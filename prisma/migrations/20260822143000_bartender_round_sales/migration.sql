-- Fixed-price rounds, bartender discount snapshots, and individual sale history.
ALTER TABLE "exchange_products" ADD COLUMN "original_price" DECIMAL(12,2) NOT NULL DEFAULT 0;
UPDATE "exchange_products" SET "original_price" = "start_price" WHERE "original_price" = 0;
UPDATE "exchange_products" SET "current_price" = "min_price" WHERE "current_price" = "start_price";
ALTER TABLE "exchange_products" ADD COLUMN "current_discount_percent" DECIMAL(6,2) NOT NULL DEFAULT 0;
ALTER TABLE "exchange_products" ADD COLUMN "actual_discount_percent" DECIMAL(6,2);
UPDATE "exchange_products" SET "current_discount_percent" = CASE WHEN "original_price" = 0 THEN 0 ELSE ROUND(("original_price" - "current_price") / "original_price" * 100, 2) END;
ALTER TABLE "round_prices" ADD COLUMN "selected_discount_percent" DECIMAL(6,2) NOT NULL DEFAULT 0;
ALTER TABLE "round_prices" ADD COLUMN "actual_discount_percent" DECIMAL(6,2) NOT NULL DEFAULT 0;
ALTER TABLE "exchange_sales" ADD COLUMN "selected_discount_percent_at_sale" DECIMAL(6,2) NOT NULL DEFAULT 0;
ALTER TABLE "exchange_sales" ADD COLUMN "actual_discount_percent_at_sale" DECIMAL(6,2) NOT NULL DEFAULT 0;
DROP INDEX IF EXISTS "exchange_sales_round_id_exchange_product_id_key";
DROP INDEX IF EXISTS "exchange_sales_round_id_product_id_key";
ALTER TYPE "RoundStatus" ADD VALUE IF NOT EXISTS 'CLOSED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'MANUAL_PRICE_APPLIED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'ROUND_TRANSITION';
