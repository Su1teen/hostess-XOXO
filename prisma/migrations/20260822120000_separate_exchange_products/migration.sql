-- Separate exchange catalog from the legacy iiko/general products table.
-- Additive migration: existing catalog rows and round data are preserved.

CREATE TABLE "exchange_products" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "volume_ml" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'KZT',
    "start_price" DECIMAL(12,2) NOT NULL,
    "current_price" DECIMAL(12,2) NOT NULL,
    "min_price" DECIMAL(12,2) NOT NULL,
    "max_price" DECIMAL(12,2) NOT NULL,
    "price_step" DECIMAL(12,2) NOT NULL DEFAULT 50,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "exchange_products_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "exchange_products_slug_key" ON "exchange_products"("slug");
CREATE INDEX "exchange_products_is_active_idx" ON "exchange_products"("is_active");
CREATE INDEX "exchange_products_category_idx" ON "exchange_products"("category");

ALTER TABLE "round_prices" ALTER COLUMN "product_id" DROP NOT NULL;
ALTER TABLE "round_prices" ADD COLUMN "exchange_product_id" UUID;
ALTER TABLE "round_prices" ALTER COLUMN "previous_price" DROP NOT NULL;
CREATE UNIQUE INDEX "round_prices_round_id_exchange_product_id_key" ON "round_prices"("round_id", "exchange_product_id");
CREATE INDEX "round_prices_exchange_product_id_idx" ON "round_prices"("exchange_product_id");
ALTER TABLE "round_prices" ADD CONSTRAINT "round_prices_exchange_product_id_fkey" FOREIGN KEY ("exchange_product_id") REFERENCES "exchange_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "exchange_sales" ALTER COLUMN "product_id" DROP NOT NULL;
ALTER TABLE "exchange_sales" ADD COLUMN "exchange_product_id" UUID;
CREATE UNIQUE INDEX "exchange_sales_round_id_exchange_product_id_key" ON "exchange_sales"("round_id", "exchange_product_id");
CREATE INDEX "exchange_sales_round_id_exchange_product_id_idx" ON "exchange_sales"("round_id", "exchange_product_id");
ALTER TABLE "exchange_sales" ADD CONSTRAINT "exchange_sales_exchange_product_id_fkey" FOREIGN KEY ("exchange_product_id") REFERENCES "exchange_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "crash_events" ALTER COLUMN "product_id" DROP NOT NULL;
ALTER TABLE "crash_events" ADD COLUMN "exchange_product_id" UUID;
CREATE INDEX "crash_events_round_id_exchange_product_id_idx" ON "crash_events"("round_id", "exchange_product_id");
ALTER TABLE "crash_events" ADD CONSTRAINT "crash_events_exchange_product_id_fkey" FOREIGN KEY ("exchange_product_id") REFERENCES "exchange_products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
