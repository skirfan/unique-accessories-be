import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { env } from "../env.js";
import { fail } from "../lib/http-error.js";
import { hash } from "../lib/admin-auth.js";
import { transaction } from "../lib/checkout.js";
import {
  productSchema,
  productUpdateSchema,
  adjustmentSchema,
  taxonomySchemas,
} from "../validation/catalog.js";
import { registerProductImages } from "./product-images.js";

export const productInclude = {
  subcategory: { include: { category: true } },
  variants: { include: { inventory: true }, orderBy: { id: "asc" as const } },
  images: { orderBy: { position: "asc" as const } },
  compatibility: true,
} satisfies Prisma.ProductInclude;
export function serializeProduct(
  p: Prisma.ProductGetPayload<{ include: typeof productInclude }>,
) {
  return {
    ...p,
    compatibleDeviceModelIds: p.compatibility.map((c) => c.deviceModelId),
    variants: p.variants.map((v) => ({
      ...v,
      price: Number(v.price),
      compareAt: v.compareAt === null ? null : Number(v.compareAt),
      initialStock: 0,
    })),
    ratingAverage: Number(p.ratingAverage),
  };
}
export async function taxonomy() {
  const [categories, subcategories, brands, deviceModels] = await Promise.all([
    prisma.category.findMany({ orderBy: { name: "asc" } }),
    prisma.subcategory.findMany({
      include: { category: true },
      orderBy: { name: "asc" },
    }),
    prisma.brand.findMany({ orderBy: { name: "asc" } }),
    prisma.deviceModel.findMany({
      include: { brand: true },
      orderBy: { name: "asc" },
    }),
  ]);
  return { categories, subcategories, brands, deviceModels };
}
async function saveProduct(
  input: z.infer<typeof productSchema>,
  id?: string,
  version?: number,
) {
  return transaction(async (tx) => {
    const sub = await tx.subcategory.findUnique({
      where: { id: input.subcategoryId },
    });
    if (!sub) fail(400, "Select an existing subcategory.");
    const models = await tx.deviceModel.count({
      where: { id: { in: input.compatibleDeviceModelIds } },
    });
    if (models !== input.compatibleDeviceModelIds.length)
      fail(400, "Select existing device models.");
    if (id) {
      const current = await tx.product.findUnique({
        where: { id },
        include: { variants: true },
      });
      if (!current) fail(404, "Product not found.");
      const incomingIds = input.variants.flatMap((v) => (v.id ? [v.id] : []));
      if (
        incomingIds.some((vid) => !current.variants.some((v) => v.id === vid))
      )
        fail(400, "A variant does not belong to this product.");
      if (current.variants.some((v) => !incomingIds.includes(v.id)))
        fail(
          400,
          "Keep existing variants and disable any you no longer sell. This preserves order history.",
        );
      if (input.variants.some((v) => v.id && v.initialStock !== 0))
        fail(400, "Use Inventory to adjust stock for existing variants.");
      const update = await tx.product.updateMany({
        where: { id, version },
        data: { version: { increment: 1 } },
      });
      if (!update.count)
        fail(
          409,
          "This product changed in another session. Reload before saving.",
        );
    } else if (input.variants.some((v) => v.id))
      fail(400, "New products cannot reuse existing variant IDs.");
    const { variants, compatibleDeviceModelIds, ...data } = input;
    const product = id
      ? await tx.product.update({ where: { id }, data })
      : await tx.product.create({ data });
    for (const { id: variantId, initialStock, ...variant } of variants) {
      const row = variantId
        ? await tx.productVariant.update({
            where: { id: variantId },
            data: variant,
          })
        : await tx.productVariant.create({
            data: {
              ...variant,
              productId: product.id,
              inventory: { create: { quantity: initialStock } },
            },
          });
      if (!variantId && initialStock)
        await tx.inventoryMovement.create({
          data: {
            variantId: row.id,
            delta: initialStock,
            quantityBefore: 0,
            quantityAfter: initialStock,
            reason: "Opening stock",
            actor: env.ADMIN_EMAIL!,
          },
        });
    }
    await tx.productCompatibility.deleteMany({
      where: { productId: product.id },
    });
    if (compatibleDeviceModelIds.length)
      await tx.productCompatibility.createMany({
        data: compatibleDeviceModelIds.map((deviceModelId) => ({
          productId: product.id,
          deviceModelId,
        })),
      });
    return serializeProduct(
      await tx.product.findUniqueOrThrow({
        where: { id: product.id },
        include: productInclude,
      }),
    );
  });
}
export async function adminCatalogRoutes(app: FastifyInstance) {
  app.get("/admin/catalog/taxonomy", taxonomy);
  // Taxonomy deletions are deliberately blocked while referenced; never cascade-delete a catalog.
  for (const kind of [
    "categories",
    "subcategories",
    "brands",
    "deviceModels",
  ] as const) {
    const model = {
      categories: "category",
      subcategories: "subcategory",
      brands: "brand",
      deviceModels: "deviceModel",
    } as const;
    const validateParent = async (
      tx: Prisma.TransactionClient,
      data: Record<string, unknown>,
      id?: string,
    ) => {
      if (kind === "deviceModels") {
        const brand = await tx.brand.findUnique({
          where: { id: data.brandId as string },
        });
        if (!brand || brand.type !== data.type)
          fail(400, "Choose a brand with the same device type.");
      }
      if (
        kind === "brands" &&
        id &&
        (await tx.deviceModel.count({
          where: { brandId: id, type: { not: data.type as "PHONE" | "CAR" } },
        }))
      )
        fail(
          409,
          "Update or remove the brand’s models before changing its device type.",
        );
      if (
        kind === "subcategories" &&
        !(await tx.category.findUnique({
          where: { id: data.categoryId as string },
        }))
      )
        fail(400, "Choose an existing category.");
    };
    app.post(`/admin/catalog/${kind}`, async (request) =>
      transaction(async (tx) => {
        const data = taxonomySchemas[kind].parse(request.body);
        await validateParent(tx, data);
        // The route kind and strict schema select the matching Prisma input at this boundary.
        return (
          tx[model[kind]].create as unknown as (args: {
            data: unknown;
          }) => Promise<unknown>
        )({ data });
      }),
    );
    app.patch<{ Params: { id: string } }>(
      `/admin/catalog/${kind}/:id`,
      async (request) =>
        transaction(async (tx) => {
          const data = taxonomySchemas[kind].parse(request.body);
          await validateParent(tx, data, request.params.id);
          return (
            tx[model[kind]].update as unknown as (args: {
              where: { id: string };
              data: unknown;
            }) => Promise<unknown>
          )({ where: { id: request.params.id }, data });
        }),
    );
    app.delete<{ Params: { id: string } }>(
      `/admin/catalog/${kind}/:id`,
      async (request) =>
        transaction(async (tx) => {
          const id = request.params.id;
          const references =
            kind === "categories"
              ? await tx.subcategory.count({ where: { categoryId: id } })
              : kind === "subcategories"
                ? await tx.product.count({ where: { subcategoryId: id } })
                : kind === "brands"
                  ? await tx.deviceModel.count({ where: { brandId: id } })
                  : await tx.productCompatibility.count({
                      where: { deviceModelId: id },
                    });
          if (references)
            fail(
              409,
              "This entry is in use. Move or remove its references first.",
            );
          await (
            tx[model[kind]].delete as unknown as (args: {
              where: { id: string };
            }) => Promise<unknown>
          )({ where: { id } });
          return { ok: true };
        }),
    );
  }
  app.get("/admin/products", async (request) => {
    const { page, q, status, subcategoryId } = z
      .object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        q: z.string().trim().max(100).default(""),
        status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]).optional(),
        subcategoryId: z.string().optional(),
      })
      .parse(request.query);
    const where: Prisma.ProductWhereInput = {
      ...(status ? { status } : {}),
      ...(subcategoryId ? { subcategoryId } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { slug: { contains: q, mode: "insensitive" } },
              {
                variants: {
                  some: { sku: { contains: q, mode: "insensitive" } },
                },
              },
            ],
          }
        : {}),
    };
    const total = await prisma.product.count({ where });
    const pages = Math.max(1, Math.ceil(total / 20));
    const current = Math.min(page, pages);
    const products = await prisma.product.findMany({
      where,
      include: productInclude,
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      skip: (current - 1) * 20,
      take: 20,
    });
    return {
      products: products.map(serializeProduct),
      total,
      page: current,
      pages,
    };
  });
  app.get<{ Params: { id: string } }>(
    "/admin/products/:id",
    async (request) => {
      const p = await prisma.product.findUnique({
        where: { id: request.params.id },
        include: productInclude,
      });
      if (!p) fail(404, "Product not found.");
      return serializeProduct(p);
    },
  );
  app.post("/admin/products", async (request, reply) =>
    reply.code(201).send(await saveProduct(productSchema.parse(request.body))),
  );
  app.patch<{ Params: { id: string } }>(
    "/admin/products/:id",
    async (request) => {
      const { version, ...data } = productUpdateSchema.parse(request.body);
      return saveProduct(data, request.params.id, version);
    },
  );
  app.get("/admin/inventory", async (request) => {
    const { q, page, lowStock, threshold } = z
      .object({
        q: z.string().trim().max(100).default(""),
        page: z.coerce.number().int().min(1).max(100000).default(1),
        lowStock: z.enum(["true", "false"]).default("false"),
        threshold: z.coerce.number().int().min(0).max(10000).default(5),
      })
      .parse(request.query);
    const search = q
      ? Prisma.sql`WHERE (p."name" ILIKE ${`%${q}%`} OR v."sku" ILIKE ${`%${q}%`})`
      : Prisma.empty;
    const low = Prisma.sql`v."isActive" = true AND p."status" <> 'ARCHIVED' AND COALESCE(i."quantity",0)-COALESCE(i."reserved",0) <= ${threshold}`;
    const from = Prisma.sql`FROM "ProductVariant" v JOIN "Product" p ON p."id"=v."productId" LEFT JOIN "Inventory" i ON i."variantId"=v."id"`;
    const [stats] = await prisma.$queryRaw<
      { total: bigint; lowStockCount: bigint }[]
    >(
      Prisma.sql`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE ${low}) AS "lowStockCount" ${from} ${search}`,
    );
    const total = Number(
      lowStock === "true" ? stats.lowStockCount : stats.total,
    );
    const pages = Math.max(1, Math.ceil(total / 30));
    const current = Math.min(page, pages);
    const lowFilter =
      lowStock === "true"
        ? q
          ? Prisma.sql`AND ${low}`
          : Prisma.sql`WHERE ${low}`
        : Prisma.empty;
    const ids = await prisma.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT v."id" ${from} ${search} ${lowFilter} ORDER BY p."name" ASC,v."sku" ASC LIMIT 30 OFFSET ${(current - 1) * 30}`,
    );
    const variants = await prisma.productVariant.findMany({
      where: { id: { in: ids.map((v) => v.id) } },
      include: {
        inventory: true,
        product: { select: { id: true, name: true, status: true } },
      },
    });
    const items = ids.flatMap(({ id }) => {
      const v = variants.find((v) => v.id === id);
      return v
        ? [
            {
              ...v,
              price: Number(v.price),
              compareAt: v.compareAt === null ? null : Number(v.compareAt),
              available: Math.max(
                0,
                (v.inventory?.quantity ?? 0) - (v.inventory?.reserved ?? 0),
              ),
            },
          ]
        : [];
    });
    return {
      items,
      total,
      page: current,
      pages,
      lowStockCount: Number(stats.lowStockCount),
    };
  });
  app.get<{ Params: { variantId: string } }>(
    "/admin/inventory/:variantId/history",
    async (request) => {
      const { page } = z
        .object({ page: z.coerce.number().int().min(1).max(100000).default(1) })
        .parse(request.query);
      const where = { variantId: request.params.variantId };
      return {
        items: await prisma.inventoryMovement.findMany({
          where,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 30,
          skip: (page - 1) * 30,
        }),
        total: await prisma.inventoryMovement.count({ where }),
      };
    },
  );
  app.post("/admin/inventory/adjust", async (request) => {
    const body = adjustmentSchema.parse(request.body);
    const requestHash = hash(
      JSON.stringify({ reason: body.reason, items: body.items }),
    );
    return transaction(async (tx) => {
      const previous = await tx.stockAdjustment.findUnique({
        where: { id: body.idempotencyKey },
      });
      if (previous) {
        if (previous.requestHash !== requestHash)
          fail(
            409,
            "This adjustment ID has already been used with different values.",
          );
        return previous.result;
      }
      const movements = [];
      for (const item of [...body.items].sort((a, b) =>
        a.variantId.localeCompare(b.variantId),
      )) {
        const inventory = await tx.inventory.findUnique({
          where: { variantId: item.variantId },
        });
        if (!inventory) fail(404, "Inventory not found.");
        if (inventory.version !== item.version)
          fail(
            409,
            "Stock changed since this page loaded. Refresh and review your adjustments.",
          );
        const next = inventory.quantity + item.delta;
        if (next < inventory.reserved || next > 1_000_000)
          fail(
            400,
            "Stock must remain between the reserved amount and 1,000,000.",
          );
        const result = await tx.inventory.updateMany({
          where: { id: inventory.id, version: item.version },
          data: { quantity: next, version: { increment: 1 } },
        });
        if (!result.count) fail(409, "Stock changed. Refresh and try again.");
        movements.push(
          await tx.inventoryMovement.create({
            data: {
              variantId: item.variantId,
              delta: item.delta,
              quantityBefore: inventory.quantity,
              quantityAfter: next,
              reason: body.reason,
              actor: env.ADMIN_EMAIL!,
            },
          }),
        );
      }
      const result = { ok: true, count: movements.length };
      await tx.stockAdjustment.create({
        data: { id: body.idempotencyKey, requestHash, result },
      });
      return result;
    });
  });
  await registerProductImages(app);
}
