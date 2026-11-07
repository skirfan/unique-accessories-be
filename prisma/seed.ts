/**
 * Seeds the database from the same catalog content the frontend currently
 * ships as local mock JSON (unique-accessories-fe/src/data/*.json), copied
 * into ./seed-data so this repo stays self-contained.
 *
 * Scope note: doc/phases/02-database-schema.md only calls for seeding
 * taxonomy (categories/subcategories/brands/device models). This script
 * goes further and also seeds the full product catalog + coupons + a
 * handful of demo reviewer accounts, so phase 4 (swapping the frontend from
 * JSON to this API) starts from real, matching data instead of an empty
 * catalog. Existing rows are preserved by default; SEED_OVERWRITE=true explicitly restores fixtures.
 */
import type { ProductBadge, CouponType, DeviceType } from "@prisma/client";
import { prisma } from "../src/lib/prisma.js";

import categoriesJson from "./seed-data/categories.json" with { type: "json" };
import subcategoriesJson from "./seed-data/subcategories.json" with { type: "json" };
import brandsJson from "./seed-data/brands.json" with { type: "json" };
import deviceModelsJson from "./seed-data/device-models.json" with { type: "json" };
import productsJson from "./seed-data/products.json" with { type: "json" };
import couponsJson from "./seed-data/coupons.json" with { type: "json" };

// The JSON files hold heterogeneous variant/review shapes (e.g. some
// variants have `capacity`, some don't), so TS infers a narrow union from
// the literal data rather than a stable shape. Cast once here instead of
// re-deriving the frontend's full type set for a seed script.
interface SeedVariant {
  id: string;
  sku: string;
  color?: string;
  colorHex?: string;
  capacity?: string;
  price: number;
  compareAtPrice?: number;
  stock: number;
}

interface SeedReview {
  id: string;
  author: string;
  rating: number;
  title: string;
  comment: string;
  verified: boolean;
}

interface SeedProduct {
  id: string;
  slug: string;
  name: string;
  subcategoryId: string;
  shortDescription: string;
  description: string;
  features: string[];
  rating: number;
  reviewCount: number;
  badge: string | null;
  visual: { icon: string; theme: string };
  variants: SeedVariant[];
  compatibleDeviceModelIds: string[];
  reviews: SeedReview[];
}

// Repeated setup must not overwrite products edited by the operator.
const overwrite = process.env.SEED_OVERWRITE === "true";
if (process.env.NODE_ENV === "production")
  throw new Error("Sample catalog seeding is disabled in production.");

const categories = categoriesJson as {
  id: string;
  name: string;
  slug: string;
  description: string;
  icon: string;
}[];
const subcategories = subcategoriesJson as {
  id: string;
  categoryId: string;
  name: string;
  slug: string;
  description: string;
  icon: string;
}[];
const brands = brandsJson as { id: string; name: string; type: string }[];
const deviceModels = deviceModelsJson as {
  id: string;
  brandId: string;
  name: string;
  type: string;
}[];
const products = productsJson as SeedProduct[];
const coupons = couponsJson as {
  code: string;
  type: string;
  value: number;
  minOrderValue: number;
  description: string;
}[];

function toBadge(badge: string | null): ProductBadge | null {
  if (!badge) return null;
  return badge.toUpperCase() as ProductBadge;
}

function slugifyEmail(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/(^\.|\.$)/g, "");
}

async function seedTaxonomy() {
  for (const c of categories) {
    await prisma.category.upsert({
      where: { id: c.id },
      update: overwrite
        ? {
            name: c.name,
            slug: c.slug,
            description: c.description,
            icon: c.icon,
          }
        : {},
      create: {
        id: c.id,
        name: c.name,
        slug: c.slug,
        description: c.description,
        icon: c.icon,
      },
    });
  }

  for (const s of subcategories) {
    await prisma.subcategory.upsert({
      where: { id: s.id },
      update: overwrite
        ? {
            categoryId: s.categoryId,
            name: s.name,
            slug: s.slug,
            description: s.description,
            icon: s.icon,
          }
        : {},
      create: {
        id: s.id,
        categoryId: s.categoryId,
        name: s.name,
        slug: s.slug,
        description: s.description,
        icon: s.icon,
      },
    });
  }

  for (const b of brands) {
    await prisma.brand.upsert({
      where: { id: b.id },
      update: overwrite ? { name: b.name, type: b.type as DeviceType } : {},
      create: { id: b.id, name: b.name, type: b.type as DeviceType },
    });
  }

  for (const d of deviceModels) {
    await prisma.deviceModel.upsert({
      where: { id: d.id },
      update: overwrite
        ? { brandId: d.brandId, name: d.name, type: d.type as DeviceType }
        : {},
      create: {
        id: d.id,
        brandId: d.brandId,
        name: d.name,
        type: d.type as DeviceType,
      },
    });
  }

  console.log(
    `Taxonomy: ${categories.length} categories, ${subcategories.length} subcategories, ${brands.length} brands, ${deviceModels.length} device models`,
  );
}

async function seedDemoReviewers() {
  const authors = new Map<string, string>(); // author name -> userId

  for (const p of products) {
    for (const r of p.reviews) {
      if (authors.has(r.author)) continue;
      const id = `seed-user-${slugifyEmail(r.author)}`;
      authors.set(r.author, id);
      await prisma.user.upsert({
        where: { id },
        update: overwrite ? { fullName: r.author } : {},
        create: {
          id,
          email: `${slugifyEmail(r.author)}@seed.uniqueaccessories.example`,
          fullName: r.author,
        },
      });
    }
  }

  console.log(
    `Demo reviewers: ${authors.size} seed users (for sample review data only)`,
  );
  return authors;
}

async function seedProducts(authorToUserId: Map<string, string>) {
  for (const p of products) {
    await prisma.product.upsert({
      where: { id: p.id },
      update: overwrite
        ? {
            subcategoryId: p.subcategoryId,
            name: p.name,
            slug: p.slug,
            shortDescription: p.shortDescription,
            description: p.description,
            features: p.features,
            status: "PUBLISHED",
            badge: toBadge(p.badge),
            ratingAverage: p.rating,
            ratingCount: p.reviewCount,
            placeholderIcon: p.visual.icon,
            placeholderTheme: p.visual.theme,
          }
        : {},
      create: {
        id: p.id,
        subcategoryId: p.subcategoryId,
        name: p.name,
        slug: p.slug,
        shortDescription: p.shortDescription,
        description: p.description,
        features: p.features,
        status: "PUBLISHED",
        badge: toBadge(p.badge),
        ratingAverage: p.rating,
        ratingCount: p.reviewCount,
        placeholderIcon: p.visual.icon,
        placeholderTheme: p.visual.theme,
      },
    });

    for (const v of p.variants) {
      await prisma.productVariant.upsert({
        where: { id: v.id },
        update: overwrite
          ? {
              productId: p.id,
              sku: v.sku,
              color: v.color,
              colorHex: v.colorHex,
              capacity: v.capacity,
              price: v.price,
              compareAt: v.compareAtPrice,
            }
          : {},
        create: {
          id: v.id,
          productId: p.id,
          sku: v.sku,
          color: v.color,
          colorHex: v.colorHex,
          capacity: v.capacity,
          price: v.price,
          compareAt: v.compareAtPrice,
        },
      });

      await prisma.inventory.upsert({
        where: { variantId: v.id },
        update: overwrite ? { quantity: v.stock } : {},
        create: { variantId: v.id, quantity: v.stock },
      });
    }

    for (const deviceModelId of p.compatibleDeviceModelIds) {
      await prisma.productCompatibility.upsert({
        where: { productId_deviceModelId: { productId: p.id, deviceModelId } },
        update: {},
        create: { productId: p.id, deviceModelId },
      });
    }

    for (const r of p.reviews) {
      const userId = authorToUserId.get(r.author);
      if (!userId) continue;
      await prisma.review.upsert({
        where: { id: r.id },
        update: overwrite
          ? {
              productId: p.id,
              userId,
              rating: r.rating,
              title: r.title,
              comment: r.comment,
              verified: r.verified,
              approved: true,
            }
          : {},
        create: {
          id: r.id,
          productId: p.id,
          userId,
          rating: r.rating,
          title: r.title,
          comment: r.comment,
          verified: r.verified,
          approved: true,
        },
      });
    }
  }

  const variantCount = products.reduce((sum, p) => sum + p.variants.length, 0);
  const compatCount = products.reduce(
    (sum, p) => sum + p.compatibleDeviceModelIds.length,
    0,
  );
  const reviewCount = products.reduce((sum, p) => sum + p.reviews.length, 0);
  console.log(
    `Catalog: ${products.length} products, ${variantCount} variants, ${compatCount} compatibility links, ${reviewCount} reviews`,
  );
}

async function seedCoupons() {
  for (const c of coupons) {
    await prisma.coupon.upsert({
      where: { code: c.code },
      update: overwrite
        ? {
            type: c.type as CouponType,
            value: c.value,
            minOrderValue: c.minOrderValue,
            description: c.description,
          }
        : {},
      create: {
        code: c.code,
        type: c.type as CouponType,
        value: c.value,
        minOrderValue: c.minOrderValue,
        description: c.description,
      },
    });
  }
  console.log(`Coupons: ${coupons.length}`);
}

async function main() {
  await prisma.storeSettings.upsert({
    where: { id: "store" },
    update: {},
    create: { id: "store" },
  });
  await seedTaxonomy();
  const authorToUserId = await seedDemoReviewers();
  await seedProducts(authorToUserId);
  await seedCoupons();
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
