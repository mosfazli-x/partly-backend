BEGIN;
CREATE TYPE "Role" AS ENUM ('CUSTOMER', 'VENDOR', 'ADMIN');
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'PENDING', 'SUSPENDED');
CREATE TYPE "ProductStatus" AS ENUM ('ACTIVE', 'PENDING', 'REJECTED');
CREATE TYPE "OrderStatus" AS ENUM ('PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED');
CREATE TYPE "PaymentMethod" AS ENUM ('COD');
CREATE TABLE "User" (
  "id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT NOT NULL, "passwordHash" TEXT NOT NULL,
  "role" "Role" NOT NULL DEFAULT 'CUSTOMER', "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
  "shopName" TEXT, "phone" TEXT, "address" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE TABLE "Session" (
  "id" TEXT PRIMARY KEY, "tokenHash" TEXT NOT NULL, "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
-- Legacy products retain their price and stock, remain active, and have no vendor.
ALTER TABLE "Product" ADD COLUMN "vendorId" TEXT,
  ADD COLUMN "status" "ProductStatus" NOT NULL DEFAULT 'ACTIVE',
  ADD CONSTRAINT "Product_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Product_vendorId_status_idx" ON "Product"("vendorId", "status");
CREATE INDEX "Product_status_createdAt_idx" ON "Product"("status", "createdAt");
CREATE TABLE "Order" (
  "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
  "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'COD', "total" DECIMAL(16,2) NOT NULL,
  "name" TEXT NOT NULL, "phone" TEXT NOT NULL, "address" TEXT NOT NULL, "postalCode" TEXT NOT NULL, "note" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "Order_userId_createdAt_idx" ON "Order"("userId", "createdAt");
CREATE TABLE "OrderItem" (
  "id" TEXT PRIMARY KEY, "orderId" TEXT NOT NULL, "productId" TEXT NOT NULL, "vendorId" TEXT,
  "name" TEXT NOT NULL, "sku" TEXT NOT NULL, "image" TEXT NOT NULL, "price" DECIMAL(12,2) NOT NULL,
  "quantity" INTEGER NOT NULL, "status" "OrderStatus" NOT NULL DEFAULT 'PENDING',
  CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OrderItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "OrderItem_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");
CREATE INDEX "OrderItem_vendorId_status_idx" ON "OrderItem"("vendorId", "status");
COMMIT;
