-- Add discrete exchange price levels without changing existing canonical prices.
ALTER TABLE "exchange_products"
  ADD COLUMN "price_level_percent" INTEGER NOT NULL DEFAULT -30;

UPDATE "exchange_products"
SET "price_level_percent" = CASE
  WHEN "original_price" = 0 THEN 0
  WHEN (("original_price" - "current_price") / "original_price") * 100 < -25 THEN -30
  WHEN (("original_price" - "current_price") / "original_price") * 100 < -15 THEN -20
  WHEN (("original_price" - "current_price") / "original_price") * 100 < -5 THEN -10
  WHEN (("original_price" - "current_price") / "original_price") * 100 < 5 THEN 0
  WHEN (("original_price" - "current_price") / "original_price") * 100 < 15 THEN 10
  WHEN (("original_price" - "current_price") / "original_price") * 100 < 25 THEN 20
  WHEN (("original_price" - "current_price") / "original_price") * 100 < 35 THEN 30
  WHEN (("original_price" - "current_price") / "original_price") * 100 < 45 THEN 40
  WHEN (("original_price" - "current_price") / "original_price") * 100 < 55 THEN 50
  WHEN (("original_price" - "current_price") / "original_price") * 100 < 65 THEN 60
  ELSE 70
END;

ALTER TABLE "round_prices"
  ADD COLUMN "price_level_percent" INTEGER,
  ADD COLUMN "discount_percent" DECIMAL(9,4);

UPDATE "round_prices" AS rp
SET
  "price_level_percent" = ep."price_level_percent",
  "discount_percent" = COALESCE(rp."actual_discount_percent", rp."selected_discount_percent")
FROM "exchange_products" AS ep
WHERE rp."exchange_product_id" = ep."id";

ALTER TABLE "exchange_sales"
  ADD COLUMN "price_level_percent_at_sale" INTEGER,
  ADD COLUMN "discount_percent_at_sale" DECIMAL(9,4);

UPDATE "exchange_sales" AS es
SET
  "price_level_percent_at_sale" = ep."price_level_percent",
  "discount_percent_at_sale" = COALESCE(es."actual_discount_percent_at_sale", es."selected_discount_percent_at_sale")
FROM "exchange_products" AS ep
WHERE es."exchange_product_id" = ep."id";
