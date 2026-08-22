-- Ручные скидки бармена: originalPrice как база расчёта и хранение скидок.
-- Миграция аддитивная: колонки и данные не удаляются.

ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BARTENDER_LOGIN';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BARTENDER_PRICE_APPLIED';
ALTER TYPE "AuditAction" ADD VALUE IF NOT EXISTS 'BARTENDER_SALE_RECORDED';

ALTER TABLE "exchange_products" ADD COLUMN "original_price" DECIMAL(12,2);
ALTER TABLE "exchange_products" ADD COLUMN "current_discount_percent" DECIMAL(9,4) NOT NULL DEFAULT 0;
ALTER TABLE "exchange_products" ADD COLUMN "actual_discount_percent" DECIMAL(9,4);
ALTER TABLE "exchange_products" ADD COLUMN "manual_price_applied_at" TIMESTAMP(3);

-- До этой миграции start_price хранил цену меню (без скидки).
UPDATE "exchange_products" SET "original_price" = "start_price" WHERE "original_price" IS NULL;

-- Биржа стартует с minPrice: приводим стартовую и текущую цену к минимуму,
-- если позиция ещё стоит на устаревшей стартовой цене (= цена меню).
UPDATE "exchange_products" SET "current_price" = "min_price" WHERE "current_price" >= "original_price";
UPDATE "exchange_products" SET "start_price" = "min_price";

UPDATE "exchange_products"
SET "current_discount_percent" = ROUND(("original_price" - "current_price") / "original_price" * 100, 4)
WHERE "original_price" > 0;

ALTER TABLE "exchange_products" ALTER COLUMN "original_price" SET NOT NULL;

ALTER TABLE "round_prices" ADD COLUMN "original_price" DECIMAL(12,2);
ALTER TABLE "round_prices" ADD COLUMN "selected_discount_percent" DECIMAL(9,4);
ALTER TABLE "round_prices" ADD COLUMN "actual_discount_percent" DECIMAL(9,4);

ALTER TABLE "exchange_sales" ADD COLUMN "selected_discount_percent_at_sale" DECIMAL(9,4);
ALTER TABLE "exchange_sales" ADD COLUMN "actual_discount_percent_at_sale" DECIMAL(9,4);
