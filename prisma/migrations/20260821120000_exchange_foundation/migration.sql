-- Exchange foundation: собственные биржевые позиции, продажи и crash-event структура.
-- Только additive changes; существующие iiko/read-only данные не удаляются.

CREATE TYPE "RoundType" AS ENUM ('NORMAL', 'CRASH');
CREATE TYPE "SaleSource" AS ENUM ('MANUAL_PANEL');

ALTER TABLE "products" ALTER COLUMN "iiko_item_id" DROP NOT NULL;
ALTER TABLE "products" ADD COLUMN "exchange_key" TEXT;
ALTER TABLE "products" ADD COLUMN "category" TEXT;
ALTER TABLE "products" ADD COLUMN "volume_ml" INTEGER;
ALTER TABLE "products" ADD COLUMN "start_price" DECIMAL(12,2);
ALTER TABLE "products" ADD COLUMN "current_price" DECIMAL(12,2);
CREATE UNIQUE INDEX "products_exchange_key_key" ON "products"("exchange_key");

ALTER TABLE "price_rounds" ADD COLUMN "type" "RoundType" NOT NULL DEFAULT 'NORMAL';
ALTER TABLE "round_prices" ADD COLUMN "price" DECIMAL(12,2);
UPDATE "round_prices" SET "price" = COALESCE("published_price", "calculated_price");
ALTER TABLE "round_prices" ALTER COLUMN "price" SET NOT NULL;
ALTER TABLE "round_prices" ADD COLUMN "sold_quantity" DECIMAL(12,3) NOT NULL DEFAULT 0;

CREATE TABLE "exchange_sales" (
    "id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "price_at_sale" DECIMAL(12,2) NOT NULL,
    "source" "SaleSource" NOT NULL DEFAULT 'MANUAL_PANEL',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "exchange_sales_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "crash_events" (
    "id" UUID NOT NULL,
    "round_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "discount_percent" DECIMAL(6,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "crash_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "exchange_sales_round_id_product_id_key" ON "exchange_sales"("round_id", "product_id");
CREATE INDEX "exchange_sales_round_id_product_id_idx" ON "exchange_sales"("round_id", "product_id");
CREATE INDEX "crash_events_round_id_product_id_idx" ON "crash_events"("round_id", "product_id");
ALTER TABLE "exchange_sales" ADD CONSTRAINT "exchange_sales_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "price_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "exchange_sales" ADD CONSTRAINT "exchange_sales_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crash_events" ADD CONSTRAINT "crash_events_round_id_fkey" FOREIGN KEY ("round_id") REFERENCES "price_rounds"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "crash_events" ADD CONSTRAINT "crash_events_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
