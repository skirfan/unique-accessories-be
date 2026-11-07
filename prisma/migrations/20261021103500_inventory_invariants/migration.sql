-- Keep inventory valid even when modified outside the application.
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_nonnegative_stock" CHECK ("quantity" >= 0 AND "reserved" >= 0 AND "quantity" >= "reserved");
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_positive_version" CHECK ("version" > 0);
CREATE UNIQUE INDEX "ProductVariant_sku_case_insensitive_key" ON "ProductVariant" (lower("sku"));
