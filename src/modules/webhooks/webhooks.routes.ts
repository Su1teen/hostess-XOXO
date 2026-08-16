import type { FastifyInstance } from 'fastify';
import { API_PREFIX, SALES_EVENT_SOURCE_IIKO_WEBHOOK } from '../../config/constants.js';
import { unauthorized } from '../../lib/errors.js';
import { deriveExternalEventId, safeCompare } from '../../lib/idempotency.js';
import { redactDeep } from '../../lib/redaction.js';

/**
 * Приём событий iiko (experimental, v0.1).
 * Сохраняет событие идемпотентно и не выполняет никаких действий в iiko.
 */
export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    `${API_PREFIX}/webhooks/iiko`,
    {
      schema: {
        tags: ['Webhooks'],
        summary: '[experimental] Приём событий iiko',
        description:
          'Событие сохраняется идемпотентно (source + externalEventId). Цены и заказы не изменяются. ' +
          'Если задан IIKO_WEBHOOK_SECRET, требуется заголовок x-iiko-signature с этим значением.',
        body: {},
        response: {
          202: {
            type: 'object',
            properties: {
              accepted: { type: 'boolean' },
              duplicate: { type: 'boolean' },
              eventId: { type: 'string' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      if (app.env.IIKO_WEBHOOK_SECRET) {
        const header = request.headers['x-iiko-signature'];
        const value = Array.isArray(header) ? header[0] : header;
        if (!safeCompare(value, app.env.IIKO_WEBHOOK_SECRET)) {
          // Детали причины наружу не раскрываем.
          throw unauthorized('Подпись webhook не подтверждена');
        }
      }

      const payload = request.body ?? {};
      const extracted = extractEventFields(payload);
      const externalEventId = deriveExternalEventId(payload, extracted.eventId);

      const organization =
        (extracted.organizationId
          ? await app.prisma.organization.findUnique({
              where: { iikoOrganizationId: extracted.organizationId },
            })
          : null) ?? (await app.prisma.organization.findFirst({ where: { isSelected: true } }));

      if (!organization) {
        // Организации ещё нет — подтверждаем приём, чтобы iiko не ретраил бесконечно.
        app.log.warn({ requestId: request.id }, 'webhook получен до выбора организации');
        return reply.code(202).send({ accepted: true, duplicate: false, eventId: externalEventId });
      }

      const existing = await app.prisma.salesEvent.findUnique({
        where: {
          source_externalEventId: {
            source: SALES_EVENT_SOURCE_IIKO_WEBHOOK,
            externalEventId,
          },
        },
      });
      if (existing) {
        return reply.code(202).send({ accepted: true, duplicate: true, eventId: externalEventId });
      }

      const product = extracted.productId
        ? await app.prisma.product.findUnique({
            where: {
              organizationId_iikoProductId: {
                organizationId: organization.id,
                iikoProductId: extracted.productId,
              },
            },
          })
        : null;

      await app.prisma.salesEvent.create({
        data: {
          organizationId: organization.id,
          productId: product?.id ?? null,
          externalEventId,
          iikoOrderId: extracted.orderId ?? null,
          source: SALES_EVENT_SOURCE_IIKO_WEBHOOK,
          eventType: extracted.eventType ?? 'UNKNOWN',
          quantity: extracted.quantity?.toString() ?? '0',
          unitPrice: extracted.unitPrice?.toString() ?? null,
          occurredAt: extracted.occurredAt,
          status: 'RECEIVED',
          // Сырой payload сохраняем только в отредактированном виде.
          rawPayload: app.env.IIKO_DEBUG_RAW_PAYLOADS
            ? (redactDeep(payload) as object)
            : { note: 'raw payload не сохраняется (IIKO_DEBUG_RAW_PAYLOADS=false)' },
        },
      });

      await app.services.audit.log({
        action: 'WEBHOOK_RECEIVED',
        actorType: 'IIKO',
        organizationId: organization.id,
        entityType: 'SalesEvent',
        entityId: externalEventId,
        requestId: request.id,
        summary: `Получено событие iiko: ${extracted.eventType ?? 'UNKNOWN'}`,
        metadata: { eventType: extracted.eventType ?? null },
        ipAddress: request.ip,
      });

      return reply.code(202).send({ accepted: true, duplicate: false, eventId: externalEventId });
    },
  );
}

interface ExtractedEvent {
  eventId?: string;
  eventType?: string;
  orderId?: string;
  organizationId?: string;
  productId?: string;
  quantity?: number;
  unitPrice?: number;
  occurredAt: Date | null;
}

/** Максимально терпимое извлечение полей: разные схемы событий iiko не должны ломать приём. */
function extractEventFields(payload: unknown): ExtractedEvent {
  const record = asRecord(payload);
  const first = Array.isArray(payload) ? asRecord(payload[0]) : undefined;
  const source = record ?? first ?? {};
  const eventInfo = asRecord(source.eventInfo) ?? {};
  const order = asRecord(eventInfo.order) ?? asRecord(source.order) ?? {};

  const timestampCandidate =
    str(source.timestamp) ??
    str(source.eventTime) ??
    str(order.whenCreated) ??
    str(eventInfo.timestamp);

  return {
    eventId: str(source.eventId) ?? str(source.id) ?? str(eventInfo.id) ?? str(order.id),
    eventType: str(source.eventType) ?? str(source.type) ?? str(eventInfo.eventType),
    orderId: str(order.id) ?? str(eventInfo.orderId) ?? str(source.orderId),
    organizationId: str(source.organizationId) ?? str(eventInfo.organizationId),
    productId: str(source.productId),
    quantity: num(source.quantity),
    unitPrice: num(source.price) ?? num(source.unitPrice),
    occurredAt: parseDate(timestampCandidate),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseDate(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
