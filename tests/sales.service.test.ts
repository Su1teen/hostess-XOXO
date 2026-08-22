import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { SalesService } from '../src/modules/sales/sales.service.js';

const round = {
  id: 'round-1',
  organizationId: 'org-1',
  status: 'PUBLISHED',
  endsAt: new Date(Date.now() + 60_000),
};
const product = {
  id: 'product-1',
  isActive: true,
  currentPrice: new Prisma.Decimal(2000),
};

function makePrisma(roundValue = round) {
  const upsert = vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
    ...create,
    quantity: 3,
    priceAtSale: new Prisma.Decimal(2000),
    roundId: 'round-1',
    exchangeProductId: 'product-1',
  }));
  const tx = {
    priceRound: { findUnique: vi.fn(async () => roundValue) },
    exchangeProduct: { findFirst: vi.fn(async () => product) },
    exchangeSale: { upsert },
  };
  return {
    $transaction: vi.fn(async (callback: (value: typeof tx) => unknown) => callback(tx)),
    tx,
    upsert,
  } as never;
}

describe('SalesService', () => {
  it('атомарно увеличивает количество и фиксирует цену продажи', async () => {
    const prisma = makePrisma();
    const result = await new SalesService(prisma).increment('round-1', 'product-1', 3);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(result.quantity).toBe(3);
    expect(result.priceAtSale.toString()).toBe('2000');
  });

  it('не изменяет закрытый раунд', async () => {
    const prisma = makePrisma({ ...round, endsAt: new Date(Date.now() - 1) });
    await expect(
      new SalesService(prisma).increment('round-1', 'product-1', 1),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    });
  });

  it('отклоняет не положительное целое количество', async () => {
    const prisma = makePrisma();
    await expect(
      new SalesService(prisma).increment('round-1', 'product-1', 1.5),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});
