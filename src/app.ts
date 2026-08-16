import fastify, { type FastifyInstance } from 'fastify';
import { getEnv, type AppEnv } from './config/env.js';
import { AppError, internalError } from './lib/errors.js';
import { sanitizeMessage } from './lib/redaction.js';
import { adminPageRoutes } from './modules/admin/admin-page.routes.js';
import { diagnosticsRoutes } from './modules/admin/diagnostics.routes.js';
import { frontPluginRoutes } from './modules/front-plugin/front-plugin.routes.js';
import { healthRoutes } from './modules/health/health.routes.js';
import { iikoRoutes } from './modules/iiko/iiko.routes.js';
import { productsRoutes } from './modules/products/products.routes.js';
import { publicRoutes } from './modules/public-api/public.routes.js';
import { roundsRoutes } from './modules/rounds/rounds.routes.js';
import { telegramRoutes } from './modules/telegram/telegram.routes.js';
import { webhookRoutes } from './modules/webhooks/webhooks.routes.js';
import { authPlugin } from './plugins/auth.js';
import { buildLoggerOptions } from './plugins/logger.js';
import { prismaPlugin } from './plugins/prisma.js';
import { securityPlugin } from './plugins/security.js';
import { swaggerPlugin } from './plugins/swagger.js';

const MAX_BODY_BYTES = 512 * 1024;

export async function buildApp(env: AppEnv = getEnv()): Promise<FastifyInstance> {
  const app = fastify({
    logger: buildLoggerOptions(env),
    bodyLimit: MAX_BODY_BYTES,
    trustProxy: true,
    disableRequestLogging: false,
    genReqId: (request) => {
      const header = request.headers['x-request-id'];
      const value = Array.isArray(header) ? header[0] : header;
      return value && value.length <= 200 ? value : crypto.randomUUID();
    },
  });

  app.decorate('env', env);

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  await app.register(securityPlugin);
  await app.register(authPlugin);
  await app.register(prismaPlugin);
  await app.register(swaggerPlugin);

  await app.register(healthRoutes);
  await app.register(publicRoutes);
  await app.register(diagnosticsRoutes);
  await app.register(iikoRoutes);
  await app.register(productsRoutes);
  await app.register(roundsRoutes);
  await app.register(telegramRoutes);
  await app.register(webhookRoutes);
  await app.register(frontPluginRoutes);
  await app.register(adminPageRoutes);

  app.setNotFoundHandler(async (request, reply) =>
    reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден', requestId: request.id } }),
  );

  // Единый безопасный обработчик ошибок: наружу уходит только код и текст,
  // stack trace и внутренние детали остаются в логах.
  app.setErrorHandler(async (error, request, reply) => {
    if (error instanceof AppError) {
      request.log.warn(
        { requestId: request.id, code: error.code, details: error.details },
        sanitizeMessage(error.message),
      );
      return reply.code(error.statusCode).send(error.toBody(request.id));
    }

    const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 500;

    if (error.validation) {
      return reply.code(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Некорректные параметры запроса',
          requestId: request.id,
        },
      });
    }

    if (statusCode < 500) {
      return reply.code(statusCode).send({
        error: {
          code:
            statusCode === 401
              ? 'UNAUTHORIZED'
              : statusCode === 403
                ? 'FORBIDDEN'
                : 'VALIDATION_ERROR',
          message: sanitizeMessage(error.message),
          requestId: request.id,
        },
      });
    }

    request.log.error(
      { requestId: request.id, stack: error.stack },
      sanitizeMessage(error.message),
    );
    return reply.code(500).send(internalError().toBody(request.id));
  });

  return app;
}
