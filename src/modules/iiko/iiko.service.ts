import type { Prisma, PrismaClient } from '@prisma/client';
import type { AppEnv } from '../../config/env.js';
import { notFound, organizationNotSelected, validationError } from '../../lib/errors.js';
import { toMoney } from '../../lib/money.js';
import type { AuditService } from '../../services/audit.service.js';
import type { IikoClient, IikoNomenclature } from '../../services/iiko-client.service.js';
import type { TelegramService } from '../../services/telegram.service.js';

export interface SyncOrganizationsResult {
  fetched: number;
  created: number;
  updated: number;
  selectedIikoOrganizationId: string | null;
}

export interface SyncMenuResult {
  organizationId: string;
  groups: number;
  productsFetched: number;
  productsCreated: number;
  productsUpdated: number;
  productsArchived: number;
  revision: number | null;
  stopListItems: number;
}

/**
 * Синхронизация справочников iiko → PostgreSQL. Только чтение из iiko.
 * Пропавшие товары не удаляются, а помечаются ARCHIVED/неактивными.
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

  async syncMenu(requestId?: string): Promise<SyncMenuResult> {
    const organization = await this.prisma.organization.findFirst({ where: { isSelected: true } });
    if (!organization) throw organizationNotSelected();

    let nomenclature: IikoNomenclature;
    try {
      nomenclature = await this.iiko.getNomenclature(organization.iikoOrganizationId);
    } catch (error) {
      await this.telegram.sendAlert(
        'IIKO_MENU_SYNC_FAILED',
        `⚠️ Bar Exchange: синхронизация меню не удалась для «${organization.name}».`,
      );
      throw error;
    }

    const groupNameById = new Map(nomenclature.groups.map((group) => [group.id, group.name]));
    const groupPath = (groupId: string | null | undefined): string => {
      const segments: string[] = [];
      let current = groupId ?? null;
      const guard = new Set<string>();
      while (current && !guard.has(current)) {
        guard.add(current);
        const name = groupNameById.get(current);
        if (!name) break;
        segments.unshift(name);
        current = nomenclature.groups.find((group) => group.id === current)?.parentGroup ?? null;
      }
      return segments.join(' / ');
    };

    for (const group of nomenclature.groups) {
      await this.prisma.productGroup.upsert({
        where: {
          organizationId_iikoGroupId: {
            organizationId: organization.id,
            iikoGroupId: group.id,
          },
        },
        create: {
          organizationId: organization.id,
          iikoGroupId: group.id,
          parentIikoGroupId: group.parentGroup ?? null,
          name: group.name,
          path: groupPath(group.id),
        },
        update: {
          parentIikoGroupId: group.parentGroup ?? null,
          name: group.name,
          path: groupPath(group.id),
        },
      });
    }

    const syncedAt = new Date();
    let productsCreated = 0;
    let productsUpdated = 0;
    const seenIikoIds: string[] = [];

    for (const product of nomenclature.products) {
      if (product.isDeleted) continue;
      seenIikoIds.push(product.id);
      const knownPrice =
        product.price === null || product.price === undefined ? null : toMoney(product.price);

      const existing = await this.prisma.product.findUnique({
        where: {
          organizationId_iikoProductId: {
            organizationId: organization.id,
            iikoProductId: product.id,
          },
        },
      });

      const shared = {
        iikoParentGroupId: product.parentGroup ?? null,
        name: product.name,
        description: product.description ?? null,
        sku: product.code ?? null,
        productType: product.type ?? null,
        unit: product.measureUnit ?? null,
        imageUrl: product.imageLinks?.[0] ?? null,
        currentKnownIikoPrice: knownPrice?.toString() ?? null,
        isActive: true,
        status: 'ACTIVE' as const,
        syncedAt,
        metadata: {
          iikoGroupPath: groupPath(product.parentGroup),
        } satisfies Prisma.InputJsonValue,
      };

      if (existing) {
        await this.prisma.product.update({
          where: { id: existing.id },
          data: {
            ...shared,
            // basePrice администратор настраивает вручную; перезаписываем только если он ещё нулевой.
            basePrice:
              existing.basePrice.isZero() && knownPrice ? knownPrice.toString() : undefined,
          },
        });
        productsUpdated += 1;
      } else {
        await this.prisma.product.create({
          data: {
            organizationId: organization.id,
            iikoProductId: product.id,
            basePrice: (knownPrice ?? toMoney(0)).toString(),
            priceStep: this.env.PRICE_DEFAULT_STEP.toString(),
            maxChangePercent: this.env.PRICE_MAX_CHANGE_PERCENT.toString(),
            ...shared,
          },
        });
        productsCreated += 1;
      }
    }

    // Пропавшие в iiko товары не удаляем — архивируем.
    const archived = await this.prisma.product.updateMany({
      where: {
        organizationId: organization.id,
        iikoProductId: { notIn: seenIikoIds.length > 0 ? seenIikoIds : ['__none__'] },
        status: { not: 'ARCHIVED' },
      },
      data: { status: 'ARCHIVED', isActive: false },
    });

    let stopListItems = 0;
    try {
      const stopList = await this.iiko.getStopList(organization.iikoOrganizationId);
      stopListItems = stopList.length;
      if (stopList.length > 0) {
        await this.prisma.product.updateMany({
          where: {
            organizationId: organization.id,
            iikoProductId: { in: stopList.map((item) => item.productId) },
          },
          data: { status: 'STOPPED' },
        });
      }
    } catch {
      // Стоп-лист не критичен для v0.1: продолжаем без него.
      stopListItems = 0;
    }

    const result: SyncMenuResult = {
      organizationId: organization.id,
      groups: nomenclature.groups.length,
      productsFetched: nomenclature.products.length,
      productsCreated,
      productsUpdated,
      productsArchived: archived.count,
      revision: nomenclature.revision ?? null,
      stopListItems,
    };

    await this.prisma.appSetting.upsert({
      where: { key: 'iiko.lastMenuSyncAt' },
      create: { key: 'iiko.lastMenuSyncAt', value: syncedAt.toISOString() },
      update: { value: syncedAt.toISOString() },
    });

    await this.audit.log({
      action: 'IIKO_MENU_SYNC',
      actorType: 'ADMIN',
      organizationId: organization.id,
      requestId: requestId ?? null,
      summary: `Синхронизация меню: ${result.productsFetched} товаров, ${result.groups} групп`,
      metadata: { ...result },
    });

    return result;
  }

  async getLastMenuSyncAt(): Promise<string | null> {
    const setting = await this.prisma.appSetting.findUnique({
      where: { key: 'iiko.lastMenuSyncAt' },
    });
    return typeof setting?.value === 'string' ? setting.value : null;
  }

  assertOrganizationMatches(iikoOrganizationId: string, selectedIikoOrganizationId: string): void {
    if (iikoOrganizationId !== selectedIikoOrganizationId) {
      throw validationError('Организация не совпадает с выбранной');
    }
  }
}
