import { Prisma, type Product } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { ProductsService } from '../src/modules/products/products.service.js';

const audit = { log: vi.fn(async () => {}) };

function mockPrisma(overrides: {
  findMany?: ReturnType<typeof vi.fn>;
  count?: ReturnType<typeof vi.fn>;
  groupBy?: ReturnType<typeof vi.fn>;
  findFirst?: ReturnType<typeof vi.fn>;
  findUnique?: ReturnType<typeof vi.fn>;
  update?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    product: {
      findMany: overrides.findMany ?? vi.fn(async () => []),
      count: overrides.count ?? vi.fn(async () => 0),
      groupBy: overrides.groupBy ?? vi.fn(async () => []),
      findFirst: overrides.findFirst ?? vi.fn(async () => null),
      findUnique: overrides.findUnique ?? vi.fn(async () => null),
      update: overrides.update ?? vi.fn(async () => ({})),
    },
  } as unknown as Parameters<typeof ProductsService.prototype.list>[0] extends never
    ? never
    : import('@prisma/client').PrismaClient;
}

describe('ProductsService.list pagination', () => {
  it('ограничивает pageSize до 100', async () => {
    const findMany = vi.fn(async () => []);
    const count = vi.fn(async () => 0);
    const prisma = mockPrisma({ findMany, count });
    const service = new ProductsService(prisma, audit as never);

    await service.list({ page: 1, pageSize: 500 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100, skip: 0 }),
    );

    await service.list({ page: 2, pageSize: 25 });
    expect(findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 25, skip: 25 }),
    );
  });

  it('возвращает структуру с pagination', async () => {
    const findMany = vi.fn(async () => [{ id: 'a' }]);
    const count = vi.fn(async () => 123);
    const prisma = mockPrisma({ findMany, count });
    const service = new ProductsService(prisma, audit as never);

    const result = await service.list({ page: 1, pageSize: 50 });
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(50);
    expect(result.total).toBe(123);
    expect(result.totalPages).toBe(3);
    expect(result.items).toHaveLength(1);
  });

  it('по умолчанию показывает доступных sellable напитков-кандидатов', async () => {
    const findMany = vi.fn(async () => []);
    const count = vi.fn(async () => 0);
    const prisma = mockPrisma({ findMany, count });
    const service = new ProductsService(prisma, audit as never);

    await service.list({});
    const call = count.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(call.where.isDrinkCandidate).toBe(true);
    expect(call.where.isSellable).toBe(true);
    expect(call.where.isAvailable).toBe(true);
    expect(call.where.isActive).toBe(true);
  });

  it('поддерживает весь каталог и отдельный фильтр товаров биржи', async () => {
    const count = vi.fn(async () => 0);
    const prisma = mockPrisma({ count });
    const service = new ProductsService(prisma, audit as never);

    await service.list({
      drinkCandidatesOnly: false,
      sellableOnly: false,
      availableOnly: false,
      activeOnly: false,
      exchangeOnly: true,
    });
    const call = count.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(call.where).toEqual({ isExchangeProduct: true });
  });

  it('категории группируются по categoryName с count', async () => {
    const groupBy = vi.fn(async () => [
      { categoryName: 'Коктейли', _count: { _all: 5 } },
      { categoryName: 'Пиво', _count: { _all: 3 } },
    ]);
    const prisma = mockPrisma({ groupBy });
    const service = new ProductsService(prisma, audit as never);

    const cats = await service.listCategories();
    expect(cats).toEqual([
      { name: 'Коктейли', count: 5 },
      { name: 'Пиво', count: 3 },
    ]);
  });
});

describe('ProductsService exchange selection', () => {
  it('retains iiko item and size IDs when a product is selected for exchange', async () => {
    const product = {
      id: 'product-id',
      organizationId: 'organization-id',
      iikoItemId: 'iiko-item-id',
      iikoSizeId: 'iiko-size-id',
      displayName: 'AVA лимонад · 0.5 л',
      isExchangeProduct: false,
      isSellable: true,
      isAvailable: true,
      basePrice: new Prisma.Decimal(850),
      currentExchangePrice: null,
      minPrice: new Prisma.Decimal(700),
      maxPrice: new Prisma.Decimal(1000),
      priceStep: new Prisma.Decimal(50),
    } as Product;
    const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
      ...product,
      ...data,
      isExchangeProduct: true,
    }));
    const prisma = mockPrisma({
      findUnique: vi.fn(async () => product),
      update,
    });
    const service = new ProductsService(prisma, audit as never);

    const selected = await service.setExchangeSelection(product.id, true);

    expect(selected.iikoItemId).toBe('iiko-item-id');
    expect(selected.iikoSizeId).toBe('iiko-size-id');
    expect(update).toHaveBeenCalledWith({
      where: { id: product.id },
      data: {
        isExchangeProduct: true,
        currentExchangePrice: '850',
      },
    });
  });
});
