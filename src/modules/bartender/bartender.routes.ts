import type { FastifyInstance, FastifyRequest } from 'fastify';
import { API_PREFIX } from '../../config/constants.js';
import { BARTENDER_TOKEN_HEADER } from './bartender.session.js';

const productParams = {
  type: 'object',
  required: ['id'],
  additionalProperties: false,
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

const saleQuantityBody = {
  type: 'object',
  required: ['quantity'],
  additionalProperties: false,
  properties: { quantity: { type: 'integer', minimum: 1 } },
} as const;

const absoluteQuantityBody = {
  type: 'object',
  required: ['quantity'],
  additionalProperties: false,
  properties: { quantity: { type: 'integer', minimum: 0, maximum: 9999 } },
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
      };
    },
  );

  app.post(
    `${API_PREFIX}/bartender/logout`,
    { preHandler: requireSession, schema: { tags: ['Bartender'] } },
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

  app.post<{ Params: { id: string }; Body: { quantity: number } }>(
    `${API_PREFIX}/bartender/exchange/products/:id/sales/increment`,
    {
      preHandler: requireSession,
      schema: {
        tags: ['Bartender'],
        summary: 'Добавить продажи в текущий раунд',
        params: productParams,
        body: saleQuantityBody,
      },
    },
    async (request) =>
      app.services.bartender.incrementSales(request.params.id, request.body.quantity, {
        requestId: request.id,
        ipAddress: request.ip ?? null,
      }),
  );

  app.put<{ Params: { id: string }; Body: { quantity: number } }>(
    `${API_PREFIX}/bartender/exchange/products/:id/sales/quantity`,
    {
      preHandler: requireSession,
      schema: {
        tags: ['Bartender'],
        summary: 'Установить итоговое количество продаж в текущем раунде',
        params: productParams,
        body: absoluteQuantityBody,
      },
    },
    async (request) =>
      app.services.bartender.setSalesQuantity(request.params.id, request.body.quantity, {
        requestId: request.id,
        ipAddress: request.ip ?? null,
      }),
  );

  app.post<{ Params: { id: string }; Body: { quantity: number } }>(
    `${API_PREFIX}/bartender/exchange/products/:id/sales/decrement`,
    {
      preHandler: requireSession,
      schema: {
        tags: ['Bartender'],
        summary: 'Убрать продажи из текущего раунда',
        params: productParams,
        body: saleQuantityBody,
      },
    },
    async (request) =>
      app.services.bartender.decrementSales(request.params.id, request.body.quantity, {
        requestId: request.id,
        ipAddress: request.ip ?? null,
      }),
  );
}
