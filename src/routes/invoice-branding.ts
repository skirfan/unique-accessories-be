import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { productStorage } from "../lib/product-storage.js";
import { getSettings, serializeSettings } from "../lib/settings.js";
import { fail } from "../lib/http-error.js";

export async function invoiceBrandingRoutes(app: FastifyInstance) {
  await app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  });
  app.post("/admin/settings/invoice-logo", async (request) => {
    const { version } = z
      .object({ version: z.coerce.number().int().min(1) })
      .parse(request.query);
    if ((await getSettings()).version !== version)
      fail(409, "Settings changed. Reload and try again.");
    const file = await request.file();
    if (!file) fail(400, "Choose a PNG, JPEG or WebP logo.");
    const bytes = await file.toBuffer();
    let png: Buffer;
    try {
      const image = sharp(bytes, { limitInputPixels: 10_000_000 });
      const metadata = await image.metadata();
      if (
        !["png", "jpeg", "webp"].includes(metadata.format ?? "") ||
        (metadata.pages ?? 1) > 1
      )
        fail(400, "Choose a static PNG, JPEG or WebP logo.");
      png = await image
        .rotate()
        .resize({
          width: 1200,
          height: 400,
          fit: "inside",
          withoutEnlargement: true,
        })
        .png({ compressionLevel: 9 })
        .toBuffer();
    } catch {
      fail(400, "Choose a valid static PNG, JPEG or WebP image.");
    }
    if (png.length > 512 * 1024)
      fail(400, "Logo is too complex. Please upload a smaller image.");
    const key = `${randomUUID()}.png`;
    await productStorage.putInvoiceLogo(key, png);
    try {
      const result = await prisma.storeSettings.updateMany({
        where: { id: "store", version },
        data: {
          invoiceLogoImage: `data:image/png;base64,${png.toString("base64")}`,
          invoiceLogoUrl: productStorage.invoiceLogoUrl(key),
          invoiceLogoKey: key,
          version: { increment: 1 },
        },
      });
      if (!result.count) fail(409, "Settings changed. Reload and try again.");
    } catch (error) {
      await productStorage.removeInvoiceLogo(key).catch(() => {});
      throw error;
    }
    return serializeSettings(await getSettings());
  });
  app.delete("/admin/settings/invoice-logo", async (request) => {
    const { version } = z
      .object({ version: z.number().int().min(1) })
      .strict()
      .parse(request.body);
    const result = await prisma.storeSettings.updateMany({
      where: { id: "store", version },
      data: {
        invoiceLogoImage: null,
        invoiceLogoUrl: null,
        invoiceLogoKey: null,
        version: { increment: 1 },
      },
    });
    if (!result.count) fail(409, "Settings changed. Reload and try again.");
    return serializeSettings(await getSettings());
  });
}
