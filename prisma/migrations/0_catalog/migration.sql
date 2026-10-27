-- Baseline of the existing catalog. On an existing matching catalog, mark this
-- migration applied with `prisma migrate resolve --applied 0_catalog` instead of executing it.
BEGIN;
CREATE TYPE "VehicleType" AS ENUM ('CAR', 'MOTORCYCLE', 'TRUCK');
CREATE TYPE "ProductCondition" AS ENUM ('NEW', 'REFURBISHED', 'USED');
CREATE TABLE "VehicleMake" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "slug" TEXT NOT NULL,
  "type" "VehicleType" NOT NULL, "logo" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "VehicleModel" (
  "id" TEXT PRIMARY KEY, "makeId" TEXT NOT NULL, "name" TEXT NOT NULL, "slug" TEXT NOT NULL,
  "yearFrom" INTEGER, "yearTo" INTEGER, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VehicleModel_makeId_fkey" FOREIGN KEY ("makeId") REFERENCES "VehicleMake"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "VehicleVariant" (
  "id" TEXT PRIMARY KEY, "modelId" TEXT NOT NULL, "name" TEXT NOT NULL, "slug" TEXT NOT NULL,
  "engine" TEXT, "years" TEXT, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VehicleVariant_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "VehicleModel"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "Category" (
  "id" TEXT PRIMARY KEY, "parentId" TEXT, "name" TEXT NOT NULL, "slug" TEXT NOT NULL,
  "description" TEXT, "icon" TEXT, "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE TABLE "Product" (
  "id" TEXT PRIMARY KEY, "sku" TEXT NOT NULL, "name" TEXT NOT NULL, "slug" TEXT NOT NULL,
  "description" TEXT NOT NULL, "price" DECIMAL(12,2) NOT NULL, "compareAt" DECIMAL(12,2),
  "stock" INTEGER NOT NULL DEFAULT 0, "condition" "ProductCondition" NOT NULL DEFAULT 'NEW',
  "brand" TEXT NOT NULL, "image" TEXT NOT NULL, "tags" TEXT[], "categoryId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Product_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE TABLE "ProductFitment" (
  "productId" TEXT NOT NULL, "variantId" TEXT NOT NULL,
  CONSTRAINT "ProductFitment_pkey" PRIMARY KEY ("productId", "variantId"),
  CONSTRAINT "ProductFitment_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProductFitment_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "VehicleVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE TABLE "ProductSpecification" (
  "id" TEXT PRIMARY KEY, "productId" TEXT NOT NULL, "name" TEXT NOT NULL, "value" TEXT NOT NULL,
  CONSTRAINT "ProductSpecification_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "VehicleMake_name_key" ON "VehicleMake"("name");
CREATE UNIQUE INDEX "VehicleMake_slug_key" ON "VehicleMake"("slug");
CREATE UNIQUE INDEX "VehicleModel_makeId_slug_key" ON "VehicleModel"("makeId", "slug");
CREATE INDEX "VehicleModel_makeId_idx" ON "VehicleModel"("makeId");
CREATE UNIQUE INDEX "VehicleVariant_modelId_slug_key" ON "VehicleVariant"("modelId", "slug");
CREATE INDEX "VehicleVariant_modelId_idx" ON "VehicleVariant"("modelId");
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");
CREATE INDEX "Category_parentId_idx" ON "Category"("parentId");
CREATE UNIQUE INDEX "Product_sku_key" ON "Product"("sku");
CREATE UNIQUE INDEX "Product_slug_key" ON "Product"("slug");
CREATE INDEX "Product_categoryId_idx" ON "Product"("categoryId");
CREATE INDEX "Product_brand_idx" ON "Product"("brand");
CREATE INDEX "ProductFitment_variantId_idx" ON "ProductFitment"("variantId");
CREATE INDEX "ProductSpecification_productId_idx" ON "ProductSpecification"("productId");
COMMIT;
