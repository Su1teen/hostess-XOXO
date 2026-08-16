import type { Product } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { API_PREFIX, CURRENCY } from '../../config/constants.js';
import { shortId } from '../../lib/redaction.js';

interface ProductQuery {
  search?: string;
  group?: string;
  activeOnly?: boolean;
  exchangeOnly?: boolean;
  limit?: number;
  offset?: number;
}

interface ProductPatchBody {
  basePrice?: number;
  minPrice?: number | null;
  maxPrice?: number | null;
  priceStep?: number;
  maxChangePercent?: number;
  isActive?: boolean;
  currentExchangePrice?: number | null;
}

export async function productsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: ProductQuery }>(
    `${API_PREFIX}/admin/products`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Products'],
        summary: 'Поиск товаров (русский и английский текст)',
        security: [{ adminApiKey: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            search: { type: 'string' },
            group: { type: 'string' },
            activeOnly: { type: 'boolean', default: false },
            exchangeOnly: { type: 'boolean', default: false },
            limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
            offset: { type: 'integer', minimum: 0, default: 0 },
          },
        },
      },
    },
    async (request) => {
      const result = await app.services.products.search(request.query);
      return {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        items: result.items.map(serializeProduct),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    `${API_PREFIX}/admin/products/:id`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Products'],
        summary: 'Карточка товара',
        security: [{ adminApiKey: [] }],
        params: idParamSchema,
      },
    },
    async (request) => serializeProduct(await app.services.products.getById(request.params.id)),
  );

  app.patch<{ Params: { id: string }; Body: ProductPatchBody }>(
    `${API_PREFIX}/admin/products/:id`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Products'],
        summary: 'Изменить биржевые настройки товара',
        security: [{ adminApiKey: [] }],
        params: idParamSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            basePrice: { type: 'number', minimum: 0 },
            minPrice: { type: ['number', 'null'], minimum: 0 },
            maxPrice: { type: ['number', 'null'], minimum: 0 },
            priceStep: { type: 'number', exclusiveMinimum: 0 },
            maxChangePercent: { type: 'number', minimum: 0, maximum: 100 },
            isActive: { type: 'boolean' },
            currentExchangePrice: { type: ['number', 'null'], minimum: 0 },
          },
        },
      },
    },
    async (request) =>
      serializeProduct(
        await app.services.products.update(request.params.id, request.body, 'admin', request.id),
      ),
  );

  app.post<{ Params: { id: string } }>(
    `${API_PREFIX}/admin/products/:id/select-for-exchange`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Products'],
        summary: 'Добавить товар на биржу',
        security: [{ adminApiKey: [] }],
        params: idParamSchema,
      },
    },
    async (request) =>
      serializeProduct(
        await app.services.products.setExchangeSelection(
          request.params.id,
          true,
          'admin',
          request.id,
        ),
      ),
  );

  app.post<{ Params: { id: string } }>(
    `${API_PREFIX}/admin/products/:id/remove-from-exchange`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Products'],
        summary: 'Убрать товар с биржи',
        security: [{ adminApiKey: [] }],
        params: idParamSchema,
      },
    },
    async (request) =>
      serializeProduct(
        await app.services.products.setExchangeSelection(
          request.params.id,
          false,
          'admin',
          request.id,
        ),
      ),
  );
}

const idParamSchema = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

function serializeProduct(product: Product) {
  const groupPath =
    product.metadata && typeof product.metadata === 'object' && !Array.isArray(product.metadata)
      ? (product.metadata as Record<string, unknown>).iikoGroupPath
      : null;

  return {
    id: product.id,
    name: product.name,
    iikoProductId: product.iikoProductId,
    iikoProductIdShort: shortId(product.iikoProductId),
    group: typeof groupPath === 'string' ? groupPath : null,
    unit: product.unit,
    currency: CURRENCY,
    basePrice: Number(product.basePrice.toString()),
    currentKnownIikoPrice:
      product.currentKnownIikoPrice === null
        ? null
        : Number(product.currentKnownIikoPrice.toString()),
    currentExchangePrice:
      product.currentExchangePrice === null
        ? null
        : Number(product.currentExchangePrice.toString()),
    minPrice: product.minPrice === null ? null : Number(product.minPrice.toString()),
    maxPrice: product.maxPrice === null ? null : Number(product.maxPrice.toString()),
    priceStep: Number(product.priceStep.toString()),
    maxChangePercent: Number(product.maxChangePercent.toString()),
    isExchangeProduct: product.isExchangeProduct,
    isActive: product.isActive,
    status: product.status,
    syncedAt: product.syncedAt?.toISOString() ?? null,
  };
}
