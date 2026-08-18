import type { Prisma, Product, PrismaClient } from '@prisma/client';
import { conflict, notFound, validationError } from '../../lib/errors.js';
import { toMoney } from '../../lib/money.js';
import type { AuditService } from '../../services/audit.service.js';

export interface ProductListParams {
  page?: number;
  pageSize?: number;
  search?: string;
  category?: string;
  drinkCandidatesOnly?: boolean;
  sellableOnly?: boolean;
  exchangeOnly?: boolean;
  activeOnly?: boolean;
  availableOnly?: boolean;
}

export interface ProductListResult {
  items: Product[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
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

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 50;

export class ProductsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly audit: AuditService,
  ) {}

  /** Постраничный список товаров с фильтрами. Максимум 100 строк на страницу. */
  async list(params: ProductListParams): Promise<ProductListResult> {
    const page = Math.max(params.page ?? 1, 1);
    const pageSize = Math.min(Math.max(params.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = (page - 1) * pageSize;

    const where: Prisma.ProductWhereInput = {};
    if (params.search && params.search.trim().length > 0) {
      const term = params.search.trim();
      where.OR = [
        { name: { contains: term, mode: 'insensitive' } },
        { displayName: { contains: term, mode: 'insensitive' } },
        { sku: { contains: term, mode: 'insensitive' } },
        { categoryName: { contains: term, mode: 'insensitive' } },
      ];
    }
    if (params.category && params.category.trim().length > 0) {
      where.categoryName = params.category.trim();
    }
    if (params.drinkCandidatesOnly ?? true) {
      where.isDrinkCandidate = true;
    }
    if (params.sellableOnly ?? true) {
      where.isSellable = true;
    }
    if (params.exchangeOnly) {
      where.isExchangeProduct = true;
    }
    if (params.activeOnly ?? true) {
      where.isActive = true;
    }
    if (params.availableOnly ?? true) {
      where.isAvailable = true;
    }

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: [{ isExchangeProduct: 'desc' }, { displayName: 'asc' }],
        take: pageSize,
        skip: offset,
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(Math.ceil(total / pageSize), 1),
    };
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
      summary: `Обновлены настройки товара «${updated.displayName}»`,
      metadata: { fields: Object.keys(input) },
    });

    return updated;
  }

  /**
   * Добавление/удаление товара на биржу.
   * При выборе требует sellable+available, basePrice>0 и заданные min/max/step,
   * а также minPrice <= basePrice <= maxPrice. Не позволяет выбрать дважды.
   */
  async setExchangeSelection(
    id: string,
    selected: boolean,
    actorId?: string,
    requestId?: string,
  ): Promise<Product> {
    const product = await this.getById(id);

    if (selected) {
      if (product.isExchangeProduct) {
        throw conflict('Товар уже выбран для биржи');
      }
      if (!product.isSellable || !product.isAvailable) {
        throw validationError('Товар не является sellable/доступным вариантом');
      }
      if (product.basePrice.lte(0)) {
        throw validationError(
          'Нельзя добавить товар на биржу без basePrice > 0. Сначала задайте базовую цену.',
        );
      }
      if (product.minPrice === null || product.maxPrice === null || product.priceStep === null) {
        throw validationError(
          'Для выбора на биржу должны быть заданы minPrice, maxPrice и priceStep.',
        );
      }
      const base = toMoney(product.basePrice.toString());
      const min = toMoney(product.minPrice.toString());
      const max = toMoney(product.maxPrice.toString());
      if (min.gt(base)) {
        throw validationError('minPrice не может быть больше basePrice');
      }
      if (base.gt(max)) {
        throw validationError('basePrice не может быть больше maxPrice');
      }
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
        ? `Товар «${updated.displayName}» добавлен на биржу`
        : `Товар «${updated.displayName}» убран с биржи`,
    });

    return updated;
  }

  async counts() {
    const [total, drinkCandidates, exchange, active, sellable, available] = await Promise.all([
      this.prisma.product.count(),
      this.prisma.product.count({ where: { isDrinkCandidate: true } }),
      this.prisma.product.count({ where: { isExchangeProduct: true } }),
      this.prisma.product.count({ where: { isActive: true } }),
      this.prisma.product.count({ where: { isSellable: true } }),
      this.prisma.product.count({ where: { isAvailable: true } }),
    ]);
    return { total, drinkCandidates, exchange, active, sellable, available };
  }

  /** Категории с количеством sellable+available вариантов. */
  async listCategories(
    params: {
      drinkCandidatesOnly?: boolean;
      sellableOnly?: boolean;
      availableOnly?: boolean;
    } = {},
  ) {
    const where: Prisma.ProductWhereInput = {
      categoryName: { not: null },
    };
    if (params.drinkCandidatesOnly ?? true) where.isDrinkCandidate = true;
    if (params.sellableOnly ?? true) where.isSellable = true;
    if (params.availableOnly ?? true) where.isAvailable = true;

    const rows = await this.prisma.product.groupBy({
      by: ['categoryName'],
      where,
      _count: { _all: true },
      orderBy: { categoryName: 'asc' },
    });
    return rows
      .filter((row): row is (typeof rows)[number] & { categoryName: string } =>
        Boolean(row.categoryName),
      )
      .map((row) => ({ name: row.categoryName, count: row._count._all }));
  }

  /** Поиск продукта по iikoItemId (для webhooks/front-plugin). */
  async findByIikoItemId(
    organizationId: string,
    iikoItemId: string,
  ): Promise<Product | null> {
    return this.prisma.product.findFirst({
      where: { organizationId, iikoItemId, isSellable: true, isAvailable: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Fallback-поиск по iikoProductId, если itemId недоступен. */
  async findByIikoProductId(
    organizationId: string,
    iikoProductId: string,
  ): Promise<Product | null> {
    return this.prisma.product.findFirst({
      where: { organizationId, iikoProductId, isSellable: true, isAvailable: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}
