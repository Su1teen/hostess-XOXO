import type { ExchangeProduct } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../../config/constants.js';
import { toNumber } from '../../lib/money.js';
import { getNextRound } from '../../lib/time.js';
import type { RoundWithPrices } from '../rounds/rounds.service.js';

const publicProductSchema = {
  type: 'object',
  required: [
    'id',
    'name',
    'category',
    'price',
    'currency',
    'previousPrice',
    'changePercent',
    'isAvailable',
  ],
  additionalProperties: false,
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    category: { type: 'string' },
    price: { type: 'number' },
    currency: { type: 'string' },
    originalPrice: { type: 'number' },
    currentDiscountPercent: { type: 'number' },
    previousPrice: { type: ['number', 'null'] },
    changePercent: { type: 'number' },
    isAvailable: { type: 'boolean' },
  },
} as const;

const publicPayloadSchema = {
  type: 'object',
  required: ['generatedAt', 'timezone', 'status', 'currentRound', 'products'],
  additionalProperties: false,
  properties: {
    generatedAt: { type: 'string' },
    timezone: { type: 'string' },
    status: { type: 'string', enum: ['ok', 'no_published_round'] },
    currentRound: {
      type: ['object', 'null'],
      additionalProperties: false,
      properties: {
        id: { type: 'string' },
        roundKey: { type: 'string' },
        startsAt: { type: 'string' },
        endsAt: { type: 'string' },
        status: { type: 'string' },
      },
    },
    products: { type: 'array', items: publicProductSchema },
  },
} as const;

export async function publicRoutes(app: FastifyInstance): Promise<void> {
  const activeProducts = () =>
    app.prisma.exchangeProduct.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });

  const buildPayload = async () => {
    const round = await app.services.rounds.getCurrentPublishedRound();
    return {
      generatedAt: new Date().toISOString(),
      timezone: app.env.APP_TIMEZONE,
      status: round ? ('ok' as const) : ('no_published_round' as const),
      currentRound: round
        ? {
            id: round.id,
            roundKey: round.roundKey,
            startsAt: round.startsAt.toISOString(),
            endsAt: round.endsAt.toISOString(),
            status: round.status,
          }
        : null,
      // Каноническая цена живёт в exchange_products, поэтому без раунда доска не пуста.
      products: round ? mapProducts(round) : mapCatalog(await activeProducts()),
    };
  };
  const publicOptions = {
    config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
    schema: { tags: ['Public'], response: { 200: publicPayloadSchema } },
  };
  app.get(`${API_PREFIX}/public/current-round`, publicOptions, async () => buildPayload());
  app.get(`${API_PREFIX}/public/rounds/current`, publicOptions, async () => buildPayload());
  app.get(`${API_PREFIX}/public/prices`, publicOptions, async () => buildPayload());

  app.get(
    `${API_PREFIX}/public/rounds/next`,
    { ...publicOptions, schema: { tags: ['Public'] } },
    async () => {
      const now = new Date();
      const next = getNextRound(now, app.env.APP_TIMEZONE, app.env.PRICE_ROUND_INTERVAL_MINUTES);
      return {
        roundKey: next.roundKey,
        startsAt: next.startsAt.toISOString(),
        endsAt: next.endsAt.toISOString(),
        countdownSeconds: Math.max(0, Math.ceil((next.startsAt.getTime() - now.getTime()) / 1000)),
        intervalMinutes: app.env.PRICE_ROUND_INTERVAL_MINUTES,
        timezone: app.env.APP_TIMEZONE,
      };
    },
  );

  app.get(
    `${API_PREFIX}/public/products`,
    { ...publicOptions, schema: { tags: ['Public'] } },
    async () => {
      const [products, round] = await Promise.all([
        app.prisma.exchangeProduct.findMany({
          where: { isActive: true },
          orderBy: { name: 'asc' },
        }),
        app.services.rounds.getCurrentPublishedRound(),
      ]);
      const prices = new Map(
        (round?.prices ?? [])
          .filter((item) => item.exchangeProductId)
          .map((item) => [item.exchangeProductId!, item]),
      );
      return {
        generatedAt: new Date().toISOString(),
        timezone: app.env.APP_TIMEZONE,
        products: products.map((product) => {
          const item = prices.get(product.id);
          return {
            ...mapCatalogProduct(product),
            previousPrice:
              item?.previousPrice === null || item?.previousPrice === undefined
                ? null
                : toNumber(item.previousPrice.toString()),
            changePercent: item ? Number(item.changePercent.toString()) : 0,
          };
        }),
      };
    },
  );
}

/**
 * Цена для гостевого табло берётся из exchange_products.currentPrice:
 * это то же значение, которое пишет панель бармена и расчёт раунда.
 * Доступность определяется только isActive биржевой позиции, а не iiko.
 */
function mapProducts(round: RoundWithPrices) {
  return round.prices
    .filter((item) => item.exchangeProduct?.isActive && item.exchangeProductId)
    .map((item) => ({
      ...mapCatalogProduct(item.exchangeProduct!),
      previousPrice: item.previousPrice === null ? null : toNumber(item.previousPrice.toString()),
      changePercent: Number(item.changePercent.toString()),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function mapCatalog(products: ExchangeProduct[]) {
  return products
    .map((product) => ({ ...mapCatalogProduct(product), previousPrice: null, changePercent: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function mapCatalogProduct(product: ExchangeProduct) {
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    price: toNumber(product.currentPrice.toString()),
    currency: product.currency,
    originalPrice: toNumber(product.originalPrice.toString()),
    currentDiscountPercent: Number(product.currentDiscountPercent.toString()),
    isAvailable: product.isActive,
  };
}
