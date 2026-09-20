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
import { changePercent, toMoney } from '../../lib/money.js';
import { getCurrentRound, getNextRound, getRoundForInstant, getRoundKey } from '../../lib/time.js';
import type { AuditService } from '../../services/audit.service.js';
import { calculateDiscountPercent } from '../../services/discount.service.js';
import {
  calculateExchangeDemandScore,
  calculatePriceFromLevel,
  calculatePriceLevelDelta,
  clampPriceLevel,
} from '../../services/price-engine.service.js';

/** Минимальный логгер перехода раундов: только структурированные события без секретов. */
export interface RoundsLogger {
  info(payload: Record<string, unknown>, message?: string): void;
  error(payload: Record<string, unknown>, message?: string): void;
}

/** Наблюдаемое состояние последнего перехода — для админ-диагностики. */
export interface RoundTransitionState {
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastClosedRoundKey: string | null;
  lastCreatedRoundKey: string | null;
  lastProductsChanged: number | null;
  lastClosedRoundSalesTotal: number | null;
}

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
  CLOSED: [],
};

export function canTransition(from: RoundStatus, to: RoundStatus): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

const ROUND_INCLUDE = { prices: { include: { product: true, exchangeProduct: true } } } as const;

/** Бизнес-логика ценовых раундов. Никогда не вызывает write-операции iiko. */
export class RoundsService {
  private transitionState: RoundTransitionState = {
    lastStartedAt: null,
    lastCompletedAt: null,
    lastError: null,
    lastErrorAt: null,
    lastClosedRoundKey: null,
    lastCreatedRoundKey: null,
    lastProductsChanged: null,
    lastClosedRoundSalesTotal: null,
  };

  constructor(
    private readonly prisma: PrismaClient,
    private readonly env: AppEnv,
    private readonly audit: AuditService,
    private readonly logger?: RoundsLogger,
  ) {}

  getTransitionState(): RoundTransitionState {
    return { ...this.transitionState };
  }

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
      const levelDelta = calculatePriceLevelDelta(salesQuantity);
      const currentLevel = product.priceLevelPercent;
      const nextLevel = clampPriceLevel(currentLevel + levelDelta);
      const nextPrice =
        levelDelta === 0
          ? product.currentPrice
          : calculatePriceFromLevel({
              originalPrice: product.originalPrice,
              minPrice: product.minPrice,
              maxPrice: product.maxPrice,
              priceStep: product.priceStep,
              priceLevelPercent: nextLevel,
            });
      const discount = calculateDiscountPercent(product.originalPrice.toString(), nextPrice);
      const roundChange = changePercent(product.currentPrice, nextPrice);

      return {
        exchangeProductId: product.id,
        originalPrice: product.originalPrice.toString(),
        priceLevelPercent: nextLevel,
        discountPercent: discount.toString(),
        actualDiscountPercent: discount.toString(),
        price: nextPrice.toString(),
        soldQuantity: String(salesQuantity),
        previousPrice: product.currentPrice.toString(),
        calculatedPrice: nextPrice.toString(),
        minPrice: product.minPrice.toString(),
        maxPrice: product.maxPrice.toString(),
        priceStep: product.priceStep.toString(),
        salesQuantity: String(salesQuantity),
        demandScore: (override?.demandScore ?? demandScore).toString(),
        changePercent: roundChange.toString(),
        calculationInput: {
          algorithm: 'discrete-price-levels-v1',
          currentLevel,
          levelDelta,
          salesQuantity,
          averageSales,
        } as Prisma.InputJsonValue,
        calculationResult: {
          nextLevel,
          nextPrice: nextPrice.toString(),
          minPriceHardFloor: true,
        } as Prisma.InputJsonValue,
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

  /**
   * Закрывает завершившиеся раунды и публикует раунд текущего окна с ценами,
   * пересчитанными по фактическим продажам закрытого раунда.
   *
   * Свойства:
   * - идемпотентность: как только завершившийся раунд получил статус CLOSED,
   *   повторный вызов ничего не пересчитывает и возвращает текущий раунд;
   * - раунд текущего окна, уже созданный чтением (carry-over), не блокирует
   *   переход: его позиции пересчитываются на месте;
   * - всё выполняется в одной транзакции под advisory lock, поэтому два
   *   процесса (web + cron) не создают дубликаты и не применяют уровень дважды.
   */
  async transitionRound(now = new Date()): Promise<RoundWithPrices | null> {
    const organization = await this.getSelectedOrganization();
    const nextWindow = getCurrentRound(now, this.env.APP_TIMEZONE, this.interval);
    const startedAt = new Date();
    this.transitionState = {
      ...this.transitionState,
      lastStartedAt: startedAt.toISOString(),
    };

    try {
      const result = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('exchange-round-transition'))`;
        const endedRounds = await tx.priceRound.findMany({
          where: { organizationId: organization.id, status: 'PUBLISHED', endsAt: { lte: now } },
          orderBy: { endsAt: 'desc' },
          include: ROUND_INCLUDE,
        });
        const closedRound = endedRounds[0] ?? null;
        const existing = await tx.priceRound.findUnique({
          where: { roundKey: nextWindow.roundKey },
          include: ROUND_INCLUDE,
        });
        // Нечего закрывать — переход уже выполнен (идемпотентность).
        if (!closedRound) return { round: existing, closedRound: null, rows: [], salesTotal: 0 };

        this.logger?.info({
          event: 'round_transition_started',
          activeRoundId: closedRound.id,
          roundKey: closedRound.roundKey,
          endsAt: closedRound.endsAt.toISOString(),
          serverNow: now.toISOString(),
          timezone: this.env.APP_TIMEZONE,
        });

        const products = await tx.exchangeProduct.findMany({
          where: { isActive: true },
          orderBy: { name: 'asc' },
        });
        // Спрос закрытого раунда: именно SUM(quantity), а не COUNT(rows).
        const grouped = await tx.exchangeSale.groupBy({
          by: ['exchangeProductId'],
          where: { roundId: closedRound.id, exchangeProductId: { not: null } },
          _sum: { quantity: true },
        });
        const quantities = new Map<string, number>();
        for (const row of grouped) {
          if (row.exchangeProductId) quantities.set(row.exchangeProductId, row._sum.quantity ?? 0);
        }
        const salesTotal = products.reduce(
          (sum, product) => sum + (quantities.get(product.id) ?? 0),
          0,
        );
        const average = salesTotal / Math.max(products.length, 1);

        const rows = products.map((product) => {
          const quantity = quantities.get(product.id) ?? 0;
          const demandScore = calculateExchangeDemandScore(quantity, average);
          const levelDelta = calculatePriceLevelDelta(quantity);
          const currentLevel = product.priceLevelPercent;
          const nextLevel = clampPriceLevel(currentLevel + levelDelta);
          const nextPrice =
            nextLevel === currentLevel
              ? toMoney(product.currentPrice.toString())
              : calculatePriceFromLevel({
                  originalPrice: product.originalPrice,
                  minPrice: product.minPrice,
                  maxPrice: product.maxPrice,
                  priceStep: product.priceStep,
                  priceLevelPercent: nextLevel,
                });
          const discount = calculateDiscountPercent(product.originalPrice.toString(), nextPrice);
          this.logger?.info({
            event: 'round_product_calculated',
            productId: product.id,
            productName: product.name,
            closedRoundQuantity: quantity,
            previousLevel: currentLevel,
            nextLevel,
            previousPrice: product.currentPrice.toString(),
            nextPrice: nextPrice.toString(),
          });
          return { product, quantity, nextPrice, discount, demandScore, nextLevel, levelDelta };
        });

        const priceRows = rows.map(
          ({ product, quantity, nextPrice, discount, demandScore, nextLevel, levelDelta }) => ({
            exchangeProductId: product.id,
            price: nextPrice.toString(),
            previousPrice: product.currentPrice.toString(),
            calculatedPrice: nextPrice.toString(),
            publishedPrice: nextPrice.toString(),
            minPrice: product.minPrice.toString(),
            maxPrice: product.maxPrice.toString(),
            priceStep: product.priceStep.toString(),
            originalPrice: product.originalPrice.toString(),
            priceLevelPercent: nextLevel,
            discountPercent: discount.toString(),
            selectedDiscountPercent: discount.toString(),
            actualDiscountPercent: discount.toString(),
            soldQuantity: String(quantity),
            salesQuantity: String(quantity),
            demandScore: demandScore.toString(),
            changePercent: changePercent(product.currentPrice, nextPrice).toString(),
            calculationInput: {
              algorithm: 'discrete-price-levels-v1',
              closedRoundId: closedRound.id,
              closedRoundKey: closedRound.roundKey,
              closedRoundQuantity: quantity,
              currentLevel: product.priceLevelPercent,
              levelDelta,
              salesQuantity: quantity,
              averageSales: average,
            } as Prisma.InputJsonValue,
            calculationResult: {
              nextLevel,
              nextPrice: nextPrice.toString(),
              minPriceHardFloor: true,
            } as Prisma.InputJsonValue,
            status: 'PUBLISHED' as RoundStatus,
          }),
        );

        for (const ended of endedRounds) {
          await tx.priceRound.update({ where: { id: ended.id }, data: { status: 'CLOSED' } });
        }

        let round: RoundWithPrices;
        if (existing) {
          // Раунд текущего окна уже создан чтением или симуляцией: заменяем его
          // позиции пересчитанными и публикуем — carry-over не должен «съедать» переход.
          await tx.roundPrice.deleteMany({ where: { roundId: existing.id } });
          round = await tx.priceRound.update({
            where: { id: existing.id },
            data: {
              status: 'PUBLISHED',
              publishedAt: now,
              startsAt: nextWindow.startsAt,
              endsAt: nextWindow.endsAt,
              timezone: this.env.APP_TIMEZONE,
              algorithmVersion: PRICE_ALGORITHM_VERSION,
              prices: { create: priceRows },
            },
            include: ROUND_INCLUDE,
          });
        } else {
          round = await tx.priceRound.create({
            data: {
              organizationId: organization.id,
              roundKey: nextWindow.roundKey,
              startsAt: nextWindow.startsAt,
              endsAt: nextWindow.endsAt,
              timezone: this.env.APP_TIMEZONE,
              status: 'PUBLISHED',
              algorithmVersion: PRICE_ALGORITHM_VERSION,
              triggerSource: 'CRON',
              publishedAt: now,
              prices: { create: priceRows },
            },
            include: ROUND_INCLUDE,
          });
        }

        for (const row of rows) {
          await tx.exchangeProduct.update({
            where: { id: row.product.id },
            data: {
              currentPrice: row.nextPrice.toString(),
              priceLevelPercent: row.nextLevel,
              currentDiscountPercent: row.discount.toString(),
              actualDiscountPercent: row.discount.toString(),
            },
          });
        }

        return { round, closedRound, rows, salesTotal };
      });

      if (result.closedRound && result.round) {
        const productsChanged = result.rows.filter(
          (row) => row.nextLevel !== row.product.priceLevelPercent,
        ).length;
        this.transitionState = {
          lastStartedAt: startedAt.toISOString(),
          lastCompletedAt: new Date().toISOString(),
          lastError: null,
          lastErrorAt: this.transitionState.lastErrorAt,
          lastClosedRoundKey: result.closedRound.roundKey,
          lastCreatedRoundKey: result.round.roundKey,
          lastProductsChanged: productsChanged,
          lastClosedRoundSalesTotal: result.salesTotal,
        };
        this.logger?.info({
          event: 'round_transition_completed',
          closedRoundId: result.closedRound.id,
          newRoundId: result.round.id,
          newRoundKey: result.round.roundKey,
          closedRoundSalesTotal: result.salesTotal,
          productsChanged,
        });
        await this.audit.log({
          action: 'ROUND_PUBLISHED',
          actorType: 'CRON',
          organizationId: organization.id,
          entityType: 'PriceRound',
          entityId: result.round.id,
          summary: `Переход раунда: ${result.closedRound.roundKey} → ${result.round.roundKey}`,
          metadata: {
            closedRoundKey: result.closedRound.roundKey,
            newRoundKey: result.round.roundKey,
            closedRoundSalesTotal: result.salesTotal,
            productsChanged,
          },
        });
      }

      return result.round;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.transitionState = {
        ...this.transitionState,
        lastError: message.slice(0, 500),
        lastErrorAt: new Date().toISOString(),
      };
      this.logger?.error({
        event: 'round_transition_failed',
        message,
        stack: error instanceof Error ? error.stack : undefined,
      });
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
