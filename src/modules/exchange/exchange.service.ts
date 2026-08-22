import type { PrismaClient } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { EXCHANGE_INTERVAL_MINUTES, EXCHANGE_PRODUCTS, EXCHANGE_TIMEZONE } from './exchange.catalog.js';
import { getCurrentRound } from '../../lib/time.js';

const PAUSED_SETTING = 'exchange.paused';
const ROUND_INCLUDE = { prices: { include: { exchangeProduct: true } } } as const;

export class ExchangeService {
  constructor(private readonly prisma: PrismaClient) {}

  async seedProducts() {
    for (const product of EXCHANGE_PRODUCTS) {
      const maxPrice = new Decimal(product.startPrice).mul(1.5).div(50).round().mul(50);
      await this.prisma.exchangeProduct.upsert({
        where: { slug: product.slug },
        update: {
          name: product.name,
          category: product.category,
          volumeMl: product.volumeMl,
          currency: 'KZT',
          startPrice: product.startPrice,
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
          startPrice: product.startPrice,
          currentPrice: product.startPrice,
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

    const products = await this.prisma.exchangeProduct.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
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
              price: product.startPrice,
              previousPrice: null,
              calculatedPrice: product.startPrice,
              publishedPrice: product.startPrice,
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
        return { created: false, round: await this.prisma.priceRound.findUnique({ where: { roundKey: 'exchange-initial' }, include: ROUND_INCLUDE }) };
      }
      throw error;
    }
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
      this.prisma.priceRound.findFirst({ where: { status: 'PUBLISHED', prices: { some: { exchangeProductId: { not: null } } } }, orderBy: { startsAt: 'desc' }, include: ROUND_INCLUDE }),
      this.prisma.priceRound.findFirst({ where: { status: { in: ['SIMULATED', 'PUBLISHED'] }, prices: { some: { exchangeProductId: { not: null } } } }, orderBy: { startsAt: 'asc' } }),
      this.isPaused(),
    ]);
    return {
      total,
      active,
      initialization: { expectedProducts: EXCHANGE_PRODUCTS.length, complete: total === EXCHANGE_PRODUCTS.length },
      currentRound,
      nextRound,
      paused,
      scheduler: { intervalMinutes: EXCHANGE_INTERVAL_MINUTES, timezone: EXCHANGE_TIMEZONE, running: !paused },
    };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'P2002';
}
