import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { API_PREFIX } from '../config/constants.js';

/** helmet, CORS по whitelist и rate limiting (строже для admin/webhook/plugin). */
export const securityPlugin = fp(async (app: FastifyInstance) => {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // /admin и Swagger UI используют инлайновые скрипты/стили и не тянут внешние CDN.
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });

  const allowedOrigins = app.env.CORS_ORIGINS;
  await app.register(cors, {
    origin: (origin, callback) => {
      // Запросы без Origin (curl, серверные интеграции, плагин кассы) не блокируем.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      app.env.ADMIN_API_KEY_HEADER,
      'x-plugin-secret',
      'x-request-id',
    ],
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    allowList: [],
    hook: 'onRequest',
    errorResponseBuilder: (request, context) => ({
      error: {
        code: 'RATE_LIMITED',
        message: `Слишком много запросов, повторите через ${context.after}`,
        requestId: request.id,
      },
    }),
  });

  // Строгий лимит для чувствительных префиксов.
  app.addHook('onRoute', (routeOptions) => {
    const url = routeOptions.url;
    const strict =
      url.startsWith(`${API_PREFIX}/admin`) ||
      url.startsWith(`${API_PREFIX}/webhooks`) ||
      url.startsWith(`${API_PREFIX}/front-plugin`);
    if (!strict) return;

    const config = (routeOptions.config ?? {}) as Record<string, unknown>;
    if (config.rateLimit) return;
    routeOptions.config = {
      ...config,
      rateLimit: { max: 30, timeWindow: '1 minute' },
    };
  });
});
