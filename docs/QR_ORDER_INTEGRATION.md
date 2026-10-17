# QR order integration — XOXO

## Ownership and audit

Command Center owns guests, sessions, QR tables (17 physical tables), customer orders, loyalty and its transactional outbox. XOXO only owns exchange catalog, published prices, round demand and event accounting. No second customer order, wallet, database, broker or payment confirmation is created here. A pilot "assumed_paid" event is not bank settlement.

The existing manual path stores one ExchangeSale counter per round/product. SalesService previously attempted repeated INSERTs despite the unique key: it now uses atomic upsert and shares the round-transition lock. Bartender absolute/relative counters remain manual-only. Simulation now sums all quantities rather than taking the last row. iiko webhook events remain receipt-only and do not feed exchange demand; adding iiko as a sales source requires a cross-source order identity before enabling it.

## Authenticated contract (schema version 1)

POST /api/v1/command-center/order-events
Header: x-command-center-key = existing COMMAND_CENTER_SERVICE_KEY.
Server-to-server only; never embed the credential in a QR URL or browser bundle.

Example (substitute real IDs from the read-only snapshot):
```json
{
  "eventId": "21da23d0-2028-4025-b181-5b3796b2a145",
  "eventType": "ORDER_ACCEPTED",
  "venueCode": "xoxo",
  "orderId": "8856ae0e-b23b-47fa-bd3f-158886ef35d6",
  "orderItemId": "4a26f607-dfd7-4c90-9f9d-1c2d32a4b14a",
  "exchangeProductId": "c145d564-515a-491a-8484-5bcf0937515c",
  "roundId": "b419e267-2994-4e7b-9905-8b347a119232",
  "quantity": 3,
  "unitPrice": "1590.00",
  "occurredAt": "2026-10-16T13:00:00.000Z"
}
```

Required fields and types match the supplied Command Center contract. Optional schemaVersion=1, correlationId (UUID), idempotencyKey (UUID). Unknown fields are rejected; do not attach guest names, phones, cookies, secrets, bonus balances or paid totals. UUIDs, money and UTC timestamps are canonicalized before hashing. Changes to optional transport metadata do not change business identity.

Both event types require a positive integer quantity, at most PostgreSQL int max, and a nonnegative decimal string with up to two fractional digits. Currency is KZT. ORDER_CANCELLED reverses the whole original item and must retain its orderId, orderItemId, product, original round, quantity and unitPrice; only eventId, eventType and occurredAt change. Partial cancellation is not supported by this v1 contract. Cancellation timestamp must not precede acceptance. No timestamp can be more than 60 seconds ahead of the receiving server.

The round must have been published and belong to the selected organization. The product must have a RoundPrice in it. unitPrice must equal that published price before any loyalty deduction. Acceptance occurredAt must be inside [startsAt, endsAt); the original round can already be CLOSED when delivery arrives. Historical cancellations remain possible when a product has since become inactive.

HTTP 200 ACK:
```json
{"accepted":true,"alreadyProcessed":false,"eventId":"21da23d0-2028-4025-b181-5b3796b2a145","appliedToRound":null}
```

appliedToRound is null while pending, or the consuming round UUID when known. Duplicate delivery returns accepted=true, alreadyProcessed=true and the incoming eventId. Delete/ack an outbox delivery only after a successful HTTP response AND accepted=true. Replay identical business fields, preserving occurredAt. Do not generate a new acceptance after a cancellation.

Error envelope: accepted=false, error={code,retryable,message}. Retry with backoff/jitter when error.retryable=true, retaining the outbox record. Without a parseable envelope, retry network errors, 429 and 5xx. Malformed JSON/body-limit failures are permanent 4xx. A failed database transaction is never ACKed.

| HTTP | Codes | Sender action |
| --- | --- | --- |
| 401 | UNAUTHORIZED | Fix credential; never put it in the browser |
| 400 | INVALID_PAYLOAD / INVALID_QUERY | Dead-letter and fix payload |
| 409 | EVENT_ID_CONFLICT / ORDER_ITEM_CONFLICT | Permanent; inspect identity reuse |
| 409 | ACCEPTANCE_NOT_RECEIVED | Retry after acceptance; alert if predecessor never arrives |
| 422 | ROUND_NOT_FOUND / VENUE_ROUND_MISMATCH / ROUND_NOT_PUBLISHED / PRODUCT_ROUND_MISMATCH / PRICE_MISMATCH / ROUND_TIME_MISMATCH / INVALID_EVENT_TIME / CANCELLATION_MISMATCH | Permanent; reconcile source record |
| 503 | QR_EVENTS_DISABLED / DATABASE_UNAVAILABLE | Retry; keep the event in outbox |
| 429 | rate limit | Retry with backoff |

Authentication is timing-safe and runs before processing. Existing key redaction is reused. Validated metadata is retained for audit; unvalidated raw bodies are not stored.

## Persistence and concurrency

Migration: 20261016160000_qr_order_events.

- exchange_order_events: unique external event ID and (command_center_order_item_id,event_type), immutable original order/item/product/round/quantity/price/time, receivedAt, PENDING/APPLIED/HISTORICAL_ONLY, processedAt, appliedToRoundId, canonical business hash and safe metadata.
- exchange_order_deliveries: each incoming external ID, payload hash, event FK, duplicate count and receipt times. This includes alias IDs for semantic duplicates, so reusing an alias with a changed payload also conflicts.
- Rejected attempts: existing audit_logs, entityType=ExchangeOrderEventRejection, safe code/request ID and valid event reference only. When PostgreSQL is offline, rejection is logged by code; it cannot be persisted until delivery is retried.
- New foreign keys use RESTRICT; no cascade deletes of accounted events. DB checks constrain quantity, type, price and status.

Ingestion and automatic round transitions acquire the same transaction-scoped PostgreSQL advisory lock. Receipt, event and acknowledgement state commit together. The publisher consumes pending demand and marks its consuming round in the publication transaction. A crash rolls back both changes. Data and idempotency survive service restart. Manual increments and bartender writes use this lock too.

A duplicate event ID with changed business payload is a conflict. An identical semantic event under a new event ID creates only a delivery receipt, not another sale. Published product prices and customer order snapshots are never overwritten by ingestion.

## Demand and late delivery policy

Price engine and price-level thresholds are unchanged. Demand = sum of OFFLINE manual quantities in rounds being closed + eligible, previously unconsumed QR quantities. Quantity is units, not event rows or amount paid after bonuses.

Acceptance adds quantity once. Cancellation received before acceptance is retryable. Acceptance and full cancellation pending at the same price cutoff net to zero. Cancellation of already consumed demand is HISTORICAL_ONLY: it changes sales reconciliation, never creates negative future demand or reverses an already published quote. This deliberately separates sales corrections from price history.

Example: accepted at 19:14:59 in round A, delivered at 19:15:03 after B is published. Store original A and timestamp; leave B unchanged. Consume the event once while publishing C. A cancellation after this consumption corrects historical net QR units only. The originating round remains available for reports and the appliedToRound identifies the actual price calculation.

If a round is already PUBLISHED, transitionRound never deletes/recreates its prices. Pending QR demand and unclosed manual counters remain available for the following transition. All ended rounds being closed are aggregated, including recovery after downtime. Inactive products retain history but do not receive new prices.

simulateRound is a dry run. It snapshots eligible pending QR demand, ended source rounds and manual counters under the shared lock without consuming them. Explicit publication revalidates that snapshot under the same lock, consumes the exact QR event IDs and closes the captured manual source rounds in its publication transaction. A preview cannot publish before its window starts. Changed manual counters, new eligible acceptances/cancellations, previously consumed inputs and legacy previews without source accounting are rejected (HTTP 409 CONFLICT); use the automatic transition to recalculate. Automatic transitions remain the normal scheduler. Published manual demand cannot be counted again at the next transition.

## Preventing cross-source double counting

The editable bartender counter is labeled "Вне QR"; each card and status show a separate read-only QR count. QR positions must never be added to manual counters. Absolute quantity sets only OFFLINE manual sales and cannot erase QR events. For accidental double entry, compare the source counts and correct the manual counter during the active round. There is no automatic identity inference for anonymous manual counters: the system cannot prove two counters describe the same physical drink.

GET /api/v1/command-center/order-events/diagnostics?roundId=<UUID> uses the same service key. It returns event status totals, delivery/duplicate counts, global rejected-attempt count, last 100 accepted events and per-product manual/QR reconciliation for the selected round. Omitting roundId gives global event totals; manual totals require a round. No credential or guest PII is returned.

Command Center sales reporting includes signed QR event quantities and snapshot gross revenue. exchange_sales rows are counters, not complete customer checks: ordersCount and averageCheck are null, qrOrdersCount counts known QR order IDs, and salesLinesCount names line counts explicitly. Guest discounts, payment settlement and loyalty-adjusted revenue remain in Command Center. iiko receipts are excluded from these totals until mapped and deduplicated.

## Public pricing compatibility

GET /api/v1/public/snapshot remains read-only and never starts a price-writing job. It returns the existing generatedAt, timezone, status, currentRound and products shapes. No active published round means no_published_round/currentRound=null: the catalog is not a quote and Command Center must refuse checkout until a valid round exists. IDs remain exchangeProduct UUIDs, not names or iiko IDs.

The snapshot derives price and level/discount from the actual published RoundPrice, so live product metadata cannot silently relabel a stale quote. Product catalog, TV/current-round endpoints and categories remain compatible. Only the scheduler/administrative publisher advances pricing.

## Railway deployment

Service: hostess-XOXO in the existing hostess project, production environment. Shared PostgreSQL remains unchanged. Existing variables DATABASE_URL and COMMAND_CENTER_SERVICE_KEY are reused. The only new variable is QR_ORDER_EVENTS_ENABLED (default false).

railway.toml declares preDeployCommand="npm run db:migrate:deploy"; startCommand remains npm run start. Prisma 5.22.0 is a runtime dependency, so migration CLI survives production dependency pruning. There is no seed/reset/db push on start. Existing migrations are unchanged.

1. Run CI on Node 22 with PostgreSQL: install, migrations on an empty test DB, second deploy no-op, schema/migration diff, typecheck, lint, build, contract tests, full unit and PostgreSQL regressions.
2. Push the verified commit to main. Verify Railway picks that SHA and executes pre-deploy successfully before replacing the service.
3. Verify /health and read-only /api/v1/public/snapshot. Confirm an active published round and price IDs match the quote consumer.
4. Enable QR_ORDER_EVENTS_ENABLED=true only for hostess-XOXO after the Command Center outbox is configured for https://hostess-xoxo-production.up.railway.app/api/v1/command-center/order-events and shares the existing service credential. Do not change the existing credential during rollout.
5. Inspect authenticated diagnostics and outbox backlog; manually reconcile the first real order and cancellation against staff records.

If Railway dashboard overrides configuration, set Pre-deploy Command to npm run db:migrate:deploy, ensure the deployed image includes Prisma CLI, and inspect the actual deployment logs. An existing shared DB must already have its prior Prisma history applied: investigate any unexpected baseline failure, never reset, force-resolve or sync the production schema to make deployment green.

Rollback: set the flag false, retain queued outbox events and additive tables, then redeploy the prior application SHA if necessary. Do not remove tables or migration history. Finish retrying retained events after recovery.

## Validation and limitations

CI provisions isolated PostgreSQL databases, never production data. QR_TEST_DATABASE_URL must name qr_integration_test (the test suite enforces this). The existing exchange regression suite uses a separate exchange_regression_test database. The workflow runs all tests and schema checks and repeats migrate deploy to detect non-idempotent deployment behavior.

The final production audit and exact validation SHAs are recorded in QR_PRODUCTION_READINESS.md. The actual Command Center DINE_IN_API_CONTRACT.md and outbox implementation were inspected; no wire changes were required. Local tests include real PostgreSQL and real HTTP checkout/outbox/delivery/cancellation between the two services. No production guest purchase is implied by test success. Live end-to-end behavior also depends on the Command Center outbox and Hostess frontend rollout.

### Reproduce the cross-service test

Use Node 22 and a checkout of Command Center with dependencies installed. Create two fresh, empty local databases named `xoxo_cross_test` and `command_cross_test`; the harness refuses other names and non-local hosts. Set `CROSS_RECEIVER_DATABASE_URL`, `CROSS_SENDER_DATABASE_URL`, and `COMMAND_CENTER_SOURCE_ROOT` to those test connections and the sender checkout. Apply XOXO migrations with `DATABASE_URL=$CROSS_RECEIVER_DATABASE_URL npm run db:migrate:deploy`, then run `npm run test:command-center-e2e`. The harness applies only Command Center SQL migrations to the fresh sender test database; XOXO Prisma never manages its tables.

It uses a real local HTTP listener and the real Command Center checkout/outbox: disabled receiver retains a retryable event, enabling it yields a matching ACK and delivered outbox row, replay remains one sale, full cancellation delivers and nets demand to zero, and the original published price stays 1590 KZT. Recreate only these disposable local databases before rerunning; no production credentials are used.

The public Hostess origin is `https://hostes.online`. Add it to XOXO `CORS_ORIGINS` while retaining other required trusted frontend origins. Service keys remain server-side and are not added to browser CORS headers.

Existing schema drift corrected: the historical products(is_active) index is now represented in Prisma schema; no index is dropped or rebuilt.
