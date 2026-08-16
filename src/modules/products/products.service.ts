import type { Prisma, Product, PrismaClient } from '@prisma/client';
import { notFound, validationError } from '../../lib/errors.js';
import { toMoney } from '../../lib/money.js';
import type { AuditService } from '../../services/audit.service.js';

export interface ProductSearchParams {
  search?: string;
  group?: string;
  activeOnly?: boolean;
  exchangeOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface ProductUpdateInput {
  basePrice?: number;
  minPrice?: number | null;
  maxPrice?: number | null;
  priceStep?: number;
  maxChangePercent?: number;
  isActive?: boolean;
  currentExchangePrice?: number | null;
}

export class ProductsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  /** Поиск поддерживает русский и английский текст (case-insensitive). */
  async search(params: ProductSearchParams) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 500);
    const offset = Math.max(params.offset ?? 0, 0);

    const where: Prisma.ProductWhereInput = {};
    if (params.search && params.search.trim().length > 0) {
      const term = params.search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { description: { contains: term, mode: 'insensitive' } },
        { sku: { contains: term, mode: 'insensitive' } },
      ];
    }
    if (params.group) {
      where.iikoParentGroupId = params.group;
    }
    if (params.activeOnly) {
      where.isActive = true;
    }
    if (params.exchangeOnly) {
      where.isExchangeProduct = true;
    }

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: [{ isExchangeProduct: 'desc' }, { name: 'asc' }],
        take: limit,
        skip: offset,
      }),
      this.prisma.product.count({ where }),
    ]);

    return { items, total, limit, offset };
  }

  async getById(id: string): Promise<Product> {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw notFound('Товар не найден');
    return product;
  }

  async update(
    id: string,
    input: ProductUpdateInput,
    actorId?: string,
    requestId?: string,
  ): Promise<Product> {
    const product = await this.getById(id);

    const nextMin = input.minPrice === undefined ? product.minPrice : input.minPrice;
    const nextMax = input.maxPrice === undefined ? product.maxPrice : input.maxPrice;
    if (nextMin !== null && nextMax !== null && nextMin !== undefined && nextMax !== undefined) {
      if (toMoney(nextMin.toString()).gt(toMoney(nextMax.toString()))) {
        throw validationError('minPrice не может быть больше maxPrice');
      }
    }
    if (input.priceStep !== undefined && input.priceStep <= 0) {
      throw validationError('priceStep должен быть больше нуля');
    }
    if (input.basePrice !== undefined && input.basePrice < 0) {
      throw validationError('basePrice не может быть отрицательным');
    }

    const updated = await this.prisma.product.update({
      where: { id },
      data: {
        basePrice: input.basePrice === undefined ? undefined : toMoney(input.basePrice).toString(),
        minPrice:
          input.minPrice === undefined
            ? undefined
            : input.minPrice === null
              ? null
              : toMoney(input.minPrice).toString(),
        maxPrice:
          input.maxPrice === undefined
            ? undefined
            : input.maxPrice === null
              ? null
              : toMoney(input.maxPrice).toString(),
        priceStep: input.priceStep === undefined ? undefined : toMoney(input.priceStep).toString(),
        maxChangePercent:
          input.maxChangePercent === undefined
            ? undefined
            : toMoney(input.maxChangePercent).toString(),
        isActive: input.isActive,
        currentExchangePrice:
          input.currentExchangePrice === undefined
            ? undefined
            : input.currentExchangePrice === null
              ? null
              : toMoney(input.currentExchangePrice).toString(),
      },
    });

    await this.audit.log({
      action: 'PRODUCT_UPDATED',
      actorType: 'ADMIN',
      actorId: actorId ?? null,
      organizationId: updated.organizationId,
      entityType: 'Product',
      entityId: updated.id,
      requestId: requestId ?? null,
      summary: `Обновлены настройки товара «${updated.name}»`,
      metadata: { fields: Object.keys(input) },
    });

    return updated;
  }

  async setExchangeSelection(
    id: string,
    selected: boolean,
    actorId?: string,
    requestId?: string,
  ): Promise<Product> {
    const product = await this.getById(id);
    if (selected && product.basePrice.lte(0)) {
      throw validationError(
        'Нельзя добавить товар на биржу без basePrice > 0. Сначала задайте базовую цену.',
      );
    }

    const updated = await this.prisma.product.update({
      where: { id },
      data: {
        isExchangeProduct: selected,
        currentExchangePrice:
          selected && product.currentExchangePrice === null
            ? product.basePrice.toString()
            : undefined,
      },
    });

    await this.audit.log({
      action: 'PRODUCT_SELECTED',
      actorType: 'ADMIN',
      actorId: actorId ?? null,
      organizationId: updated.organizationId,
      entityType: 'Product',
      entityId: updated.id,
      requestId: requestId ?? null,
      summary: selected
        ? `Товар «${updated.name}» добавлен на биржу`
        : `Товар «${updated.name}» убран с биржи`,
    });

    return updated;
  }

  async counts() {
    const [total, exchange, active] = await Promise.all([
      this.prisma.product.count(),
      this.prisma.product.count({ where: { isExchangeProduct: true } }),
      this.prisma.product.count({ where: { isActive: true } }),
    ]);
    return { total, exchange, active };
  }

  async listGroups(organizationId?: string) {
    return this.prisma.productGroup.findMany({
      where: organizationId ? { organizationId } : undefined,
      orderBy: { path: 'asc' },
      select: { iikoGroupId: true, name: true, path: true },
      take: 500,
    });
  }
}
