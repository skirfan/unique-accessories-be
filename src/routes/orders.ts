import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { FastifyInstance, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { hash } from "../lib/admin-auth.js";
import {
  basketSchema,
  orderSchema,
  orderAccessToken,
  quoteBasket,
  transaction,
} from "../lib/checkout.js";
import { fail } from "../lib/http-error.js";
import { customerSession, checkCustomerOrigin } from "../lib/customer-auth.js";
import { invoiceSnapshot, ensureInvoice, invoicePdf } from "../lib/invoice.js";
import { getSettings } from "../lib/settings.js";

export const orderInclude = {
  shipment: true,
  items: { orderBy: { id: "asc" as const } },
  statusHistory: { orderBy: { createdAt: "asc" as const } },
};
export type FullOrder = Prisma.OrderGetPayload<{
  include: typeof orderInclude;
}>;
export async function serializeOrder(order: FullOrder) {
  const settings = await getSettings();
  const active = ["CONFIRMED", "PACKED", "SHIPPED", "DELIVERED"].includes(
    order.status,
  );
  const allowUpi =
    active &&
    order.paymentMethod === "UPI" &&
    order.manualPaymentStatus !== "PAID" &&
    settings.upiEnabled &&
    (settings.upiId || settings.upiQrImage) &&
    settings.upiName;
  const upiUrl =
    allowUpi && settings.upiId
      ? `upi://pay?${new URLSearchParams({ pa: settings.upiId, pn: settings.upiName, am: Number(order.total).toFixed(2), cu: "INR", tn: order.reference })}`
      : null;
  const text = [
    `Order ${order.reference}`,
    `Name: ${order.customerName}`,
    ...order.items.map(
      (l) => `${l.productName} (${l.variantLabel}) × ${l.quantity}`,
    ),
    `Total: ₹${order.total}`,
    `Payment: ${order.paymentMethod}`,
    `Delivery: ${(order.shippingAddress as { city?: string }).city ?? ""}`,
    "Please help me with this order.",
  ].join("\n");
  return {
    accountLinked: Boolean(order.userId),
    invoiceNumber: order.invoiceNumber,
    shipment: order.shipment
      ? {
          state: order.shipment.state,
          awb: order.shipment.awb,
          courierName: order.shipment.courierName,
          trackingUrl: order.shipment.trackingUrl,
        }
      : null,
    canPayUpi: Boolean(
      active &&
      settings.upiEnabled &&
      (settings.upiId || settings.upiQrImage) &&
      settings.upiName &&
      !order.shipment &&
      ["CONFIRMED", "PACKED"].includes(order.status) &&
      order.manualPaymentStatus === "UNPAID",
    ),
    reference: order.reference,
    status: order.status,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.manualPaymentStatus,
    paymentReference: order.paymentReference,
    paymentVerifiedAt: order.paymentVerifiedAt,
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerPhone: order.customerPhone,
    shippingAddress: order.shippingAddress,
    subtotal: Number(order.subtotal),
    discount: Number(order.discount),
    shippingFee: Number(order.shippingFee),
    total: Number(order.total),
    items: order.items.map((l) => ({
      productName: l.productName,
      productSlug: l.productSlug,
      variantLabel: l.variantLabel,
      quantity: l.quantity,
      unitPrice: Number(l.unitPrice),
      sku: l.sku,
    })),
    history: order.statusHistory.map((h) => ({
      status: h.status,
      note: h.note,
      createdAt: h.createdAt,
    })),
    createdAt: order.createdAt,
    trackingNumber: order.trackingNumber,
    whatsappUrl: settings.whatsappNumber
      ? `https://wa.me/${settings.whatsappNumber}?text=${encodeURIComponent(text)}`
      : null,
    upi: allowUpi
      ? {
          id: settings.upiId,
          name: settings.upiName,
          url: upiUrl,
          qrDataUrl:
            settings.upiQrImage ??
            (await QRCode.toDataURL(upiUrl!, { width: 320, margin: 2 })),
          instructions: settings.paymentInstructions,
          customQr: Boolean(settings.upiQrImage),
        }
      : null,
  };
}
export async function authorizedOrder(
  request: FastifyRequest<{ Params: { reference: string } }>,
) {
  const token = request.headers.authorization?.replace(/^Bearer /, "");
  const user = await customerSession(request);
  const tokenHash = token && /^[a-f0-9]{64}$/.test(token) ? hash(token) : null;
  if (!tokenHash && !user)
    fail(404, "Order not found or private link is invalid.");
  const order = await prisma.order.findFirst({
    where: {
      reference: request.params.reference,
      OR: [
        ...(tokenHash ? [{ accessTokenHash: tokenHash }] : []),
        ...(user ? [{ userId: user.id }] : []),
      ],
    },
    include: orderInclude,
  });
  if (!order) fail(404, "Order not found or private link is invalid.");
  return order;
}
export async function orderRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
  });
  app.post("/checkout/review", async (request) => {
    const basket = basketSchema.parse(request.body);
    return transaction((tx) => quoteBasket(tx, basket));
  });
  app.post(
    "/orders",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const body = orderSchema.parse(request.body);
      const user = await customerSession(request);
      if (user) {
        checkCustomerOrigin(request);
        body.customer.email = user.email;
      }
      const accessToken = orderAccessToken(body.idempotencyKey);
      const identity = {
        userId: user?.id ?? null,
        basket: body.basket,
        customer: body.customer,
        address: body.address,
        paymentMethod: body.paymentMethod,
        idempotencyKey: body.idempotencyKey,
      };
      const requestHash = hash(JSON.stringify(identity));
      const existing = async () => {
        const order = await prisma.order.findUnique({
          where: { idempotencyKey: body.idempotencyKey },
          include: orderInclude,
        });
        if (order && order.requestHash !== requestHash)
          fail(
            409,
            "This request was already used. Please review your order again.",
          );
        return order;
      };
      let order = await existing();
      if (!order) {
        let newlyCreated = false;
        try {
          order = await transaction(async (tx) => {
            newlyCreated = false;
            // A serializable retry may follow another copy of this same request.
            // Resolve it before rechecking stock that the first copy already allocated.
            const prior = await tx.order.findUnique({
              where: { idempotencyKey: body.idempotencyKey },
              include: orderInclude,
            });
            if (prior) {
              if (prior.requestHash !== requestHash)
                fail(
                  409,
                  "This request was already used. Please review your order again.",
                );
              return prior;
            }
            const quote = await quoteBasket(tx, body.basket);
            if (!quote.eligible)
              fail(
                400,
                `Add ₹${quote.remainingForMinimum} more to meet the minimum order of ₹${quote.minimumOrderAmount}.`,
              );
            if (quote.quoteToken !== body.quoteToken)
              fail(
                409,
                "Prices or store settings changed. Please review your updated total before submitting.",
              );
            const settings = await tx.storeSettings.findUniqueOrThrow({
              where: { id: "store" },
            });
            if (body.paymentMethod === "COD" && !settings.codEnabled)
              fail(400, "Cash on Delivery is currently unavailable.");
            if (
              body.paymentMethod === "UPI" &&
              (!settings.upiEnabled ||
                (!settings.upiId && !settings.upiQrImage) ||
                !settings.upiName)
            )
              fail(400, "UPI is currently unavailable.");
            const reference = `UA-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().slice(0, 8).toUpperCase()}`;
            if (settings.autoApproveOrders) {
              for (const line of quote.lines) {
                const inventory = await tx.inventory.findUniqueOrThrow({
                  where: { variantId: line.variantId },
                });
                const result = await tx.inventory.updateMany({
                  where: {
                    id: inventory.id,
                    version: inventory.version,
                    quantity: { gte: line.quantity + inventory.reserved },
                  },
                  data: {
                    quantity: { decrement: line.quantity },
                    version: { increment: 1 },
                  },
                });
                if (result.count !== 1)
                  fail(409, "Stock changed. Please review your cart again.");
                await tx.inventoryMovement.create({
                  data: {
                    variantId: line.variantId,
                    delta: -line.quantity,
                    quantityBefore: inventory.quantity,
                    quantityAfter: inventory.quantity - line.quantity,
                    reason: "Order automatically confirmed",
                    actor: "checkout",
                    orderReference: reference,
                  },
                });
              }
            }
            const imageVariants = await tx.productVariant.findMany({
              where: { id: { in: quote.lines.map((line) => line.variantId) } },
              include: {
                product: {
                  include: { images: { orderBy: { position: "asc" } } },
                },
              },
            });
            const snapshot = invoiceSnapshot(
              {
                reference,
                paymentMethod: body.paymentMethod,
                customerName: body.customer.name,
                customerEmail: body.customer.email,
                customerPhone: body.customer.phone,
                shippingAddress: body.address,
                ...quote,
                items: quote.lines.map((line) => {
                  const images =
                    imageVariants.find((v) => v.id === line.variantId)?.product
                      .images ?? [];
                  const image =
                    images.find((i) => i.variantId === line.variantId) ??
                    images.find((i) => !i.variantId) ??
                    images[0];
                  return {
                    ...line,
                    imageUrl: image?.thumbnailUrl ?? image?.url ?? null,
                  };
                }),
              },
              settings,
            );
            newlyCreated = true;
            return tx.order.create({
              data: {
                reference,
                userId: user?.id,
                invoiceNumber: snapshot.number,
                invoiceSnapshot: snapshot as unknown as Prisma.InputJsonValue,
                stockAllocated: settings.autoApproveOrders,
                accessTokenHash: hash(accessToken),
                idempotencyKey: body.idempotencyKey,
                requestHash,
                customerName: body.customer.name,
                customerEmail: body.customer.email,
                customerPhone: body.customer.phone,
                shippingAddress: body.address,
                paymentMethod: body.paymentMethod,
                status: settings.autoApproveOrders
                  ? "CONFIRMED"
                  : "AWAITING_APPROVAL",
                subtotal: quote.subtotal,
                discount: quote.discount,
                shippingFee: quote.shippingFee,
                total: quote.total,
                couponCode: quote.couponCode,
                items: {
                  create: quote.lines.map(({ stock: _stock, ...l }) => l),
                },
                statusHistory: {
                  create: {
                    status: settings.autoApproveOrders
                      ? "CONFIRMED"
                      : "AWAITING_APPROVAL",
                    note: settings.autoApproveOrders
                      ? "Order confirmed automatically. Stock allocated."
                      : "Order request received. Stock and delivery are confirmed on acceptance.",
                  },
                },
              },
              include: orderInclude,
            });
          });
          reply.code(newlyCreated ? 201 : 200);
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
          )
            order = await existing();
          if (!order) throw err;
        }
      }
      return { order: await serializeOrder(order), accessToken };
    },
  );
  app.get<{ Params: { reference: string } }>(
    "/orders/:reference",
    async (request) => serializeOrder(await authorizedOrder(request)),
  );
  app.get<{ Params: { reference: string } }>(
    "/orders/:reference/invoice",
    async (request, reply) => {
      const order = await authorizedOrder(request);
      const snapshot = await ensureInvoice(order);
      reply
        .header("Content-Type", "application/pdf")
        .header(
          "Content-Disposition",
          `attachment; filename="${snapshot.number}.pdf"`,
        );
      return reply.send(await invoicePdf(snapshot));
    },
  );
  app.post<{ Params: { reference: string } }>(
    "/orders/:reference/claim",
    async (request) => {
      checkCustomerOrigin(request);
      const user = await customerSession(request);
      if (!user) fail(401, "Sign in first.");
      const order = await authorizedOrder(request);
      if (
        order.customerEmail.toLowerCase() !== user.email.toLowerCase() ||
        (order.userId && order.userId !== user.id)
      )
        fail(403, "The order email must match your verified Google email.");
      await prisma.order.updateMany({
        where: { id: order.id, userId: null },
        data: { userId: user.id },
      });
      return { ok: true };
    },
  );
  app.post<{ Params: { reference: string } }>(
    "/orders/:reference/pay-with-upi",
    async (request) => {
      if (await customerSession(request)) checkCustomerOrigin(request);
      const order = await authorizedOrder(request);
      await transaction(async (tx) => {
        const current = await tx.order.findUniqueOrThrow({
          where: { id: order.id },
          include: { shipment: true },
        });
        const settings = await tx.storeSettings.findUniqueOrThrow({
          where: { id: "store" },
        });
        if (
          !settings.upiEnabled ||
          !(settings.upiId || settings.upiQrImage) ||
          !settings.upiName
        )
          fail(409, "UPI is not configured.");
        if (
          current.shipment ||
          !["CONFIRMED", "PACKED"].includes(current.status) ||
          current.manualPaymentStatus !== "UNPAID"
        )
          fail(409, "Payment method cannot be changed at this stage.");
        await tx.order.update({
          where: { id: order.id },
          data: {
            paymentMethod: "UPI",
            statusHistory: {
              create: {
                status: current.status,
                note: "Customer chose to pay by UPI before shipment.",
              },
            },
          },
        });
      });
      return serializeOrder(
        await prisma.order.findUniqueOrThrow({
          where: { id: order.id },
          include: orderInclude,
        }),
      );
    },
  );
  app.post<{ Params: { reference: string } }>(
    "/orders/:reference/payment-reference",
    async (request) => {
      const body = z
        .object({
          reference: z
            .string()
            .trim()
            .regex(
              /^\d{12}$/,
              "Enter the 12-digit UPI transaction reference (UTR).",
            ),
        })
        .strict()
        .parse(request.body);
      const order = await authorizedOrder(request);
      await transaction(async (tx) => {
        const current = await tx.order.findUniqueOrThrow({
          where: { id: order.id },
        });
        if (
          current.paymentMethod !== "UPI" ||
          !["CONFIRMED", "PACKED"].includes(current.status) ||
          !["UNPAID", "PENDING_VERIFICATION"].includes(
            current.manualPaymentStatus,
          )
        )
          fail(409, "This order cannot accept a payment reference now.");
        await tx.order.update({
          where: { id: order.id },
          data: {
            paymentReference: body.reference,
            manualPaymentStatus: "PENDING_VERIFICATION",
            statusHistory: {
              create: {
                status: current.status,
                note: `UPI reference ${body.reference} submitted; payment is awaiting verification.`,
              },
            },
          },
        });
      });
      return serializeOrder(
        await prisma.order.findUniqueOrThrow({
          where: { id: order.id },
          include: orderInclude,
        }),
      );
    },
  );
}
