import { Prisma } from "@prisma/client";
import { mediaRoutes } from "./routes/product-images.js";
import { ZodError } from "zod";
import { shippingWebhookRoutes } from "./routes/shipping.js";
import { customerRoutes } from "./routes/customer.js";
import { catalogRoutes } from "./routes/catalog.js";
import { orderRoutes } from "./routes/orders.js";
import { adminRoutes } from "./routes/admin.js";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyError } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import sensible from "@fastify/sensible";
import rateLimit from "@fastify/rate-limit";
import { env } from "./env.js";
import { prisma } from "./lib/prisma.js";

export async function buildApp() {
  const app = Fastify({
    trustProxy: env.TRUST_PROXY,
    // Honor an inbound correlation id from a proxy/gateway; fall back to a
    // fresh one otherwise. Lets logs be traced across services later.
    genReqId: (req) =>
      (req.headers["x-request-id"] as string | undefined) ?? randomUUID(),
    logger: {
      level:
        env.LOG_LEVEL ?? (env.NODE_ENV === "production" ? "info" : "debug"),
      transport:
        env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
      // Groundwork for phase 03 auth, which introduces these headers/cookies.
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'req.headers["x-api-key"]',
          'res.headers["set-cookie"]',
        ],
        censor: "[redacted]",
      },
    },
  });

  // Awaited deliberately: registering these concurrently (no await) was
  // found to silently prevent @fastify/rate-limit's onRequest hook from
  // attaching at all — no error, it just never rate-limits. Sequential
  // await avoids that.
  await app.register(cors, { origin: env.CORS_ORIGIN });
  await app.register(helmet);
  await app.register(sensible);
  // Server-rendered pages and link prefetches share the frontend server's IP.
  // Give authenticated reads their own quota without consuming mutation/login limits.
  app.addHook("onRoute", (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (
      methods.includes("GET") &&
      (route.url.startsWith("/account/") || route.url === "/auth/session")
    ) {
      route.config ??= {};
      route.config.rateLimit ??= {
        max: 600,
        timeWindow: "1 minute",
        groupId: "customer-read",
      };
    }
    if (methods.includes("GET") && route.url.startsWith("/admin/")) {
      route.config ??= {};
      route.config.rateLimit ??= {
        max: 600,
        timeWindow: "1 minute",
        groupId: "admin-read",
      };
    }
  });
  await app.register(rateLimit, {
    max: 100,
    timeWindow: "1 minute",
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error({ err: error }, "request error");
    const statusCode =
      error instanceof ZodError
        ? 400
        : error instanceof Prisma.PrismaClientKnownRequestError
          ? error.code === "P2002" || error.code === "P2003"
            ? 409
            : error.code === "P2025"
              ? 404
              : 500
          : (error.statusCode ?? 500);
    reply.status(statusCode).send({
      error: {
        message:
          statusCode >= 500 && env.NODE_ENV === "production"
            ? "Internal Server Error"
            : error instanceof ZodError
              ? error.issues
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join("; ")
              : error instanceof Prisma.PrismaClientKnownRequestError
                ? error.code === "P2002"
                  ? "That slug or SKU is already in use. Choose a unique value."
                  : error.code === "P2003"
                    ? "This entry is referenced by other data and cannot be removed."
                    : error.code === "P2025"
                      ? "The entry no longer exists."
                      : "Could not save the change."
                : error.message,
        ...(error instanceof ZodError
          ? {
              issues: error.issues.map((i) => ({
                path: i.path.join("."),
                message: i.message,
              })),
            }
          : {}),
        statusCode,
      },
    });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({
      error: {
        message: `Route ${request.method} ${request.url} not found`,
        statusCode: 404,
      },
    });
  });

  // Prisma owns its own connection lifecycle; tie it to Fastify's so a
  // graceful app.close() (see src/index.ts) also closes the DB connection.
  app.addHook("onClose", async () => {
    await prisma.$disconnect();
  });

  // Health check — used by uptime monitoring and load balancers.
  // See doc/phases/01-foundation-setup.md and 13-deployment-devops.md.
  app.get("/health", async () => {
    let db: "connected" | "unreachable" = "connected";
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = "unreachable";
    }

    return {
      status: db === "connected" ? "ok" : "degraded",
      db,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  });

  await app.register(mediaRoutes);
  await app.register(catalogRoutes);
  await app.register(orderRoutes);
  await app.register(customerRoutes);
  await app.register(shippingWebhookRoutes);
  await app.register(adminRoutes);

  // Route modules land here as each phase is implemented, e.g.:
  // app.register(catalogRoutes, { prefix: "/products" });   // phase 04
  // app.register(cartRoutes, { prefix: "/cart" });           // phase 05
  // app.register(orderRoutes, { prefix: "/orders" });        // phase 06/07

  return app;
}
