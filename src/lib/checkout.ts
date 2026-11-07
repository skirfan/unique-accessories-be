import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { env } from "../env.js";
import { fail } from "./http-error.js";
import { hash } from "./admin-auth.js";

export const basketSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            variantId: z.string().min(1).max(100),
            quantity: z.number().int().min(1).max(99),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    couponCode: z.string().trim().max(40).nullable().optional(),
  })
  .strict()
  .refine(
    (b) => new Set(b.items.map((i) => i.variantId)).size === b.items.length,
    "Duplicate variants are not allowed.",
  );
export const orderSchema = z
  .object({
    basket: basketSchema,
    customer: z
      .object({
        name: z.string().trim().min(2).max(100),
        email: z.string().trim().email().max(254),
        phone: z
          .string()
          .trim()
          .regex(
            /^(?:\+91[ -]?)?[6-9]\d{9}$/,
            "Enter a valid Indian mobile number.",
          ),
      })
      .strict(),
    address: z
      .object({
        line1: z.string().trim().min(5).max(200),
        line2: z.string().trim().max(200).default(""),
        city: z.string().trim().min(2).max(100),
        state: z.string().trim().min(2).max(100),
        pincode: z
          .string()
          .regex(/^[1-9]\d{5}$/, "Enter a valid 6-digit PIN code."),
      })
      .strict(),
    paymentMethod: z.enum(["COD", "UPI"]),
    idempotencyKey: z.string().uuid(),
    quoteToken: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type Basket = z.infer<typeof basketSchema>;
const paise = (value: Prisma.Decimal | number) =>
  Math.round(Number(value) * 100);

export async function quoteBasket(
  tx: Prisma.TransactionClient,
  basket: Basket,
) {
  const settings = await tx.storeSettings.findUniqueOrThrow({
    where: { id: "store" },
  });
  const variants = await tx.productVariant.findMany({
    where: { id: { in: basket.items.map((i) => i.variantId) } },
    include: { inventory: true, product: true },
  });
  const lines = basket.items.map((item) => {
    const variant = variants.find((v) => v.id === item.variantId);
    if (!variant || !variant.isActive || variant.product.status !== "PUBLISHED")
      fail(409, "An item is no longer available. Please update your cart.");
    const available = Math.max(
      0,
      (variant.inventory?.quantity ?? 0) - (variant.inventory?.reserved ?? 0),
    );
    if (item.quantity > available)
      fail(409, `Only ${available} of ${variant.product.name} are available.`);
    return {
      variantId: variant.id,
      productName: variant.product.name,
      productSlug: variant.product.slug,
      variantLabel:
        [variant.color, variant.capacity, variant.material]
          .filter(Boolean)
          .join(" / ") || "Standard",
      sku: variant.sku,
      unitPrice: paise(variant.price) / 100,
      quantity: item.quantity,
      stock: available,
    };
  });
  const subtotalP = lines.reduce(
    (sum, l) => sum + Math.round(l.unitPrice * 100) * l.quantity,
    0,
  );
  let discountP = 0;
  let couponCode: string | null = null;
  if (basket.couponCode) {
    const coupon = await tx.coupon.findUnique({
      where: { code: basket.couponCode.toUpperCase() },
    });
    if (!coupon || (coupon.expiresAt && coupon.expiresAt <= new Date()))
      fail(400, "That coupon is invalid or expired.");
    if (subtotalP < paise(coupon.minOrderValue ?? 0))
      fail(400, `This coupon requires a subtotal of ₹${coupon.minOrderValue}.`);
    if (coupon.usageLimit !== null) {
      const used = await tx.order.count({
        where: {
          couponCode: coupon.code,
          status: { notIn: ["REJECTED", "CANCELLED"] },
        },
      });
      if (used >= coupon.usageLimit)
        fail(400, "That coupon has reached its usage limit.");
    }
    discountP = Math.min(
      subtotalP,
      coupon.type === "PERCENT"
        ? Math.round((subtotalP * Number(coupon.value)) / 100)
        : paise(coupon.value),
    );
    couponCode = coupon.code;
  }
  const netP = subtotalP - discountP;
  const shippingP =
    netP >= paise(settings.freeShippingThreshold)
      ? 0
      : paise(settings.shippingFee);
  const remainingP = settings.minimumOrderEnabled
    ? Math.max(0, paise(settings.minimumOrderAmount) - netP)
    : 0;
  const result = {
    lines,
    couponCode,
    subtotal: subtotalP / 100,
    discount: discountP / 100,
    shippingFee: shippingP / 100,
    total: (netP + shippingP) / 100,
    minimumOrderEnabled: settings.minimumOrderEnabled,
    minimumOrderAmount: Number(settings.minimumOrderAmount),
    remainingForMinimum: remainingP / 100,
    eligible: remainingP === 0,
    settingsVersion: settings.version,
  };
  // Recomputed at submission; a price/settings change requires customer review.
  const quoteToken = hash(
    JSON.stringify({
      ...result,
      lines: lines.map(({ stock: _stock, ...l }) => l),
    }),
  );
  return { ...result, quoteToken };
}
export function orderAccessToken(idempotencyKey: string) {
  if (!env.ADMIN_SESSION_SECRET)
    fail(503, "Order submission is not configured.");
  return createHmac("sha256", env.ADMIN_SESSION_SECRET)
    .update(`order:${idempotencyKey}`)
    .digest("hex");
}

// Serializable transactions retry conflicts from concurrent order/stock updates.
export async function transaction<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const { prisma } = await import("./prisma.js");
  for (let attempt = 0; ; attempt++) {
    try {
      return await prisma.$transaction(fn, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    } catch (err) {
      const conflict =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        (err.code === "P2034" ||
          (err.code === "P2010" &&
            ["40001", "40P01"].includes(String(err.meta?.code))));
      if (conflict && attempt < 3) continue;
      if (conflict)
        fail(
          409,
          "Another request changed this order or stock. Refresh and try again.",
        );
      throw err;
    }
  }
}
