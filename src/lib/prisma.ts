import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "../env.js";

// Prisma 7 requires an explicit driver adapter — the client no longer
// manages its own connection from a schema-level datasource url.
// See doc/phases/02-database-schema.md "Implementation Notes".
const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });

// Reuse the client across tsx's hot-reload in dev so we don't exhaust
// Postgres connections on every file save.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (env.NODE_ENV === "development") {
  globalForPrisma.prisma = prisma;
}
