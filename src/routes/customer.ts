import { randomBytes } from "node:crypto";
import { OAuth2Client, CodeChallengeMethod } from "google-auth-library";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../lib/prisma.js";
import { env } from "../env.js";
import { fail } from "../lib/http-error.js";
import { hash } from "../lib/admin-auth.js";
import {
  customerCookie,
  cookieValue,
  setCustomerCookie,
  customerSession,
  requireCustomer,
  createCustomerSession,
  publicCustomer,
} from "../lib/customer-auth.js";
import { orderInclude, serializeOrder } from "./orders.js";
export function googleConfigured() {
  return Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REDIRECT_URI,
  );
}
export async function customerRoutes(app: FastifyInstance) {
  app.addHook("onSend", async (_req, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
  });
  app.get("/auth/session", async (request) => ({
    user: await customerSession(request).then((u) =>
      u ? publicCustomer(u) : null,
    ),
    googleEnabled: googleConfigured(),
  }));
  app.get(
    "/auth/google/start",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (!googleConfigured())
        return reply.redirect(`${env.SITE_URL}/login?error=not-configured`);
      const { returnTo } = z
        .object({
          returnTo: z
            .enum(["/account", "/wishlist", "/checkout"])
            .default("/account"),
        })
        .parse(request.query);
      const state = randomBytes(32).toString("hex"),
        nonce = randomBytes(32).toString("hex");
      const client = new OAuth2Client(
        env.GOOGLE_CLIENT_ID,
        env.GOOGLE_CLIENT_SECRET,
        env.GOOGLE_REDIRECT_URI,
      );
      const { codeVerifier, codeChallenge } =
        await client.generateCodeVerifierAsync();
      await prisma.oAuthAttempt.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      });
      await prisma.oAuthAttempt.create({
        data: {
          stateHash: hash(state),
          nonce,
          verifier: codeVerifier,
          returnTo,
          expiresAt: new Date(Date.now() + 600_000),
        },
      });
      setCustomerCookie(reply, "ua_oauth", state, 600);
      return reply.redirect(
        client.generateAuthUrl({
          scope: ["openid", "email", "profile"],
          state,
          nonce,
          code_challenge: codeChallenge,
          code_challenge_method: CodeChallengeMethod.S256,
          prompt: "select_account",
        }),
      );
    },
  );
  app.get(
    "/auth/google/callback",
    { logLevel: "silent" },
    async (request, reply) => {
      const query = z
        .object({
          state: z.string().max(100).optional(),
          code: z.string().max(4096).optional(),
          error: z.string().max(200).optional(),
        })
        .parse(request.query);
      const cookie = cookieValue(request, "ua_oauth");
      setCustomerCookie(reply, "ua_oauth", "", 0);
      if (!googleConfigured() || !query.state || query.state !== cookie)
        return reply.redirect(`${env.SITE_URL}/login?error=invalid-state`);
      const attempt = await prisma.oAuthAttempt.findUnique({
        where: { stateHash: hash(query.state) },
      });
      const consumed = await prisma.oAuthAttempt.deleteMany({
        where: { stateHash: hash(query.state), expiresAt: { gt: new Date() } },
      });
      if (!attempt || !consumed.count || query.error || !query.code)
        return reply.redirect(`${env.SITE_URL}/login?error=cancelled`);
      try {
        const client = new OAuth2Client(
          env.GOOGLE_CLIENT_ID,
          env.GOOGLE_CLIENT_SECRET,
          env.GOOGLE_REDIRECT_URI,
        );
        const { tokens } = await client.getToken({
          code: query.code,
          codeVerifier: attempt.verifier,
          redirect_uri: env.GOOGLE_REDIRECT_URI,
        });
        if (!tokens.id_token) throw new Error("Missing identity token");
        const payload = (
          await client.verifyIdToken({
            idToken: tokens.id_token,
            audience: env.GOOGLE_CLIENT_ID,
          })
        ).getPayload();
        if (
          !payload?.sub ||
          !payload.email ||
          !payload.email_verified ||
          payload.nonce !== attempt.nonce
        )
          throw new Error("Identity could not be verified");
        const email = payload.email.toLowerCase();
        const user = await prisma.$transaction(async (tx) => {
          const existing = await tx.user.findFirst({
            where: {
              OR: [
                { googleId: payload.sub },
                { email: { equals: email, mode: "insensitive" } },
              ],
            },
          });
          if (
            existing &&
            (existing.role !== "CUSTOMER" ||
              (existing.googleId && existing.googleId !== payload.sub))
          )
            fail(403, "This identity cannot be linked.");
          return existing
            ? tx.user.update({
                where: { id: existing.id },
                data: {
                  googleId: payload.sub,
                  fullName: payload.name ?? existing.fullName,
                  avatarUrl: payload.picture ?? null,
                },
              })
            : tx.user.create({
                data: {
                  email,
                  googleId: payload.sub,
                  fullName: payload.name ?? null,
                  avatarUrl: payload.picture ?? null,
                },
              });
        });
        // Keep the OAuth cookie expiry and the new session cookie in the same response.
        reply.removeHeader("Set-Cookie");
        await createCustomerSession(user.id, reply);
        const sessionCookie = reply.getHeader("Set-Cookie");
        reply.header("Set-Cookie", [
          String(sessionCookie),
          `ua_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${env.NODE_ENV === "production" ? "; Secure" : ""}`,
        ]);
        return reply.redirect(`${env.SITE_URL}${attempt.returnTo}`);
      } catch {
        return reply.redirect(`${env.SITE_URL}/login?error=sign-in-failed`);
      }
    },
  );
  app.post("/auth/logout", async (request, reply) => {
    await requireCustomer(request);
    const token = cookieValue(request, customerCookie)!;
    await prisma.customerSession.deleteMany({
      where: { tokenHash: hash(token) },
    });
    setCustomerCookie(reply, customerCookie, "", 0);
    return { ok: true };
  });
  app.get("/account/orders", async (request) => {
    const user = await requireCustomer(request);
    const { page } = z
      .object({ page: z.coerce.number().int().min(1).max(10000).default(1) })
      .parse(request.query);
    const [orders, total] = await Promise.all([
      prisma.order.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
        take: 10,
        skip: (page - 1) * 10,
        include: orderInclude,
      }),
      prisma.order.count({ where: { userId: user.id } }),
    ]);
    return {
      orders: await Promise.all(orders.map(serializeOrder)),
      total,
      page,
      pageSize: 10,
    };
  });
  app.get("/account/wishlist", async (request) => {
    const user = await requireCustomer(request);
    const wishlist = await prisma.wishlist.findUnique({
      where: { userId: user.id },
      include: { items: { where: { product: { status: "PUBLISHED" } } } },
    });
    return { productIds: wishlist?.items.map((i) => i.productId) ?? [] };
  });
  app.post("/account/wishlist/merge", async (request) => {
    const user = await requireCustomer(request);
    const { productIds } = z
      .object({ productIds: z.array(z.string().min(1).max(100)).max(100) })
      .strict()
      .parse(request.body);
    await prisma.$transaction(async (tx) => {
      const wishlist = await tx.wishlist.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: {},
      });
      const products = await tx.product.findMany({
        where: { id: { in: productIds }, status: "PUBLISHED" },
        select: { id: true },
      });
      await tx.wishlistItem.createMany({
        data: products.map((p) => ({
          wishlistId: wishlist.id,
          productId: p.id,
        })),
        skipDuplicates: true,
      });
    });
    const wishlist = await prisma.wishlist.findUnique({
      where: { userId: user.id },
      include: { items: true },
    });
    return { productIds: wishlist?.items.map((i) => i.productId) ?? [] };
  });
  app.put<{ Params: { id: string } }>(
    "/account/wishlist/:id",
    async (request) => {
      const user = await requireCustomer(request);
      const id = z.string().max(100).parse(request.params.id);
      if (
        !(await prisma.product.findFirst({
          where: { id, status: "PUBLISHED" },
        }))
      )
        fail(404, "Product unavailable.");
      const w = await prisma.wishlist.upsert({
        where: { userId: user.id },
        create: { userId: user.id },
        update: {},
      });
      await prisma.wishlistItem.upsert({
        where: { wishlistId_productId: { wishlistId: w.id, productId: id } },
        create: { wishlistId: w.id, productId: id },
        update: {},
      });
      return { ok: true };
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/account/wishlist/:id",
    async (request) => {
      const user = await requireCustomer(request);
      await prisma.wishlistItem.deleteMany({
        where: { productId: request.params.id, wishlist: { userId: user.id } },
      });
      return { ok: true };
    },
  );
}
