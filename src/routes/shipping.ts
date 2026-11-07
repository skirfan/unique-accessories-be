import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { fail } from "../lib/http-error.js";
import { hash } from "../lib/admin-auth.js";
import { transaction } from "../lib/checkout.js";
import {
  shiprocket,
  shippingConfigured,
  ShippingError,
} from "../lib/shiprocket.js";
import { orderInclude, serializeOrder } from "./orders.js";
const parcelSchema = z
  .object({
    length: z.number().gt(0.5).max(200),
    breadth: z.number().gt(0.5).max(200),
    height: z.number().gt(0.5).max(200),
    weight: z.number().positive().max(100),
  })
  .strict();
const ids = z.object({
  order_id: z.coerce.number().int().positive(),
  shipment_id: z.coerce.number().int().positive(),
});
function safeUrl(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}
async function shippingOrder(reference: string) {
  const order = await prisma.order.findUnique({
    where: { reference },
    include: orderInclude,
  });
  if (!order) fail(404, "Order not found.");
  return order;
}
async function eligible(reference: string) {
  const order = await shippingOrder(reference);
  if (!["CONFIRMED", "PACKED"].includes(order.status) || !order.stockAllocated)
    fail(409, "Only confirmed or packed orders can be sent to Shiprocket.");
  if (order.paymentMethod === "UPI" && order.manualPaymentStatus !== "PAID")
    fail(409, "Verify the UPI payment before shipping.");
  return order;
}
export async function shippingAdminRoutes(app: FastifyInstance) {
  app.get("/admin/integrations", async () => ({
    shiprocket: shippingConfigured(),
    google: Boolean(
      env.GOOGLE_CLIENT_ID &&
      env.GOOGLE_CLIENT_SECRET &&
      env.GOOGLE_REDIRECT_URI,
    ),
    pickupLocation: env.SHIPROCKET_PICKUP_LOCATION ?? null,
  }));
  app.get<{ Params: { reference: string } }>(
    "/admin/orders/:reference/shipment",
    async (req) => (await shippingOrder(req.params.reference)).shipment,
  );
  app.post<{ Params: { reference: string } }>(
    "/admin/orders/:reference/shipment",
    async (request) => {
      const parcel = parcelSchema.parse(request.body);
      if (!shippingConfigured())
        fail(
          503,
          "Shiprocket is not configured. Add the API user and pickup location to the backend environment.",
        );
      const order = await eligible(request.params.reference);
      // Claim the operation inside the same serializable boundary as cancellation/payment changes.
      const shipment = await transaction(async (tx) => {
        const current = await tx.order.findUniqueOrThrow({
          where: { id: order.id },
          include: { shipment: true },
        });
        if (current.shipment)
          fail(
            409,
            "This order already has a shipment operation. Refresh or reconcile it; do not create a duplicate.",
          );
        if (
          !["CONFIRMED", "PACKED"].includes(current.status) ||
          (current.paymentMethod === "UPI" &&
            current.manualPaymentStatus !== "PAID")
        )
          fail(409, "Order changed. Refresh before shipping.");
        return tx.shipment.create({
          data: { orderId: order.id, package: parcel },
        });
      });
      try {
        const a = order.shippingAddress as {
          line1: string;
          line2?: string;
          city: string;
          state: string;
          pincode: string;
        };
        const names = order.customerName.trim().split(/\s+/);
        const result = ids.parse(
          await shiprocket("/orders/create/adhoc", "POST", {
            order_id: order.reference,
            order_date: order.createdAt.toLocaleString("sv-SE", {
              timeZone: "Asia/Kolkata",
            }),
            pickup_location: env.SHIPROCKET_PICKUP_LOCATION,
            billing_customer_name: names[0],
            billing_last_name: names.slice(1).join(" "),
            billing_address: a.line1,
            billing_address_2: a.line2 ?? "",
            billing_city: a.city,
            billing_pincode: a.pincode,
            billing_state: a.state,
            billing_country: "India",
            billing_email: order.customerEmail,
            billing_phone: order.customerPhone.replace(/^\+91[ -]?/, ""),
            shipping_is_billing: true,
            order_items: order.items.map((i) => ({
              name: i.productName,
              sku: i.sku,
              units: i.quantity,
              selling_price: Number(i.unitPrice),
              discount: 0,
            })),
            payment_method: order.paymentMethod === "COD" ? "COD" : "Prepaid",
            shipping_charges: Number(order.shippingFee),
            total_discount: Number(order.discount),
            sub_total: Number(order.subtotal) - Number(order.discount),
            invoice_number: order.invoiceNumber ?? undefined,
            ...parcel,
          }),
        );
        await prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            state: "READY",
            externalOrderId: result.order_id,
            externalShipmentId: result.shipment_id,
            error: null,
          },
        });
      } catch (error) {
        const knownFailure =
          error instanceof ShippingError &&
          [400, 401, 403, 422].includes(error.status);
        await prisma.shipment.update({
          where: { id: shipment.id },
          data: {
            state: knownFailure ? "FAILED" : "RECONCILIATION_REQUIRED",
            error: knownFailure
              ? error.message
              : "The external result is uncertain. Check Shiprocket and reconcile this order before retrying.",
          },
        });
        fail(
          502,
          knownFailure
            ? "Shiprocket rejected the request. Check the parcel, pickup and account details."
            : "Shipment result is uncertain. Check Shiprocket before creating another shipment.",
        );
      }
      return serializeOrder(await shippingOrder(order.reference));
    },
  );
  app.post<{ Params: { reference: string } }>(
    "/admin/orders/:reference/shipment/reconcile",
    async (request) => {
      const { externalOrderId } = z
        .object({ externalOrderId: z.number().int().positive() })
        .strict()
        .parse(request.body);
      const order = await shippingOrder(request.params.reference);
      if (
        !order.shipment ||
        !["RECONCILIATION_REQUIRED", "CREATING", "FAILED"].includes(
          order.shipment.state,
        )
      )
        fail(409, "This shipment does not need reconciliation.");
      const response = await shiprocket(`/orders/show/${externalOrderId}`);
      const d = z
        .object({
          id: z.coerce.number().int(),
          channel_order_id: z.string(),
          shipments: z
            .array(z.object({ id: z.coerce.number().int().positive() }))
            .min(1),
        })
        .parse(response.data);
      if (d.id !== externalOrderId || d.channel_order_id !== order.reference)
        fail(409, "That Shiprocket order does not match this website order.");
      await prisma.shipment.update({
        where: { id: order.shipment.id },
        data: {
          externalOrderId: d.id,
          externalShipmentId: d.shipments[0].id,
          state: "READY",
          error: null,
        },
      });
      return serializeOrder(await shippingOrder(order.reference));
    },
  );
  app.delete<{ Params: { reference: string } }>(
    "/admin/orders/:reference/shipment/failed",
    async (request) => {
      const order = await shippingOrder(request.params.reference);
      if (order.shipment?.state !== "FAILED")
        fail(
          409,
          "Only a definitively rejected request can be reset. Reconcile uncertain requests instead.",
        );
      await prisma.shipment.delete({ where: { id: order.shipment.id } });
      return { ok: true };
    },
  );
  app.post<{ Params: { reference: string } }>(
    "/admin/orders/:reference/shipment/action",
    async (request) => {
      const body = z
        .object({
          action: z.enum([
            "awb",
            "pickup",
            "label",
            "manifest",
            "sync",
            "cancel",
          ]),
          courierId: z.number().int().positive().optional(),
        })
        .strict()
        .parse(request.body);
      const order = await shippingOrder(request.params.reference),
        s = order.shipment;
      if (
        !s?.externalShipmentId ||
        !s.externalOrderId ||
        ["CANCELLED", "CREATING", "RECONCILIATION_REQUIRED", "FAILED"].includes(
          s.state,
        )
      )
        fail(409, "Create or reconcile the shipment first.");
      if (body.action !== "sync" && body.action !== "cancel")
        await eligible(order.reference);
      if (body.action === "awb") {
        if (s.awb)
          fail(409, "An AWB is already assigned. Refresh the shipment.");
        const result = await shiprocket("/courier/assign/awb", "POST", {
          shipment_id: s.externalShipmentId,
          ...(body.courierId ? { courier_id: body.courierId } : {}),
        });
        const info = z
          .object({
            awb_code: z.string().min(1),
            courier_name: z.string().optional(),
          })
          .parse((result.response as { data?: unknown })?.data);
        await prisma.shipment.update({
          where: { id: s.id },
          data: {
            awb: info.awb_code,
            courierName: info.courier_name,
            state: "AWB_ASSIGNED",
          },
        });
        await prisma.order.update({
          where: { id: order.id },
          data: { trackingNumber: info.awb_code },
        });
      } else if (body.action === "pickup") {
        if (!s.awb) fail(409, "Assign an AWB first.");
        if (s.pickupScheduled) fail(409, "Pickup is already scheduled.");
        const result = await shiprocket("/courier/generate/pickup", "POST", {
          shipment_id: [s.externalShipmentId],
        });
        if (Number(result.pickup_status) !== 1)
          fail(
            502,
            "Shiprocket did not confirm pickup. Check the Shiprocket dashboard before retrying.",
          );
        await prisma.shipment.update({
          where: { id: s.id },
          data: { pickupScheduled: true, state: "PICKUP_SCHEDULED" },
        });
      } else if (body.action === "label" || body.action === "manifest") {
        if (!s.awb) fail(409, "Assign an AWB first.");
        if (body.action === "manifest" && !s.pickupScheduled)
          fail(409, "Schedule pickup before generating a manifest.");
        const result = await shiprocket(
          body.action === "label"
            ? "/courier/generate/label"
            : "/manifests/generate",
          "POST",
          { shipment_id: [s.externalShipmentId] },
        );
        const url = safeUrl(result[`${body.action}_url`]);
        if (!url) fail(502, "The shipping document is not available yet.");
        await prisma.shipment.update({
          where: { id: s.id },
          data:
            body.action === "label" ? { labelUrl: url } : { manifestUrl: url },
        });
      } else if (body.action === "cancel") {
        if (["SHIPPED", "DELIVERED"].includes(order.status))
          fail(
            409,
            "Shipped orders require courier support; they cannot be cancelled here.",
          );
        const result = await shiprocket("/orders/cancel", "POST", {
          ids: [s.externalOrderId],
        });
        if (result.status_code && Number(result.status_code) !== 200)
          fail(502, "Shiprocket did not confirm cancellation.");
        await prisma.shipment.update({
          where: { id: s.id },
          data: { state: "CANCELLED" },
        });
      } else {
        const response = await shiprocket(
          `/courier/track/shipment/${s.externalShipmentId}`,
        );
        const tracking = z
          .object({
            tracking_data: z.object({
              track_status: z.number(),
              shipment_track: z
                .array(
                  z.object({
                    current_status: z.string(),
                    awb_code: z.string().optional(),
                    courier_name: z.string().optional(),
                  }),
                )
                .optional(),
              track_url: z.string().optional(),
            }),
          })
          .parse(response).tracking_data;
        if (tracking.track_status !== 1 || !tracking.shipment_track?.[0])
          fail(
            409,
            "Tracking is not available yet. Try after AWB assignment/pickup.",
          );
        const track = tracking.shipment_track[0];
        await applyTracking(
          s.id,
          track.current_status,
          new Date(),
          track.awb_code,
          track.courier_name,
          safeUrl(tracking.track_url),
        );
      }
      return {
        order: await serializeOrder(await shippingOrder(order.reference)),
        shipment: await prisma.shipment.findUnique({ where: { id: s.id } }),
      };
    },
  );
}
async function applyTracking(
  id: string,
  status: string,
  at: Date,
  awb?: string,
  courier?: string,
  url?: string | null,
) {
  await transaction(async (tx) => {
    const s = await tx.shipment.findUniqueOrThrow({
      where: { id },
      include: { order: true },
    });
    if (s.lastEventAt && s.lastEventAt >= at) return;
    if (s.state === "CANCELLED") return;
    const normalized = status.trim().toUpperCase();
    const delivered = normalized === "DELIVERED";
    const shipped = [
      "SHIPPED",
      "IN TRANSIT",
      "OUT FOR DELIVERY",
      "PICKED UP",
    ].includes(normalized);
    await tx.shipment.update({
      where: { id },
      data: {
        state: normalized.slice(0, 100),
        lastEventAt: at,
        ...(awb ? { awb } : {}),
        ...(courier ? { courierName: courier } : {}),
        ...(url ? { trackingUrl: url } : {}),
      },
    });
    if (!["CONFIRMED", "PACKED", "SHIPPED"].includes(s.order.status)) return;
    if (
      s.order.paymentMethod === "UPI" &&
      s.order.manualPaymentStatus !== "PAID"
    )
      return;
    const next = delivered
      ? "DELIVERED"
      : shipped && s.order.status !== "SHIPPED"
        ? "SHIPPED"
        : null;
    if (next)
      await tx.order.update({
        where: { id: s.orderId },
        data: {
          status: next,
          ...(awb ? { trackingNumber: awb } : {}),
          statusHistory: {
            create: {
              status: next,
              note: `Shiprocket tracking: ${status}`,
              actor: "Shiprocket",
            },
          },
        },
      });
  });
}
export async function shippingWebhookRoutes(app: FastifyInstance) {
  app.post(
    "/shipping/events",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (request) => {
      const token = request.headers["x-api-key"];
      if (
        !env.SHIPROCKET_WEBHOOK_TOKEN ||
        typeof token !== "string" ||
        !timingSafeEqual(
          Buffer.from(hash(token)),
          Buffer.from(hash(env.SHIPROCKET_WEBHOOK_TOKEN)),
        )
      )
        fail(401, "Invalid shipping webhook token.");
      const body = z
        .object({
          awb: z.string().min(1).max(100),
          current_status: z.string().max(100),
          current_timestamp: z.string().max(100).optional(),
        })
        .passthrough()
        .parse(request.body);
      const raw = body.current_timestamp;
      const parts = raw?.match(
        /^(\d{2}) (\d{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2})$/,
      );
      // Shiprocket's day/month/year timestamps are India local time.
      const at = parts
        ? new Date(
            `${parts[3]}-${parts[2]}-${parts[1]}T${parts[4]}:${parts[5]}:${parts[6]}+05:30`,
          )
        : raw
          ? new Date(raw)
          : new Date();
      if (!Number.isFinite(at.getTime()) || at.getTime() > Date.now() + 300_000)
        fail(400, "Invalid event timestamp.");
      const s = await prisma.shipment.findUnique({ where: { awb: body.awb } });
      if (!s) return { ok: true };
      await applyTracking(s.id, body.current_status, at);
      return { ok: true };
    },
  );
}
