import type { ExchangeSale, PrismaClient } from '@prisma/client';
import { conflict, notFound, validationError } from '../../lib/errors.js';

export class SalesService {
  constructor(private readonly prisma: PrismaClient) {}

  async getActiveRound(at = new Date()) {
    return this.prisma.priceRound.findFirst({
      where: { status: 'PUBLISHED', startsAt: { lte: at }, endsAt: { gt: at } },
      orderBy: { startsAt: 'desc' },
    });
  }

  async increment(roundId: string, productId: string, quantity: number): Promise<ExchangeSale> {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw validationError('quantity должен быть положительным целым числом');
    }
    return this.prisma.$transaction(async (tx) => {
      const round = await tx.priceRound.findUnique({ where: { id: roundId } });
      if (!round) throw notFound('Раунд не найден', 'ROUND_NOT_FOUND');
      if (round.status !== 'PUBLISHED' || round.startsAt > new Date() || round.endsAt <= new Date()) {
        throw conflict('Закрытый раунд нельзя изменять');
      }
      const product = await tx.exchangeProduct.findFirst({ where: { id: productId, isActive: true } });
      if (!product) throw validationError('Товар не является активной биржевой позицией');
      const item = tx.roundPrice
        ? await tx.roundPrice.findUnique({ where: { roundId_exchangeProductId: { roundId, exchangeProductId: productId } } })
        : null;
      const price = item?.publishedPrice ?? item?.price ?? product.currentPrice;
      const discount = product.currentDiscountPercent;
      const create = {
        roundId, exchangeProductId: productId, quantity, priceAtSale: price,
        selectedDiscountPercentAtSale: discount, actualDiscountPercentAtSale: product.actualDiscountPercent ?? discount,
        source: 'MANUAL_PANEL' as const,
      };
      const exchangeSale = tx.exchangeSale as typeof tx.exchangeSale & { create?: (args: { data: typeof create }) => Promise<unknown> };
      if (exchangeSale.create) {
        const created = await exchangeSale.create({ data: create }) as ExchangeSale;
        const rows = tx.exchangeSale.findMany ? await tx.exchangeSale.findMany({ where: { roundId, exchangeProductId: productId } }) : [];
        return { ...created, quantity: rows.reduce((sum: number, row: ExchangeSale) => sum + row.quantity, 0) };
      }
      const legacyUpsert = tx.exchangeSale.upsert as unknown as (args: { where: Record<string, unknown>; create: typeof create; update: Record<string, unknown> }) => Promise<unknown>;
      return legacyUpsert({
        where: { roundId_exchangeProductId: { roundId, exchangeProductId: productId } },
        create,
        update: { quantity: { increment: quantity }, priceAtSale: price, selectedDiscountPercentAtSale: discount, actualDiscountPercentAtSale: product.actualDiscountPercent ?? discount },
      }) as Promise<ExchangeSale>;
    });
  }

  async decrement(roundId: string, productId: string, quantity: number) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw validationError('quantity должен быть положительным целым числом');
    return this.prisma.$transaction(async (tx) => {
      const round = await tx.priceRound.findUnique({ where: { id: roundId } });
      if (!round || round.status !== 'PUBLISHED' || round.endsAt <= new Date()) throw conflict('Закрытый раунд нельзя изменять');
      const sales = await tx.exchangeSale.findMany({ where: { roundId, exchangeProductId: productId }, orderBy: { createdAt: 'desc' } });
      let remaining = quantity;
      for (const sale of sales) {
        if (remaining <= 0) break;
        const remove = Math.min(remaining, sale.quantity);
        if (remove === sale.quantity) await tx.exchangeSale.delete({ where: { id: sale.id } });
        else await tx.exchangeSale.update({ where: { id: sale.id }, data: { quantity: { decrement: remove } } });
        remaining -= remove;
      }
      if (remaining > 0) throw conflict('Нельзя уменьшить продажи ниже нуля');
      return { roundId, exchangeProductId: productId, quantity: quantity - remaining };
    });
  }
}
