import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { conflict } from '../../lib/errors.js';

const uuid = z.string().uuid().transform((value) => value.toLowerCase());
export const orderEventSchema = z.object({
  eventId: uuid,
  eventType: z.enum(['ORDER_ACCEPTED', 'ORDER_CANCELLED']),
  venueCode: z.literal('xoxo'),
  orderId: uuid,
  orderItemId: uuid,
  exchangeProductId: uuid,
  roundId: uuid,
  quantity: z.number().int().positive().max(2147483647),
  unitPrice: z.string().regex(/^\d{1,10}(\.\d{1,2})?$/).transform((value) => new Prisma.Decimal(value).toFixed(2)),
  occurredAt: z.string().datetime({ offset: true }).transform((value) => new Date(value).toISOString()),
  schemaVersion: z.literal(1).optional(),
  correlationId: uuid.optional(),
  idempotencyKey: uuid.optional(),
}).strict();
export type OrderEventInput = z.infer<typeof orderEventSchema>;

export class OrderEventError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 422, readonly retryable = false) {
    super(message);
  }
}
function fingerprint(input: OrderEventInput) {
  return createHash('sha256').update(JSON.stringify([
    input.eventType, input.venueCode, input.orderId, input.orderItemId,
    input.exchangeProductId, input.roundId, input.quantity, input.unitPrice, input.occurredAt,
  ])).digest('hex');
}
export class OrderEventsService {
  constructor(private readonly prisma: PrismaClient) {}

  async ingest(input: OrderEventInput, now = new Date()) {
    const hash = fingerprint(input);
    return this.prisma.$transaction(async (tx) => {
      await lockExchange(tx);
      const receipt = await tx.exchangeOrderDelivery.findUnique({ where: { externalEventId: input.eventId } });
      if (receipt && receipt.payloadHash !== hash) {
        throw new OrderEventError('EVENT_ID_CONFLICT', 'eventId was already used with another payload', 409);
      }
      const existing = await tx.exchangeOrderEvent.findUnique({ where: {
        commandCenterOrderItemId_eventType: { commandCenterOrderItemId: input.orderItemId, eventType: input.eventType },
      } });
      if (existing && existing.payloadHash !== hash) {
        throw new OrderEventError('ORDER_ITEM_CONFLICT', 'Order item event conflicts with the recorded event', 409);
      }
      if (existing) {
        await tx.exchangeOrderDelivery.upsert({
          where: { externalEventId: input.eventId },
          create: { externalEventId: input.eventId, payloadHash: hash, eventId: existing.id, duplicateCount: 1 },
          update: { duplicateCount: { increment: 1 }, lastReceivedAt: now },
        });
        return { accepted: true, alreadyProcessed: true, eventId: input.eventId, appliedToRound: existing.appliedToRoundId };
      }
      const round = await tx.priceRound.findUnique({ where: { id: input.roundId }, include: { organization: true } });
      if (!round) throw new OrderEventError('ROUND_NOT_FOUND', 'Unknown price round');
      if (!round.organization.isSelected) throw new OrderEventError('VENUE_ROUND_MISMATCH', 'Round does not belong to the selected venue');
      if (!round.publishedAt || !['PUBLISHED', 'CLOSED', 'ROLLED_BACK'].includes(round.status)) {
        throw new OrderEventError('ROUND_NOT_PUBLISHED', 'Order must reference a published round');
      }
      const price = await tx.roundPrice.findUnique({ where: {
        roundId_exchangeProductId: { roundId: input.roundId, exchangeProductId: input.exchangeProductId },
      } });
      if (!price || price.publishedPrice === null) throw new OrderEventError('PRODUCT_ROUND_MISMATCH', 'Product has no published price in this round');
      if (!price.publishedPrice.equals(input.unitPrice)) throw new OrderEventError('PRICE_MISMATCH', 'unitPrice must equal the published price before loyalty deductions');
      const occurredAt = new Date(input.occurredAt);
      if (occurredAt.getTime() > now.getTime() + 60_000) throw new OrderEventError('INVALID_EVENT_TIME', 'Event timestamp is in the future');
      if (input.eventType === 'ORDER_ACCEPTED' && (occurredAt < round.startsAt || occurredAt >= round.endsAt)) {
        throw new OrderEventError('ROUND_TIME_MISMATCH', 'Acceptance timestamp is outside the quoted round');
      }
      if (input.eventType === 'ORDER_CANCELLED') {
        const accepted = await tx.exchangeOrderEvent.findUnique({ where: {
          commandCenterOrderItemId_eventType: { commandCenterOrderItemId: input.orderItemId, eventType: 'ORDER_ACCEPTED' },
        } });
        if (!accepted) throw new OrderEventError('ACCEPTANCE_NOT_RECEIVED', 'Deliver ORDER_ACCEPTED before cancellation', 409, true);
        if (accepted.commandCenterOrderId !== input.orderId || accepted.exchangeProductId !== input.exchangeProductId ||
          accepted.roundId !== input.roundId || accepted.quantity !== input.quantity || !accepted.unitPriceSnapshot.equals(input.unitPrice) ||
          occurredAt < accepted.occurredAt) {
          throw new OrderEventError('CANCELLATION_MISMATCH', 'Cancellation must reverse the complete original item');
        }
      }
      const event = await tx.exchangeOrderEvent.create({ data: {
        externalEventId: input.eventId, commandCenterOrderId: input.orderId,
        commandCenterOrderItemId: input.orderItemId, eventType: input.eventType,
        exchangeProductId: input.exchangeProductId, roundId: input.roundId,
        quantity: input.quantity, unitPriceSnapshot: input.unitPrice,
        occurredAt, receivedAt: now, payloadHash: hash, metadata: input,
      } });
      await tx.exchangeOrderDelivery.create({ data: { externalEventId: input.eventId, payloadHash: hash, eventId: event.id } });
      return { accepted: true, alreadyProcessed: false, eventId: input.eventId, appliedToRound: null };
    }, { maxWait: 10_000, timeout: 15_000 });
  }

  async diagnostics(roundId?: string) {
    const where = roundId ? { roundId } : {};
    const [events, receipts, rejected, recent, manual, qr] = await Promise.all([
      this.prisma.exchangeOrderEvent.groupBy({ by: ['eventType', 'processingStatus'], where, _count: true, _sum: { quantity: true } }),
      this.prisma.exchangeOrderDelivery.aggregate({ where: roundId ? { event: { roundId } } : {}, _sum: { duplicateCount: true }, _count: true }),
      this.prisma.auditLog.count({ where: { entityType: 'ExchangeOrderEventRejection' } }),
      this.prisma.exchangeOrderEvent.findMany({ where, orderBy: { receivedAt: 'desc' }, take: 100 }),
      roundId ? this.prisma.exchangeSale.groupBy({ by: ['exchangeProductId'], where: { roundId }, _sum: { quantity: true } }) : [],
      this.prisma.exchangeOrderEvent.groupBy({ by: ['exchangeProductId', 'eventType'], where, _sum: { quantity: true } }),
    ]);
    const qrByProduct = new Map<string, number>();
    for (const row of qr) qrByProduct.set(row.exchangeProductId, (qrByProduct.get(row.exchangeProductId) ?? 0) + (row.eventType === 'ORDER_ACCEPTED' ? 1 : -1) * (row._sum.quantity ?? 0));
    const ids = new Set([...qrByProduct.keys(), ...manual.map((row) => row.exchangeProductId).filter((id): id is string => !!id)]);
    return {
      sourcePolicy: 'Manual quantities are OFFLINE ONLY. Never re-enter a QR item. iiko is receipt-only and excluded from demand.',
      events, deliveries: receipts._count, duplicates: receipts._sum.duplicateCount ?? 0, rejectedAttempts: rejected,
      recent, reconciliation: [...ids].map((id) => ({
        exchangeProductId: id, qrQuantity: qrByProduct.get(id) ?? 0,
        manualQuantity: manual.find((row) => row.exchangeProductId === id)?._sum.quantity ?? 0,
      })),
    };
  }
}
export async function lockExchange(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('exchange-round-transition'))`;
}
/** Dry-run simulation reads the same inputs but does not consume them. */
export async function consumeQrDemand(tx: Prisma.TransactionClient, at: Date, markHistorical = true) {
  const events = await tx.exchangeOrderEvent.findMany({
    where: { processingStatus: 'PENDING', occurredAt: { lt: at }, round: { endsAt: { lte: at } } },
    orderBy: [{ occurredAt: 'asc' }, { eventType: 'asc' }],
  });
  const quantities = new Map<string, number>();
  const ids: string[] = [];
  for (const event of events) {
    if (event.eventType === 'ORDER_CANCELLED') {
      const accepted = await tx.exchangeOrderEvent.findUnique({ where: {
        commandCenterOrderItemId_eventType: { commandCenterOrderItemId: event.commandCenterOrderItemId, eventType: 'ORDER_ACCEPTED' },
      } });
      if (accepted?.processingStatus !== 'PENDING') {
        if (markHistorical) await tx.exchangeOrderEvent.update({ where: { id: event.id }, data: { processingStatus: 'HISTORICAL_ONLY', processedAt: new Date() } });
        continue;
      }
    }
    ids.push(event.id);
    quantities.set(event.exchangeProductId, (quantities.get(event.exchangeProductId) ?? 0) + (event.eventType === 'ORDER_ACCEPTED' ? 1 : -1) * event.quantity);
  }
  return { quantities, ids };
}

/** Consume only the QR inputs captured by an explicitly published simulation. */
export async function applyQrPreview(tx: Prisma.TransactionClient, roundId: string, prices: Array<{calculationInput: Prisma.JsonValue}>) {
  const ids = new Set<string>();
  const round = await tx.priceRound.findUniqueOrThrow({ where: { id: roundId } });
  const sourceRoundIds = new Set<string>();
  let manualSnapshot: Prisma.JsonValue | undefined;
  for (const price of prices) {
    const input = price.calculationInput;
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      const captured = input.qrDemandEventIds;
      if (Array.isArray(captured)) for (const id of captured) if (typeof id === 'string') ids.add(id);
      if (Array.isArray(input.manualSourceRoundIds)) {
        for (const id of input.manualSourceRoundIds) if (typeof id === 'string') sourceRoundIds.add(id);
        manualSnapshot = input.manualSourceSales;
      }
    }
  }
  if (manualSnapshot !== undefined) {
    if (round.startsAt > new Date()) throw conflict('A demand preview cannot be published before its window starts');
    const sources = await tx.priceRound.findMany({
      where: { organizationId: round.organizationId, status: 'PUBLISHED', endsAt: { lte: round.startsAt } },
      orderBy: { id: 'asc' },
    });
    const sourceIds = sources.map((source) => source.id);
    const sales = await tx.exchangeSale.findMany({ where: { roundId: { in: sourceIds } }, orderBy: { id: 'asc' } });
    const eligible = await consumeQrDemand(tx, round.startsAt, false);
    if (JSON.stringify(sourceIds) !== JSON.stringify([...sourceRoundIds].sort()) ||
      JSON.stringify(sales.map((sale) => ({ id: sale.id, quantity: sale.quantity }))) !== JSON.stringify(manualSnapshot) ||
      eligible.ids.length !== ids.size || eligible.ids.some((id) => !ids.has(id))) {
      throw conflict('Demand changed since simulation; use a fresh round calculation');
    }
    await tx.priceRound.updateMany({ where: { id: { in: sourceIds } }, data: { status: 'CLOSED' } });
  } else if (prices.some((price) => {
    const input = price.calculationInput;
    return input && typeof input === 'object' && !Array.isArray(input) && input.algorithm === 'discrete-price-levels-v1';
  })) {
    throw conflict('Legacy preview lacks source accounting; use a fresh round calculation');
  }
  if (!ids.size) return;
  const pending = await tx.exchangeOrderEvent.count({where:{id:{in:[...ids]},processingStatus:'PENDING'}});
  if (pending !== ids.size) throw conflict('QR inputs have already been consumed; recalculate the round');
  await tx.exchangeOrderEvent.updateMany({where:{id:{in:[...ids]}},data:{processingStatus:'APPLIED',processedAt:new Date(),appliedToRoundId:roundId}});
}
