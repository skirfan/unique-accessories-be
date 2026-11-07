import { randomBytes } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "./prisma.js";
import { hash, checkOrigin } from "./admin-auth.js";
import { env } from "../env.js";
import { fail } from "./http-error.js";
export const customerCookie = "ua_customer";
export function cookieValue(request: FastifyRequest, name: string) {
  return request.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
export function setCustomerCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  seconds: number,
) {
  reply.header(
    "Set-Cookie",
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${env.NODE_ENV === "production" ? "; Secure" : ""}`,
  );
}
export async function customerSession(request: FastifyRequest) {
  const token = cookieValue(request, customerCookie);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const session = await prisma.customerSession.findUnique({
    where: { tokenHash: hash(token) },
    include: { user: true },
  });
  return session &&
    session.expiresAt > new Date() &&
    session.user.role === "CUSTOMER"
    ? session.user
    : null;
}
export async function requireCustomer(request: FastifyRequest) {
  if (!["GET", "HEAD"].includes(request.method)) checkCustomerOrigin(request);
  const user = await customerSession(request);
  if (!user) fail(401, "Sign in to your customer account to continue.");
  return user;
}
export function checkCustomerOrigin(request: FastifyRequest) {
  checkOrigin(request);
  if (
    !request.headers.origin ||
    !env.CORS_ORIGIN.includes(request.headers.origin)
  )
    fail(403, "A same-site request is required.");
}
export async function createCustomerSession(
  userId: string,
  reply: FastifyReply,
) {
  const token = randomBytes(32).toString("hex"),
    seconds = 30 * 24 * 60 * 60;
  await prisma.customerSession.create({
    data: {
      userId,
      tokenHash: hash(token),
      expiresAt: new Date(Date.now() + seconds * 1000),
    },
  });
  setCustomerCookie(reply, customerCookie, token, seconds);
}
export const publicCustomer = (user: {
  id: string;
  email: string;
  fullName: string | null;
  avatarUrl: string | null;
}) => ({
  id: user.id,
  email: user.email,
  name: user.fullName,
  avatarUrl: user.avatarUrl,
});
