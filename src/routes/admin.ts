import { invoiceBrandingRoutes } from "./invoice-branding.js";
import { adminCatalogRoutes } from "./admin-catalog.js";
import type { Prisma } from "@prisma/client";
import { getAdminOverview } from "../lib/admin-overview.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { checkOrigin, login, logout, requireAdmin } from "../lib/admin-auth.js";
import { prisma } from "../lib/prisma.js";
import { fail } from "../lib/http-error.js";
import { transaction } from "../lib/checkout.js";
import { ensureInvoice, invoicePdf } from "../lib/invoice.js";
import { shippingAdminRoutes } from "./shipping.js";
import { getSettings, serializeSettings } from "../lib/settings.js";
import { orderInclude, serializeOrder } from "./orders.js";

const money = z
  .number()
  .min(0)
  .max(1_000_000)
  .refine(
    (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.000001,
    "Use at most two decimal places.",
  );
const qrImage = z
  .string()
  .max(750000)
  .nullable()
  .refine((value) => {
    if (value === null) return true;
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      value,
    );
    if (!match) return false;
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length > 512 * 1024) return false;
    return match[1] === "png"
      ? bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  }, "Upload a PNG or JPEG image up to 512 KB.");
const settingsSchema = z
  .object({
    autoApproveOrders: z.boolean(),
    sellerName: z.string().trim().min(2).max(150),
    sellerAddress: z.string().trim().max(1000),
    sellerEmail: z.union([z.email(), z.literal("")]),
    sellerPhone: z.string().trim().max(30),
    sellerGstin: z.string().trim().max(20),
    minimumOrderEnabled: z.boolean(),
    minimumOrderAmount: money,
    shippingFee: money,
    freeShippingThreshold: money,
    codEnabled: z.boolean(),
    upiEnabled: z.boolean(),
    whatsappNumber: z
      .string()
      .trim()
      .regex(
        /^(?:[1-9]\d{7,14})?$/,
        "Use country code and digits only, e.g. 919876543210.",
      ),
    upiId: z
      .string()
      .trim()
      .max(200)
      .refine(
        (v) => !v || /^[a-zA-Z0-9.\-_]+@[a-zA-Z0-9]+$/.test(v),
        "Enter a valid UPI ID.",
      ),
    upiName: z.string().trim().max(100),
    upiQrImage: qrImage,
    paymentInstructions: z.string().trim().max(1000),
    version: z.number().int().min(1),
  })
  .strict()
  .refine(
    (s) => !s.upiEnabled || Boolean((s.upiId || s.upiQrImage) && s.upiName),
    "A UPI ID or QR image, plus the recipient name, are required to enable UPI.",
  )
  .refine(
    (s) => s.codEnabled || s.upiEnabled,
    "Enable at least one payment option.",
  );

export async function adminRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  app.post(
    "/admin/login",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (request, reply) => {
      checkOrigin(request);
      const body = z
        .object({
          email: z.string().email(),
          password: z.string().min(1).max(200),
        })
        .strict()
        .parse(request.body);
      return login(body.email, body.password, reply);
    },
  );
  await app.register(async (protectedApp) => {
    protectedApp.addHook("preHandler", requireAdmin);
    await protectedApp.register(adminCatalogRoutes);
    await protectedApp.register(invoiceBrandingRoutes);
    await protectedApp.register(shippingAdminRoutes);
    protectedApp.get<{ Params: { reference: string } }>(
      "/admin/orders/:reference/invoice",
      async (request, reply) => {
        const order = await prisma.order.findUnique({
          where: { reference: request.params.reference },
          include: orderInclude,
        });
        if (!order) fail(404, "Order not found.");
        const snapshot = await ensureInvoice(order);
        return reply
          .type("application/pdf")
          .header(
            "Content-Disposition",
            `attachment; filename="${snapshot.number}.pdf"`,
          )
          .send(await invoicePdf(snapshot));
      },
    );
    protectedApp.get("/admin/session", async () => ({
      email: env.ADMIN_EMAIL,
    }));
    protectedApp.post("/admin/logout", async (_request, reply) => {
      logout(reply);
      return { ok: true };
    });
    protectedApp.get("/admin/overview", async (request) => {
      const { days } = z
        .object({ days: z.enum(["7", "30", "180", "365"]).default("30") })
        .parse(request.query);
      return getAdminOverview(Number(days) as 7 | 30 | 180 | 365);
    });
    protectedApp.get("/admin/settings", async () =>
      serializeSettings(await getSettings()),
    );
    protectedApp.patch("/admin/settings", async (request) => {
      const { version, ...data } = settingsSchema.parse(request.body);
      const update = await prisma.storeSettings.updateMany({
        where: { id: "store", version },
        data: { ...data, version: { increment: 1 } },
      });
      if (!update.count)
        fail(409, "Settings changed in another session. Reload and try again.");
      return serializeSettings(await getSettings());
    });
    protectedApp.get("/admin/orders", async (request) => {
      const { page, status, q, paymentStatus } = z
        .object({
          page: z.coerce.number().int().min(1).max(100000).default(1),
          q: z.string().trim().max(100).optional(),
          paymentStatus: z
            .enum([
              "UNPAID",
              "PENDING_VERIFICATION",
              "PAID",
              "REFUND_REQUIRED",
              "REFUNDED",
            ])
            .optional(),
          status: z
            .enum([
              "AWAITING_APPROVAL",
              "CONFIRMED",
              "PACKED",
              "SHIPPED",
              "DELIVERED",
              "REJECTED",
              "CANCELLED",
            ])
            .optional(),
        })
        .parse(request.query);
      const where: Prisma.OrderWhereInput = {
        ...(status ? { status } : {}),
        ...(paymentStatus ? { manualPaymentStatus: paymentStatus } : {}),
        ...(q
          ? {
              OR: [
                "reference",
                "customerName",
                "customerEmail",
                "customerPhone",
              ].map((field) => ({
                [field]: { contains: q, mode: "insensitive" },
              })),
            }
          : {}),
      };
      const [orders, total] = await Promise.all([
        prisma.order.findMany({
          where,
          include: orderInclude,
          orderBy: { createdAt: "desc" },
          take: 25,
          skip: (page - 1) * 25,
        }),
        prisma.order.count({ where }),
      ]);
      return {
        orders: await Promise.all(orders.map(serializeOrder)),
        total,
        page,
        pageSize: 25,
      };
    });
    protectedApp.get<{ Params: { reference: string } }>(
      "/admin/orders/:reference",
      async (request) => {
        const order = await prisma.order.findUnique({
          where: { reference: request.params.reference },
          include: orderInclude,
        });
        if (!order) fail(404, "Order not found.");
        return serializeOrder(order);
      },
    );
    protectedApp.post<{ Params: { reference: string } }>(
      "/admin/orders/:reference/action",
      async (request) => {
        const body = z
          .object({
            action: z.enum([
              "accept",
              "reject",
              "cancel",
              "packed",
              "shipped",
              "delivered",
              "verify-payment",
              "reject-payment",
              "collect-cod",
              "refund-recorded",
            ]),
            note: z.string().trim().max(500).default(""),
            trackingNumber: z.string().trim().max(100).optional(),
          })
          .strict()
          .parse(request.body);
        const updated = await transaction(async (tx) => {
          const order = await tx.order.findUnique({
            where: { reference: request.params.reference },
            include: orderInclude,
          });
          if (!order) fail(404, "Order not found.");
          const data: {
            status?: typeof order.status;
            stockAllocated?: boolean;
            manualPaymentStatus?: typeof order.manualPaymentStatus;
            paymentVerifiedAt?: Date;
            paymentVerifiedBy?: string;
            paymentReference?: string | null;
            trackingNumber?: string;
          } = {};
          let note = body.note;
          if (body.action === "accept") {
            if (order.status !== "AWAITING_APPROVAL")
              fail(409, "Only requests awaiting approval can be accepted.");
            for (const item of order.items) {
              const variant = await tx.productVariant.findUnique({
                where: { id: item.variantId },
                include: { product: true },
              });
              if (
                !variant ||
                !variant.isActive ||
                variant.product.status !== "PUBLISHED"
              )
                fail(409, `${item.productName} is no longer available.`);
              const inventory = await tx.inventory.findUnique({
                where: { variantId: item.variantId },
              });
              if (
                !inventory ||
                inventory.quantity - inventory.reserved < item.quantity
              )
                fail(
                  409,
                  `Insufficient stock for ${item.productName}. No stock changes were saved.`,
                );
              const allocation = await tx.inventory.updateMany({
                where: {
                  id: inventory.id,
                  quantity: inventory.quantity,
                  reserved: inventory.reserved,
                },
                data: {
                  quantity: { decrement: item.quantity },
                  version: { increment: 1 },
                },
              });
              if (allocation.count !== 1)
                fail(
                  409,
                  `Stock changed for ${item.productName}. Refresh and try again.`,
                );
              await tx.inventoryMovement.create({
                data: {
                  variantId: item.variantId,
                  delta: -item.quantity,
                  quantityBefore: inventory.quantity,
                  quantityAfter: inventory.quantity - item.quantity,
                  reason: "Order accepted",
                  actor: env.ADMIN_EMAIL!,
                  orderReference: order.reference,
                },
              });
            }
            data.status = "CONFIRMED";
            data.stockAllocated = true;
            note ||= "Order accepted. Stock allocated.";
          } else if (body.action === "reject" || body.action === "cancel") {
            if (order.manualPaymentStatus === "PENDING_VERIFICATION")
              fail(
                409,
                "Verify or reject the submitted UPI reference before cancelling, so received funds can be refunded correctly.",
              );
            if (
              body.action === "reject" &&
              order.status !== "AWAITING_APPROVAL"
            )
              fail(409, "Only pending requests can be rejected.");
            if (
              body.action === "cancel" &&
              !["AWAITING_APPROVAL", "CONFIRMED", "PACKED"].includes(
                order.status,
              )
            )
              fail(409, "This order cannot be cancelled at its current stage.");
            if (order.shipment && order.shipment.state !== "CANCELLED")
              fail(
                409,
                "Cancel the Shiprocket shipment before cancelling this order.",
              );
            if (order.stockAllocated)
              for (const item of order.items) {
                const restored = await tx.inventory.update({
                  where: { variantId: item.variantId },
                  data: {
                    quantity: { increment: item.quantity },
                    version: { increment: 1 },
                  },
                });
                await tx.inventoryMovement.create({
                  data: {
                    variantId: item.variantId,
                    delta: item.quantity,
                    quantityBefore: restored.quantity - item.quantity,
                    quantityAfter: restored.quantity,
                    reason: "Order cancelled; stock released",
                    actor: env.ADMIN_EMAIL!,
                    orderReference: order.reference,
                  },
                });
              }
            data.stockAllocated = false;
            data.status = body.action === "reject" ? "REJECTED" : "CANCELLED";
            if (order.manualPaymentStatus === "PAID")
              data.manualPaymentStatus = "REFUND_REQUIRED";
            note ||=
              body.action === "reject"
                ? "Order request rejected."
                : "Order cancelled; allocated stock released.";
          } else if (body.action === "reject-payment") {
            if (
              order.paymentMethod !== "UPI" ||
              order.manualPaymentStatus !== "PENDING_VERIFICATION" ||
              !["CONFIRMED", "PACKED"].includes(order.status) ||
              !body.note
            )
              fail(409, "A pending UPI reference and a reason are required.");
            data.manualPaymentStatus = "UNPAID";
            data.paymentReference = null;
            note = `UPI reference ${order.paymentReference} could not be verified: ${body.note}`;
          } else if (
            body.action === "verify-payment" ||
            body.action === "collect-cod"
          ) {
            if (body.action === "verify-payment") {
              if (
                order.paymentMethod !== "UPI" ||
                order.manualPaymentStatus !== "PENDING_VERIFICATION" ||
                !["CONFIRMED", "PACKED"].includes(order.status)
              )
                fail(
                  409,
                  "There is no UPI payment awaiting verification for this order.",
                );
              const used = await tx.order.findFirst({
                where: {
                  id: { not: order.id },
                  paymentReference: order.paymentReference,
                  manualPaymentStatus: {
                    in: ["PAID", "REFUND_REQUIRED", "REFUNDED"],
                  },
                },
              });
              if (used)
                fail(
                  409,
                  "This transaction reference is already verified against another order.",
                );
              note ||=
                "UPI receipt verified by admin against merchant records.";
            } else {
              if (
                order.paymentMethod !== "COD" ||
                order.status !== "DELIVERED" ||
                order.manualPaymentStatus !== "UNPAID"
              )
                fail(
                  409,
                  "COD collection can be recorded once, after delivery.",
                );
              note ||= "Cash on Delivery collection recorded.";
            }
            data.manualPaymentStatus = "PAID";
            data.paymentVerifiedAt = new Date();
            data.paymentVerifiedBy = env.ADMIN_EMAIL;
          } else if (body.action === "refund-recorded") {
            if (order.manualPaymentStatus !== "REFUND_REQUIRED" || !body.note)
              fail(
                409,
                "A refund must be due and a transaction/reference note is required.",
              );
            data.manualPaymentStatus = "REFUNDED";
          } else {
            const transitions = {
              packed: ["CONFIRMED", "PACKED"],
              shipped: ["PACKED", "SHIPPED"],
              delivered: ["SHIPPED", "DELIVERED"],
            } as const;
            const [from, to] = transitions[body.action];
            if (order.status !== from)
              fail(
                409,
                `Order must be ${from.toLowerCase()} before this action.`,
              );
            if (
              order.paymentMethod === "UPI" &&
              order.manualPaymentStatus !== "PAID"
            )
              fail(409, "Verify UPI receipt before fulfillment.");
            if (body.action === "shipped" && !body.trackingNumber)
              fail(400, "Enter a tracking number before marking shipped.");
            data.status = to;
            if (body.trackingNumber) data.trackingNumber = body.trackingNumber;
            note ||= `Order marked ${to.toLowerCase()}.`;
          }
          return tx.order.update({
            where: { id: order.id },
            data: {
              ...data,
              statusHistory: {
                create: {
                  status: data.status ?? order.status,
                  note,
                  actor: env.ADMIN_EMAIL,
                },
              },
            },
            include: orderInclude,
          });
        });
        return serializeOrder(updated);
      },
    );
  });
}
