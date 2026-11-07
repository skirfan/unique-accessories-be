import "dotenv/config";
import { z } from "zod";

const optionalValue = (schema: z.ZodType<string>) =>
  z.preprocess(
    (value) => (typeof value === "string" && !value.trim() ? undefined : value),
    schema.optional(),
  );

const storageUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    ["http:", "https:"].includes(url.protocol) &&
    !url.search &&
    !url.hash &&
    !url.username &&
    !url.password
  );
}, "Use an HTTP(S) URL without credentials, query parameters or fragments.");

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().default(4000),
    // Comma-separated for multiple allowed origins (e.g. staging + prod frontends).
    // "http://a.com,http://b.com" -> ["http://a.com", "http://b.com"]
    CORS_ORIGIN: z
      .string()
      .default("http://localhost:3000")
      .transform((value) => value.split(",").map((origin) => origin.trim())),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .optional(),
    // Only set to true once this actually sits behind a reverse proxy/load balancer
    // (Phase 13) — affects how Fastify derives request.ip.
    TRUST_PROXY: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    ADMIN_EMAIL: z.string().email().optional(),
    ADMIN_PASSWORD: z.string().min(12).optional(),
    ADMIN_SESSION_SECRET: z.string().min(32).optional(),
    DATABASE_URL: z.string().url(), // local Postgres for now; swap to Supabase's pooled URL when that project exists
    SITE_URL: storageUrl.default("http://localhost:3000"),
    GOOGLE_CLIENT_ID: optionalValue(z.string().trim().min(1)),
    GOOGLE_CLIENT_SECRET: optionalValue(z.string().trim().min(1)),
    GOOGLE_REDIRECT_URI: optionalValue(storageUrl),
    SHIPROCKET_EMAIL: optionalValue(z.email()),
    SHIPROCKET_PASSWORD: optionalValue(z.string().min(1)),
    SHIPROCKET_PICKUP_LOCATION: optionalValue(z.string().trim().min(1)),
    SHIPROCKET_WEBHOOK_TOKEN: optionalValue(z.string().min(32)),
    UPLOAD_DIR: z.string().default("uploads/products"),
    R2_ACCOUNT_ID: optionalValue(z.string().trim().min(1)),
    R2_ACCESS_KEY_ID: optionalValue(z.string().trim().min(1)),
    R2_SECRET_ACCESS_KEY: optionalValue(z.string().trim().min(1)),
    R2_BUCKET: optionalValue(z.string().trim().min(1)),
    R2_PUBLIC_URL: optionalValue(storageUrl),
    R2_ENDPOINT: optionalValue(storageUrl),
    // Uncommented as each phase wires up the real dependency:
    // SUPABASE_URL: z.string().url(),          // phase 03
    // SUPABASE_SERVICE_ROLE_KEY: z.string(),   // phase 03
    // RAZORPAY_KEY_ID: z.string(),             // phase 06
    // RAZORPAY_KEY_SECRET: z.string(),
  })
  .superRefine((e, ctx) => {
    const fields = [
      e.R2_ACCOUNT_ID,
      e.R2_ACCESS_KEY_ID,
      e.R2_SECRET_ACCESS_KEY,
      e.R2_BUCKET,
      e.R2_PUBLIC_URL,
    ];
    if ((fields.some(Boolean) || e.R2_ENDPOINT) && !fields.every(Boolean))
      ctx.addIssue({
        code: "custom",
        message:
          "Configure all R2 credentials, bucket and public URL together.",
      });
    if (
      e.NODE_ENV === "production" &&
      (e.R2_PUBLIC_URL?.startsWith("http:") ||
        e.R2_ENDPOINT?.startsWith("http:"))
    )
      ctx.addIssue({
        code: "custom",
        message: "Production R2 URLs must use HTTPS.",
      });
    if (e.NODE_ENV === "production" && !fields.every(Boolean))
      ctx.addIssue({
        code: "custom",
        message:
          "Product media requires R2 storage in production. Configure all R2 variables.",
      });
  });

export const env = envSchema.parse(process.env);
