import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { SWAGGER_TAGS } from '../config/constants.js';

export const swaggerPlugin = fp(async (app: FastifyInstance) => {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'Bar Exchange Backend API',
        version: '0.1.0',
        description: [
          'API динамических цен бара («алкогольная биржа»).',
          '',
          '**v0.1 не выполняет write-операций в iiko:** заказы не создаются, цены в iiko не меняются,',
          'прайс-приказы не создаются. Публикация раунда фиксирует цену только в этом backend-е',
          'и в public API для экрана гостей.',
          '',
          'Endpoints, помеченные как experimental, предназначены для будущих версий',
          '(webhook приёма событий iiko и контракт для iikoFront plugin).',
        ].join('\n'),
      },
      tags: SWAGGER_TAGS.map((tag) => ({ name: tag.name, description: tag.description })),
      components: {
        securitySchemes: {
          adminApiKey: {
            type: 'apiKey',
            in: 'header',
            name: app.env.ADMIN_API_KEY_HEADER,
            description: 'Ключ администратора. Значение задаётся переменной ADMIN_API_KEY.',
          },
          pluginSecret: {
            type: 'apiKey',
            in: 'header',
            name: 'x-plugin-secret',
            description: 'Shared secret будущего iikoFront plugin (FRONT_PLUGIN_SHARED_SECRET).',
          },
        },
      },
    },
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
    staticCSP: true,
  });
});
