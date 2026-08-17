import { describe, expect, it, vi } from 'vitest';
import { ProductsService } from '../src/modules/products/products.service.js';

const audit = { log: vi.fn(async () => {}) };

function mockPrisma(overrides: {
  findMany?: ReturnType<typeof vi.fn>;
  count?: ReturnType<typeof vi.fn>;
  groupBy?: ReturnType<typeof vi.fn>;
  findFirst?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    product: {
      findMany: overrides.findMany ?? vi.fn(async () => []),
      count: overrides.count ?? vi.fn(async () => 0),
      groupBy: overrides.groupBy ?? vi.fn(async () => []),
      findFirst: overrides.findFirst ?? vi.fn(async () => null),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
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

  it('по умолчанию sellableOnly=true и availableOnly=true', async () => {
    const findMany = vi.fn(async () => []);
    const count = vi.fn(async () => 0);
    const prisma = mockPrisma({ findMany, count });
    const service = new ProductsService(prisma, audit as never);

    await service.list({});
    const call = count.mock.calls[0]?.[0] as { where: Record<string, unknown> };
    expect(call.where.isSellable).toBe(true);
    expect(call.where.isAvailable).toBe(true);
    expect(call.where.isActive).toBe(true);
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
