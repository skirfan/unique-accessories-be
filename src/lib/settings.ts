import { prisma } from "./prisma.js";
import type { StoreSettings } from "@prisma/client";
export function serializeSettings(s: StoreSettings) {
  return {
    ...s,
    minimumOrderAmount: Number(s.minimumOrderAmount),
    shippingFee: Number(s.shippingFee),
    freeShippingThreshold: Number(s.freeShippingThreshold),
  };
}
export async function getSettings() {
  return prisma.storeSettings.findUniqueOrThrow({ where: { id: "store" } });
}

// Public catalog settings omit the merchant payment payload. Instructions and
// QR are returned on the private order endpoint only after acceptance.
export function publicSettings(s: StoreSettings) {
  const full = serializeSettings(s);
  return {
    id: full.id,
    autoApproveOrders: full.autoApproveOrders,
    minimumOrderEnabled: full.minimumOrderEnabled,
    minimumOrderAmount: full.minimumOrderAmount,
    shippingFee: full.shippingFee,
    freeShippingThreshold: full.freeShippingThreshold,
    codEnabled: full.codEnabled,
    upiEnabled: full.upiEnabled,
    whatsappNumber: full.whatsappNumber,
    version: full.version,
    updatedAt: full.updatedAt,
  };
}
