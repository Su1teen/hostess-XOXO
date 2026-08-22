import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_PREFIX } from '../../config/constants.js';
import { MANUAL_DISCOUNT_OPTIONS } from '../../services/discount.service.js';
import { BARTENDER_TOKEN_HEADER } from './bartender.session.js';

const productParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const discountBody = {
  type: 'object',
  required: ['selectedDiscountPercent'],
  additionalProperties: false,
  properties: {
    selectedDiscountPercent: { type: 'integer', minimum: 0, maximum: 100 },
  },
} as const;

const quantityBody = {
  type: 'object',
  additionalProperties: false,
  properties: { quantity: { type: 'integer', minimum: 1, default: 1 } },
} as const;

function tokenOf(request: FastifyRequest): string | undefined {
  const raw = request.headers[BARTENDER_TOKEN_HEADER];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * API панели бармена. Вход по PIN выдаёт короткоживущий токен; PIN больше
 * не передаётся и никогда не попадает в URL или логи.
 */
export async function bartenderRoutes(app: FastifyInstance): Promise<void> {
  const requireSession = async (request: FastifyRequest) => {
    app.services.bartenderSessions.requireSession(tokenOf(request));
  };

  const session = {
    preHandler: requireSession,
    schema: { tags: ['Bartender'] as string[] },
  };

  app.post<{ Body: { pin: string } }>(
    `${API_PREFIX}/bartender/auth`,
    {
      schema: {
        tags: ['Bartender'],
        summary: 'Вход в панель бармена по PIN',
        body: {
          type: 'object',
          required: ['pin'],
          additionalProperties: false,
          properties: { pin: { type: 'string', minLength: 1, maxLength: 32 } },
        },
      },
    },
    async (request) => {
      const created = app.services.bartenderSessions.login(
        request.body.pin,
        request.ip ?? 'unknown',
      );
      await app.services.audit.log({
        action: 'BARTENDER_LOGIN',
        actorType: 'ADMIN',
        actorId: 'bartender',
        requestId: request.id,
        ipAddress: request.ip ?? null,
        summary: 'Успешный вход в панель бармена',
      });
      return {
        token: created.token,
        expiresAt: created.expiresAt.toISOString(),
        discountOptions: MANUAL_DISCOUNT_OPTIONS,
      };
    },
  );

  app.post(
    `${API_PREFIX}/bartender/logout`,
    { schema: { tags: ['Bartender'] } },
    async (request) => {
      const removed = app.services.bartenderSessions.logout(tokenOf(request));
      return { loggedOut: removed };
    },
  );

  app.get(`${API_PREFIX}/bartender/exchange/products`, session, async () =>
    app.services.bartender.listProducts(),
  );

  app.get(`${API_PREFIX}/bartender/exchange/status`, session, async () =>
    app.services.bartender.status(),
  );

  app.post<{ Params: { id: string }; Body: { selectedDiscountPercent: number } }>(
    `${API_PREFIX}/bartender/exchange/products/:id/price-preview`,
    {
      preHandler: requireSession,
      schema: {
        tags: ['Bartender'],
        summary: 'Рассчитать цену со скидкой (без записи в БД)',
        params: productParams,
        body: discountBody,
      },
    },
    async (request) =>
      app.services.bartender.preview(request.params.id, request.body.selectedDiscountPercent),
  );

  app.post<{ Params: { id: string }; Body: { selectedDiscountPercent: number } }>(
    `${API_PREFIX}/bartender/exchange/products/:id/apply-price`,
    {
      preHandler: requireSession,
      schema: {
        tags: ['Bartender'],
        summary: 'Применить скидку: цена пересчитывается на сервере',
        params: productParams,
        body: discountBody,
      },
    },
    async (request) => {
      const result = await app.services.bartender.applyPrice(
        request.params.id,
        request.body.selectedDiscountPercent,
        { requestId: request.id, ipAddress: request.ip ?? null },
      );
      return { appliedAt: new Date().toISOString(), ...result };
    },
  );

  app.post<{ Params: { id: string }; Body: { quantity?: number } }>(
    `${API_PREFIX}/bartender/exchange/products/:id/sales/increment`,
    {
      preHandler: requireSession,
      schema: {
        tags: ['Bartender'],
        summary: 'Добавить продажи в текущий раунд',
        params: productParams,
        body: quantityBody,
      },
    },
    async (request) =>
      app.services.bartender.incrementSales(request.params.id, request.body?.quantity ?? 1, {
        requestId: request.id,
        ipAddress: request.ip ?? null,
      }),
  );

  app.post<{ Params: { id: string }; Body: { quantity?: number } }>(
    `${API_PREFIX}/bartender/exchange/products/:id/sales/decrement`,
    {
      preHandler: requireSession,
      schema: {
        tags: ['Bartender'],
        summary: 'Убрать продажи из текущего раунда',
        params: productParams,
        body: quantityBody,
      },
    },
    async (request) =>
      app.services.bartender.decrementSales(request.params.id, request.body?.quantity ?? 1, {
        requestId: request.id,
        ipAddress: request.ip ?? null,
      }),
  );
}
