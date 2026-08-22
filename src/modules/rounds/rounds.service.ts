import type { Prisma, PriceRound, PrismaClient, RoundStatus } from '@prisma/client';
import { PRICE_ALGORITHM_VERSION, TRIGGER_SOURCE } from '../../config/constants.js';
import type { AppEnv } from '../../config/env.js';
import {
  conflict,
  invalidRoundTransition,
  noExchangeProducts,
  organizationNotSelected,
  roundNotFound,
} from '../../lib/errors.js';
import { toMoney } from '../../lib/money.js';
import { getCurrentRound, getNextRound, getRoundForInstant, getRoundKey } from '../../lib/time.js';
import type { AuditService } from '../../services/audit.service.js';
import { calculateDiscountPercent } from '../../services/discount.service.js';
import {
  calculateExchangeDemandScore,
  calculateNextPrice,
} from '../../services/price-engine.service.js';

export interface DemandOverride {
  productId: string;
  demandScore?: number;
  salesQuantity?: number;
}

export interface SimulateRoundOptions {
  startsAt?: string | Date;
  demandOverrides?: DemandOverride[];
  note?: string;
  triggerSource?: (typeof TRIGGER_SOURCE)[keyof typeof TRIGGER_SOURCE];
  createdBy?: string;
  requestId?: string;
  /** true — использовать текущее окно вместо следующего (ручные тесты). */
  useCurrentWindow?: boolean;
}

export interface SimulateRoundResult {
  created: boolean;
  round: RoundWithPrices;
}

export type RoundWithPrices = Prisma.PriceRoundGetPayload<{
  include: { prices: { include: { product: true; exchangeProduct: true } } };
}>;

const ALLOWED_TRANSITIONS: Record<RoundStatus, RoundStatus[]> = {
  DRAFT: ['SIMULATED', 'CANCELLED'],
  SIMULATED: ['READY_FOR_REVIEW', 'APPROVED', 'CANCELLED'],
  READY_FOR_REVIEW: ['APPROVED', 'CANCELLED'],
  APPROVED: ['PUBLISHED', 'APPLYING_TO_IIKO', 'CANCELLED'],
  APPLYING_TO_IIKO: ['APPLIED_TO_IIKO', 'FAILED'],
  APPLIED_TO_IIKO: ['PUBLISHED', 'FAILED'],
  PUBLISHED: ['ROLLED_BACK'],
  FAILED: ['CANCELLED', 'SIMULATED'],
  ROLLED_BACK: [],
  CANCELLED: [],
};

export function canTransition(from: RoundStatus, to: RoundStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

const ROUND_INCLUDE = { prices: { include: { product: true, exchangeProduct: true } } } as const;

/** Бизнес-логика ценовых раундов. Никогда не вызывает write-операции iiko. */
export class RoundsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: AppEnv,
    private readonly audit: AuditService,
  ) {}

  private get interval(): number {
    return this.env.PRICE_ROUND_INTERVAL_MINUTES;
  }

  async getSelectedOrganization() {
    const organization = await this.prisma.organization.findFirst({ where: { isSelected: true } });
    if (!organization) throw organizationNotSelected();
    return organization;
  }

  /**
   * Создаёт SIMULATED раунд. Идемпотентно по roundKey: повторный вызов для того же
   * окна возвращает существующий раунд и не создаёт дубликат.
   */
  async simulateRound(options: SimulateRoundOptions = {}): Promise<SimulateRoundResult> {
    const organization = await this.getSelectedOrganization();
    const timezone = this.env.APP_TIMEZONE;

    const window = options.startsAt
      ? getRoundForInstant(options.startsAt, timezone, this.interval)
      : options.useCurrentWindow
        ? getCurrentRound(new Date(), timezone, this.interval)
        : getNextRound(new Date(), timezone, this.interval);

    const existing = await this.prisma.priceRound.findUnique({
      where: { roundKey: window.roundKey },
      include: ROUND_INCLUDE,
    });
    if (existing) {
      return { created: false, round: existing };
    }

    const products = await this.prisma.exchangeProduct.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
    if (products.length === 0) throw noExchangeProducts();

    const currentRound = await this.prisma.priceRound.findFirst({
      where: { status: 'PUBLISHED', startsAt: { lte: new Date() }, endsAt: { gt: new Date() } },
      orderBy: { startsAt: 'desc' },
    });
    const sales = currentRound
      ? await this.prisma.exchangeSale.findMany({ where: { roundId: currentRound.id } })
      : [];
    const salesByProduct = new Map(sales.map((sale) => [sale.exchangeProductId, sale.quantity]));
    const totalSales = products.reduce(
      (sum, product) => sum + (salesByProduct.get(product.id) ?? 0),
      0,
    );
    const averageSales = totalSales / products.length;
    const overrides = new Map(
      (options.demandOverrides ?? []).map((override) => [override.productId, override]),
    );

    const priceRows = products.map((product) => {
      const override = overrides.get(product.id);
      const salesQuantity = override?.salesQuantity ?? salesByProduct.get(product.id) ?? 0;
      const demandScore = calculateExchangeDemandScore(salesQuantity, averageSales);
      const calculation = calculateNextPrice({
        productId: product.id,
        productName: product.name,
        currentPrice: product.currentPrice,
        basePrice: product.startPrice,
        minPrice: product.minPrice,
        maxPrice: product.maxPrice,
        priceStep: product.priceStep,
        maxChangePercent: 10,
        demandScore: override?.demandScore ?? demandScore,
        salesQuantity,
        k: 0.1,
      });

      return {
        exchangeProductId: product.id,
        originalPrice: product.originalPrice.toString(),
        selectedDiscountPercent: null,
        actualDiscountPercent: calculateDiscountPercent(
          product.originalPrice.toString(),
          calculation.calculatedPrice,
        ).toString(),
        price: calculation.calculatedPrice.toString(),
        soldQuantity: calculation.salesQuantity.toString(),
        previousPrice: calculation.previousPrice.toString(),
        calculatedPrice: calculation.calculatedPrice.toString(),
        minPrice: calculation.minPrice.toString(),
        maxPrice: calculation.maxPrice.toString(),
        priceStep: calculation.priceStep.toString(),
        salesQuantity: calculation.salesQuantity.toString(),
        demandScore: calculation.demandScore.toString(),
        changePercent: calculation.changePercent.toString(),
        calculationInput: calculation.input as unknown as Prisma.InputJsonValue,
        calculationResult: calculation.result as unknown as Prisma.InputJsonValue,
        status: 'SIMULATED' as RoundStatus,
      };
    });

    try {
      const round = await this.prisma.$transaction(async (tx) => {
        const created = await tx.priceRound.create({
          data: {
            organizationId: organization.id,
            roundKey: window.roundKey,
            startsAt: window.startsAt,
            endsAt: window.endsAt,
            timezone,
            status: 'SIMULATED',
            algorithmVersion: PRICE_ALGORITHM_VERSION,
            triggerSource: options.triggerSource ?? TRIGGER_SOURCE.MANUAL,
            note: options.note ?? null,
            createdBy: options.createdBy ?? null,
            prices: { create: priceRows },
          },
          include: ROUND_INCLUDE,
        });
        return created;
      });

      await this.audit.log({
        action: 'ROUND_SIMULATED',
        actorType: options.triggerSource === TRIGGER_SOURCE.CRON ? 'CRON' : 'ADMIN',
        actorId: options.createdBy ?? null,
        organizationId: organization.id,
        entityType: 'PriceRound',
        entityId: round.id,
        requestId: options.requestId ?? null,
        summary: `Создан симулированный раунд ${round.roundKey} (${round.prices.length} товаров)`,
        metadata: { roundKey: round.roundKey, productsCount: round.prices.length },
      });

      return { created: true, round };
    } catch (error) {
      // Гонка двух cron-процессов: уникальный roundKey защищает от дубликата.
      if (isUniqueViolation(error)) {
        const round = await this.prisma.priceRound.findUnique({
          where: { roundKey: window.roundKey },
          include: ROUND_INCLUDE,
        });
        if (round) return { created: false, round };
      }
      throw error;
    }
  }

  async listRounds(params: { limit?: number; status?: RoundStatus } = {}) {
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100);
    return this.prisma.priceRound.findMany({
      where: params.status ? { status: params.status } : undefined,
      orderBy: { startsAt: 'desc' },
      take: limit,
      include: { _count: { select: { prices: true } } },
    });
  }

  async getRound(roundId: string): Promise<RoundWithPrices> {
    const round = await this.prisma.priceRound.findUnique({
      where: { id: roundId },
      include: ROUND_INCLUDE,
    });
    if (!round) throw roundNotFound();
    return round;
  }

  async approveRound(roundId: string, actorId?: string, requestId?: string): Promise<PriceRound> {
    const round = await this.getRound(roundId);
    if (!canTransition(round.status, 'APPROVED')) {
      throw invalidRoundTransition(round.status, 'APPROVED');
    }
    const updated = await this.prisma.priceRound.update({
      where: { id: round.id },
      data: { status: 'APPROVED', approvedAt: new Date() },
    });
    await this.audit.log({
      action: 'ROUND_APPROVED',
      actorType: 'ADMIN',
      actorId: actorId ?? null,
      organizationId: round.organizationId,
      entityType: 'PriceRound',
      entityId: round.id,
      requestId: requestId ?? null,
      summary: `Раунд ${round.roundKey} утверждён`,
    });
    return updated;
  }

  /**
   * v0.1: публикация фиксирует publishedPrice в БД и делает раунд текущим для
   * public API. Никаких обращений к iiko write API не происходит.
   */
  async publishRound(
    roundId: string,
    actorId?: string,
    requestId?: string,
  ): Promise<RoundWithPrices> {
    const round = await this.getRound(roundId);
    if (!canTransition(round.status, 'PUBLISHED')) {
      throw invalidRoundTransition(round.status, 'PUBLISHED');
    }
    if (round.prices.length === 0) throw noExchangeProducts();

    const published = await this.prisma.$transaction(async (tx) => {
      for (const price of round.prices) {
        await tx.roundPrice.update({
          where: { id: price.id },
          data: { publishedPrice: price.calculatedPrice, status: 'PUBLISHED' },
        });
        if (price.exchangeProductId) {
          await tx.exchangeProduct.update({
            where: { id: price.exchangeProductId },
            data: { currentPrice: price.calculatedPrice },
          });
        } else if (price.productId) {
          await tx.product.update({
            where: { id: price.productId },
            data: {
              currentExchangePrice: price.calculatedPrice,
              currentPrice: price.calculatedPrice,
            },
          });
        }
      }
      return tx.priceRound.update({
        where: { id: round.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
        include: ROUND_INCLUDE,
      });
    });

    await this.audit.log({
      action: 'ROUND_PUBLISHED',
      actorType: 'ADMIN',
      actorId: actorId ?? null,
      organizationId: round.organizationId,
      entityType: 'PriceRound',
      entityId: round.id,
      requestId: requestId ?? null,
      summary: `Раунд ${round.roundKey} опубликован (без изменения цен в iiko)`,
      metadata: { productsCount: round.prices.length },
    });

    return published;
  }

  /**
   * Откат: текущий PUBLISHED раунд помечается ROLLED_BACK, актуальным снова
   * становится предыдущий опубликованный раунд (его цены возвращаются в товары).
   */
  async rollbackRound(roundId: string, actorId?: string, requestId?: string) {
    const round = await this.getRound(roundId);
    if (!canTransition(round.status, 'ROLLED_BACK')) {
      throw invalidRoundTransition(round.status, 'ROLLED_BACK');
    }

    const previous = await this.prisma.priceRound.findFirst({
      where: {
        organizationId: round.organizationId,
        status: 'PUBLISHED',
        id: { not: round.id },
        publishedAt: { not: null, lt: round.publishedAt ?? new Date() },
      },
      orderBy: { publishedAt: 'desc' },
      include: ROUND_INCLUDE,
    });

    const result = await this.prisma.$transaction(async (tx) => {
      const rolledBack = await tx.priceRound.update({
        where: { id: round.id },
        data: { status: 'ROLLED_BACK' },
      });
      if (previous) {
        for (const price of previous.prices) {
          if (price.exchangeProductId) {
            await tx.exchangeProduct.update({
              where: { id: price.exchangeProductId },
              data: { currentPrice: price.publishedPrice ?? price.calculatedPrice },
            });
          }
        }
      }
      return rolledBack;
    });

    await this.audit.log({
      action: 'ROUND_ROLLED_BACK',
      actorType: 'ADMIN',
      actorId: actorId ?? null,
      organizationId: round.organizationId,
      entityType: 'PriceRound',
      entityId: round.id,
      requestId: requestId ?? null,
      summary: previous
        ? `Раунд ${round.roundKey} откатан, актуальным стал ${previous.roundKey}`
        : `Раунд ${round.roundKey} откатан, предыдущего опубликованного раунда нет`,
      metadata: { previousRoundKey: previous?.roundKey ?? null },
    });

    return { round: result, restoredRoundKey: previous?.roundKey ?? null };
  }

  /** Только активный опубликованный раунд, покрывающий момент `at`. */
  async getCurrentPublishedRound(at: Date = new Date()): Promise<RoundWithPrices | null> {
    const active = await this.prisma.priceRound.findFirst({
      where: {
        status: 'PUBLISHED',
        startsAt: { lte: at },
        endsAt: { gt: at },
        prices: { some: { exchangeProductId: { not: null } } },
      },
      orderBy: { startsAt: 'desc' },
      include: ROUND_INCLUDE,
    });
    return active;
  }

  async getLatestSimulatedRound(): Promise<PriceRound | null> {
    return this.prisma.priceRound.findFirst({
      where: { status: { in: ['SIMULATED', 'READY_FOR_REVIEW', 'APPROVED'] } },
      orderBy: { startsAt: 'desc' },
    });
  }

  /** Ключ следующего раунда — используется диагностикой и cron-ом. */
  nextRoundKey(now: Date = new Date()): string {
    return getRoundKey(
      getNextRound(now, this.env.APP_TIMEZONE, this.interval).startsAt,
      this.env.APP_TIMEZONE,
      this.interval,
    );
  }

  async ensureExchangeProductsExist(): Promise<number> {
    const count = await this.prisma.exchangeProduct.count({ where: { isActive: true } });
    if (count === 0) throw noExchangeProducts();
    return count;
  }

  /** Данные для ManualPricePublisher / manual-export. */
  async buildManualExport(roundId: string) {
    const round = await this.getRound(roundId);
    if (round.prices.length === 0) throw conflict('В раунде нет позиций');
    return {
      roundId: round.id,
      roundKey: round.roundKey,
      startsAt: round.startsAt.toISOString(),
      endsAt: round.endsAt.toISOString(),
      status: round.status,
      timezone: round.timezone,
      items: round.prices.map((price) => ({
        productName: price.exchangeProduct?.name ?? price.product?.name ?? 'Unknown',
        iikoProductId: price.product?.iikoProductId ?? null,
        currentPrice: toMoney(
          (price.previousPrice ?? price.exchangeProduct?.currentPrice ?? 0).toString(),
        ).toNumber(),
        nextPrice: toMoney((price.publishedPrice ?? price.calculatedPrice).toString()).toNumber(),
        startTime: round.startsAt.toISOString(),
        roundId: round.id,
      })),
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
