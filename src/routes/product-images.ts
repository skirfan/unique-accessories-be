import type { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
import { env } from "../env.js";
import { productStorage, storageForImage } from "../lib/product-storage.js";
import { prisma } from "../lib/prisma.js";
import { transaction } from "../lib/checkout.js";
import { fail } from "../lib/http-error.js";
import { productInclude, serializeProduct } from "./admin-catalog.js";
const root = resolve(env.UPLOAD_DIR);
const imageMeta = z
  .object({
    version: z.number().int().min(1),
    variantId: z.string().min(1).nullable(),
    altText: z.string().trim().max(200),
  })
  .strict();
export async function mediaRoutes(app: FastifyInstance) {
  app.get<{ Params: { key: string } }>(
    "/media/invoice-logos/:key",
    { config: { rateLimit: { max: 3000, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const { key } = request.params;
      if (!/^[0-9a-f-]{36}\.png$/.test(key)) fail(404, "Image not found.");
      try {
        return reply
          .type("image/png")
          .header("Cache-Control", "public, max-age=31536000, immutable")
          .send(await readFile(join(root, "invoice-logos", key)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          fail(404, "Image not found.");
        throw error;
      }
    },
  );
  app.get<{ Params: { key: string } }>(
    "/media/products/:key",
    {
      config: {
        rateLimit: {
          max: 3000,
          timeWindow: "1 minute",
          groupId: "product-media",
        },
      },
    },
    async (request, reply) => {
      const { key } = request.params;
      if (!/^[0-9a-f-]{36}(?:-thumb)?\.webp$/.test(key))
        fail(404, "Image not found.");
      try {
        const bytes = await readFile(join(root, key));
        return reply
          .header("Cache-Control", "public, max-age=31536000, immutable")
          .type("image/webp")
          .send(bytes);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT")
          fail(404, "Image not found.");
        throw e;
      }
    },
  );
}
export async function registerProductImages(app: FastifyInstance) {
  app.get("/admin/media", async () => ({
    provider: productStorage.kind,
    maxFileSize: 5 * 1024 * 1024,
    maxPhotos: 20,
  }));
  await app.register(multipart, {
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  });
  app.post<{ Params: { id: string } }>(
    "/admin/products/:id/images",
    async (request) => {
      const { version, variantId, altText } = imageMeta.parse({
        version: Number((request.query as Record<string, string>).version),
        variantId: (request.query as Record<string, string>).variantId || null,
        altText: (request.query as Record<string, string>).altText || "",
      });
      const product = await prisma.product.findUnique({
        where: { id: request.params.id },
        include: { variants: true },
      });
      if (!product) fail(404, "Product not found.");
      if (product.version !== version)
        fail(409, "Product changed. Reload before uploading.");
      if (variantId && !product.variants.some((v) => v.id === variantId))
        fail(400, "Variant does not belong to this product.");
      const file = await request.file();
      if (!file) fail(400, "Choose a JPEG, PNG or WebP image up to 5 MB.");
      const bytes = await file.toBuffer();
      const png = bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const jpeg = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
      const webp =
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP";
      if (!png && !jpeg && !webp)
        fail(400, "Use a valid JPEG, PNG or WebP image.");
      let full: Buffer, thumb: Buffer;
      try {
        const source = sharp(bytes, {
          limitInputPixels: 40_000_000,
          animated: false,
        });
        const meta = await source.metadata();
        if (!["jpeg", "png", "webp"].includes(meta.format ?? ""))
          fail(400, "Use JPEG, PNG or WebP images.");
        [full, thumb] = await Promise.all([
          source
            .clone()
            .rotate()
            .resize({
              width: 1600,
              height: 1600,
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: 82 })
            .toBuffer(),
          source
            .clone()
            .rotate()
            .resize({
              width: 400,
              height: 400,
              fit: "inside",
              withoutEnlargement: true,
            })
            .webp({ quality: 75 })
            .toBuffer(),
        ]);
      } catch {
        fail(
          400,
          "The file could not be decoded. Use a valid JPEG, PNG or WebP up to 40 megapixels.",
        );
      }
      const key = `${randomUUID()}.webp`,
        thumbKey = key.replace(".webp", "-thumb.webp");
      try {
        await productStorage.put(key, full);
        await productStorage.put(thumbKey, thumb);
        return await transaction(async (tx) => {
          const update = await tx.product.updateMany({
            where: { id: product.id, version },
            data: { version: { increment: 1 } },
          });
          if (!update.count)
            fail(409, "Product changed. Reload and try again.");
          const images = await tx.productImage.findMany({
            where: { productId: product.id },
          });
          if (images.length >= 20)
            fail(400, "A product can have at most 20 images.");
          await tx.productImage.create({
            data: {
              productId: product.id,
              variantId,
              url: productStorage.url(key),
              thumbnailUrl: productStorage.url(thumbKey),
              storageKey: key,
              altText,
              position: images.reduce((n, i) => Math.max(n, i.position + 1), 0),
            },
          });
          return serializeProduct(
            await tx.product.findUniqueOrThrow({
              where: { id: product.id },
              include: productInclude,
            }),
          );
        });
      } catch (e) {
        await Promise.allSettled([
          productStorage.remove(key),
          productStorage.remove(thumbKey),
        ]);
        throw e;
      }
    },
  );
  app.patch<{ Params: { id: string } }>(
    "/admin/products/:id/images",
    async (request) => {
      const body = z
        .object({
          version: z.number().int().min(1),
          images: z
            .array(
              z
                .object({
                  id: z.string().min(1),
                  variantId: z.string().nullable(),
                  altText: z.string().trim().max(200),
                })
                .strict(),
            )
            .max(20)
            .refine(
              (a) => new Set(a.map((i) => i.id)).size === a.length,
              "Duplicate image.",
            ),
        })
        .strict()
        .parse(request.body);
      return transaction(async (tx) => {
        const product = await tx.product.findUnique({
          where: { id: request.params.id },
          include: { images: true, variants: true },
        });
        if (!product) fail(404, "Product not found.");
        if (
          body.images.length !== product.images.length ||
          body.images.some(
            (i) =>
              !product.images.some((x) => x.id === i.id) ||
              (i.variantId &&
                !product.variants.some((v) => v.id === i.variantId)),
          )
        )
          fail(
            400,
            "Images and variants must belong to this product. Use delete to remove a photo.",
          );
        if (
          !(
            await tx.product.updateMany({
              where: { id: product.id, version: body.version },
              data: { version: { increment: 1 } },
            })
          ).count
        )
          fail(409, "Product changed. Reload before saving photos.");
        for (const [position, image] of body.images.entries()) {
          const { id, ...data } = image;
          await tx.productImage.update({
            where: { id },
            data: { ...data, position },
          });
        }
        return serializeProduct(
          await tx.product.findUniqueOrThrow({
            where: { id: product.id },
            include: productInclude,
          }),
        );
      });
    },
  );
  app.delete<{ Params: { id: string; imageId: string } }>(
    "/admin/products/:id/images/:imageId",
    async (request) => {
      const { version } = z
        .object({ version: z.number().int().min(1) })
        .strict()
        .parse(request.body);
      const image = await transaction(async (tx) => {
        const image = await tx.productImage.findFirst({
          where: { id: request.params.imageId, productId: request.params.id },
        });
        if (!image) fail(404, "Image not found.");
        if (
          !(
            await tx.product.updateMany({
              where: { id: request.params.id, version },
              data: { version: { increment: 1 } },
            })
          ).count
        )
          fail(409, "Product changed. Reload before deleting photos.");
        await tx.productImage.delete({ where: { id: image.id } });
        return image;
      });
      // DB removal succeeds even if storage cleanup fails; log for operator cleanup.
      if (image.storageKey)
        await Promise.all([
          Promise.resolve().then(() =>
            storageForImage(image.url).remove(image.storageKey!),
          ),
          Promise.resolve().then(() =>
            storageForImage(image.url).remove(
              image.storageKey!.replace(".webp", "-thumb.webp"),
            ),
          ),
        ]).catch((error) =>
          request.log.error({ err: error }, "Image storage cleanup failed"),
        );
      return serializeProduct(
        await prisma.product.findUniqueOrThrow({
          where: { id: request.params.id },
          include: productInclude,
        }),
      );
    },
  );
}
