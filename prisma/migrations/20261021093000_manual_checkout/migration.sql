-- CreateEnum
CREATE TYPE "ManualPaymentMethod" AS ENUM ('COD', 'UPI');

-- CreateEnum
CREATE TYPE "ManualPaymentStatus" AS ENUM ('UNPAID', 'PENDING_VERIFICATION', 'PAID', 'REFUND_REQUIRED', 'REFUNDED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.




-- DropForeignKey
ALTER TABLE "Order" DROP CONSTRAINT "Order_userId_fkey";

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "accessTokenHash" TEXT NOT NULL,
ADD COLUMN     "customerEmail" TEXT NOT NULL,
ADD COLUMN     "customerName" TEXT NOT NULL,
ADD COLUMN     "customerPhone" TEXT NOT NULL,
ADD COLUMN     "idempotencyKey" TEXT NOT NULL,
ADD COLUMN     "manualPaymentStatus" "ManualPaymentStatus" NOT NULL DEFAULT 'UNPAID',
ADD COLUMN     "paymentMethod" "ManualPaymentMethod" NOT NULL,
ADD COLUMN     "paymentReference" TEXT,
ADD COLUMN     "paymentVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "paymentVerifiedBy" TEXT,
ADD COLUMN     "reference" TEXT NOT NULL,
ADD COLUMN     "requestHash" TEXT NOT NULL,
ADD COLUMN     "stockAllocated" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trackingNumber" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "userId" DROP NOT NULL,
ALTER COLUMN "status" SET DEFAULT 'AWAITING_APPROVAL';

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "productName" TEXT NOT NULL,
ADD COLUMN     "productSlug" TEXT NOT NULL,
ADD COLUMN     "sku" TEXT NOT NULL,
ADD COLUMN     "variantLabel" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "OrderStatusHistory" ADD COLUMN     "actor" TEXT;

-- CreateTable
CREATE TABLE "StoreSettings" (
    "id" TEXT NOT NULL DEFAULT 'store',
    "minimumOrderEnabled" BOOLEAN NOT NULL DEFAULT true,
    "minimumOrderAmount" DECIMAL(10,2) NOT NULL DEFAULT 199,
    "shippingFee" DECIMAL(10,2) NOT NULL DEFAULT 79,
    "freeShippingThreshold" DECIMAL(10,2) NOT NULL DEFAULT 999,
    "codEnabled" BOOLEAN NOT NULL DEFAULT true,
    "upiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "whatsappNumber" TEXT NOT NULL DEFAULT '',
    "upiId" TEXT NOT NULL DEFAULT '',
    "upiName" TEXT NOT NULL DEFAULT '',
    "paymentInstructions" TEXT NOT NULL DEFAULT 'Pay only after your order is accepted. Include your order reference in the payment note.',
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreSettings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_reference_key" ON "Order"("reference");

-- CreateIndex
CREATE UNIQUE INDEX "Order_accessTokenHash_key" ON "Order"("accessTokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "Order_idempotencyKey_key" ON "Order"("idempotencyKey");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Enforce core monetary and inventory invariants below the API boundary.
ALTER TABLE "StoreSettings" ADD CONSTRAINT "StoreSettings_nonnegative_money"
CHECK ("minimumOrderAmount" >= 0 AND "shippingFee" >= 0 AND "freeShippingThreshold" >= 0);
ALTER TABLE "Inventory" ADD CONSTRAINT "Inventory_valid_stock"
CHECK ("quantity" >= 0 AND "reserved" >= 0 AND "reserved" <= "quantity");
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_positive_quantity" CHECK ("quantity" > 0 AND "unitPrice" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_valid_totals" CHECK ("subtotal" >= 0 AND "discount" >= 0 AND "discount" <= "subtotal" AND "shippingFee" >= 0 AND "total" = "subtotal" - "discount" + "shippingFee");
