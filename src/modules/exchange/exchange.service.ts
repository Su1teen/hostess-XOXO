import type { PrismaClient } from '@prisma/client';
import { Decimal } from 'decimal.js';
import {
  EXCHANGE_INTERVAL_MINUTES,
  EXCHANGE_PRODUCTS,
  EXCHANGE_TIMEZONE,
} from './exchange.catalog.js';
import { roundToStep } from '../../lib/money.js';
import { getCurrentRound } from '../../lib/time.js';
import { calculateDiscountPercent } from '../../services/discount.service.js';

const PAUSED_SETTING = 'exchange.paused';
const ROUND_INCLUDE = { prices: { include: { exchangeProduct: true } } } as const;

export class ExchangeService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Идемпотентная инициализация каталога биржи (без iiko).
   * Повторный запуск не создаёт дубликаты и НЕ сбрасывает текущую цену:
   * применённая барменом цена остаётся канонической после рестарта.
   */
  async seedProducts() {
    for (const product of EXCHANGE_PRODUCTS) {
      const maxPrice = roundToStep(new Decimal(product.originalPrice).mul(1.5), 50);
      const initialDiscount = calculateDiscountPercent(product.originalPrice, product.minPrice);
      await this.prisma.exchangeProduct.upsert({
        where: { slug: product.slug },
        update: {
          name: product.name,
          category: product.category,
          volumeMl: product.volumeMl,
          currency: 'KZT',
          originalPrice: product.originalPrice,
          startPrice: product.minPrice,
          minPrice: product.minPrice,
          maxPrice: maxPrice.toFixed(2),
          priceStep: 50,
          isActive: true,
        },
        create: {
          slug: product.slug,
          name: product.name,
          category: product.category,
          volumeMl: product.volumeMl,
          currency: 'KZT',
          originalPrice: product.originalPrice,
          startPrice: product.minPrice,
          currentPrice: product.minPrice,
          currentDiscountPercent: initialDiscount.toFixed(4),
          actualDiscountPercent: initialDiscount.toFixed(4),
          minPrice: product.minPrice,
          maxPrice: maxPrice.toFixed(2),
          priceStep: 50,
          isActive: true,
        },
      });
    }
    return this.prisma.exchangeProduct.count();
  }

  async ensureInitialRound() {
    const existing = await this.prisma.priceRound.findFirst({
      where: { roundKey: 'exchange-initial' },
      include: ROUND_INCLUDE,
    });
    if (existing) return { created: false, round: existing };

    const products = await this.prisma.exchangeProduct.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
    });
    if (products.length === 0) return null;
    const organization = await this.prisma.organization.findFirst({ where: { isSelected: true } });
    if (!organization) return null;
    const now = new Date();
    const window = getCurrentRound(now, EXCHANGE_TIMEZONE, EXCHANGE_INTERVAL_MINUTES);
    try {
      const round = await this.prisma.priceRound.create({
        data: {
          organizationId: organization.id,
          roundKey: 'exchange-initial',
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          timezone: EXCHANGE_TIMEZONE,
          status: 'PUBLISHED',
          algorithmVersion: 'initial-exchange-v1',
          triggerSource: 'SEED',
          publishedAt: now,
          prices: {
            create: products.map((product) => ({
              exchangeProductId: product.id,
              // Биржа стартует с минимальной цены; originalPrice — цена меню.
              price: product.currentPrice,
              previousPrice: null,
              calculatedPrice: product.currentPrice,
              publishedPrice: product.currentPrice,
              originalPrice: product.originalPrice,
              actualDiscountPercent: calculateDiscountPercent(
                product.originalPrice.toString(),
                product.currentPrice.toString(),
              ).toFixed(4),
              minPrice: product.minPrice,
              maxPrice: product.maxPrice,
              priceStep: product.priceStep,
              changePercent: 0,
              calculationInput: { initial: true },
              calculationResult: { initial: true },
              status: 'PUBLISHED',
            })),
          },
        },
        include: ROUND_INCLUDE,
      });
      return { created: true, round };
    } catch (error) {
      if (isUniqueViolation(error)) {
        return {
          created: false,
          round: await this.prisma.priceRound.findUnique({
            where: { roundKey: 'exchange-initial' },
            include: ROUND_INCLUDE,
          }),
        };
      }
      throw error;
    }
  }

  /**
   * Гарантирует опубликованный раунд, покрывающий текущее 15-минутное окно.
   *
   * Дубликаты невозможны: окно однозначно определяет roundKey, который уникален
   * в БД, а конкурентная вставка перехватывается как unique violation.
   */
  async ensureCurrentRound(now: Date = new Date()) {
    const active = await this.prisma.priceRound.findFirst({
      where: {
        status: 'PUBLISHED',
        startsAt: { lte: now },
        endsAt: { gt: now },
        prices: { some: { exchangeProductId: { not: null } } },
      },
      orderBy: { startsAt: 'desc' },
    });
    if (active) return active;

    const window = getCurrentRound(now, EXCHANGE_TIMEZONE, EXCHANGE_INTERVAL_MINUTES);
    const existing = await this.prisma.priceRound.findUnique({
      where: { roundKey: window.roundKey },
      include: ROUND_INCLUDE,
    });
    if (existing) {
      if (existing.status === 'PUBLISHED') return existing;
      return this.publishRoundPrices(existing.id);
    }

    const products = await this.prisma.exchangeProduct.findMany({ where: { isActive: true } });
    if (products.length === 0) return null;
    const organization = await this.prisma.organization.findFirst({ where: { isSelected: true } });
    if (!organization) return null;

    try {
      return await this.prisma.priceRound.create({
        data: {
          organizationId: organization.id,
          roundKey: window.roundKey,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
          timezone: EXCHANGE_TIMEZONE,
          status: 'PUBLISHED',
          algorithmVersion: 'exchange-window-v1',
          triggerSource: 'SYSTEM',
          publishedAt: now,
          prices: {
            create: products.map((product) => ({
              exchangeProductId: product.id,
              price: product.currentPrice,
              previousPrice: null,
              calculatedPrice: product.currentPrice,
              publishedPrice: product.currentPrice,
              originalPrice: product.originalPrice,
              actualDiscountPercent: product.currentDiscountPercent,
              minPrice: product.minPrice,
              maxPrice: product.maxPrice,
              priceStep: product.priceStep,
              changePercent: 0,
              calculationInput: { carriedOver: true },
              calculationResult: { carriedOver: true },
              status: 'PUBLISHED',
            })),
          },
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return this.prisma.priceRound.findUnique({ where: { roundKey: window.roundKey } });
      }
      throw error;
    }
  }

  /**
   * Возвращает текущий опубликованный раунд без инициализации или перехода.
   * Продажа не должна создавать раунд или пересчитывать цены.
   */
  async getActiveRound(now: Date = new Date()) {
    return this.prisma.priceRound.findFirst({
      where: {
        status: 'PUBLISHED',
        startsAt: { lte: now },
        endsAt: { gt: now },
        prices: { some: { exchangeProductId: { not: null } } },
      },
      orderBy: { startsAt: 'desc' },
      include: ROUND_INCLUDE,
    });
  }

  /** Публикует рассчитанные цены раунда и делает их каноническими. */
  private async publishRoundPrices(roundId: string) {
    return this.prisma.$transaction(async (tx) => {
      const round = await tx.priceRound.findUniqueOrThrow({
        where: { id: roundId },
        include: ROUND_INCLUDE,
      });
      for (const price of round.prices) {
        if (!price.exchangeProductId || !price.exchangeProduct) continue;
        const discount = calculateDiscountPercent(
          price.exchangeProduct.originalPrice.toString(),
          price.calculatedPrice.toString(),
        );
        await tx.roundPrice.update({
          where: { id: price.id },
          data: {
            publishedPrice: price.calculatedPrice,
            actualDiscountPercent: discount.toFixed(4),
            status: 'PUBLISHED',
          },
        });
        await tx.exchangeProduct.update({
          where: { id: price.exchangeProductId },
          data: {
            currentPrice: price.calculatedPrice,
            currentDiscountPercent: discount.toFixed(4),
            actualDiscountPercent: discount.toFixed(4),
          },
        });
      }
      return tx.priceRound.update({
        where: { id: round.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
    });
  }

  async isPaused(): Promise<boolean> {
    const setting = await this.prisma.appSetting.findUnique({ where: { key: PAUSED_SETTING } });
    return setting?.value === true;
  }

  async setPaused(paused: boolean): Promise<boolean> {
    await this.prisma.appSetting.upsert({
      where: { key: PAUSED_SETTING },
      update: { value: paused },
      create: { key: PAUSED_SETTING, value: paused, isSecret: false },
    });
    return paused;
  }

  async status() {
    const [total, active, currentRound, nextRound, paused] = await Promise.all([
      this.prisma.exchangeProduct.count(),
      this.prisma.exchangeProduct.count({ where: { isActive: true } }),
      this.prisma.priceRound.findFirst({
        where: { status: 'PUBLISHED', prices: { some: { exchangeProductId: { not: null } } } },
        orderBy: { startsAt: 'desc' },
        include: ROUND_INCLUDE,
      }),
      this.prisma.priceRound.findFirst({
        where: {
          status: { in: ['SIMULATED', 'PUBLISHED'] },
          prices: { some: { exchangeProductId: { not: null } } },
        },
        orderBy: { startsAt: 'asc' },
      }),
      this.isPaused(),
    ]);
    return {
      total,
      active,
      initialization: {
        expectedProducts: EXCHANGE_PRODUCTS.length,
        complete: total === EXCHANGE_PRODUCTS.length,
      },
      currentRound,
      nextRound,
      paused,
      scheduler: {
        intervalMinutes: EXCHANGE_INTERVAL_MINUTES,
        timezone: EXCHANGE_TIMEZONE,
        running: !paused,
      },
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'P2002'
  );
}
