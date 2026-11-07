import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { env } from "../env.js";
import { fail } from "./http-error.js";

const COOKIE = "ua_admin";
const MAX_AGE = 8 * 60 * 60;
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const equal = (a: string, b: string) =>
  timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));

export function checkAdminConfigured() {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD || !env.ADMIN_SESSION_SECRET)
    fail(503, "Admin access is not configured.");
}
export function checkOrigin(request: FastifyRequest) {
  const origin = request.headers.origin;
  if (
    (origin && !env.CORS_ORIGIN.includes(origin)) ||
    request.headers["sec-fetch-site"] === "cross-site"
  ) {
    fail(403, "This request origin is not allowed.");
  }
}
export function login(email: string, password: string, reply: FastifyReply) {
  checkAdminConfigured();
  if (
    !equal(email.toLowerCase(), env.ADMIN_EMAIL!.toLowerCase()) ||
    !equal(password, env.ADMIN_PASSWORD!)
  )
    fail(401, "Invalid email or password.");
  const data = Buffer.from(
    JSON.stringify({
      email: env.ADMIN_EMAIL,
      expires: Date.now() + MAX_AGE * 1000,
    }),
  ).toString("base64url");
  const signature = createHmac("sha256", env.ADMIN_SESSION_SECRET!)
    .update(data)
    .digest("base64url");
  setCookie(reply, `${data}.${signature}`, MAX_AGE);
  return { email: env.ADMIN_EMAIL };
}
function setCookie(reply: FastifyReply, value: string, maxAge: number) {
  reply.header(
    "Set-Cookie",
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${env.NODE_ENV === "production" ? "; Secure" : ""}`,
  );
  reply.header("Cache-Control", "no-store");
}
export function logout(reply: FastifyReply) {
  setCookie(reply, "", 0);
}
export async function requireAdmin(request: FastifyRequest) {
  checkAdminConfigured();
  if (!["GET", "HEAD"].includes(request.method)) checkOrigin(request);
  const token = request.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  if (!token) fail(401, "Sign in to continue.");
  const [data, signature, extra] = token.split(".");
  const expected = createHmac("sha256", env.ADMIN_SESSION_SECRET!)
    .update(data ?? "")
    .digest("base64url");
  if (!data || !signature || extra || !equal(signature, expected))
    fail(401, "Your session has expired. Please sign in.");
  try {
    const session = JSON.parse(Buffer.from(data, "base64url").toString());
    if (
      session.email !== env.ADMIN_EMAIL ||
      !Number.isFinite(session.expires) ||
      session.expires < Date.now()
    )
      throw new Error();
  } catch {
    fail(401, "Your session has expired. Please sign in.");
  }
}
