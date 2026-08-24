import type { ExchangeProduct, PrismaClient } from '@prisma/client';
import { CURRENCY } from '../../config/constants.js';
import { conflict, notFound, validationError } from '../../lib/errors.js';
import { toNumber } from '../../lib/money.js';
import type { AuditService } from '../../services/audit.service.js';
import { calculateDiscountPercent } from '../../services/discount.service.js';
import {
  EXCHANGE_INTERVAL_MINUTES,
  EXCHANGE_PRODUCTS,
  EXCHANGE_TIMEZONE,
} from '../exchange/exchange.catalog.js';
import type { ExchangeService } from '../exchange/exchange.service.js';

export interface BartenderActor {
  requestId?: string | null;
  ipAddress?: string | null;
}

export interface BartenderProductDto {
  id: string;
  slug: string;
  name: string;
  category: string;
  volumeMl: number | null;
  currency: string;
  originalPrice: number;
  currentPrice: number;
  priceLevelPercent: number;
  minPrice: number;
  maxPrice: number;
  priceStep: number;
  currentDiscountPercent: number;
  salesQuantity: number;
  manualPriceAppliedAt: string | null;
  updatedAt: string;
}

/**
 * Рабочая логика панели бармена: просмотр canonical price и продажи текущего раунда.
 * Каталог берётся только из exchange_products, iiko здесь не участвует.
 */
export class BartenderService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly exchange: ExchangeService,
    private readonly audit: AuditService,
  ) {}

  async listProducts(): Promise<{
    generatedAt: string;
    currency: string;
    roundId: string | null;
    products: BartenderProductDto[];
  }> {
    const round = await this.exchange.ensureCurrentRound();
    const [products, sales] = await Promise.all([
      this.prisma.exchangeProduct.findMany({
        where: { isActive: true },
        orderBy: [{ category: 'asc' }, { name: 'asc' }],
      }),
      round
        ? this.prisma.exchangeSale.findMany({ where: { roundId: round.id } })
        : Promise.resolve([]),
    ]);
    const salesByProduct = new Map(
      sales.map((sale) => [sale.exchangeProductId ?? '', sale.quantity]),
    );
    return {
      generatedAt: new Date().toISOString(),
      currency: CURRENCY,
      roundId: round?.id ?? null,
      products: products.map((product) =>
        toProductDto(product, salesByProduct.get(product.id) ?? 0),
      ),
    };
  }

  async incrementSales(productId: string, quantity: number, actor: BartenderActor = {}) {
    return this.changeSales(productId, quantity, 1, actor);
  }

  async decrementSales(productId: string, quantity: number, actor: BartenderActor = {}) {
    return this.changeSales(productId, quantity, -1, actor);
  }

  async setSalesQuantity(productId: string, quantity: number, actor: BartenderActor = {}) {
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 9999) {
      throw validationError('quantity должен быть целым числом от 0 до 9999');
    }
    const round = await this.exchange.getActiveRound();
    if (!round) throw notFound('Активный раунд не найден', 'ROUND_NOT_FOUND');

    const result = await this.prisma.$transaction(async (tx) => {
      const currentRound = await tx.priceRound.findUnique({ where: { id: round.id } });
      if (!currentRound) throw notFound('Раунд не найден', 'ROUND_NOT_FOUND');
      if (currentRound.status !== 'PUBLISHED' || currentRound.endsAt <= new Date()) {
        throw conflict('Закрытый раунд нельзя изменять');
      }
      const product = await tx.exchangeProduct.findFirst({
        where: { id: productId, isActive: true },
      });
      if (!product) throw validationError('Товар не является активной биржевой позицией');

      const discount = calculateDiscountPercent(
        product.originalPrice.toString(),
        product.currentPrice.toString(),
      );
      const snapshot = {
        priceAtSale: product.currentPrice,
        priceLevelPercentAtSale: product.priceLevelPercent,
        discountPercentAtSale: discount.toFixed(4),
        selectedDiscountPercentAtSale: product.currentDiscountPercent,
        actualDiscountPercentAtSale: discount.toFixed(4),
      };
      const sale = await tx.exchangeSale.upsert({
        where: {
          roundId_exchangeProductId: { roundId: round.id, exchangeProductId: product.id },
        },
        update: { quantity, ...snapshot },
        create: {
          roundId: round.id,
          exchangeProductId: product.id,
          quantity,
          source: 'MANUAL_PANEL',
          ...snapshot,
        },
      });
      return { sale, product };
    });

    await this.audit.log({
      action: 'BARTENDER_SALE_RECORDED',
      actorType: 'ADMIN',
      actorId: 'bartender',
      entityType: 'ExchangeSale',
      entityId: result.sale.id,
      requestId: actor.requestId ?? null,
      ipAddress: actor.ipAddress ?? null,
      summary: `Бармен установил ${quantity} продаж(и) «${result.product.name}»`,
      metadata: { roundId: round.id, salesQuantity: quantity, absolute: true },
    });

    return {
      productId,
      roundId: round.id,
      quantity: result.sale.quantity,
      roundEndsAt: round.endsAt.toISOString(),
    };
  }

  /**
   * Продажи пишутся только в активный текущий раунд и НЕ меняют цену сразу:
   * спрос влияет на цену следующего раунда.
   */
  private async changeSales(
    productId: string,
    quantity: number,
    direction: 1 | -1,
    actor: BartenderActor,
  ): Promise<{ productId: string; roundId: string; salesQuantity: number; quantity?: number; priceAtSale?: number; discountPercentAtSale?: number; roundEndsAt?: string }> {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw validationError('quantity должен быть положительным целым числом');
    }
    const round = await this.exchange.getActiveRound();
    if (!round) throw notFound('Активный раунд не найден', 'ROUND_NOT_FOUND');

    const result = await this.prisma.$transaction(async (tx) => {
      const currentRound = await tx.priceRound.findUnique({ where: { id: round.id } });
      if (!currentRound) throw notFound('Раунд не найден', 'ROUND_NOT_FOUND');
      if (currentRound.status !== 'PUBLISHED' || currentRound.endsAt <= new Date()) {
        throw conflict('Закрытый раунд нельзя изменять');
      }
      const product = await tx.exchangeProduct.findFirst({
        where: { id: productId, isActive: true },
      });
      if (!product) throw validationError('Товар не является активной биржевой позицией');

      const existing = await tx.exchangeSale.findUnique({
        where: {
          roundId_exchangeProductId: { roundId: round.id, exchangeProductId: product.id },
        },
      });
      const nextQuantity = Math.max(0, (existing?.quantity ?? 0) + direction * quantity);
      const discount = calculateDiscountPercent(
        product.originalPrice.toString(),
        product.currentPrice.toString(),
      );
      const snapshot = {
        priceAtSale: product.currentPrice,
        priceLevelPercentAtSale: product.priceLevelPercent,
        discountPercentAtSale: discount.toFixed(4),
        selectedDiscountPercentAtSale: product.currentDiscountPercent,
        actualDiscountPercentAtSale: discount.toFixed(4),
      };
      const sale = existing
        ? await tx.exchangeSale.update({
            where: { id: existing.id },
            data: { quantity: nextQuantity, ...snapshot },
          })
        : await tx.exchangeSale.create({
            data: {
              roundId: round.id,
              exchangeProductId: product.id,
              quantity: nextQuantity,
              source: 'MANUAL_PANEL',
              ...snapshot,
            },
          });
      return { sale, product };
    });

    await this.audit.log({
      action: 'BARTENDER_SALE_RECORDED',
      actorType: 'ADMIN',
      actorId: 'bartender',
      entityType: 'ExchangeSale',
      entityId: result.sale.id,
      requestId: actor.requestId ?? null,
      ipAddress: actor.ipAddress ?? null,
      summary: `Бармен ${direction > 0 ? 'добавил' : 'убрал'} ${quantity} продаж(и) «${result.product.name}»`,
      metadata: { roundId: round.id, salesQuantity: result.sale.quantity },
    });

    return {
      productId,
      roundId: round.id,
      salesQuantity: result.sale.quantity,
      quantity: result.sale.quantity,
      priceAtSale: toNumber(result.sale.priceAtSale.toString()),
      discountPercentAtSale: toNumber((result.sale.discountPercentAtSale ?? result.sale.actualDiscountPercentAtSale ?? result.sale.selectedDiscountPercentAtSale ?? 0).toString()),
      roundEndsAt: round.endsAt.toISOString(),
    };
  }

  async status() {
    const round = await this.exchange.ensureCurrentRound();
    const [paused, activeProducts, salesAggregate, lastApplied] = await Promise.all([
      this.exchange.isPaused(),
      this.prisma.exchangeProduct.count({ where: { isActive: true } }),
      round
        ? this.prisma.exchangeSale.aggregate({
            where: { roundId: round.id },
            _sum: { quantity: true },
          })
        : Promise.resolve(null),
      this.prisma.exchangeProduct.findFirst({
        where: { manualPriceAppliedAt: { not: null } },
        orderBy: { manualPriceAppliedAt: 'desc' },
        select: { manualPriceAppliedAt: true },
      }),
    ]);

    const now = Date.now();
    const endsAt = round?.endsAt ?? null;
    return {
      generatedAt: new Date().toISOString(),
      timezone: EXCHANGE_TIMEZONE,
      intervalMinutes: EXCHANGE_INTERVAL_MINUTES,
      running: !paused,
      paused,
      activeProducts,
      expectedProducts: EXCHANGE_PRODUCTS.length,
      currentRound: round
        ? {
            id: round.id,
            roundKey: round.roundKey,
            startsAt: round.startsAt.toISOString(),
            endsAt: round.endsAt.toISOString(),
            status: round.status,
          }
        : null,
      nextRoundStartsAt: endsAt ? endsAt.toISOString() : null,
      secondsRemaining: endsAt ? Math.max(0, Math.floor((endsAt.getTime() - now) / 1000)) : null,
      currentRoundSales: salesAggregate?._sum.quantity ?? 0,
      lastPriceAppliedAt: lastApplied?.manualPriceAppliedAt?.toISOString() ?? null,
    };
  }

  private async currentSalesQuantity(roundId: string, productId: string): Promise<number> {
    const sale = await this.prisma.exchangeSale.findUnique({
      where: { roundId_exchangeProductId: { roundId, exchangeProductId: productId } },
    });
    return sale?.quantity ?? 0;
  }

  private async getActiveProduct(productId: string): Promise<ExchangeProduct> {
    const product = await this.prisma.exchangeProduct.findFirst({
      where: { id: productId, isActive: true },
    });
    if (!product) throw notFound('Активная биржевая позиция не найдена');
    return product;
  }
}

function toProductDto(product: ExchangeProduct, salesQuantity: number): BartenderProductDto {
  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    category: product.category,
    volumeMl: product.volumeMl,
    currency: product.currency,
    originalPrice: toNumber(product.originalPrice.toString()),
    currentPrice: toNumber(product.currentPrice.toString()),
    priceLevelPercent: product.priceLevelPercent,
    minPrice: toNumber(product.minPrice.toString()),
    maxPrice: toNumber(product.maxPrice.toString()),
    priceStep: toNumber(product.priceStep.toString()),
    currentDiscountPercent: Number(product.currentDiscountPercent.toString()),
    salesQuantity,
    manualPriceAppliedAt: product.manualPriceAppliedAt?.toISOString() ?? null,
    updatedAt: product.updatedAt.toISOString(),
  };
}

