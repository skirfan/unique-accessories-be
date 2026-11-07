import { z } from "zod";
import { env } from "../env.js";
import { fail } from "./http-error.js";
const BASE = "https://apiv2.shiprocket.in/v1/external";
let cached: { token: string; expires: number } | null = null;
export const shippingConfigured = () =>
  Boolean(
    env.SHIPROCKET_EMAIL &&
    env.SHIPROCKET_PASSWORD &&
    env.SHIPROCKET_PICKUP_LOCATION,
  );
export class ShippingError extends Error {
  constructor(public status: number) {
    super(
      `Shiprocket returned HTTP ${status}. Check the API account and shipment details.`,
    );
  }
}
async function call(
  path: string,
  method: string,
  body: unknown,
  token?: string,
) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new ShippingError(response.status);
  return z.record(z.string(), z.unknown()).parse(await response.json());
}
export async function shiprocket(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Record<string, unknown>> {
  if (!shippingConfigured())
    fail(
      503,
      "Configure the Shiprocket API user and pickup location in the backend environment.",
    );
  if (!cached || cached.expires < Date.now()) {
    const data = await call("/auth/login", "POST", {
      email: env.SHIPROCKET_EMAIL,
      password: env.SHIPROCKET_PASSWORD,
    });
    if (typeof data.token !== "string")
      fail(502, "Shiprocket did not return a session token.");
    cached = { token: data.token, expires: Date.now() + 6 * 24 * 3600_000 };
  }
  try {
    return await call(path, method, body, cached.token);
  } catch (error) {
    if (error instanceof ShippingError && error.status === 401) cached = null;
    throw error;
  }
}
