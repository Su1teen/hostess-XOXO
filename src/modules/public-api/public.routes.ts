import type { ExchangeProduct } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { API_PREFIX } from '../../config/constants.js';
import { calculateDiscountPercent } from '../../services/discount.service.js';
import { toNumber } from '../../lib/money.js';
import { getNextRound } from '../../lib/time.js';
import { getCanonicalPriceLevelPercent } from '../../services/price-engine.service.js';
import type { RoundWithPrices } from '../rounds/rounds.service.js';

const publicProductSchema = {
  type: 'object',
  required: [
    'id',
    'name',
    'category',
    'price',
    'currency',
    'originalPrice',
    'minPrice',
    'priceLevelPercent',
    'discountPercent',
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
    minPrice: { type: 'number' },
    priceLevelPercent: { type: 'integer', minimum: -30, maximum: 70, multipleOf: 10 },
    discountPercent: { type: 'integer' },
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
  // Read-only snapshot for guest BFF and quotes. Scheduler owns round advancement.
  app.get(`${API_PREFIX}/public/snapshot`, publicOptions, async () => buildPayload());
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
      return {
        generatedAt: new Date().toISOString(),
        timezone: app.env.APP_TIMEZONE,
        products: round ? mapProducts(round) : mapCatalog(products),
      };
    },
  );
}

/** Published round amounts remain stable when mutable catalog settings change. */
function mapProducts(round: RoundWithPrices) {
  return round.prices
    .filter((item) => item.exchangeProduct?.isActive && item.exchangeProductId)
    .map((item) => ({
      ...mapCatalogProduct(item.exchangeProduct!),
      price: toNumber((item.publishedPrice ?? item.price).toString()),
      originalPrice: toNumber((item.originalPrice ?? item.exchangeProduct!.originalPrice).toString()),
      minPrice: toNumber(item.minPrice.toString()),
      priceLevelPercent: getCanonicalPriceLevelPercent({ originalPrice: item.originalPrice ?? item.exchangeProduct!.originalPrice, currentPrice: item.publishedPrice ?? item.price }),
      discountPercent: Math.round(calculateDiscountPercent(item.originalPrice ?? item.exchangeProduct!.originalPrice, item.publishedPrice ?? item.price).toNumber()),
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
    minPrice: toNumber(product.minPrice.toString()),
    // Отдаём уровень, вычисленный от той же фактической цены, что показываем.
    // Это защищает TV от старого/несогласованного значения в БД.
    priceLevelPercent: getCanonicalPriceLevelPercent({
      originalPrice: product.originalPrice,
      currentPrice: product.currentPrice,
    }),
    discountPercent: Math.round(Number(product.currentDiscountPercent.toString())),
    isAvailable: product.isActive,
  };
}
