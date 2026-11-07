import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { prisma } from "../lib/prisma.js";
import { getSettings, publicSettings } from "../lib/settings.js";
import { fail } from "../lib/http-error.js";

export async function loadCatalog() {
  const [categories, subs, brands, models, products, settings] =
    await Promise.all([
      prisma.category.findMany({ orderBy: { id: "asc" } }),
      prisma.subcategory.findMany({
        include: { category: true },
        orderBy: { id: "asc" },
      }),
      prisma.brand.findMany({ orderBy: { name: "asc" } }),
      prisma.deviceModel.findMany({
        include: { brand: true },
        orderBy: { name: "asc" },
      }),
      prisma.product.findMany({
        where: { status: "PUBLISHED" },
        orderBy: { id: "asc" },
        include: {
          subcategory: { include: { category: true } },
          variants: {
            where: { isActive: true },
            include: { inventory: true },
            orderBy: { id: "asc" },
          },
          images: { orderBy: { position: "asc" } },
          compatibility: true,
          reviews: {
            where: { approved: true },
            include: { user: { select: { fullName: true } } },
            orderBy: { createdAt: "desc" },
          },
        },
      }),
      getSettings(),
    ]);
  return {
    categories,
    subcategories: subs.map(({ category, ...s }) => ({
      ...s,
      categorySlug: category.slug,
    })),
    brands,
    deviceModels: models.map(({ brand, ...m }) => ({
      ...m,
      brandName: brand.name,
    })),
    products: products
      .filter((p) => p.variants.length > 0)
      .map((p) => {
        const images = p.images
          .filter(
            (image) =>
              !image.variantId ||
              p.variants.some((v) => v.id === image.variantId),
          )
          .map(({ id, url, thumbnailUrl, altText, variantId, position }) => ({
            id,
            url,
            thumbnailUrl,
            altText,
            variantId,
            position,
          }));
        return {
          id: p.id,
          name: p.name,
          slug: p.slug,
          subcategoryId: p.subcategoryId,
          subcategorySlug: p.subcategory.slug,
          categorySlug: p.subcategory.category.slug,
          shortDescription: p.shortDescription,
          description: p.description,
          features: p.features,
          rating: Number(p.ratingAverage),
          reviewCount: p.ratingCount,
          badge:
            p.badge === "BESTSELLER"
              ? "Bestseller"
              : p.badge === "NEW"
                ? "New"
                : p.badge === "SALE"
                  ? "Sale"
                  : null,
          images,
          visual: {
            imageUrl: images[0]?.thumbnailUrl ?? images[0]?.url,
            icon: p.placeholderIcon ?? "Package",
            theme: p.placeholderTheme ?? "navy",
          },
          variants: p.variants.map((v) => ({
            id: v.id,
            sku: v.sku,
            color: v.color ?? undefined,
            colorHex: v.colorHex ?? undefined,
            capacity: v.capacity ?? undefined,
            material: v.material ?? undefined,
            price: Number(v.price),
            compareAtPrice: v.compareAt ? Number(v.compareAt) : undefined,
            stock: Math.max(
              0,
              (v.inventory?.quantity ?? 0) - (v.inventory?.reserved ?? 0),
            ),
          })),
          compatibleDeviceModelIds: p.compatibility.map((c) => c.deviceModelId),
          reviews: p.reviews.map((r) => ({
            id: r.id,
            author: r.user.fullName ?? "Customer",
            rating: r.rating,
            title: r.title ?? "",
            comment: r.comment ?? "",
            date: r.createdAt.toISOString(),
            verified: r.verified,
          })),
        };
      }),
    coupons: [], // Codes are validated server-side; do not publish private promotions.
    settings: publicSettings(settings),
  };
}
export async function catalogRoutes(app: FastifyInstance) {
  app.get(
    "/catalog",
    {
      config: {
        rateLimit: {
          max: 1000,
          timeWindow: "1 minute",
          groupId: "catalog-read",
        },
      },
    },
    async () => loadCatalog(),
  );
  app.get("/settings", async () => publicSettings(await getSettings()));
  app.get("/categories", async () => (await loadCatalog()).categories);
  app.get("/brands", async (request) => {
    const { type } = z
      .object({ type: z.enum(["PHONE", "CAR"]).optional() })
      .parse(request.query);
    return (await loadCatalog()).brands.filter((b) => !type || b.type === type);
  });
  app.get("/device-models", async (request) => {
    const { brandId } = z
      .object({ brandId: z.string().optional() })
      .parse(request.query);
    return (await loadCatalog()).deviceModels.filter(
      (m) => !brandId || m.brandId === brandId,
    );
  });
  app.get<{ Params: { slug: string } }>(
    "/categories/:slug/subcategories",
    async (request) => {
      const catalog = await loadCatalog();
      if (!catalog.categories.some((c) => c.slug === request.params.slug))
        fail(404, "Category not found.");
      return catalog.subcategories.filter(
        (s) => s.categorySlug === request.params.slug,
      );
    },
  );
  app.get("/products", async (request) => {
    const { page, subcategory, deviceModelId } = z
      .object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        subcategory: z.string().optional(),
        deviceModelId: z.string().optional(),
      })
      .parse(request.query);
    const products = (await loadCatalog()).products.filter(
      (p) =>
        (!subcategory ||
          p.subcategorySlug === subcategory ||
          p.subcategoryId === subcategory) &&
        (!deviceModelId || p.compatibleDeviceModelIds.includes(deviceModelId)),
    );
    const pages = Math.max(1, Math.ceil(products.length / 20));
    const current = Math.min(page, pages);
    return {
      products: products.slice((current - 1) * 20, current * 20),
      total: products.length,
      page: current,
      pages,
      pageSize: 20,
    };
  });
  app.get<{ Params: { slug: string } }>("/products/:slug", async (request) => {
    return (
      (await loadCatalog()).products.find(
        (p) => p.slug === request.params.slug,
      ) ?? fail(404, "Product not found.")
    );
  });
}
