import type { FastifyInstance, FastifyError } from 'fastify';
import { z } from 'zod';
import { safeCompare } from '../../lib/idempotency.js';
import { OrderEventError, OrderEventsService, orderEventSchema } from './order-events.service.js';

export async function orderEventsRoutes(app: FastifyInstance) {
  const service = new OrderEventsService(app.prisma);
  app.addHook('onRequest', async (request, reply) => {
    const key = request.headers['x-command-center-key'];
    if (typeof key !== 'string' || !app.env.COMMAND_CENTER_SERVICE_KEY || !safeCompare(key, app.env.COMMAND_CENTER_SERVICE_KEY)) {
      return reply.code(401).send({ accepted: false, error: { code: 'UNAUTHORIZED', retryable: false } });
    }
  });
  app.setErrorHandler<FastifyError>(async (error, request, reply) => {
    const known = error instanceof OrderEventError;
    const status = known ? error.statusCode : (error.statusCode && error.statusCode < 500 ? error.statusCode : 503);
    const retryable = known ? error.retryable : status >= 500 || status === 429;
    const code = known ? error.code : (status >= 500 ? 'DATABASE_UNAVAILABLE' : 'INVALID_PAYLOAD');
    const parsed = orderEventSchema.safeParse(request.body);
    try {
      await app.prisma.auditLog.create({ data: {
        action: 'ADMIN_ACTION', actorType: 'COMMAND_CENTER', entityType: 'ExchangeOrderEventRejection',
        entityId: parsed.success ? parsed.data.eventId : null,
        summary: code, metadata: { code, retryable, requestId: request.id },
      } });
    } catch { /* PostgreSQL may be offline; sender must retain its outbox event. */ }
    request.log.warn({ code, retryable, requestId: request.id }, 'QR order delivery rejected');
    return reply.code(status).send({ accepted: false, error: { code, retryable, message: known ? error.message : 'Order event could not be processed' } });
  });
  app.post('/api/v1/command-center/order-events', { bodyLimit: 8192 }, async (request, reply) => {
    if (!app.env.QR_ORDER_EVENTS_ENABLED) throw new OrderEventError('QR_EVENTS_DISABLED', 'QR order ingestion is disabled', 503, true);
    const parsed = orderEventSchema.safeParse(request.body);
    if (!parsed.success) throw new OrderEventError('INVALID_PAYLOAD', 'Invalid order event payload', 400);
    return reply.code(200).send(await service.ingest(parsed.data));
  });
  app.get('/api/v1/command-center/order-events/diagnostics', async (request) => {
    const result = z.object({ roundId: z.string().uuid().optional() }).strict().safeParse(request.query);
    if (!result.success) throw new OrderEventError('INVALID_QUERY', 'roundId must be a UUID', 400);
    return { enabled: app.env.QR_ORDER_EVENTS_ENABLED, ...await service.diagnostics(result.data.roundId) };
  });
}
