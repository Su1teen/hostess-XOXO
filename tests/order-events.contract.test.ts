import fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { orderEventsRoutes } from '../src/modules/command-center/order-events.routes.js';
import { OrderEventsService, orderEventSchema } from '../src/modules/command-center/order-events.service.js';

const example = () => ({
  eventId: randomUUID(), eventType: 'ORDER_ACCEPTED', venueCode: 'xoxo',
  orderId: randomUUID(), orderItemId: randomUUID(), exchangeProductId: randomUUID(),
  roundId: randomUUID(), quantity: 3, unitPrice: '1590.00', occurredAt: '2026-10-16T13:00:00.000Z',
});
afterEach(() => vi.restoreAllMocks());
describe('Command Center order-event HTTP contract', () => {
  async function server(enabled = true) {
    const app = fastify();
    app.decorate('env', { COMMAND_CENTER_SERVICE_KEY: 'test-service-credential-32-characters', QR_ORDER_EVENTS_ENABLED: enabled } as never);
    app.decorate('prisma', { auditLog: { create: vi.fn() } } as never);
    await app.register(orderEventsRoutes);
    return app;
  }
  const headers = {'x-command-center-key':'test-service-credential-32-characters'};
  it('returns the documented ACK and preserves quantity=3', async () => {
    const event = example();
    const ingest = vi.spyOn(OrderEventsService.prototype, 'ingest').mockResolvedValue({ accepted:true, alreadyProcessed:false, eventId:event.eventId, appliedToRound:null });
    const app = await server();
    const response = await app.inject({method:'POST',url:'/api/v1/command-center/order-events',headers,payload:event});
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({accepted:true,alreadyProcessed:false,eventId:event.eventId,appliedToRound:null});
    expect(ingest).toHaveBeenCalledWith(event);
    await app.close();
  });
  it.each([undefined, 'wrong'])('rejects missing or wrong service key before ingestion', async key => {
    const ingest = vi.spyOn(OrderEventsService.prototype, 'ingest');
    const app = await server();
    const response = await app.inject({method:'POST',url:'/api/v1/command-center/order-events',headers:key?{'x-command-center-key':key}:{},payload:example()});
    expect(response.statusCode).toBe(401);
    expect(response.json().error.retryable).toBe(false);
    expect(ingest).not.toHaveBeenCalled();
    await app.close();
  });
  it('returns a retryable response while disabled', async () => {
    const app = await server(false);
    const response = await app.inject({method:'POST',url:'/api/v1/command-center/order-events',headers,payload:example()});
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({code:'QR_EVENTS_DISABLED',retryable:true});
    await app.close();
  });
  it('never ACKs a failed database transaction', async () => {
    vi.spyOn(OrderEventsService.prototype,'ingest').mockRejectedValue(new Error('connection unavailable'));
    const app = await server();
    const response = await app.inject({method:'POST',url:'/api/v1/command-center/order-events',headers,payload:example()});
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({code:'DATABASE_UNAVAILABLE',retryable:true});
    await app.close();
  });
  it.each([{quantity:0},{quantity:-1},{quantity:1.5},{venueCode:'other'},{unitPrice:'NaN'},{unitPrice:'1.234'},{roundId:'invalid'},{guestName:'PII'},{eventType:'REFUNDED'}])('rejects malformed input %o', overrides => {
    expect(orderEventSchema.safeParse({...example(),...overrides}).success).toBe(false);
  });
  it('normalizes decimal and timestamp representations for idempotency', () => {
    expect(orderEventSchema.parse({...example(),unitPrice:'1590',occurredAt:'2026-10-16T18:00:00+05:00'})).toMatchObject({unitPrice:'1590.00',occurredAt:'2026-10-16T13:00:00.000Z'});
  });
});
