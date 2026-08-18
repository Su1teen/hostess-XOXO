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
import { parseExternalMenu, type ParserSample } from './iiko-menu-parser.js';

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
  drinkCategoryCount: number;
  drinkCandidateCount: number;
  candidateWithFinitePriceCount: number;
  candidateWithPositivePriceCount: number;
  savedCount: number;
  updatedCount: number;
  zeroPriceCandidateCount: number;
  skippedWithoutItemIdCount: number;
  skippedWithoutPriceCount: number;
  nonDrinkItemCount: number;
  unavailableCount: number;
  durationMs: number;
  success: boolean;
  error: string | null;
}

const SYNC_BATCH_SIZE = 250;

/**
 * Синхронизация внешнего меню iiko → PostgreSQL. Только чтение из iiko.
 * Пропавшие товары не удаляются, а помечаются недоступными (isAvailable=false).
 * Сырое тело меню никогда не логируется и не возвращается — только сводка.
 */
export class IikoSyncService {
  private latestParserSamples: ParserSample[] = [];

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
   * Извлекает drink-candidate item-size variants по алгоритму Python extractor,
   * сохраняет их батчами и помечает пропавшие недоступными.
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
      this.latestParserSamples = parsed.parserSamples;
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
        seenKeys.add(variantKey(variant.organizationId, variant.iikoItemId, variant.iikoSizeId));
        const basePrice = toMoney(variant.basePrice.toString());
        const existing = await this.prisma.product.findFirst({
          where: {
            organizationId: organization.id,
            iikoItemId: variant.iikoItemId,
            iikoSizeId: variant.iikoSizeId,
          },
          select: { id: true },
        });
        const syncData = {
          iikoSizeId: variant.iikoSizeId,
          iikoProductId: variant.iikoProductId,
          name: variant.name,
          displayName: variant.displayName,
          sizeName: variant.sizeName,
          sizeCode: variant.sizeCode,
          sku: variant.sku,
          categoryId: variant.categoryId,
          categoryName: variant.categoryName,
          basePrice: basePrice.toString(),
          currentKnownIikoPrice: basePrice.toString(),
          currency: variant.currency,
          isDrinkCandidate: variant.isDrinkCandidate,
          isSellable: variant.isSellable,
          isAvailable: variant.isAvailable,
          isActive: true,
          status: 'ACTIVE' as const,
          sourceMenuId: parsed.sourceMenuId,
          sourceExternalMenuId: parsed.sourceExternalMenuId,
          sourceMetadata: variant.sourceMetadata as Prisma.InputJsonValue,
          syncWarnings: variant.syncWarnings as unknown as Prisma.InputJsonValue,
          lastSeenAt: syncedAt,
          syncedAt,
        };
        if (existing) {
          await this.prisma.product.update({ where: { id: existing.id }, data: syncData });
          updatedCount += 1;
        } else {
          await this.prisma.product.create({
            data: {
              organizationId: organization.id,
              iikoItemId: variant.iikoItemId,
              isExchangeProduct: false,
              priceStep: this.env.PRICE_DEFAULT_STEP.toString(),
              maxChangePercent: this.env.PRICE_MAX_CHANGE_PERCENT.toString(),
              ...syncData,
            },
          });
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
      const key = variantKey(organization.iikoOrganizationId, row.iikoItemId, row.iikoSizeId);
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
      drinkCategoryCount: parsed.drinkCategoryCount,
      drinkCandidateCount: parsed.drinkCandidateCount,
      candidateWithFinitePriceCount: parsed.candidateWithFinitePriceCount,
      candidateWithPositivePriceCount: parsed.candidateWithPositivePriceCount,
      savedCount,
      updatedCount,
      zeroPriceCandidateCount: parsed.zeroPriceCandidateCount,
      skippedWithoutItemIdCount: parsed.skippedWithoutItemIdCount,
      skippedWithoutPriceCount: parsed.skippedWithoutPriceCount,
      nonDrinkItemCount: parsed.nonDrinkItemCount,
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
      drinkCategoryCount: 0,
      drinkCandidateCount: 0,
      candidateWithFinitePriceCount: 0,
      candidateWithPositivePriceCount: 0,
      savedCount: 0,
      updatedCount: 0,
      zeroPriceCandidateCount: 0,
      skippedWithoutItemIdCount: 0,
      skippedWithoutPriceCount: 0,
      nonDrinkItemCount: 0,
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
      drinkCategoryCount: summary.drinkCategoryCount,
      drinkCandidateCount: summary.drinkCandidateCount,
      candidateWithFinitePriceCount: summary.candidateWithFinitePriceCount,
      candidateWithPositivePriceCount: summary.candidateWithPositivePriceCount,
      savedCount: summary.savedCount,
      updatedCount: summary.updatedCount,
      zeroPriceCandidateCount: summary.zeroPriceCandidateCount,
      skippedWithoutItemIdCount: summary.skippedWithoutItemIdCount,
      skippedWithoutPriceCount: summary.skippedWithoutPriceCount,
      nonDrinkItemCount: summary.nonDrinkItemCount,
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
        ? `Синхронизация меню: ${summary.drinkCandidateCount} напитков-кандидатов, ${summary.candidateWithPositivePriceCount} вариантов с положительной ценой; товаров биржи выбрано отдельно`
        : `Синхронизация меню не удалась: ${summary.error ?? 'ошибка'}`,
      metadata: safeMetadata,
    });
  }

  getLatestParserSamples(): { samples: ParserSample[] } {
    return { samples: this.latestParserSamples };
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

function variantKey(organizationId: string, iikoItemId: string, iikoSizeId: string | null): string {
  return JSON.stringify([organizationId, iikoItemId, iikoSizeId]);
}
