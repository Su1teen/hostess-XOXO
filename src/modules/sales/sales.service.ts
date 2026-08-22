import type { PrismaClient } from '@prisma/client';
import { conflict, notFound, validationError } from '../../lib/errors.js';

export class SalesService {
  constructor(private readonly prisma: PrismaClient) {}

  async increment(roundId: string, productId: string, quantity: number) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) throw validationError('quantity должен быть положительным целым числом');
    return this.prisma.$transaction(async (tx) => {
      const round = await tx.priceRound.findUnique({ where: { id: roundId } });
      if (!round) throw notFound('Раунд не найден', 'ROUND_NOT_FOUND');
      if (round.status !== 'PUBLISHED' || round.endsAt <= new Date()) throw conflict('Закрытый раунд нельзя изменять');
      const product = await tx.exchangeProduct.findFirst({ where: { id: productId, isActive: true } });
      if (!product) throw validationError('Товар не является активной биржевой позицией');
      const price = product.currentPrice;
      return tx.exchangeSale.upsert({
        where: { roundId_exchangeProductId: { roundId, exchangeProductId: productId } },
        create: { roundId, exchangeProductId: productId, quantity, priceAtSale: price, source: 'MANUAL_PANEL' },
        update: { quantity: { increment: quantity } },
      });
    });
  }
}
