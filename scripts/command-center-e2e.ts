/* eslint-disable no-console */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import fastify from 'fastify';
import { PrismaClient } from '@prisma/client';
import { parseEnv } from '../src/config/env.js';
import { orderEventsRoutes } from '../src/modules/command-center/order-events.routes.js';
import { publicRoutes } from '../src/modules/public-api/public.routes.js';
import { RoundsService } from '../src/modules/rounds/rounds.service.js';
import { ExchangeService } from '../src/modules/exchange/exchange.service.js';
import { AuditService } from '../src/services/audit.service.js';

// Only dedicated databases on this task's local PostgreSQL instance are used.
const receiverUrl = process.env.CROSS_RECEIVER_DATABASE_URL ?? '';
const senderUrl = process.env.CROSS_SENDER_DATABASE_URL ?? '';
for (const [raw, database] of [
  [receiverUrl, 'xoxo_cross_test'],
  [senderUrl, 'command_cross_test'],
]) {
  const url = new URL(raw!);
  assert.ok(
    ['127.0.0.1', 'localhost'].includes(url.hostname) && url.pathname === '/' + database,
    'Use dedicated local cross-service databases only',
  );
}
process.env.DATABASE_URL = senderUrl;
process.env.NODE_ENV = 'test';
process.env.DINE_IN_ENABLED = 'yes';
process.env.DINE_IN_PILOT_ASSUMED_PAID = 'yes';
process.env.DINE_IN_OUTBOX_ENABLED = 'yes';
process.env.COMMAND_CENTER_SERVICE_KEY = 'local-cross-service-credential-32-characters';
process.env.HOSTESS_PUBLIC_ORIGIN = 'https://hostes.online';
const senderRoot = process.env.COMMAND_CENTER_SOURCE_ROOT;
assert.ok(senderRoot, 'COMMAND_CENTER_SOURCE_ROOT must identify the checked-out sender');
const load = async (path: string) => import(pathToFileURL(senderRoot + '/' + path).href);
const { pool } = await load('src/server/db/pool.ts');
const { createQuote, checkout, changeStatus } = await load('src/server/dine-in/service.ts');
const { drainOutbox } = await load('src/server/dine-in/outbox.ts');
const prisma = new PrismaClient({ datasources: { db: { url: receiverUrl } } });
const env = parseEnv({
  DATABASE_URL: receiverUrl,
  ADMIN_API_KEY: 'local-test-admin-0123456789',
  COMMAND_CENTER_SERVICE_KEY: process.env.COMMAND_CENTER_SERVICE_KEY,
  QR_ORDER_EVENTS_ENABLED: 'false',
  ROUND_SCHEDULER_ENABLED: 'false',
});
const logger = { info: () => {}, warn: () => {}, error: () => {} };
const rounds = new RoundsService(prisma, env, new AuditService(prisma, logger), logger);
const exchange = new ExchangeService(prisma, rounds, logger);
const app = fastify();
app.decorate('env', env);
app.decorate('prisma', prisma);
app.decorate('services', { rounds, exchange } as never);
await app.register(orderEventsRoutes);
await app.register(publicRoutes);
try {
  assert.equal(
    await prisma.exchangeOrderEvent.count(),
    0,
    'Receiver test database must be freshly migrated',
  );
  assert.equal(await prisma.organization.count(), 0, 'Receiver test database must be empty');
  for (const file of readdirSync(senderRoot + '/src/server/db/migrations')
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    await pool.query(readFileSync(senderRoot + '/src/server/db/migrations/' + file, 'utf8'));
  }
  const table = (await pool.query('SELECT token,venue_id FROM table_qr_codes LIMIT 1')).rows[0];
  const organization = await prisma.organization.create({
    data: { iikoOrganizationId: randomUUID(), name: 'Isolated E2E', isSelected: true },
  });
  const product = await prisma.exchangeProduct.create({
    data: {
      slug: 'isolated-e2e',
      name: 'Isolated E2E drink',
      category: 'Drinks',
      originalPrice: 2000,
      startPrice: 1590,
      currentPrice: 1590,
      minPrice: 1590,
      maxPrice: 3000,
    },
  });
  const startsAt = new Date(Math.floor(Date.now() / 900000) * 900000),
    endsAt = new Date(startsAt.getTime() + 900000);
  const round = await prisma.priceRound.create({
    data: {
      organizationId: organization.id,
      roundKey: randomUUID(),
      startsAt,
      endsAt,
      timezone: 'Asia/Almaty',
      status: 'PUBLISHED',
      publishedAt: new Date(),
      algorithmVersion: 'test',
      triggerSource: 'TEST',
      prices: {
        create: {
          exchangeProductId: product.id,
          price: 1590,
          publishedPrice: 1590,
          calculatedPrice: 1590,
          minPrice: 1590,
          maxPrice: 3000,
          priceStep: 50,
          changePercent: 0,
          calculationInput: {},
          calculationResult: {},
          status: 'PUBLISHED',
        },
      },
    },
  });
  process.env.EXCHANGE_API_ORIGIN = await app.listen({ host: '127.0.0.1', port: 0 });
  const owner = { guestId: null, hash: randomUUID() };
  const quote = await createQuote(owner, {
    qrToken: table.token,
    items: [{ productId: product.id, quantity: 3 }],
    redeemMinor: 0,
  });
  const order = await checkout(owner, { quoteId: quote.id, idempotencyKey: randomUUID() });
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM integration_outbox')).rows[0].n,
    1,
  );
  assert.deepEqual(await drainOutbox(), { delivered: 0, failed: 1 });
  assert.equal(await prisma.exchangeOrderEvent.count(), 0);
  assert.equal(
    (await pool.query('SELECT terminal FROM integration_outbox')).rows[0].terminal,
    false,
  );
  env.QR_ORDER_EVENTS_ENABLED = true;
  await pool.query('UPDATE integration_outbox SET next_attempt_at=now()');
  assert.deepEqual(await drainOutbox(), { delivered: 1, failed: 0 });
  const accepted = await prisma.exchangeOrderEvent.findFirstOrThrow();
  assert.equal(accepted.quantity, 3);
  assert.equal(accepted.unitPriceSnapshot.toFixed(2), '1590.00');
  assert.equal(
    (await pool.query('SELECT status FROM integration_outbox')).rows[0].status,
    'delivered',
  );
  await pool.query("UPDATE integration_outbox SET status='failed',next_attempt_at=now()");
  assert.deepEqual(await drainOutbox(), { delivered: 1, failed: 0 });
  assert.equal(await prisma.exchangeOrderEvent.count(), 1);
  await changeStatus(
    order.order.id,
    table.venue_id,
    'e2e-manager',
    undefined,
    'Isolated audit cancellation',
  );
  assert.deepEqual(await drainOutbox(), { delivered: 1, failed: 0 });
  const diagnostics = await app.inject({
    url: '/api/v1/command-center/order-events/diagnostics?roundId=' + round.id,
    headers: { 'x-command-center-key': env.COMMAND_CENTER_SERVICE_KEY! },
  });
  assert.equal(diagnostics.statusCode, 200);
  assert.equal(diagnostics.json().reconciliation[0].qrQuantity, 0);
  assert.equal((await prisma.roundPrice.findFirstOrThrow()).publishedPrice!.toFixed(2), '1590.00');
  const next = await rounds.transitionRound(endsAt);
  assert.equal(Number(next!.prices[0]!.salesQuantity), 0);
  console.log(
    JSON.stringify({
      result: 'PASS',
      senderSource: senderRoot,
      realHTTP: true,
      checkoutOrders: 1,
      receiverEvents: await prisma.exchangeOrderEvent.count(),
      outbox: (
        await pool.query(
          'SELECT event_type,status,terminal FROM integration_outbox ORDER BY event_type',
        )
      ).rows,
      duplicates: diagnostics.json().duplicates,
      qrNetUnits: 0,
      quotedKzt: '1590.00',
      units: 3,
      disabledReceiverRetainedForRetry: true,
      publishedHistoryUnchanged: true,
    }),
  );
} finally {
  await app.close();
  await pool.end();
  await prisma.$disconnect();
}
