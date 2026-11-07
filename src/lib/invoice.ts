import type { Prisma, StoreSettings } from "@prisma/client";
import { prisma } from "./prisma.js";
import type { FullOrder } from "../routes/orders.js";
export function invoiceSnapshot(
  order: {
    paymentMethod?: string;
    reference: string;
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    shippingAddress: unknown;
    subtotal: number;
    discount: number;
    shippingFee: number;
    total: number;
    items: {
      imageUrl?: string | null;
      productName: string;
      sku: string;
      variantLabel: string;
      quantity: number;
      unitPrice: number;
    }[];
  },
  settings: StoreSettings,
) {
  return {
    version: 2,
    paymentMethod: order.paymentMethod ?? "",
    number: `INV-${order.reference.slice(3)}`,
    issuedAt: new Date().toISOString(),
    seller: {
      logoImage: settings.invoiceLogoImage,
      name: settings.sellerName,
      address: settings.sellerAddress,
      email: settings.sellerEmail,
      phone: settings.sellerPhone,
      gstin: settings.sellerGstin,
    },
    buyer: {
      name: order.customerName,
      email: order.customerEmail,
      phone: order.customerPhone,
      address: order.shippingAddress,
    },
    reference: order.reference,
    items: order.items.map((i) => ({
      imageUrl: i.imageUrl ?? null,
      name: i.productName,
      sku: i.sku,
      option: i.variantLabel,
      quantity: i.quantity,
      price: i.unitPrice,
    })),
    subtotal: order.subtotal,
    discount: order.discount,
    shipping: order.shippingFee,
    total: order.total,
    currency: "INR",
  };
}
export type InvoiceSnapshot = ReturnType<typeof invoiceSnapshot>;
export async function ensureInvoice(order: FullOrder) {
  if (order.invoiceSnapshot)
    return order.invoiceSnapshot as unknown as InvoiceSnapshot;
  const settings = await prisma.storeSettings.findUniqueOrThrow({
    where: { id: "store" },
  });
  const snapshot = invoiceSnapshot(
    {
      ...order,
      subtotal: Number(order.subtotal),
      discount: Number(order.discount),
      shippingFee: Number(order.shippingFee),
      total: Number(order.total),
      items: order.items.map((i) => ({ ...i, unitPrice: Number(i.unitPrice) })),
    },
    settings,
  );
  await prisma.order.updateMany({
    where: { id: order.id, invoiceNumber: null },
    data: {
      invoiceNumber: snapshot.number,
      invoiceSnapshot: snapshot as unknown as Prisma.InputJsonValue,
    },
  });
  const saved = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
  });
  return saved.invoiceSnapshot as unknown as InvoiceSnapshot;
}
export { invoicePdf } from "./invoice-pdf.js";
