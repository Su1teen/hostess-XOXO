import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { API_PREFIX, CURRENCY } from '../../config/constants.js';
import { forbidden, validationError } from '../../lib/errors.js';
import { toNumber } from '../../lib/money.js';

interface PriceQuoteBody {
  organizationId: string;
  terminalId: string;
  productId: string;
  requestedAt?: string;
}

type QuoteStatus = 'ok' | 'unavailable' | 'product_not_exchange' | 'no_active_round';

/**
 * Контракт для будущего iikoFront plugin (experimental).
 *
 * Backend только сообщает цену опубликованного раунда. Установку predefinedPrice
 * в чеке выполняет сам плагин на кассе — v0.1 backend в iiko ничего не пишет.
 */
export async function frontPluginRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: PriceQuoteBody }>(
    `${API_PREFIX}/front-plugin/price-quote`,
    {
      preHandler: app.requirePluginSecret,
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
      schema: {
        tags: ['Front Plugin'],
        summary: '[experimental] Цена товара для iikoFront plugin',
        description:
          'Отключено при FRONT_PLUGIN_ENABLED=false (503 PLUGIN_INTEGRATION_DISABLED). ' +
          'Цена берётся только из PUBLISHED раунда.',
        security: [{ pluginSecret: [] }],
        body: {
          type: 'object',
          required: ['organizationId', 'terminalId', 'productId'],
          additionalProperties: false,
          properties: {
            organizationId: { type: 'string', minLength: 1 },
            terminalId: { type: 'string', minLength: 1 },
            productId: { type: 'string', minLength: 1 },
            requestedAt: { type: 'string', format: 'date-time' },
          },
        },
      },
    },
    async (request, reply) => {
      const { organizationId, terminalId, productId } = request.body;
      const allowedTerminals = app.env.FRONT_PLUGIN_ALLOWED_TERMINAL_IDS;
      if (allowedTerminals.length > 0 && !allowedTerminals.includes(terminalId)) {
        throw forbidden('Терминал не разрешён для интеграции');
      }

      const organization = await app.prisma.organization.findFirst({ where: { isSelected: true } });
      if (!organization) {
        throw validationError('Организация не выбрана');
      }
      if (organization.iikoOrganizationId !== organizationId) {
        throw forbidden('Организация не разрешена для интеграции');
      }

      const issuedAt = new Date();
      const quoteId = randomUUID();

      const respond = (
        status: QuoteStatus,
        payload: Record<string, unknown> = {},
        httpStatus = 200,
      ) =>
        reply.code(httpStatus).send({
          quoteId,
          status,
          currency: CURRENCY,
          productId,
          issuedAt: issuedAt.toISOString(),
          fallbackAllowed: false,
          ...payload,
        });

      const product =
        (await app.services.products.findByIikoItemId(organization.id, productId)) ??
        (await app.services.products.findByIikoProductId(organization.id, productId));

      await app.services.audit.log({
        action: 'PLUGIN_QUOTE_REQUESTED',
        actorType: 'PLUGIN',
        organizationId: organization.id,
        entityType: 'Product',
        entityId: product?.id ?? null,
        requestId: request.id,
        summary: `Плагин запросил цену товара ${productId}`,
        metadata: { terminalId, quoteId },
        ipAddress: request.ip,
      });

      if (!product || !product.isExchangeProduct) {
        return respond('product_not_exchange');
      }
      if (!product.isActive || product.status !== 'ACTIVE') {
        return respond('unavailable');
      }

      const round = await app.services.rounds.getCurrentPublishedRound(issuedAt);
      if (!round) {
        return respond('no_active_round');
      }
      const price = round.prices.find((item) => item.productId === product.id);
      if (!price || price.publishedPrice === null) {
        return respond('no_active_round');
      }

      return respond('ok', {
        roundId: round.id,
        roundKey: round.roundKey,
        productName: product.name,
        price: toNumber(price.publishedPrice.toString()),
        validFrom: round.startsAt.toISOString(),
        validUntil: round.endsAt.toISOString(),
      });
    },
  );
}
