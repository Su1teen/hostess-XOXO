import type { FastifyInstance } from 'fastify';
import { API_PREFIX, CURRENCY, TRIGGER_SOURCE } from '../../config/constants.js';
import type { RoundWithPrices } from './rounds.service.js';

interface SimulateBody {
  startsAt?: string;
  demandOverrides?: Array<{ productId: string; demandScore?: number; salesQuantity?: number }>;
  note?: string;
}

const roundIdParams = {
  type: 'object',
  required: ['roundId'],
  additionalProperties: false,
  properties: { roundId: { type: 'string', format: 'uuid' } },
} as const;

export async function roundsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { limit?: number; status?: string } }>(
    `${API_PREFIX}/admin/rounds`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Rounds'],
        summary: 'Список раундов',
        security: [{ adminApiKey: [] }],
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
            status: {
              type: 'string',
              enum: [
                'DRAFT',
                'SIMULATED',
                'READY_FOR_REVIEW',
                'APPROVED',
                'APPLYING_TO_IIKO',
                'APPLIED_TO_IIKO',
                'PUBLISHED',
                'FAILED',
                'ROLLED_BACK',
                'CANCELLED',
              ],
            },
          },
        },
      },
    },
    async (request) => {
      const rounds = await app.services.rounds.listRounds({
        limit: request.query.limit,
        status: request.query.status as never,
      });
      return {
        items: rounds.map((round) => ({
          id: round.id,
          roundKey: round.roundKey,
          startsAt: round.startsAt.toISOString(),
          endsAt: round.endsAt.toISOString(),
          status: round.status,
          triggerSource: round.triggerSource,
          createdBy: round.createdBy,
          productsCount: round._count.prices,
          note: round.note,
          approvedAt: round.approvedAt?.toISOString() ?? null,
          publishedAt: round.publishedAt?.toISOString() ?? null,
          createdAt: round.createdAt.toISOString(),
        })),
      };
    },
  );

  app.get<{ Params: { roundId: string } }>(
    `${API_PREFIX}/admin/rounds/:roundId`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Rounds'],
        summary: 'Детали раунда с расчётами',
        security: [{ adminApiKey: [] }],
        params: roundIdParams,
      },
    },
    async (request) => serializeRound(await app.services.rounds.getRound(request.params.roundId)),
  );

  app.post<{ Body: SimulateBody }>(
    `${API_PREFIX}/admin/rounds/simulate`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Rounds'],
        summary: 'Создать симулированный раунд (без обращения к iiko)',
        description:
          'Если startsAt не указан, создаётся следующий 15-минутный раунд. Повторный вызов для того же окна возвращает существующий раунд.',
        security: [{ adminApiKey: [] }],
        body: {
          type: 'object',
          additionalProperties: false,
          properties: {
            startsAt: { type: 'string', format: 'date-time' },
            note: { type: 'string', maxLength: 500 },
            demandOverrides: {
              type: 'array',
              maxItems: 500,
              items: {
                type: 'object',
                required: ['productId'],
                additionalProperties: false,
                properties: {
                  productId: { type: 'string', format: 'uuid' },
                  demandScore: { type: 'number', minimum: -1, maximum: 1 },
                  salesQuantity: { type: 'number', minimum: 0 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await app.services.rounds.simulateRound({
        startsAt: request.body?.startsAt,
        demandOverrides: request.body?.demandOverrides,
        note: request.body?.note,
        triggerSource: TRIGGER_SOURCE.MANUAL,
        createdBy: 'admin',
        requestId: request.id,
      });
      return reply.code(result.created ? 201 : 200).send({
        created: result.created,
        round: serializeRound(result.round),
      });
    },
  );

  app.post<{ Params: { roundId: string } }>(
    `${API_PREFIX}/admin/rounds/:roundId/approve`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Rounds'],
        summary: 'Утвердить раунд (меняется только статус)',
        security: [{ adminApiKey: [] }],
        params: roundIdParams,
      },
    },
    async (request) => {
      const round = await app.services.rounds.approveRound(
        request.params.roundId,
        'admin',
        request.id,
      );
      return { id: round.id, roundKey: round.roundKey, status: round.status };
    },
  );

  app.post<{ Params: { roundId: string } }>(
    `${API_PREFIX}/admin/rounds/:roundId/publish`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Rounds'],
        summary: 'Опубликовать раунд для public API',
        description: 'v0.1: цены в iiko не отправляются, publishedPrice фиксируется в базе.',
        security: [{ adminApiKey: [] }],
        params: roundIdParams,
      },
    },
    async (request) => {
      try {
        const round = await app.services.rounds.publishRound(
          request.params.roundId,
          'admin',
          request.id,
        );
        return serializeRound(round);
      } catch (error) {
        await app.services.telegram.sendAlert(
          'ROUND_PUBLISH_FAILED',
          '⚠️ Bar Exchange: публикация раунда завершилась ошибкой.',
        );
        throw error;
      }
    },
  );

  app.post<{ Params: { roundId: string } }>(
    `${API_PREFIX}/admin/rounds/:roundId/rollback`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Rounds'],
        summary: 'Откатить раунд к предыдущему опубликованному',
        security: [{ adminApiKey: [] }],
        params: roundIdParams,
      },
    },
    async (request) => {
      const result = await app.services.rounds.rollbackRound(
        request.params.roundId,
        'admin',
        request.id,
      );
      return {
        id: result.round.id,
        roundKey: result.round.roundKey,
        status: result.round.status,
        restoredRoundKey: result.restoredRoundKey,
      };
    },
  );

  app.get<{ Params: { roundId: string } }>(
    `${API_PREFIX}/admin/rounds/:roundId/manual-export`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Rounds'],
        summary: 'Ручной экспорт цен раунда (для оператора)',
        description:
          'Возвращает таблицу товар / iikoProductId / текущая цена / следующая цена / время начала. В iiko ничего не отправляется.',
        security: [{ adminApiKey: [] }],
        params: roundIdParams,
      },
    },
    async (request) => {
      const validation = await app.services.pricePublisher.validate(request.params.roundId);
      const exported = await app.services.rounds.buildManualExport(request.params.roundId);
      return {
        publisherMode: app.services.pricePublisher.mode,
        validation,
        currency: CURRENCY,
        ...exported,
      };
    },
  );
}

function serializeRound(round: RoundWithPrices) {
  return {
    id: round.id,
    roundKey: round.roundKey,
    startsAt: round.startsAt.toISOString(),
    endsAt: round.endsAt.toISOString(),
    timezone: round.timezone,
    status: round.status,
    algorithmVersion: round.algorithmVersion,
    triggerSource: round.triggerSource,
    note: round.note,
    createdBy: round.createdBy,
    createdAt: round.createdAt.toISOString(),
    approvedAt: round.approvedAt?.toISOString() ?? null,
    publishedAt: round.publishedAt?.toISOString() ?? null,
    currency: CURRENCY,
    prices: round.prices.map((price) => ({
      productId: price.productId,
      productName: price.exchangeProduct?.name ?? price.product?.name ?? 'Unknown',
      previousPrice: price.previousPrice === null ? null : Number(price.previousPrice.toString()),
      calculatedPrice: Number(price.calculatedPrice.toString()),
      publishedPrice:
        price.publishedPrice === null ? null : Number(price.publishedPrice.toString()),
      minPrice: Number(price.minPrice.toString()),
      maxPrice: Number(price.maxPrice.toString()),
      priceStep: Number(price.priceStep.toString()),
      demandScore: Number(price.demandScore.toString()),
      salesQuantity: Number(price.salesQuantity.toString()),
      changePercent: Number(price.changePercent.toString()),
      status: price.status,
      calculationInput: price.calculationInput,
      calculationResult: price.calculationResult,
    })),
  };
}
