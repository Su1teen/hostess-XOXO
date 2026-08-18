ALTER TABLE "products"
  ADD COLUMN "is_drink_candidate" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "products_is_drink_candidate_idx"
  ON "products"("is_drink_candidate");

UPDATE "products"
SET "iiko_size_id" = NULL
WHERE "iiko_size_id" = '__no_size__';

DROP INDEX "products_organization_id_iiko_item_id_iiko_size_id_key";

CREATE UNIQUE INDEX "products_organization_id_iiko_item_id_iiko_size_id_key"
  ON "products"("organization_id", "iiko_item_id", "iiko_size_id") NULLS NOT DISTINCT;
