import type { PrismaClient } from '@prisma/client';
import { conflict, notFound, validationError } from '../../lib/errors.js';

export class SalesService {
  constructor(private readonly prisma: PrismaClient) {}

  /** Атомарно увеличивает продажи позиции в открытом опубликованном раунде. */
  async increment(roundId: string, productId: string, quantity: number) {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw validationError('quantity должен быть положительным целым числом');
    }

    return this.prisma.$transaction(async (tx) => {
      const round = await tx.priceRound.findUnique({ where: { id: roundId } });
      if (!round) throw notFound('Раунд не найден', 'ROUND_NOT_FOUND');
      if (round.status !== 'PUBLISHED' || round.endsAt <= new Date()) {
        throw conflict('Закрытый раунд нельзя изменять');
      }

      const product = await tx.product.findFirst({
        where: { id: productId, isExchangeProduct: true, isActive: true },
      });
      if (!product) throw validationError('Товар не является активной биржевой позицией');
      if (product.organizationId !== round.organizationId) {
        throw validationError('Товар не принадлежит организации раунда');
      }

      const price = product.currentPrice ?? product.currentExchangePrice ?? product.basePrice;
      return tx.exchangeSale.upsert({
        where: { roundId_productId: { roundId, productId } },
        create: { roundId, productId, quantity, priceAtSale: price, source: 'MANUAL_PANEL' },
        update: { quantity: { increment: quantity } },
      });
    });
  }
}
