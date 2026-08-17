-- Migration: external menu variants (item + size) + drop product_groups.
-- iikoItemId + iikoSizeId дают уникальный sellable вариант товара.

-- 1. Убираем старый unique constraint (organization_id, iiko_product_id).
DROP INDEX IF EXISTS "products_organization_id_iiko_product_id_key";

-- 2. Делаем iiko_product_id nullable (API может использовать иное поле).
ALTER TABLE "products" ALTER COLUMN "iiko_product_id" DROP NOT NULL;

-- 3. Добавляем новые колонки.
ALTER TABLE "products" ADD COLUMN "iiko_item_id" TEXT;
ALTER TABLE "products" ADD COLUMN "iiko_size_id" TEXT;
ALTER TABLE "products" ADD COLUMN "display_name" TEXT;
ALTER TABLE "products" ADD COLUMN "size_name" TEXT;
ALTER TABLE "products" ADD COLUMN "size_code" TEXT;
ALTER TABLE "products" ADD COLUMN "category_id" TEXT;
ALTER TABLE "products" ADD COLUMN "category_name" TEXT;
ALTER TABLE "products" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'KZT';
ALTER TABLE "products" ADD COLUMN "is_sellable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "products" ADD COLUMN "is_available" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "products" ADD COLUMN "source_menu_id" TEXT;
ALTER TABLE "products" ADD COLUMN "source_external_menu_id" TEXT;
ALTER TABLE "products" ADD COLUMN "source_metadata" JSONB;
ALTER TABLE "products" ADD COLUMN "sync_warnings" JSONB;
ALTER TABLE "products" ADD COLUMN "last_seen_at" TIMESTAMP(3);

-- 4. Backfill существующих строк: item = product, size = fallback, display_name = name.
UPDATE "products"
SET
  "iiko_item_id" = "iiko_product_id",
  "iiko_size_id" = '__no_size__',
  "display_name" = "name",
  "last_seen_at" = COALESCE("synced_at", "updated_at")
WHERE "iiko_item_id" IS NULL;

-- 5. Теперь iiko_item_id обязателен.
ALTER TABLE "products" ALTER COLUMN "iiko_item_id" SET NOT NULL;
ALTER TABLE "products" ALTER COLUMN "display_name" SET NOT NULL;

-- 6. Новый unique constraint: (organization_id, iiko_item_id, iiko_size_id).
-- iiko_size_id nullable в схеме, но приложение всегда подставляет fallback,
-- поэтому NULL-значений в уникальном индексе не возникает.
CREATE UNIQUE INDEX "products_organization_id_iiko_item_id_iiko_size_id_key"
  ON "products"("organization_id", "iiko_item_id", "iiko_size_id");

-- 7. Новые индексы.
CREATE INDEX "products_display_name_idx" ON "products"("display_name");
CREATE INDEX "products_category_name_idx" ON "products"("category_name");
CREATE INDEX "products_is_sellable_idx" ON "products"("is_sellable");
CREATE INDEX "products_synced_at_idx" ON "products"("synced_at");
CREATE INDEX "products_iiko_product_id_idx" ON "products"("iiko_product_id");

-- 8. Удаляем таблицу product_groups (категории теперь хранятся на Product).
DROP TABLE IF EXISTS "product_groups";
