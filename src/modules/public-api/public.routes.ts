import type { FastifyInstance } from 'fastify';
import { API_PREFIX, CURRENCY } from '../../config/constants.js';
import { toNumber } from '../../lib/money.js';
import type { RoundWithPrices } from '../rounds/rounds.service.js';

const publicProductSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    price: { type: 'number' },
    currency: { type: 'string' },
    previousPrice: { type: 'number' },
    changePercent: { type: 'number' },
    isAvailable: { type: 'boolean' },
  },
} as const;

const publicPayloadSchema = {
  type: 'object',
  properties: {
    generatedAt: { type: 'string' },
    timezone: { type: 'string' },
    status: { type: 'string', enum: ['ok', 'no_published_round'] },
    currentRound: {
      type: ['object', 'null'],
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

/**
 * Публичное API для Cloudflare frontend. Отдаёт только PUBLISHED-цены и
 * никаких технических ID iiko, токенов и внутренних заметок.
 */
export async function publicRoutes(app: FastifyInstance): Promise<void> {
  const buildPayload = async () => {
    const round = await app.services.rounds.getCurrentPublishedRound();
    const generatedAt = new Date().toISOString();

    if (!round) {
      return {
        generatedAt,
        timezone: app.env.APP_TIMEZONE,
        status: 'no_published_round' as const,
        currentRound: null,
        products: [],
      };
    }

    return {
      generatedAt,
      timezone: app.env.APP_TIMEZONE,
      status: 'ok' as const,
      currentRound: {
        id: round.id,
        roundKey: round.roundKey,
        startsAt: round.startsAt.toISOString(),
        endsAt: round.endsAt.toISOString(),
        status: round.status,
      },
      products: mapProducts(round),
    };
  };

  app.get(
    `${API_PREFIX}/public/current-round`,
    {
      config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
      schema: {
        tags: ['Public'],
        summary: 'Текущий опубликованный раунд и цены для экрана гостей',
        response: { 200: publicPayloadSchema },
      },
    },
    async () => buildPayload(),
  );

  app.get(
    `${API_PREFIX}/public/prices`,
    {
      config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
      schema: {
        tags: ['Public'],
        summary: 'Цены текущего опубликованного раунда',
        response: { 200: publicPayloadSchema },
      },
    },
    async () => buildPayload(),
  );

  app.get(
    `${API_PREFIX}/public/products`,
    {
      config: { rateLimit: { max: 240, timeWindow: '1 minute' } },
      schema: {
        tags: ['Public'],
        summary: 'Список биржевых товаров без цен незакрытых раундов',
        response: {
          200: {
            type: 'object',
            properties: {
              generatedAt: { type: 'string' },
              timezone: { type: 'string' },
              products: { type: 'array', items: publicProductSchema },
            },
          },
        },
      },
    },
    async () => {
      const round = await app.services.rounds.getCurrentPublishedRound();
      const products = await app.prisma.product.findMany({
        where: { isExchangeProduct: true, isActive: true },
        orderBy: { name: 'asc' },
      });
      const publishedById = new Map(
        (round?.prices ?? []).map((price) => [price.productId, price] as const),
      );

      return {
        generatedAt: new Date().toISOString(),
        timezone: app.env.APP_TIMEZONE,
        products: products.map((product) => {
          const price = publishedById.get(product.id);
          return {
            id: product.id,
            name: product.name,
            price: price ? toNumber((price.publishedPrice ?? price.calculatedPrice).toString()) : 0,
            currency: CURRENCY,
            previousPrice: price ? toNumber(price.previousPrice.toString()) : 0,
            changePercent: price ? Number(price.changePercent.toString()) : 0,
            isAvailable: Boolean(price) && product.status === 'ACTIVE',
          };
        }),
      };
    },
  );
}

function mapProducts(round: RoundWithPrices) {
  return round.prices
    .filter((price) => price.product.isExchangeProduct)
    .map((price) => ({
      id: price.product.id,
      name: price.product.name,
      price: toNumber((price.publishedPrice ?? price.calculatedPrice).toString()),
      currency: CURRENCY,
      previousPrice: toNumber(price.previousPrice.toString()),
      changePercent: Number(price.changePercent.toString()),
      isAvailable: price.product.isActive && price.product.status === 'ACTIVE',
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}
