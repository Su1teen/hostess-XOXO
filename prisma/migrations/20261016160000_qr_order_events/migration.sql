-- Additive exchange-owned tables only. No changes to shared Command Center tables.
CREATE TABLE "exchange_order_events" (
  "id" UUID NOT NULL,
  "external_event_id" UUID NOT NULL,
  "command_center_order_id" UUID NOT NULL,
  "command_center_order_item_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "exchange_product_id" UUID NOT NULL,
  "round_id" UUID NOT NULL,
  "quantity" INTEGER NOT NULL,
  "unit_price_snapshot" DECIMAL(12,2) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processing_status" TEXT NOT NULL DEFAULT 'PENDING',
  "processed_at" TIMESTAMP(3),
  "applied_to_round_id" UUID,
  "payload_hash" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  CONSTRAINT "exchange_order_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "exchange_order_events_quantity_positive" CHECK (quantity > 0),
  CONSTRAINT "exchange_order_events_type_valid" CHECK (event_type IN ('ORDER_ACCEPTED','ORDER_CANCELLED')),
  CONSTRAINT "exchange_order_events_price_nonnegative" CHECK (unit_price_snapshot >= 0),
  CONSTRAINT "exchange_order_events_status_valid" CHECK (processing_status IN ('PENDING','APPLIED','HISTORICAL_ONLY'))
);
CREATE TABLE "exchange_order_deliveries" (
  "external_event_id" UUID NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "event_id" UUID NOT NULL,
  "duplicate_count" INTEGER NOT NULL DEFAULT 0,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "exchange_order_deliveries_pkey" PRIMARY KEY ("external_event_id")
);
CREATE UNIQUE INDEX "exchange_order_events_external_event_id_key" ON "exchange_order_events"("external_event_id");
CREATE UNIQUE INDEX "exchange_order_events_command_center_order_item_id_event_ty_key" ON "exchange_order_events"("command_center_order_item_id","event_type");
CREATE INDEX "exchange_order_events_round_id_exchange_product_id_idx" ON "exchange_order_events"("round_id","exchange_product_id");
CREATE INDEX "exchange_order_events_processing_status_occurred_at_idx" ON "exchange_order_events"("processing_status","occurred_at");
CREATE INDEX "exchange_order_events_command_center_order_id_idx" ON "exchange_order_events"("command_center_order_id");
CREATE INDEX "exchange_order_deliveries_event_id_idx" ON "exchange_order_deliveries"("event_id");
ALTER TABLE "exchange_order_events" ADD CONSTRAINT "exchange_order_events_exchange_product_id_fkey" FOREIGN KEY ("exchange_product_id") REFERENCES "exchange_products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exchange_order_events" ADD CONSTRAINT "exchange_order_events_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "price_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exchange_order_events" ADD CONSTRAINT "exchange_order_events_applied_to_round_id_fkey" FOREIGN KEY ("applied_to_round_id") REFERENCES "price_rounds"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "exchange_order_deliveries" ADD CONSTRAINT "exchange_order_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "exchange_order_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
