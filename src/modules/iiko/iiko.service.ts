import { Prisma, type PrismaClient } from '@prisma/client';
import type { AppEnv } from '../../config/env.js';
import {
  iikoMenuDatabaseFailed,
  iikoMenuParserFailed,
  notFound,
  organizationNotSelected,
  validationError,
} from '../../lib/errors.js';
import { toMoney } from '../../lib/money.js';
import type { AuditService } from '../../services/audit.service.js';
import type { IikoClient } from '../../services/iiko-client.service.js';
import type { TelegramService } from '../../services/telegram.service.js';
import { parseExternalMenu } from './iiko-menu-parser.js';

export interface SyncOrganizationsResult {
  fetched: number;
  created: number;
  updated: number;
  selectedIikoOrganizationId: string | null;
}

export interface SyncMenuSummary {
  organizationId: string;
  sourceExternalMenuId: string | null;
  sourceMenuId: string | null;
  correlationId: string | null;
  sourceItemCount: number;
  sourceCategoryCount: number;
  extractedVariantCount: number;
  skippedNoSizes: number;
  skippedHidden: number;
  skippedZeroPriceCount: number;
  skippedMalformedCount: number;
  skippedAmbiguousCount: number;
  savedCount: number;
  updatedCount: number;
  unavailableCount: number;
  durationMs: number;
  success: boolean;
  error: string | null;
}

const SYNC_BATCH_SIZE = 250;
const NO_SIZE_FALLBACK = '__no_size__';

/**
 * Синхронизация внешнего меню iiko → PostgreSQL. Только чтение из iiko.
 * Пропавшие товары не удаляются, а помечаются недоступными (isAvailable=false).
 * Сырое тело меню никогда не логируется и не возвращается — только сводка.
 */
export class IikoSyncService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: AppEnv,
    private readonly iiko: IikoClient,
    private readonly audit: AuditService,
    private readonly telegram: TelegramService,
  ) {}

  async testConnection(requestId?: string) {
    try {
      const result = await this.iiko.testConnection();
      await this.audit.log({
        action: 'IIKO_AUTH',
        actorType: 'ADMIN',
        requestId: requestId ?? null,
        summary: `Проверка подключения к iiko успешна (${result.organizationsCount} организаций)`,
        metadata: { organizationsCount: result.organizationsCount, durationMs: result.durationMs },
      });
      return result;
    } catch (error) {
      await this.telegram.sendAlert(
        'IIKO_CONNECTION_FAILED',
        '⚠️ Bar Exchange: не удалось подключиться к iiko Cloud API.',
      );
      throw error;
    }
  }

  async syncOrganizations(requestId?: string): Promise<SyncOrganizationsResult> {
    const organizations = await this.iiko.getOrganizations();
    let created = 0;
    let updated = 0;

    for (const organization of organizations) {
      const existing = await this.prisma.organization.findUnique({
        where: { iikoOrganizationId: organization.id },
      });
      const data = {
        name: organization.name,
        status: organization.isActive === false ? ('INACTIVE' as const) : ('ACTIVE' as const),
        metadata: {
          country: organization.country ?? null,
          restaurantAddress: organization.restaurantAddress ?? null,
        } satisfies Prisma.InputJsonValue,
      };
      if (existing) {
        await this.prisma.organization.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await this.prisma.organization.create({
          data: { iikoOrganizationId: organization.id, ...data },
        });
        created += 1;
      }
    }

    // Если организация задана в env и ещё ничего не выбрано — выбираем её автоматически.
    if (this.env.IIKO_ORGANIZATION_ID) {
      const selectedCount = await this.prisma.organization.count({ where: { isSelected: true } });
      const target = await this.prisma.organization.findUnique({
        where: { iikoOrganizationId: this.env.IIKO_ORGANIZATION_ID },
      });
      if (selectedCount === 0 && target) {
        await this.selectOrganization(target.iikoOrganizationId, requestId);
      }
    }

    const selected = await this.prisma.organization.findFirst({ where: { isSelected: true } });

    await this.audit.log({
      action: 'IIKO_ORGANIZATIONS_SYNC',
      actorType: 'ADMIN',
      requestId: requestId ?? null,
      summary: `Синхронизация организаций: получено ${organizations.length}, создано ${created}, обновлено ${updated}`,
      metadata: { fetched: organizations.length, created, updated },
    });

    return {
      fetched: organizations.length,
      created,
      updated,
      selectedIikoOrganizationId: selected?.iikoOrganizationId ?? null,
    };
  }

  async listOrganizations() {
    return this.prisma.organization.findMany({
      orderBy: [{ isSelected: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        iikoOrganizationId: true,
        name: true,
        status: true,
        isSelected: true,
        updatedAt: true,
        _count: { select: { products: true } },
      },
    });
  }

  /** v0.1: выбранной может быть только одна организация. */
  async selectOrganization(iikoOrganizationId: string, requestId?: string) {
    const organization = await this.prisma.organization.findUnique({
      where: { iikoOrganizationId },
    });
    if (!organization) {
      throw notFound('Организация не найдена. Сначала выполните синхронизацию организаций.');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await tx.organization.updateMany({
        where: { isSelected: true, id: { not: organization.id } },
        data: { isSelected: false },
      });
      return tx.organization.update({
        where: { id: organization.id },
        data: { isSelected: true },
      });
    });

    await this.audit.log({
      action: 'ADMIN_ACTION',
      actorType: 'ADMIN',
      organizationId: updated.id,
      entityType: 'Organization',
      entityId: updated.id,
      requestId: requestId ?? null,
      summary: `Выбрана организация «${updated.name}»`,
    });

    return updated;
  }

  /**
   * Синхронизация полного внешнего меню iiko (POST /api/2/menu/by_id).
   * Извлекает sellable item-size-price variants, upsert их батчами,
   * помечает пропавшие недоступными. Возвращает только сводку — без сырого меню.
   */
  async syncMenu(requestId?: string): Promise<SyncMenuSummary> {
    const startedAt = Date.now();
    const organization = await this.prisma.organization.findFirst({ where: { isSelected: true } });
    if (!organization) throw organizationNotSelected();

    const externalMenuId = this.env.IIKO_EXTERNAL_MENU_ID;
    if (!externalMenuId) {
      throw validationError('Не задан IIKO_EXTERNAL_MENU_ID');
    }

    let rawMenu: unknown;
    try {
      rawMenu = await this.iiko.getExternalMenu(organization.iikoOrganizationId, externalMenuId);
    } catch (error) {
      const summary = this.buildFailureSummary(
        organization.id,
        null,
        null,
        Date.now() - startedAt,
        error,
      );
      await this.telegram.sendAlert(
        'IIKO_MENU_SYNC_FAILED',
        `⚠️ Bar Exchange: синхронизация меню не удалась для «${organization.name}».`,
      );
      await this.recordSyncSummary(organization.id, summary, requestId);
      throw error;
    }

    let parsed: ReturnType<typeof parseExternalMenu>;
    try {
      parsed = parseExternalMenu(rawMenu, {
        organizationId: organization.iikoOrganizationId,
        externalMenuId,
        currency: 'KZT',
      });
    } catch {
      throw iikoMenuParserFailed('Получено меню HTTP 2xx, но внутренняя нормализация завершилась ошибкой.');
    }

    try {
    const syncedAt = new Date();
    const seenKeys = new Set<string>();
    let savedCount = 0;
    let updatedCount = 0;

    // Upsert батчами без одной гигантской транзакции.
    for (let i = 0; i < parsed.variants.length; i += SYNC_BATCH_SIZE) {
      const batch = parsed.variants.slice(i, i + SYNC_BATCH_SIZE);
      for (const variant of batch) {
        const key = `${variant.organizationId}|${variant.iikoItemId}|${variant.iikoSizeId}`;
        seenKeys.add(key);
        const basePrice = toMoney(variant.basePrice.toString());
        const existing = await this.prisma.product.findUnique({
          where: {
            organizationId_iikoItemId_iikoSizeId: {
              organizationId: organization.id,
              iikoItemId: variant.iikoItemId,
              iikoSizeId: variant.iikoSizeId,
            },
          },
          select: { id: true, basePrice: true },
        });
        const upsertData = {
          iikoSizeId: variant.iikoSizeId,
          iikoProductId: variant.iikoProductId,
          name: variant.name,
          displayName: variant.displayName,
          sizeName: variant.sizeName,
          sizeCode: variant.sizeCode,
          sku: variant.sku,
          categoryId: variant.categoryId,
          categoryName: variant.categoryName,
          currentKnownIikoPrice: basePrice.toString(),
          currency: variant.currency,
          isSellable: variant.isSellable,
          isAvailable: true,
          isActive: true,
          status: 'ACTIVE' as const,
          sourceMenuId: parsed.sourceMenuId,
          sourceExternalMenuId: parsed.sourceExternalMenuId,
          sourceMetadata: variant.sourceMetadata as Prisma.InputJsonValue,
          syncWarnings: variant.syncWarnings.length
            ? (variant.syncWarnings as unknown as Prisma.InputJsonValue)
            : Prisma.JsonNull,
          lastSeenAt: syncedAt,
          syncedAt,
        };
        await this.prisma.product.upsert({
          where: {
            organizationId_iikoItemId_iikoSizeId: {
              organizationId: organization.id,
              iikoItemId: variant.iikoItemId,
              iikoSizeId: variant.iikoSizeId,
            },
          },
          create: {
            organizationId: organization.id,
            iikoItemId: variant.iikoItemId,
            basePrice: basePrice.toString(),
            priceStep: this.env.PRICE_DEFAULT_STEP.toString(),
            maxChangePercent: this.env.PRICE_MAX_CHANGE_PERCENT.toString(),
            ...upsertData,
          },
          update: {
            ...upsertData,
            // basePrice администратор настраивает вручную; перезаписываем только если он ещё нулевой.
            basePrice:
              existing && existing.basePrice.isZero() ? basePrice.toString() : undefined,
          },
        });
        if (existing) {
          updatedCount += 1;
        } else {
          savedCount += 1;
        }
      }
    }

    // Пропавшие варианты этой организации/меню помечаем недоступными.
    // Не удаляем — сохраняем lastSeenAt. Совпадение по полному ключу
    // (iikoItemId + iikoSizeId): если у товара исчез один размер, но другой
    // остался — исчезнувший размер помечается недоступным, а оставшийся — нет.
    const existingAvailable = await this.prisma.product.findMany({
      where: {
        organizationId: organization.id,
        isAvailable: true,
        OR: [{ sourceExternalMenuId: externalMenuId }, { sourceExternalMenuId: null }],
      },
      select: { id: true, iikoItemId: true, iikoSizeId: true },
    });
    const goneIds: string[] = [];
    for (const row of existingAvailable) {
      const key = `${organization.iikoOrganizationId}|${row.iikoItemId}|${row.iikoSizeId ?? NO_SIZE_FALLBACK}`;
      if (!seenKeys.has(key)) goneIds.push(row.id);
    }
    const unavailable =
      goneIds.length > 0
        ? await this.prisma.product.updateMany({
            where: { id: { in: goneIds } },
            data: { isAvailable: false, isActive: false, status: 'INACTIVE' },
          })
        : { count: 0 };

    const summary: SyncMenuSummary = {
      organizationId: organization.id,
      sourceExternalMenuId: parsed.sourceExternalMenuId,
      sourceMenuId: parsed.sourceMenuId,
      correlationId: parsed.correlationId,
      sourceItemCount: parsed.sourceItemCount,
      sourceCategoryCount: parsed.sourceCategoryCount,
      extractedVariantCount: parsed.variants.length,
      skippedNoSizes: parsed.skippedNoSizes,
      skippedHidden: parsed.skippedHidden,
      skippedZeroPriceCount: parsed.skippedZeroPrice,
      skippedMalformedCount: parsed.skippedMalformedPrice,
      skippedAmbiguousCount: parsed.skippedAmbiguousPrice,
      savedCount,
      updatedCount,
      unavailableCount: unavailable.count,
      durationMs: Date.now() - startedAt,
      success: true,
      error: null,
    };

    await this.prisma.appSetting.upsert({
      where: { key: 'iiko.lastMenuSyncAt' },
      create: { key: 'iiko.lastMenuSyncAt', value: syncedAt.toISOString() },
      update: { value: syncedAt.toISOString() },
    });
    await this.prisma.appSetting.upsert({
      where: { key: 'iiko.lastMenuSyncSummary' },
      create: { key: 'iiko.lastMenuSyncSummary', value: summary as unknown as Prisma.InputJsonValue },
      update: { value: summary as unknown as Prisma.InputJsonValue },
    });

    await this.recordSyncSummary(organization.id, summary, requestId);
    return summary;
    } catch {
      throw iikoMenuDatabaseFailed(
        'Меню получено и разобрано, но сохранение нормализованных товаров завершилось ошибкой.',
      );
    }
  }

  private buildFailureSummary(
    organizationId: string,
    externalMenuId: string | null,
    correlationId: string | null,
    durationMs: number,
    error: unknown,
  ): SyncMenuSummary {
    const message =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
    return {
      organizationId,
      sourceExternalMenuId: externalMenuId,
      sourceMenuId: null,
      correlationId,
      sourceItemCount: 0,
      sourceCategoryCount: 0,
      extractedVariantCount: 0,
      skippedNoSizes: 0,
      skippedHidden: 0,
      skippedZeroPriceCount: 0,
      skippedMalformedCount: 0,
      skippedAmbiguousCount: 0,
      savedCount: 0,
      updatedCount: 0,
      unavailableCount: 0,
      durationMs,
      success: false,
      error: message.slice(0, 500),
    };
  }

  private async recordSyncSummary(
    organizationId: string,
    summary: SyncMenuSummary,
    requestId?: string,
  ): Promise<void> {
    // Сводка без сырого тела меню.
    const safeMetadata = {
      sourceItemCount: summary.sourceItemCount,
      sourceCategoryCount: summary.sourceCategoryCount,
      extractedVariantCount: summary.extractedVariantCount,
      skippedNoSizes: summary.skippedNoSizes,
      skippedHidden: summary.skippedHidden,
      skippedZeroPriceCount: summary.skippedZeroPriceCount,
      skippedMalformedCount: summary.skippedMalformedCount,
      skippedAmbiguousCount: summary.skippedAmbiguousCount,
      savedCount: summary.savedCount,
      updatedCount: summary.updatedCount,
      unavailableCount: summary.unavailableCount,
      durationMs: summary.durationMs,
      correlationId: summary.correlationId,
      success: summary.success,
    } satisfies Prisma.InputJsonValue;

    await this.audit.log({
      action: 'IIKO_MENU_SYNC',
      actorType: 'ADMIN',
      organizationId,
      requestId: requestId ?? null,
      summary: summary.success
        ? `Синхронизация меню: ${summary.extractedVariantCount} вариантов, ${summary.sourceItemCount} товаров, ${summary.sourceCategoryCount} категорий`
        : `Синхронизация меню не удалась: ${summary.error ?? 'ошибка'}`,
      metadata: safeMetadata,
    });
  }

  async getLastMenuSyncAt(): Promise<string | null> {
    const setting = await this.prisma.appSetting.findUnique({
      where: { key: 'iiko.lastMenuSyncAt' },
    });
    return typeof setting?.value === 'string' ? setting.value : null;
  }

  async getLastMenuSyncSummary(): Promise<SyncMenuSummary | null> {
    const setting = await this.prisma.appSetting.findUnique({
      where: { key: 'iiko.lastMenuSyncSummary' },
    });
    if (!setting || typeof setting.value !== 'object' || setting.value === null) return null;
    return setting.value as unknown as SyncMenuSummary;
  }

  assertOrganizationMatches(iikoOrganizationId: string, selectedIikoOrganizationId: string): void {
    if (iikoOrganizationId !== selectedIikoOrganizationId) {
      throw validationError('Организация не совпадает с выбранной');
    }
  }
}
