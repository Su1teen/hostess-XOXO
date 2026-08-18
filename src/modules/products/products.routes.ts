import type { Product } from '@prisma/client';
import type { FastifyInstance } from 'fastify';
import { API_PREFIX, CURRENCY } from '../../config/constants.js';
import { shortId } from '../../lib/redaction.js';

interface ProductQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  category?: string;
  drinkCandidatesOnly?: boolean;
  sellableOnly?: boolean;
  exchangeOnly?: boolean;
  activeOnly?: boolean;
  availableOnly?: boolean;
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
        summary: 'Постраничный список товаров (макс 100 на страницу)',
        security: [{ adminApiKey: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            search: { type: 'string' },
            category: { type: 'string' },
            drinkCandidatesOnly: { type: 'boolean', default: true },
            sellableOnly: { type: 'boolean', default: true },
            exchangeOnly: { type: 'boolean', default: false },
            activeOnly: { type: 'boolean', default: true },
            availableOnly: { type: 'boolean', default: true },
          },
        },
      },
    },
    async (request) => {
      const result = await app.services.products.list(request.query);
      return {
        data: result.items.map(serializeProduct),
        pagination: {
          page: result.page,
          pageSize: result.pageSize,
          total: result.total,
          totalPages: result.totalPages,
        },
        filters: {
          search: request.query.search ?? null,
          category: request.query.category ?? null,
          drinkCandidatesOnly: request.query.drinkCandidatesOnly ?? true,
          sellableOnly: request.query.sellableOnly ?? true,
          exchangeOnly: request.query.exchangeOnly ?? false,
          activeOnly: request.query.activeOnly ?? true,
          availableOnly: request.query.availableOnly ?? true,
        },
      };
    },
  );

  app.get<{
    Querystring: {
      drinkCandidatesOnly?: boolean;
      sellableOnly?: boolean;
      availableOnly?: boolean;
    };
  }>(
    `${API_PREFIX}/admin/products/categories`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Products'],
        summary: 'Категории с количеством sellable+available вариантов',
        security: [{ adminApiKey: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            drinkCandidatesOnly: { type: 'boolean', default: true },
            sellableOnly: { type: 'boolean', default: true },
            availableOnly: { type: 'boolean', default: true },
          },
        },
      },
    },
    async (request) => {
      const items = await app.services.products.listCategories({
        drinkCandidatesOnly: request.query.drinkCandidatesOnly,
        sellableOnly: request.query.sellableOnly,
        availableOnly: request.query.availableOnly,
      });
      return { items };
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
        summary: 'Добавить товар на биржу (требует min/max/step и basePrice)',
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
  return {
    id: product.id,
    name: product.name,
    displayName: product.displayName,
    sizeName: product.sizeName,
    sizeCode: product.sizeCode,
    iikoItemId: product.iikoItemId,
    iikoItemIdShort: shortId(product.iikoItemId),
    iikoSizeId: product.iikoSizeId,
    iikoSizeIdShort: product.iikoSizeId ? shortId(product.iikoSizeId) : null,
    iikoProductId: product.iikoProductId,
    iikoProductIdShort: shortId(product.iikoProductId ?? product.iikoItemId),
    sku: product.sku,
    categoryName: product.categoryName,
    currency: product.currency ?? CURRENCY,
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
    isDrinkCandidate: product.isDrinkCandidate,
    isSellable: product.isSellable,
    isAvailable: product.isAvailable,
    isExchangeProduct: product.isExchangeProduct,
    isActive: product.isActive,
    status: product.status,
    syncedAt: product.syncedAt?.toISOString() ?? null,
  };
}
