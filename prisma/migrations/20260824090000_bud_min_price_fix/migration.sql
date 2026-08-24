-- Data migration: fix Bud minPrice from 990 to 1550.
--
-- Bud originalPrice = 2190 KZT.
-- Canonical -30% level: 2190 * 0.70 = 1533, rounded to step 50 = 1550.
-- Old minPrice 990 corresponded to -54.79% — below the allowed -30% floor.
--
-- This migration:
-- 1. Sets minPrice = 1550, startPrice = 1550 for Bud (slug = 'bud-bottle').
-- 2. Lifts currentPrice to 1550 if it was at or below the old floor (990).
-- 3. Sets priceLevelPercent = -30 (canonical floor level).
-- 4. Recalculates discount percents relative to originalPrice.
-- 5. Does NOT touch closed round records (history preserved).
-- 6. Idempotent: only affects rows where minPrice = 990 (the old value).

UPDATE "exchange_products"
SET
  "min_price"   = 1550,
  "start_price" = 1550,
  "current_price" = GREATEST("current_price", 1550),
  "price_level_percent" = -30,
  "current_discount_percent" = (("original_price" - GREATEST("current_price", 1550)) / "original_price") * 100,
  "actual_discount_percent"  = (("original_price" - GREATEST("current_price", 1550)) / "original_price") * 100,
  "updated_at" = NOW()
WHERE "slug" = 'bud-bottle' AND "min_price" = 990;

-- Audit log entry for the data migration.
INSERT INTO "audit_logs" ("id", "action", "actor_type", "actor_id", "entity_type", "entity_id", "summary", "metadata", "created_at")
SELECT
  gen_random_uuid(),
  'PRODUCT_UPDATED'::"AuditAction",
  'SYSTEM',
  'migration-20260824090000',
  'ExchangeProduct',
  "id",
  'Bud minPrice исправлено: 990 → 1550 (canonical -30% от originalPrice 2190, округление до шага 50)',
  jsonb_build_object(
    'migration', '20260824090000_bud_min_price_fix',
    'slug', 'bud-bottle',
    'oldMinPrice', 990,
    'newMinPrice', 1550,
    'originalPrice', 2190,
    'priceLevelPercent', -30
  ),
  NOW()
FROM "exchange_products"
WHERE "slug" = 'bud-bottle' AND "min_price" = 990;
