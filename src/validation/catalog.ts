import { z } from "zod";
export const money = z
  .number()
  .min(0.01, "Enter an amount greater than ₹0.")
  .max(1_000_000)
  .refine(
    (n) => Math.abs(n * 100 - Math.round(n * 100)) < 0.000001,
    "Use at most two decimal places.",
  );
const optionalText = z.string().trim().max(100).default("");
export const variantSchema = z
  .object({
    id: z.string().min(1).optional(),
    sku: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(
        /^[A-Za-z0-9._-]+$/,
        "Use letters, digits, dots, hyphens or underscores.",
      ),
    color: optionalText,
    colorHex: z
      .string()
      .regex(/^(#[0-9a-fA-F]{6})?$/, "Use a six-digit hex color.")
      .default(""),
    material: optionalText,
    capacity: optionalText,
    price: money,
    compareAt: money.nullable().default(null),
    isActive: z.boolean().default(true),
    initialStock: z.number().int().min(0).max(1_000_000).default(0),
  })
  .strict()
  .refine((v) => v.compareAt === null || v.compareAt > v.price, {
    path: ["compareAt"],
    message: "Compare-at price must exceed the selling price.",
  });
export const productSchema = z
  .object({
    name: z.string().trim().min(3).max(160),
    slug: z
      .string()
      .trim()
      .min(3)
      .max(180)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Use lowercase words separated by hyphens.",
      ),
    subcategoryId: z.string().min(1),
    shortDescription: z.string().trim().min(10).max(300),
    description: z.string().trim().min(10).max(20000),
    features: z.array(z.string().trim().min(1).max(300)).max(30),
    status: z.enum(["DRAFT", "PUBLISHED", "ARCHIVED"]),
    badge: z.enum(["BESTSELLER", "NEW", "SALE"]).nullable(),
    compatibleDeviceModelIds: z
      .array(z.string().min(1))
      .max(200)
      .refine(
        (a) => new Set(a).size === a.length,
        "Remove duplicate device models.",
      ),
    variants: z.array(variantSchema).min(1).max(100),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.status === "PUBLISHED" && !p.variants.some((v) => v.isActive))
      ctx.addIssue({
        code: "custom",
        path: ["variants"],
        message: "Published products need an active variant.",
      });
    const skus = new Set<string>();
    const ids = new Set<string>();
    p.variants.forEach((v, i) => {
      if (skus.has(v.sku.toLowerCase()))
        ctx.addIssue({
          code: "custom",
          path: ["variants", i, "sku"],
          message: "Each variant needs a unique SKU.",
        });
      skus.add(v.sku.toLowerCase());
      if (v.id && ids.has(v.id))
        ctx.addIssue({
          code: "custom",
          path: ["variants", i, "id"],
          message: "Duplicate variant.",
        });
      if (v.id) ids.add(v.id);
    });
  });
export const productUpdateSchema = productSchema.safeExtend({
  version: z.number().int().min(1),
});
export const adjustmentSchema = z
  .object({
    idempotencyKey: z.uuid(),
    reason: z
      .string()
      .trim()
      .min(5, "Enter a reason with at least 5 characters.")
      .max(500),
    items: z
      .array(
        z
          .object({
            variantId: z.string().min(1),
            version: z.number().int().min(1),
            delta: z
              .number()
              .int()
              .min(-1_000_000)
              .max(1_000_000)
              .refine((n) => n !== 0, "Enter a non-zero adjustment."),
          })
          .strict(),
      )
      .min(1)
      .max(100)
      .refine(
        (a) => new Set(a.map((v) => v.variantId)).size === a.length,
        "Each variant can appear only once.",
      ),
  })
  .strict();
export const taxonomySchemas = {
  categories: z
    .object({
      name: z.string().trim().min(2).max(100),
      slug: z
        .string()
        .min(2)
        .max(100)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      description: z.string().trim().max(500).default(""),
      icon: z.string().max(50).default("Package"),
    })
    .strict(),
  subcategories: z
    .object({
      name: z.string().trim().min(2).max(100),
      slug: z
        .string()
        .min(2)
        .max(100)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
      categoryId: z.string().min(1),
      description: z.string().trim().max(500).default(""),
      icon: z.string().max(50).default("Package"),
    })
    .strict(),
  brands: z
    .object({
      name: z.string().trim().min(2).max(100),
      type: z.enum(["PHONE", "CAR"]),
    })
    .strict(),
  deviceModels: z
    .object({
      name: z.string().trim().min(2).max(100),
      brandId: z.string().min(1),
      type: z.enum(["PHONE", "CAR"]),
    })
    .strict(),
};
