import type { FastifyInstance } from 'fastify';
import { API_PREFIX, CURRENCY } from '../../config/constants.js';

const paramsSchema = {
  type: 'object',
  required: ['roundId'],
  additionalProperties: false,
  properties: { roundId: { type: 'string', format: 'uuid' } },
} as const;

export async function salesRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { roundId: string }; Body: { productId: string; quantity: number } }>(
    `${API_PREFIX}/admin/rounds/:roundId/sales/increment`,
    {
      preHandler: app.requireAdmin,
      schema: {
        tags: ['Rounds'],
        summary: 'Атомарно увеличить продажи товара в раунде',
        security: [{ adminApiKey: [] }],
        params: paramsSchema,
        body: {
          type: 'object',
          required: ['productId', 'quantity'],
          additionalProperties: false,
          properties: {
            productId: { type: 'string', format: 'uuid' },
            quantity: { type: 'integer', minimum: 1 },
          },
        },
        response: {
          200: {
            type: 'object',
            required: ['roundId', 'productId', 'quantity', 'priceAtSale', 'currency'],
            properties: {
              roundId: { type: 'string' },
              productId: { type: 'string' },
              quantity: { type: 'integer' },
              priceAtSale: { type: 'number' },
              currency: { type: 'string', const: CURRENCY },
            },
          },
        },
      },
    },
    async (request) => {
      const sale = await app.services.sales.increment(
        request.params.roundId,
        request.body.productId,
        request.body.quantity,
      );
      return {
        roundId: sale.roundId,
        productId: sale.productId,
        quantity: sale.quantity,
        priceAtSale: Number(sale.priceAtSale.toString()),
        currency: CURRENCY,
      };
    },
  );
}
