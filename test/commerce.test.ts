import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { InjectOptions } from "fastify";
import { after, before, beforeEach, test } from "node:test";

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test")) {
  throw new Error(
    "Set TEST_DATABASE_URL to an isolated PostgreSQL database whose name ends in _test. Never use the application database.",
  );
}
process.env.DATABASE_URL = testUrl;
const uploadDir = await mkdtemp(join(tmpdir(), "ua-catalog-test-"));
process.env.UPLOAD_DIR = uploadDir;
process.env.NODE_ENV = "test";
for (const key of [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_URL",
  "R2_ENDPOINT",
])
  process.env[key] = "";
process.env.GOOGLE_CLIENT_ID = "integration.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_SECRET = "integration-secret";
process.env.GOOGLE_REDIRECT_URI =
  "http://localhost:3000/api/auth/google/callback";
process.env.SHIPROCKET_EMAIL = "api@integration.example";
process.env.SHIPROCKET_PASSWORD = "integration-secret";
process.env.SHIPROCKET_PICKUP_LOCATION = "integration-pickup";
process.env.SHIPROCKET_WEBHOOK_TOKEN =
  "integration-webhook-token-with-32-characters";
process.env.LOG_LEVEL = "fatal";
process.env.ADMIN_EMAIL = "admin@integration.example";
process.env.ADMIN_PASSWORD = "integration-test-only-password";
process.env.ADMIN_SESSION_SECRET =
  "integration-test-only-session-secret-32-characters";
const { buildApp } = await import("../src/app.js");
const { prisma } = await import("../src/lib/prisma.js");
const app = await buildApp();
// Independent test flows use independent clients, while explicit rate-limit cases retain their IP.
let flowClient = 1;
beforeEach(() => {
  flowClient++;
});
async function inject(options: InjectOptions) {
  return app.inject({
    ...options,
    remoteAddress: options.remoteAddress ?? `198.18.0.${flowClient}`,
  });
}

let cookie = "";
let clientIp = 20;
const email = "checkout@integration.example";
const headers = () => ({ cookie, origin: "http://localhost:3000" });
const basket = (quantity = 1, couponCode?: string) => ({
  items: [{ variantId: "launch-test-variant", quantity }],
  ...(couponCode ? { couponCode } : {}),
});
async function settings(data: Record<string, unknown>) {
  const current = (
    await inject({ url: "/admin/settings", headers: headers() })
  ).json();
  const body = { ...current };
  delete body.id;
  delete body.updatedAt;
  delete body.invoiceLogoImage;
  delete body.invoiceLogoUrl;
  delete body.invoiceLogoKey;
  const response = await inject({
    method: "PATCH",
    url: "/admin/settings",
    headers: headers(),
    payload: { ...body, ...data },
  });
  assert.equal(response.statusCode, 200, response.body);
  return response.json();
}
async function quote(b = basket()) {
  return inject({ method: "POST", url: "/checkout/review", payload: b });
}
async function order(method = "COD", b = basket(), key = randomUUID()) {
  const review = await quote(b);
  assert.equal(review.statusCode, 200, review.body);
  const payload = {
    basket: b,
    customer: { name: "Integration Buyer", email, phone: "9876543210" },
    address: {
      line1: "Test street 123",
      line2: "",
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400001",
    },
    paymentMethod: method,
    idempotencyKey: key,
    quoteToken: review.json().quoteToken,
  };
  const response = await inject({
    method: "POST",
    url: "/orders",
    remoteAddress: `192.0.2.${++clientIp}`,
    payload,
  });
  return { response, payload, result: response.json() };
}
async function action(reference: string, name: string, extra = {}) {
  return inject({
    method: "POST",
    url: `/admin/orders/${reference}/action`,
    headers: headers(),
    payload: { action: name, ...extra },
  });
}

before(async () => {
  execFileSync("pnpm", ["db:migrate:deploy"], {
    env: process.env,
    stdio: "pipe",
  });
  execFileSync("pnpm", ["db:seed"], { env: process.env, stdio: "pipe" });
  await prisma.order.deleteMany({ where: { customerEmail: email } });
  await prisma.inventoryMovement.deleteMany({
    where: { variantId: "launch-test-variant" },
  });
  await prisma.coupon.upsert({
    where: { code: "LAUNCHTEST10" },
    update: { value: 10, minOrderValue: 0 },
    create: {
      code: "LAUNCHTEST10",
      type: "PERCENT",
      value: 10,
      minOrderValue: 0,
    },
  });
  const subcategory = await prisma.subcategory.findFirstOrThrow();
  await prisma.product.upsert({
    where: { id: "launch-test-product" },
    update: { status: "PUBLISHED" },
    create: {
      id: "launch-test-product",
      name: "Launch Test Product",
      slug: "launch-test-product",
      subcategoryId: subcategory.id,
      description: "Integration fixture",
      shortDescription: "Integration fixture",
      features: [],
      status: "PUBLISHED",
    },
  });
  await prisma.productVariant.upsert({
    where: { id: "launch-test-variant" },
    update: { price: 199 },
    create: {
      id: "launch-test-variant",
      productId: "launch-test-product",
      sku: "LAUNCH-TEST",
      price: 199,
    },
  });
  await prisma.inventory.upsert({
    where: { variantId: "launch-test-variant" },
    update: { quantity: 100, reserved: 0 },
    create: { variantId: "launch-test-variant", quantity: 100 },
  });
  await prisma.storeSettings.update({
    where: { id: "store" },
    data: {
      autoApproveOrders: false,
      minimumOrderEnabled: true,
      minimumOrderAmount: 199,
      codEnabled: true,
      upiEnabled: false,
      whatsappNumber: "",
      upiId: "",
      upiName: "",
      upiQrImage: null,
    },
  });
  const login = await inject({
    method: "POST",
    url: "/admin/login",
    payload: {
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    },
  });
  assert.equal(login.statusCode, 200, login.body);
  cookie = String(login.headers["set-cookie"]).split(";")[0];
});
after(async () => {
  await prisma.order.deleteMany({ where: { customerEmail: email } });
  const productIds = ["launch-test-product", ...catalogProductIds];
  await prisma.inventoryMovement.deleteMany({
    where: { variant: { productId: { in: productIds } } },
  });
  await prisma.product.deleteMany({ where: { id: { in: productIds } } });
  await rm(uploadDir, { recursive: true, force: true });
  await prisma.coupon.delete({ where: { code: "LAUNCHTEST10" } });
  await app.close();
});

test("admin endpoints require authentication and reject cross-site changes", async () => {
  assert.equal((await inject({ url: "/admin/settings" })).statusCode, 401);
  assert.equal(
    (
      await inject({
        method: "PATCH",
        url: "/admin/settings",
        headers: { cookie, origin: "https://attacker.example" },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await inject({
        url: "/admin/session",
        headers: { cookie: cookie + "tampered" },
      })
    ).statusCode,
    401,
  );
});

test("₹199 boundary, after-discount minimum, and server-side quantity validation", async () => {
  assert.equal((await quote()).json().eligible, true);
  await prisma.productVariant.update({
    where: { id: "launch-test-variant" },
    data: { price: 198.99 },
  });
  const below = await order();
  assert.equal(below.response.statusCode, 400, below.response.body);
  assert.equal((await quote()).json().remainingForMinimum, 0.01);
  await prisma.productVariant.update({
    where: { id: "launch-test-variant" },
    data: { price: 199 },
  });
  const discounted = await quote(basket(3, "LAUNCHTEST10"));
  assert.equal(discounted.statusCode, 200, discounted.body);
  assert.equal(discounted.json().discount, 59.7);
  await settings({ minimumOrderAmount: 550 });
  assert.equal((await quote(basket(3, "LAUNCHTEST10"))).json().eligible, false);
  assert.equal(
    (
      await quote({
        items: [{ variantId: "launch-test-variant", quantity: -1 }],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await quote({
        items: [
          { variantId: "launch-test-variant", quantity: 1 },
          { variantId: "launch-test-variant", quantity: 1 },
        ],
      })
    ).statusCode,
    400,
  );
  await settings({ minimumOrderAmount: 199 });
});

test("minimum can be changed and disabled without losing its saved amount", async () => {
  await settings({ minimumOrderAmount: 500 });
  assert.equal((await quote()).json().eligible, false);
  const disabled = await settings({ minimumOrderEnabled: false });
  assert.equal(disabled.minimumOrderAmount, 500);
  assert.equal((await quote()).json().eligible, true);
  await settings({ minimumOrderEnabled: true, minimumOrderAmount: 199 });
});

test("client prices are rejected, outdated quotes require review, and settings use version checks", async () => {
  const bad = await inject({
    method: "POST",
    url: "/checkout/review",
    payload: { ...basket(), total: 1 },
  });
  assert.equal(bad.statusCode, 400);
  const result = await order();
  assert.equal(result.response.statusCode, 201, result.response.body);
  const body = { ...result.payload };
  await settings({ shippingFee: 80 });
  const stale = await inject({
    method: "POST",
    url: "/orders",
    payload: { ...body, idempotencyKey: randomUUID() },
  });
  assert.equal(stale.statusCode, 409);
  const staleSettings = (
    await inject({ url: "/admin/settings", headers: headers() })
  ).json();
  delete staleSettings.id;
  delete staleSettings.updatedAt;
  delete staleSettings.invoiceLogoImage;
  delete staleSettings.invoiceLogoUrl;
  delete staleSettings.invoiceLogoKey;
  staleSettings.version -= 1;
  const conflict = await inject({
    method: "PATCH",
    url: "/admin/settings",
    headers: headers(),
    payload: staleSettings,
  });
  assert.equal(conflict.statusCode, 409);
  await settings({ shippingFee: 79 });
});

test("duplicate and concurrent submissions create exactly one order and private links guard details", async () => {
  const first = await order();
  assert.equal(first.response.statusCode, 201, first.response.body);
  const replay = await inject({
    method: "POST",
    url: "/orders",
    payload: first.payload,
  });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json().order.reference, first.result.order.reference);
  assert.equal(replay.json().accessToken, first.result.accessToken);
  const requests = { ...first.payload, idempotencyKey: randomUUID() };
  const concurrent = await Promise.all([
    inject({ method: "POST", url: "/orders", payload: requests }),
    inject({ method: "POST", url: "/orders", payload: requests }),
  ]);
  assert.ok(
    concurrent.every((r) => [200, 201].includes(r.statusCode)),
    concurrent.map((r) => r.body).join("\n"),
  );
  assert.equal(
    concurrent[0].json().order.reference,
    concurrent[1].json().order.reference,
  );
  const url = `/orders/${first.result.order.reference}`;
  assert.equal((await inject({ url })).statusCode, 404);
  const access = await inject({
    url,
    headers: { authorization: `Bearer ${first.result.accessToken}` },
  });
  assert.equal(access.statusCode, 200);
  assert.equal(access.json().accessTokenHash, undefined);
  assert.equal(access.json().idempotencyKey, undefined);
  assert.equal(access.headers["cache-control"], "no-store");
});

test("COD acceptance allocates once; cancellation restores once; unpaid COD can fulfill", async () => {
  const created = await order();
  const ref = created.result.order.reference;
  const stock = async () =>
    (
      await prisma.inventory.findUniqueOrThrow({
        where: { variantId: "launch-test-variant" },
      })
    ).quantity;
  const before = await stock();
  assert.equal(created.result.order.status, "AWAITING_APPROVAL");
  assert.equal(created.result.order.paymentStatus, "UNPAID");
  assert.equal((await action(ref, "accept")).statusCode, 200);
  assert.equal(await stock(), before - 1);
  assert.equal((await action(ref, "accept")).statusCode, 409);
  assert.equal(await stock(), before - 1);
  assert.equal((await action(ref, "cancel")).statusCode, 200);
  assert.equal(await stock(), before);
  assert.equal((await action(ref, "cancel")).statusCode, 409);
  assert.equal(await stock(), before);
  const deliver = (await order()).result.order.reference;
  for (const name of ["accept", "packed", "shipped", "delivered"])
    assert.equal(
      (
        await action(
          deliver,
          name,
          name === "shipped" ? { trackingNumber: "TEST123" } : {},
        )
      ).statusCode,
      200,
    );
  const paid = await action(deliver, "collect-cod");
  assert.equal(paid.json().paymentStatus, "PAID");
  assert.equal((await action(deliver, "collect-cod")).statusCode, 409);
});

test("competing acceptances cannot oversell the last item", async () => {
  await prisma.inventory.update({
    where: { variantId: "launch-test-variant" },
    data: { quantity: 1 },
  });
  const first = (await order()).result.order.reference;
  const second = (await order()).result.order.reference;
  const accepted = await Promise.all([
    action(first, "accept"),
    action(second, "accept"),
  ]);
  assert.deepEqual(accepted.map((r) => r.statusCode).sort(), [200, 409]);
  assert.equal(
    (
      await prisma.inventory.findUniqueOrThrow({
        where: { variantId: "launch-test-variant" },
      })
    ).quantity,
    0,
  );
  await prisma.inventory.update({
    where: { variantId: "launch-test-variant" },
    data: { quantity: 100 },
  });
});

test("UPI is unavailable until configured and QR appears only after acceptance", async () => {
  assert.equal((await order("UPI")).response.statusCode, 400);
  await settings({
    upiEnabled: true,
    upiId: "integration@bank",
    upiName: "Integration Store",
    whatsappNumber: "919876543210",
  });
  const created = await order("UPI");
  assert.equal(created.response.statusCode, 201, created.response.body);
  const ref = created.result.order.reference;
  assert.equal(created.result.order.upi, null);
  assert.ok(
    created.result.order.whatsappUrl.startsWith(
      "https://wa.me/919876543210?text=",
    ),
  );
  assert.ok(
    !created.result.order.whatsappUrl.includes(created.result.accessToken),
  );
  const accepted = await action(ref, "accept");
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.ok(accepted.json().upi.qrDataUrl.startsWith("data:image/png;base64,"));
  assert.equal((await action(ref, "packed")).statusCode, 409);
  const submit = await inject({
    method: "POST",
    url: `/orders/${ref}/payment-reference`,
    headers: { authorization: `Bearer ${created.result.accessToken}` },
    payload: { reference: "123456789012" },
  });
  assert.equal(submit.json().paymentStatus, "PENDING_VERIFICATION");
  assert.equal((await action(ref, "cancel")).statusCode, 409);
  assert.equal(
    (
      await action(ref, "reject-payment", {
        note: "No matching credit in merchant account",
      })
    ).json().paymentStatus,
    "UNPAID",
  );
  const resubmit = await inject({
    method: "POST",
    url: `/orders/${ref}/payment-reference`,
    headers: { authorization: `Bearer ${created.result.accessToken}` },
    payload: { reference: "123456789012" },
  });
  assert.equal(resubmit.json().paymentStatus, "PENDING_VERIFICATION");
  const paid = await action(ref, "verify-payment");
  assert.equal(paid.statusCode, 200, paid.body);
  assert.equal(paid.json().paymentStatus, "PAID");
  assert.equal((await action(ref, "packed")).statusCode, 200);
  const cancelled = await action(ref, "cancel");
  assert.equal(cancelled.json().paymentStatus, "REFUND_REQUIRED");
  assert.equal(
    (
      await action(ref, "refund-recorded", {
        note: "Refund transaction TEST-REFUND",
      })
    ).json().paymentStatus,
    "REFUNDED",
  );
  assert.equal(
    (
      await inject({
        url: `/orders/${ref}`,
        headers: { authorization: `Bearer ${created.result.accessToken}` },
      })
    ).json().upi,
    null,
  );
});

test("merchant QR upload supports QR-only UPI and remains private until acceptance", async () => {
  const QRCode = (await import("qrcode")).default;
  const qr = await QRCode.toDataURL(
    "upi://pay?pa=fixture@bank&pn=Fixture%20Store",
  );
  const current = (
    await inject({ url: "/admin/settings", headers: headers() })
  ).json();
  delete current.id;
  delete current.updatedAt;
  delete current.invoiceLogoImage;
  delete current.invoiceLogoUrl;
  delete current.invoiceLogoKey;
  const invalid = await inject({
    method: "PATCH",
    url: "/admin/settings",
    headers: headers(),
    payload: { ...current, upiQrImage: "data:image/svg+xml;base64,PHN2Zz4=" },
  });
  assert.equal(invalid.statusCode, 400);
  await settings({
    upiEnabled: true,
    upiId: "",
    upiName: "Fixture Store",
    upiQrImage: qr,
  });
  const publicResponse = await inject({ url: "/settings" });
  assert.equal(publicResponse.json().upiQrImage, undefined);
  assert.equal(publicResponse.json().upiId, undefined);
  const created = await order("UPI");
  assert.equal(created.response.statusCode, 201, created.response.body);
  assert.equal(created.result.order.upi, null);
  const accepted = await action(created.result.order.reference, "accept");
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().upi.qrDataUrl, qr);
  assert.equal(accepted.json().upi.customQr, true);
  assert.equal(accepted.json().upi.url, null);
  await action(created.result.order.reference, "cancel");
  await settings({ upiEnabled: false, upiQrImage: null });
});

test("dashboard metrics and order search use authenticated live data", async () => {
  assert.equal(
    (await inject({ url: "/admin/overview", remoteAddress: "192.0.2.240" }))
      .statusCode,
    401,
  );
  const requestHeaders = headers();
  const before = (
    await inject({
      url: "/admin/overview",
      headers: requestHeaders,
      remoteAddress: "192.0.2.240",
    })
  ).json();
  const created = await order();
  assert.equal(created.response.statusCode, 201, created.response.body);
  const overview = await inject({
    url: "/admin/overview",
    headers: requestHeaders,
    remoteAddress: "192.0.2.240",
  });
  assert.equal(overview.statusCode, 200, overview.body);
  const data = overview.json();
  assert.equal(data.orders, before.orders + 1);
  assert.equal(data.pendingApproval, before.pendingApproval + 1);
  assert.equal(data.activity.length, 7);
  assert.equal(
    data.weekOrders,
    data.activity.reduce(
      (sum: number, day: { orders: number }) => sum + day.orders,
      0,
    ),
  );
  const found = await inject({
    url: `/admin/orders?q=${created.result.order.reference}&paymentStatus=UNPAID`,
    headers: requestHeaders,
    remoteAddress: "192.0.2.240",
  });
  assert.equal(found.statusCode, 200, found.body);
  assert.equal(found.json().total, 1);
  assert.equal(
    found.json().orders[0].reference,
    created.result.order.reference,
  );
  const filtered = await inject({
    url: `/admin/orders?q=${created.result.order.reference}&paymentStatus=PAID`,
    headers: requestHeaders,
    remoteAddress: "192.0.2.240",
  });
  assert.equal(filtered.json().total, 0);
});

const catalogProductIds: string[] = [];
let catalogClient = 10;
const catalogRequest = (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  payload?: object,
  customHeaders?: Record<string, string>,
) =>
  inject({
    method,
    url,
    payload,
    headers: customHeaders ?? headers(),
    remoteAddress: `198.51.100.${++catalogClient}`,
  });
async function catalogFixture(status: "DRAFT" | "PUBLISHED" = "DRAFT") {
  const sub = await prisma.subcategory.findFirstOrThrow();
  const devices = await prisma.deviceModel.findMany({ take: 3 });
  const suffix = randomUUID();
  const payload = {
    name: "Catalog integration product",
    slug: `catalog-test-${suffix}`,
    subcategoryId: sub.id,
    shortDescription: "A catalog integration fixture",
    description: "A product created through the protected admin API.",
    features: ["One useful feature"],
    status,
    badge: null,
    compatibleDeviceModelIds: devices.map((d) => d.id),
    variants: [
      {
        sku: `CAT-${suffix}-A`,
        color: "Blue",
        colorHex: "#2563eb",
        material: "Silicone",
        capacity: "",
        price: 199,
        compareAt: 249,
        isActive: true,
        initialStock: 8,
      },
      {
        sku: `CAT-${suffix}-B`,
        color: "Black",
        colorHex: "#000000",
        material: "Leather",
        capacity: "Large",
        price: 299,
        compareAt: null,
        isActive: true,
        initialStock: 3,
      },
    ],
  };
  const response = await catalogRequest("POST", "/admin/products", payload);
  assert.equal(response.statusCode, 201, response.body);
  const result = response.json();
  catalogProductIds.push(result.id);
  return { payload, result };
}

test("catalog authoring validates variants, hides drafts, and preserves ownership and versions", async () => {
  assert.equal(
    (await catalogRequest("GET", "/admin/products", undefined, {})).statusCode,
    401,
  );
  const { payload, result } = await catalogFixture();
  assert.equal(result.variants.length, 2);
  assert.equal(result.compatibleDeviceModelIds.length, 3);
  assert.equal(result.variants[0].inventory.quantity, 8);
  assert.equal(
    (
      await inject({
        url: `/products/${result.slug}`,
        remoteAddress: "203.0.113.50",
      })
    ).statusCode,
    404,
  );
  const invalid = await catalogRequest("POST", "/admin/products", {
    ...payload,
    slug: `invalid-${randomUUID()}`,
    variants: [{ ...payload.variants[0], price: -1 }],
  });
  assert.equal(invalid.statusCode, 400);
  assert.ok(
    invalid
      .json()
      .error.issues.some(
        (i: { path: string }) => i.path === "variants.0.price",
      ),
  );
  const update = {
    ...payload,
    status: "PUBLISHED",
    version: result.version,
    variants: payload.variants.map((v, i) => ({
      ...v,
      id: result.variants[i].id,
      initialStock: 0,
    })),
  };
  const published = await catalogRequest(
    "PATCH",
    `/admin/products/${result.id}`,
    update,
  );
  assert.equal(published.statusCode, 200, published.body);
  const publicProduct = await inject({
    url: `/products/${result.slug}`,
    remoteAddress: "203.0.113.50",
  });
  assert.equal(publicProduct.statusCode, 200);
  assert.equal(publicProduct.json().variants.length, 2);
  assert.equal(publicProduct.json().variants[0].material, "Silicone");
  const pageResponse = await catalogRequest(
    "GET",
    `/products?subcategory=${payload.subcategoryId}&deviceModelId=${payload.compatibleDeviceModelIds[0]}&page=1`,
  );
  assert.equal(pageResponse.statusCode, 200, pageResponse.body);
  assert.ok(
    pageResponse
      .json()
      .products.some((p: { id: string }) => p.id === result.id),
  );
  assert.ok(pageResponse.json().products.length <= 20);

  assert.equal(
    (await catalogRequest("PATCH", `/admin/products/${result.id}`, update))
      .statusCode,
    409,
  );
  const other = await catalogFixture();
  const foreign = {
    ...update,
    version: published.json().version,
    variants: [
      { ...update.variants[0], id: other.result.variants[0].id },
      update.variants[1],
    ],
  };
  assert.equal(
    (await catalogRequest("PATCH", `/admin/products/${result.id}`, foreign))
      .statusCode,
    400,
  );
  assert.equal(
    (
      await catalogRequest("PATCH", `/admin/products/${result.id}`, {
        ...update,
        version: published.json().version,
        variants: [update.variants[0]],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await catalogRequest("PATCH", `/admin/products/${result.id}`, {
        ...update,
        version: published.json().version,
        variants: [
          { ...update.variants[0], initialStock: 5 },
          update.variants[1],
        ],
      })
    ).statusCode,
    400,
  );
  const disabled = await catalogRequest(
    "PATCH",
    `/admin/products/${result.id}`,
    {
      ...update,
      version: published.json().version,
      variants: [
        { ...update.variants[0], isActive: false },
        update.variants[1],
      ],
    },
  );
  assert.equal(disabled.statusCode, 200);
  const checkout = await quote({
    items: [{ variantId: result.variants[0].id, quantity: 1 }],
  });
  assert.equal(checkout.statusCode, 409);
  assert.equal(
    (
      await inject({
        url: `/products/${result.slug}`,
        remoteAddress: "203.0.113.50",
      })
    ).json().variants.length,
    1,
  );
  assert.equal(
    (
      await catalogRequest("PATCH", `/admin/products/${result.id}`, {
        ...update,
        status: "ARCHIVED",
        version: disabled.json().version,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await inject({
        url: `/products/${result.slug}`,
        remoteAddress: "203.0.113.50",
      })
    ).statusCode,
    404,
  );
});

test("inventory batches are atomic, idempotent, conflict-aware, and audited", async () => {
  const { result } = await catalogFixture();
  const [a, b] = result.variants;
  const key = randomUUID();
  const payload = {
    idempotencyKey: key,
    reason: "Received supplier delivery",
    items: [
      { variantId: a.id, version: a.inventory.version, delta: 5 },
      { variantId: b.id, version: b.inventory.version, delta: -2 },
    ],
  };
  const responses = await Promise.all([
    catalogRequest("POST", "/admin/inventory/adjust", payload),
    catalogRequest("POST", "/admin/inventory/adjust", payload),
  ]);
  assert.deepEqual(
    responses.map((r) => r.statusCode),
    [200, 200],
    responses.map((r) => r.body).join("\n"),
  );
  assert.equal(
    (await prisma.inventory.findUniqueOrThrow({ where: { variantId: a.id } }))
      .quantity,
    13,
  );
  assert.equal(
    (await prisma.inventory.findUniqueOrThrow({ where: { variantId: b.id } }))
      .quantity,
    1,
  );
  assert.equal(
    (
      await catalogRequest("POST", "/admin/inventory/adjust", {
        ...payload,
        reason: "Different adjustment reason",
      })
    ).statusCode,
    409,
  );
  const history = await catalogRequest(
    "GET",
    `/admin/inventory/${a.id}/history`,
  );
  assert.equal(history.json().total, 2);
  assert.equal(history.json().items[0].delta, 5);
  assert.equal(history.json().items[0].actor, process.env.ADMIN_EMAIL);
  const stale = await catalogRequest("POST", "/admin/inventory/adjust", {
    ...payload,
    idempotencyKey: randomUUID(),
  });
  assert.equal(stale.statusCode, 409);
  const inventoryA = await prisma.inventory.findUniqueOrThrow({
    where: { variantId: a.id },
  });
  const inventoryB = await prisma.inventory.findUniqueOrThrow({
    where: { variantId: b.id },
  });
  const invalid = await catalogRequest("POST", "/admin/inventory/adjust", {
    ...payload,
    idempotencyKey: randomUUID(),
    items: [
      { variantId: a.id, version: inventoryA.version, delta: 2 },
      { variantId: b.id, version: inventoryB.version, delta: -100 },
    ],
  });
  assert.equal(invalid.statusCode, 400);
  assert.equal(
    (await prisma.inventory.findUniqueOrThrow({ where: { variantId: a.id } }))
      .quantity,
    13,
  );
  const low = await catalogRequest(
    "GET",
    `/admin/inventory?q=${encodeURIComponent(b.sku)}&lowStock=true&threshold=2`,
  );
  assert.equal(low.json().total, 1);
  assert.equal(low.json().items[0].available, 1);
});

test("order allocation invalidates stale inventory edits and records release history", async () => {
  const { result } = await catalogFixture("PUBLISHED");
  const variant = result.variants[0];
  const created = await order("COD", {
    items: [{ variantId: variant.id, quantity: 1 }],
  });
  assert.equal(created.response.statusCode, 201, created.response.body);
  assert.equal(
    (await action(created.result.order.reference, "accept")).statusCode,
    200,
  );
  const adjust = await catalogRequest("POST", "/admin/inventory/adjust", {
    idempotencyKey: randomUUID(),
    reason: "Stale stock count",
    items: [
      { variantId: variant.id, version: variant.inventory.version, delta: 5 },
    ],
  });
  assert.equal(adjust.statusCode, 409);
  assert.equal(
    (await action(created.result.order.reference, "cancel")).statusCode,
    200,
  );
  assert.equal(
    (
      await prisma.inventory.findUniqueOrThrow({
        where: { variantId: variant.id },
      })
    ).quantity,
    8,
  );
  const history = (
    await catalogRequest("GET", `/admin/inventory/${variant.id}/history`)
  ).json();
  assert.deepEqual(
    history.items
      .filter(
        (m: { orderReference: string }) =>
          m.orderReference === created.result.order.reference,
      )
      .map((m: { delta: number }) => m.delta)
      .sort((a: number, b: number) => a - b),
    [-1, 1],
  );
});

test("photos are decoded, optimized, scoped to their product, reordered and removed", async () => {
  const { result } = await catalogFixture();
  const other = await catalogFixture();
  const bytes = await sharp({
    create: { width: 1800, height: 900, channels: 3, background: "#2563eb" },
  })
    .png()
    .toBuffer();
  async function upload(version: number, bytes: Buffer, variantId = "") {
    const boundary = "catalog-test-boundary";
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="photo.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    return inject({
      method: "POST",
      url: `/admin/products/${result.id}/images?version=${version}&variantId=${variantId}`,
      headers: {
        ...headers(),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      remoteAddress: "203.0.113.80",
      payload,
    });
  }
  assert.equal(
    (await upload(result.version, bytes, other.result.variants[0].id))
      .statusCode,
    400,
  );
  assert.equal(
    (await upload(result.version, Buffer.from("not a photo"))).statusCode,
    400,
  );
  const uploaded = await upload(result.version, bytes, result.variants[0].id);
  assert.equal(uploaded.statusCode, 200, uploaded.body);
  const image = uploaded.json().images[0];
  const full = await inject({
    url: image.url.replace(/^\/api/, ""),
    remoteAddress: "203.0.113.80",
  });
  assert.equal(full.statusCode, 200);
  assert.match(String(full.headers["content-type"]), /image\/webp/);
  const meta = await sharp(full.rawPayload).metadata();
  assert.equal(meta.width, 1600);
  assert.equal(meta.height, 800);
  const thumb = await inject({
    url: image.thumbnailUrl.replace(/^\/api/, ""),
    remoteAddress: "203.0.113.80",
  });
  assert.equal((await sharp(thumb.rawPayload).metadata()).width, 400);
  const metadata = {
    version: uploaded.json().version,
    images: [
      {
        id: image.id,
        variantId: result.variants[1].id,
        altText: "Blue case side view",
      },
    ],
  };
  assert.equal(
    (
      await catalogRequest(
        "PATCH",
        `/admin/products/${other.result.id}/images`,
        metadata,
      )
    ).statusCode,
    400,
  );
  const saved = await catalogRequest(
    "PATCH",
    `/admin/products/${result.id}/images`,
    metadata,
  );
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().images[0].altText, "Blue case side view");
  assert.equal(
    (
      await catalogRequest(
        "DELETE",
        `/admin/products/${result.id}/images/${image.id}`,
        { version: uploaded.json().version },
      )
    ).statusCode,
    409,
  );
  const deleted = await catalogRequest(
    "DELETE",
    `/admin/products/${result.id}/images/${image.id}`,
    { version: saved.json().version },
  );
  assert.equal(deleted.statusCode, 200);
  assert.equal(deleted.json().images.length, 0);
  assert.equal(
    (
      await inject({
        url: image.url.replace(/^\/api/, ""),
        remoteAddress: "203.0.113.80",
      })
    ).statusCode,
    404,
  );
});

test("taxonomy management blocks destructive cascades and mismatched device types", async () => {
  const suffix = randomUUID();
  const category = (
    await catalogRequest("POST", "/admin/catalog/categories", {
      name: "Fixture category",
      slug: `test-${suffix}`,
      description: "Fixture",
      icon: "Package",
    })
  ).json();
  const sub = (
    await catalogRequest("POST", "/admin/catalog/subcategories", {
      name: "Fixture subcategory",
      slug: `test-sub-${suffix}`,
      categoryId: category.id,
      description: "Fixture",
      icon: "Package",
    })
  ).json();
  const brand = (
    await catalogRequest("POST", "/admin/catalog/brands", {
      name: "Fixture brand",
      type: "PHONE",
    })
  ).json();
  try {
    assert.equal(
      (
        await catalogRequest(
          "DELETE",
          `/admin/catalog/categories/${category.id}`,
        )
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await catalogRequest("POST", "/admin/catalog/deviceModels", {
          name: "Invalid car model",
          brandId: brand.id,
          type: "CAR",
        })
      ).statusCode,
      400,
    );
    const model = await catalogRequest("POST", "/admin/catalog/deviceModels", {
      name: "Fixture phone model",
      brandId: brand.id,
      type: "PHONE",
    });
    assert.equal(model.statusCode, 200, model.body);
    assert.equal(
      (
        await catalogRequest("PATCH", `/admin/catalog/brands/${brand.id}`, {
          name: brand.name,
          type: "CAR",
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await catalogRequest("DELETE", `/admin/catalog/brands/${brand.id}`))
        .statusCode,
      409,
    );
    assert.equal(
      (
        await catalogRequest(
          "DELETE",
          `/admin/catalog/deviceModels/${model.json().id}`,
        )
      ).statusCode,
      200,
    );
  } finally {
    await prisma.deviceModel.deleteMany({ where: { brandId: brand.id } });
    await prisma.brand.delete({ where: { id: brand.id } });
    await prisma.subcategory.delete({ where: { id: sub.id } });
    await prisma.category.delete({ where: { id: category.id } });
  }
});

test("repeated development seeding preserves admin-edited catalog and stock", async () => {
  const fixture = await prisma.product.findFirstOrThrow({
    where: { id: "prod-iphone15pro-cover" },
    include: { variants: { include: { inventory: true } } },
  });
  const variant = fixture.variants.find((v) => v.inventory);
  assert.ok(variant);
  const originalStock = variant.inventory!;
  try {
    await prisma.product.update({
      where: { id: fixture.id },
      data: { name: "Operator edited catalog name", version: { increment: 1 } },
    });
    await prisma.inventory.update({
      where: { variantId: variant.id },
      data: { quantity: 12345, version: { increment: 1 } },
    });
    execFileSync("pnpm", ["db:seed"], {
      env: { ...process.env, SEED_OVERWRITE: "false" },
      stdio: "pipe",
    });
    const preserved = await prisma.product.findUniqueOrThrow({
      where: { id: fixture.id },
    });
    assert.equal(preserved.name, "Operator edited catalog name");
    assert.equal(preserved.version, fixture.version + 1);
    const stock = await prisma.inventory.findUniqueOrThrow({
      where: { variantId: variant.id },
    });
    assert.equal(stock.quantity, 12345);
    assert.equal(stock.version, originalStock.version + 1);
  } finally {
    await prisma.product.update({
      where: { id: fixture.id },
      data: { name: fixture.name, version: fixture.version },
    });
    await prisma.inventory.update({
      where: { variantId: variant.id },
      data: {
        quantity: originalStock.quantity,
        version: originalStock.version,
      },
    });
  }
});

test("dashboard revenue periods and top products reflect verified payments and accepted orders", async () => {
  const { result } = await catalogFixture("PUBLISHED");
  const variant = result.variants[0];
  const snapshot = await catalogRequest("GET", "/admin/overview?days=7");
  assert.equal(snapshot.statusCode, 200, snapshot.body);
  const baseline = snapshot.json().dashboard;
  const created = await order("COD", {
    items: [{ variantId: variant.id, quantity: 1 }],
  });
  assert.equal(created.response.statusCode, 201, created.response.body);
  const reference = created.result.order.reference;
  for (const name of [
    "accept",
    "packed",
    "shipped",
    "delivered",
    "collect-cod",
  ]) {
    const response = await action(
      reference,
      name,
      name === "shipped" ? { trackingNumber: "DASHBOARD-TEST-TRACK" } : {},
    );
    assert.equal(response.statusCode, 200, response.body);
  }
  const seven = (await catalogRequest("GET", "/admin/overview?days=7")).json();
  assert.equal(seven.dashboard.days, 7);
  assert.equal(seven.dashboard.revenueActivity.length, 7);
  assert.equal(
    seven.dashboard.revenue,
    baseline.revenue + created.result.order.total,
  );
  assert.equal(
    seven.dashboard.revenueActivity.reduce(
      (n: number, d: { revenue: number }) => n + d.revenue,
      0,
    ),
    seven.dashboard.revenue,
  );
  assert.equal(
    seven.recentOrders.find(
      (o: { reference: string }) => o.reference === reference,
    ).itemCount,
    1,
  );
  const historic = new Date(Date.now() - 10 * 86400000);
  await prisma.order.update({
    where: { reference },
    data: { createdAt: historic, paymentVerifiedAt: historic },
  });
  const excluded = (
    await catalogRequest("GET", "/admin/overview?days=7")
  ).json();
  assert.equal(excluded.dashboard.revenue, baseline.revenue);
  const thirty = (
    await catalogRequest("GET", "/admin/overview?days=30")
  ).json();
  assert.ok(thirty.dashboard.revenue >= created.result.order.total);
  assert.equal(thirty.dashboard.revenueActivity.length, 30);
  const top = thirty.dashboard.topProducts.find(
    (p: { id: string }) => p.id === result.id,
  );
  assert.ok(top);
  assert.equal(top.sold, 1);
  assert.equal(top.revenue, 199);
  const annual = (
    await catalogRequest("GET", "/admin/overview?days=365")
  ).json();
  assert.equal(annual.dashboard.revenueActivity.length, 27);
  assert.ok(
    annual.dashboard.acceptanceRate >= 0 &&
      annual.dashboard.acceptanceRate <= 100,
  );
  assert.equal(
    (await catalogRequest("GET", "/admin/overview?days=8")).statusCode,
    400,
  );
  const cancelled = await order("COD", {
    items: [{ variantId: variant.id, quantity: 2 }],
  });
  assert.equal(cancelled.response.statusCode, 201);
  await action(cancelled.result.order.reference, "accept");
  await action(cancelled.result.order.reference, "cancel");
  const after = (await catalogRequest("GET", "/admin/overview?days=30")).json();
  assert.equal(
    after.dashboard.topProducts.find((p: { id: string }) => p.id === result.id)
      .sold,
    1,
  );
});

test("catalog and media delivery use separate read budgets from checkout mutations", async () => {
  const remoteAddress = "192.0.2.241";
  const catalog = await inject({ url: "/catalog", remoteAddress });
  assert.equal(catalog.statusCode, 200);
  assert.equal(Number(catalog.headers["x-ratelimit-limit"]), 1000);
  const media = await inject({
    url: "/media/products/00000000-0000-0000-0000-000000000000.webp",
    remoteAddress,
  });
  assert.equal(Number(media.headers["x-ratelimit-limit"]), 3000);
  const adminRead = await inject({ url: "/admin/session", remoteAddress });
  assert.equal(adminRead.statusCode, 401);
  assert.equal(Number(adminRead.headers["x-ratelimit-limit"]), 600);
  const order = await inject({
    method: "POST",
    url: "/orders",
    payload: {},
    remoteAddress,
  });
  assert.equal(order.statusCode, 400);
  assert.equal(Number(order.headers["x-ratelimit-limit"]), 10);
});

test("auto confirmation allocates stock once, creates a stable private invoice and prevents overselling", async () => {
  await settings({
    autoApproveOrders: true,
    minimumOrderEnabled: false,
    upiEnabled: false,
    codEnabled: true,
    sellerName: "Unique Test Store",
    sellerAddress: "Test business address",
  });
  await prisma.inventory.update({
    where: { variantId: "launch-test-variant" },
    data: { quantity: 1, reserved: 0 },
  });
  const review = await quote();
  const payload = {
    basket: basket(),
    customer: { name: "नमस्ते Buyer", email, phone: "9876543210" },
    address: {
      line1: "Test street 123",
      line2: "",
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400001",
    },
    paymentMethod: "COD",
    idempotencyKey: randomUUID(),
    quoteToken: review.json().quoteToken,
  };
  const responses = await Promise.all([
    inject({
      method: "POST",
      url: "/orders",
      payload,
      remoteAddress: "192.0.2.172",
    }),
    inject({
      method: "POST",
      url: "/orders",
      payload: { ...payload, idempotencyKey: randomUUID() },
      remoteAddress: "192.0.2.173",
    }),
  ]);
  assert.equal(responses.filter((r) => r.statusCode === 201).length, 1);
  assert.equal(responses.filter((r) => r.statusCode === 409).length, 1);
  const placed = responses.find((r) => r.statusCode === 201)!.json();
  assert.equal(placed.order.status, "CONFIRMED");
  assert.ok(placed.order.invoiceNumber);
  assert.equal(placed.order.paymentStatus, "UNPAID");
  const persisted = await prisma.order.findUniqueOrThrow({
    where: { reference: placed.order.reference },
  });
  assert.equal(persisted.stockAllocated, true);
  assert.equal(
    (
      await prisma.inventory.findUniqueOrThrow({
        where: { variantId: "launch-test-variant" },
      })
    ).quantity,
    0,
  );
  // Reconstruct the exact winning request key from the persisted order, not from public data.
  const duplicate = await inject({
    method: "POST",
    url: "/orders",
    payload: { ...payload, idempotencyKey: persisted.idempotencyKey },
    remoteAddress: "192.0.2.174",
  });
  assert.equal(duplicate.statusCode, 200, duplicate.body);
  assert.equal(duplicate.json().order.reference, placed.order.reference);
  const auth = { authorization: `Bearer ${placed.accessToken}` };
  assert.equal(
    (await inject({ url: `/orders/${placed.order.reference}/invoice` }))
      .statusCode,
    404,
  );
  const pdf = await inject({
    url: `/orders/${placed.order.reference}/invoice`,
    headers: auth,
  });
  assert.equal(pdf.statusCode, 200, pdf.body);
  assert.equal(pdf.headers["content-type"], "application/pdf");
  assert.ok(pdf.rawPayload.subarray(0, 5).equals(Buffer.from("%PDF-")));
  await settings({ sellerName: "Changed Store" });
  const saved = await prisma.order.findUniqueOrThrow({
    where: { id: persisted.id },
  });
  assert.equal(
    (saved.invoiceSnapshot as { seller: { name: string } }).seller.name,
    "Unique Test Store",
  );
  assert.equal(
    (await action(placed.order.reference, "accept")).statusCode,
    409,
  );
  assert.equal(
    (await action(placed.order.reference, "cancel")).statusCode,
    200,
  );
  assert.equal(
    (
      await prisma.inventory.findUniqueOrThrow({
        where: { variantId: "launch-test-variant" },
      })
    ).quantity,
    1,
  );
  const retryQuote = await quote();
  const repeatBody = {
    ...payload,
    idempotencyKey: randomUUID(),
    quoteToken: retryQuote.json().quoteToken,
  };
  const simultaneous = await Promise.all([
    inject({
      method: "POST",
      url: "/orders",
      payload: repeatBody,
      remoteAddress: "192.0.2.175",
    }),
    inject({
      method: "POST",
      url: "/orders",
      payload: repeatBody,
      remoteAddress: "192.0.2.176",
    }),
  ]);
  assert.ok(
    simultaneous.every((r) => [200, 201].includes(r.statusCode)),
    simultaneous.map((r) => r.body).join("\n"),
  );
  assert.equal(
    new Set(simultaneous.map((r) => r.json().order.reference)).size,
    1,
  );
  const repeatedRef = simultaneous[0].json().order.reference;
  assert.equal(
    await prisma.inventoryMovement.count({
      where: { orderReference: repeatedRef, delta: -1 },
    }),
    1,
  );
  assert.equal((await action(repeatedRef, "cancel")).statusCode, 200);
  await prisma.inventory.update({
    where: { variantId: "launch-test-variant" },
    data: { quantity: 100 },
  });
});

test("customer sessions protect orders, merge wishlists, claim guest orders and revoke on logout", async () => {
  const { hash } = await import("../src/lib/admin-auth.js");
  const token = "a".repeat(64),
    other = "b".repeat(64);
  const one = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { email, fullName: "Account Buyer" },
    }),
    two = await prisma.user.upsert({
      where: { email: "other@integration.example" },
      update: {},
      create: { email: "other@integration.example" },
    });
  await prisma.customerSession.deleteMany({
    where: { userId: { in: [one.id, two.id] } },
  });
  await prisma.customerSession.createMany({
    data: [
      {
        userId: one.id,
        tokenHash: hash(token),
        expiresAt: new Date(Date.now() + 3600_000),
      },
      {
        userId: two.id,
        tokenHash: hash(other),
        expiresAt: new Date(Date.now() + 3600_000),
      },
    ],
  });
  const h = { cookie: `ua_customer=${token}`, origin: "http://localhost:3000" },
    otherH = { ...h, cookie: `ua_customer=${other}` };
  assert.equal(
    (await inject({ url: "/auth/session", headers: h })).json().user.email,
    email,
  );
  assert.equal((await inject({ url: "/account/orders" })).statusCode, 401);
  const merge = await inject({
    method: "POST",
    url: "/account/wishlist/merge",
    headers: h,
    payload: { productIds: ["launch-test-product", "missing-product"] },
  });
  assert.equal(merge.statusCode, 200, merge.body);
  assert.deepEqual(merge.json().productIds, ["launch-test-product"]);
  assert.deepEqual(
    (await inject({ url: "/account/wishlist", headers: otherH })).json()
      .productIds,
    [],
  );
  assert.equal(
    (
      await inject({
        method: "PUT",
        url: "/account/wishlist/launch-test-product",
        headers: { ...h, origin: "https://evil.example" },
      })
    ).statusCode,
    403,
  );
  const guest = await order();
  assert.equal(guest.response.statusCode, 201);
  assert.equal(
    (
      await inject({
        url: `/orders/${guest.result.order.reference}`,
        headers: h,
      })
    ).statusCode,
    404,
  );
  const claim = await inject({
    method: "POST",
    url: `/orders/${guest.result.order.reference}/claim`,
    headers: { ...h, authorization: `Bearer ${guest.result.accessToken}` },
  });
  assert.equal(claim.statusCode, 200, claim.body);
  assert.equal(
    (
      await inject({
        url: `/orders/${guest.result.order.reference}`,
        headers: h,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await inject({
        url: `/orders/${guest.result.order.reference}`,
        headers: otherH,
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await inject({
        url: `/orders/${guest.result.order.reference}/invoice`,
        headers: h,
      })
    ).statusCode,
    200,
  );
  assert.ok(
    (await inject({ url: "/account/orders", headers: h }))
      .json()
      .orders.some(
        (o: { reference: string }) =>
          o.reference === guest.result.order.reference,
      ),
  );
  const review = await quote();
  const created = await inject({
    method: "POST",
    url: "/orders",
    headers: h,
    remoteAddress: "192.0.2.182",
    payload: {
      basket: basket(),
      customer: {
        name: "Account Buyer",
        email: "forged@integration.example",
        phone: "9876543210",
      },
      address: {
        line1: "Test street 123",
        city: "Mumbai",
        state: "Maharashtra",
        pincode: "400001",
      },
      paymentMethod: "COD",
      idempotencyKey: randomUUID(),
      quoteToken: review.json().quoteToken,
    },
  });
  assert.equal(created.statusCode, 201, created.body);
  assert.equal(created.json().order.customerEmail, email);
  assert.equal(
    (
      await prisma.order.findUniqueOrThrow({
        where: { reference: created.json().order.reference },
      })
    ).userId,
    one.id,
  );
  assert.equal(
    (await inject({ method: "POST", url: "/auth/logout", headers: h }))
      .statusCode,
    200,
  );
  assert.equal(
    (await inject({ url: "/account/orders", headers: h })).statusCode,
    401,
  );
});

test("confirmed UPI orders expose payment QR immediately, COD can switch before shipping, UTR is never paid", async () => {
  await settings({
    autoApproveOrders: true,
    upiEnabled: true,
    upiId: "integration@upi",
    upiName: "Integration Merchant",
    upiQrImage: null,
  });
  const created = await order("UPI");
  assert.equal(created.response.statusCode, 201);
  assert.equal(created.result.order.status, "CONFIRMED");
  assert.equal(created.result.order.upi.id, "integration@upi");
  assert.ok(created.result.order.upi.qrDataUrl.startsWith("data:image/png"));
  assert.ok(
    created.result.order.upi.url.includes(
      `am=${created.result.order.total.toFixed(2)}`,
    ),
  );
  const publicCatalog = (await inject({ url: "/catalog" })).json();
  assert.equal(publicCatalog.settings.upiId, undefined);
  const utr = await inject({
    method: "POST",
    url: `/orders/${created.result.order.reference}/payment-reference`,
    headers: { authorization: `Bearer ${created.result.accessToken}` },
    payload: { reference: "998877665544" },
  });
  assert.equal(utr.statusCode, 200);
  assert.equal(utr.json().paymentStatus, "PENDING_VERIFICATION");
  assert.equal(
    (await action(created.result.order.reference, "packed")).statusCode,
    409,
  );
  const cod = await order();
  const switched = await inject({
    method: "POST",
    url: `/orders/${cod.result.order.reference}/pay-with-upi`,
    headers: { authorization: `Bearer ${cod.result.accessToken}` },
  });
  assert.equal(switched.statusCode, 200, switched.body);
  assert.equal(switched.json().paymentMethod, "UPI");
  assert.ok(switched.json().upi);
});

test("Google OAuth uses one-time state and PKCE; unverified or replayed callbacks fail", async () => {
  const { OAuth2Client } = await import("google-auth-library");
  const originalGet = OAuth2Client.prototype.getToken,
    originalVerify = OAuth2Client.prototype.verifyIdToken;
  const started = await inject({
    url: "/auth/google/start?returnTo=/account",
    remoteAddress: "192.0.2.187",
  });
  assert.equal(started.statusCode, 302);
  const location = new URL(String(started.headers.location));
  assert.equal(location.origin, "https://accounts.google.com");
  assert.ok(location.searchParams.get("code_challenge"));
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  const state = location.searchParams.get("state")!;
  const oauthCookie = String(started.headers["set-cookie"]).split(";")[0];
  const rejected = await inject({
    url: `/auth/google/callback?state=${state}&code=test`,
    headers: { cookie: "ua_oauth=wrong" },
  });
  assert.match(String(rejected.headers.location), /invalid-state/);
  OAuth2Client.prototype.getToken = (async () => ({
    tokens: { id_token: "fixture" },
  })) as unknown as typeof originalGet;
  OAuth2Client.prototype.verifyIdToken = (async () => ({
    getPayload: () => ({
      sub: "google-integration-sub",
      email: "google@integration.example",
      email_verified: true,
      name: "Google Buyer",
      nonce: location.searchParams.get("nonce"),
    }),
  })) as unknown as typeof originalVerify;
  try {
    const callback = await inject({
      url: `/auth/google/callback?state=${state}&code=test`,
      headers: { cookie: oauthCookie },
    });
    assert.equal(callback.statusCode, 302);
    assert.equal(callback.headers.location, "http://localhost:3000/account");
    assert.ok(String(callback.headers["set-cookie"]).includes("ua_customer="));
    const replay = await inject({
      url: `/auth/google/callback?state=${state}&code=test`,
      headers: { cookie: oauthCookie },
    });
    assert.match(String(replay.headers.location), /cancelled/);
    const expired = await inject({
      url: "/auth/google/start",
      remoteAddress: "192.0.2.188",
    });
    const l = new URL(String(expired.headers.location));
    OAuth2Client.prototype.verifyIdToken = (async () => ({
      getPayload: () => ({
        sub: "unverified",
        email: "unverified@integration.example",
        email_verified: false,
        nonce: l.searchParams.get("nonce"),
      }),
    })) as unknown as typeof originalVerify;
    const bad = await inject({
      url: `/auth/google/callback?state=${l.searchParams.get("state")}&code=test`,
      headers: { cookie: String(expired.headers["set-cookie"]).split(";")[0] },
    });
    assert.match(String(bad.headers.location), /sign-in-failed/);
    assert.equal(
      await prisma.user.count({
        where: { email: "unverified@integration.example" },
      }),
      0,
    );
  } finally {
    OAuth2Client.prototype.getToken = originalGet;
    OAuth2Client.prototype.verifyIdToken = originalVerify;
  }
});

test("Shiprocket booking preserves totals, blocks duplicates and unpaid UPI, and authenticates monotonic tracking", async () => {
  const originalFetch = globalThis.fetch;
  let creates = 0;
  let exported: Record<string, unknown> = {};
  let counter = 8000;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    assert.ok(url.startsWith("https://apiv2.shiprocket.in/v1/external/"));
    const path = new URL(url).pathname;
    let data: unknown;
    if (path.endsWith("/auth/login")) data = { token: "fixture-shiprocket" };
    else if (path.endsWith("/orders/create/adhoc")) {
      creates++;
      exported = JSON.parse(String(init?.body));
      data = { order_id: ++counter, shipment_id: ++counter };
    } else if (path.endsWith("/courier/assign/awb"))
      data = {
        response: {
          data: {
            awb_code: "UA-INTEGRATION-AWB",
            courier_name: "Test Courier",
          },
        },
      };
    else if (path.endsWith("/courier/generate/pickup"))
      data = { pickup_status: 1 };
    else if (path.endsWith("/courier/generate/label"))
      data = { label_url: "https://example.com/label.pdf" };
    else if (path.endsWith("/manifests/generate"))
      data = { manifest_url: "https://example.com/manifest.pdf" };
    else if (path.endsWith("/orders/cancel")) data = { status_code: 200 };
    else throw new Error("Unexpected Shiprocket endpoint");
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    const created = await order("COD", basket(2, "LAUNCHTEST10"));
    assert.equal(created.response.statusCode, 201);
    const ref = created.result.order.reference;
    const url = `/admin/orders/${ref}/shipment`;
    const parcel = { length: 10, breadth: 10, height: 5, weight: 0.4 };
    const [first, second] = await Promise.all([
      inject({ method: "POST", url, headers: headers(), payload: parcel }),
      inject({ method: "POST", url, headers: headers(), payload: parcel }),
    ]);
    assert.ok(
      [first.statusCode, second.statusCode].includes(200),
      first.body + second.body,
    );
    assert.ok([first.statusCode, second.statusCode].includes(409));
    assert.equal(creates, 1);
    assert.equal(
      exported.sub_total,
      created.result.order.subtotal - created.result.order.discount,
    );
    assert.equal(exported.shipping_charges, created.result.order.shippingFee);
    assert.equal(exported.payment_method, "COD");
    const paidUpi = await order("UPI");
    assert.equal(
      (
        await inject({
          method: "POST",
          url: `/admin/orders/${paidUpi.result.order.reference}/shipment`,
          headers: headers(),
          payload: parcel,
        })
      ).statusCode,
      409,
    );
    const shipAction = async (action: string) =>
      inject({
        method: "POST",
        url: `${url}/action`,
        headers: headers(),
        payload: { action },
      });
    assert.equal((await shipAction("awb")).statusCode, 200);
    assert.equal((await shipAction("awb")).statusCode, 409);
    assert.equal((await shipAction("pickup")).statusCode, 200);
    assert.equal((await shipAction("label")).statusCode, 200);
    assert.equal((await shipAction("manifest")).statusCode, 200);
    assert.equal((await action(ref, "cancel")).statusCode, 409);
    const india = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(Date.now() - 5000));
    const part = (type: string) => india.find((p) => p.type === type)!.value;
    const localTimestamp = `${part("day")} ${part("month")} ${part("year")} ${part("hour")}:${part("minute")}:${part("second")}`;
    assert.equal(
      (
        await inject({
          method: "POST",
          url: "/shipping/events",
          headers: { "x-api-key": process.env.SHIPROCKET_WEBHOOK_TOKEN! },
          payload: {
            awb: "UA-INTEGRATION-AWB",
            current_status: "IN TRANSIT",
            current_timestamp: localTimestamp,
          },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await prisma.order.findUniqueOrThrow({ where: { reference: ref } }))
        .status,
      "SHIPPED",
    );
    const event = {
      awb: "UA-INTEGRATION-AWB",
      current_status: "DELIVERED",
      current_timestamp: new Date().toISOString(),
    };
    assert.equal(
      (
        await inject({
          method: "POST",
          url: "/shipping/events",
          payload: event,
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await inject({
          method: "POST",
          url: "/shipping/events",
          headers: { "x-api-key": process.env.SHIPROCKET_WEBHOOK_TOKEN! },
          payload: event,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await prisma.order.findUniqueOrThrow({ where: { reference: ref } }))
        .status,
      "DELIVERED",
    );
    assert.equal(
      (await prisma.order.findUniqueOrThrow({ where: { reference: ref } }))
        .manualPaymentStatus,
      "UNPAID",
    );
    await inject({
      method: "POST",
      url: "/shipping/events",
      headers: { "x-api-key": process.env.SHIPROCKET_WEBHOOK_TOKEN! },
      payload: {
        ...event,
        current_status: "IN TRANSIT",
        current_timestamp: new Date(Date.now() - 10000).toISOString(),
      },
    });
    assert.equal(
      (await prisma.order.findUniqueOrThrow({ where: { reference: ref } }))
        .status,
      "DELIVERED",
    );
  } finally {
    globalThis.fetch = originalFetch;
    await settings({ autoApproveOrders: false });
  }
});

test("uncertain Shiprocket creation blocks retry and requires matching provider reconciliation", async () => {
  await settings({ autoApproveOrders: true });
  const created = await order();
  const ref = created.result.order.reference;
  const url = `/admin/orders/${ref}/shipment`;
  const original = globalThis.fetch;
  let calls = 0;
  let match = false;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith("/orders/create/adhoc")) {
      calls++;
      throw new Error("Network result unknown");
    }
    if (path.endsWith("/orders/show/998811"))
      return new Response(
        JSON.stringify({
          data: {
            id: 998811,
            channel_order_id: match ? ref : "another-reference",
            shipments: [{ id: 998812 }],
          },
        }),
        { status: 200 },
      );
    if (path.endsWith("/auth/login"))
      return new Response(JSON.stringify({ token: "fixture" }), {
        status: 200,
      });
    throw new Error("Unexpected provider request");
  };
  try {
    const first = await inject({
      method: "POST",
      url,
      headers: headers(),
      payload: { length: 10, breadth: 10, height: 5, weight: 0.5 },
    });
    assert.equal(first.statusCode, 502);
    assert.equal(
      (
        await prisma.shipment.findUniqueOrThrow({
          where: {
            orderId: (
              await prisma.order.findUniqueOrThrow({
                where: { reference: ref },
              })
            ).id,
          },
        })
      ).state,
      "RECONCILIATION_REQUIRED",
    );
    assert.equal(
      (
        await inject({
          method: "POST",
          url,
          headers: headers(),
          payload: { length: 10, breadth: 10, height: 5, weight: 0.5 },
        })
      ).statusCode,
      409,
    );
    assert.equal(calls, 1);
    assert.equal(
      (
        await inject({
          method: "DELETE",
          url: url + "/failed",
          headers: headers(),
        })
      ).statusCode,
      409,
    );
    const body = { externalOrderId: 998811 };
    assert.equal(
      (
        await inject({
          method: "POST",
          url: url + "/reconcile",
          headers: headers(),
          payload: body,
        })
      ).statusCode,
      409,
    );
    match = true;
    assert.equal(
      (
        await inject({
          method: "POST",
          url: url + "/reconcile",
          headers: headers(),
          payload: body,
        })
      ).statusCode,
      200,
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
    await settings({ autoApproveOrders: false });
  }
});

test("invoice logos require admin, reject invalid images, survive replacement in snapshots and remain private", async () => {
  const original = await prisma.storeSettings.findUniqueOrThrow({
    where: { id: "store" },
  });
  const png = await sharp({
    create: { width: 600, height: 180, channels: 4, background: "#18375d" },
  })
    .png()
    .toBuffer();
  async function upload(version: number, bytes = png, authenticated = true) {
    const boundary = "invoice-logo-test";
    return inject({
      method: "POST",
      url: `/admin/settings/invoice-logo?version=${version}`,
      headers: {
        ...(authenticated ? headers() : {}),
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      payload: Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="logo"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n`,
        ),
        bytes,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]),
    });
  }
  try {
    assert.equal((await upload(original.version, png, false)).statusCode, 401);
    assert.equal(
      (await upload(original.version, Buffer.from("<svg/>"))).statusCode,
      400,
    );
    const uploaded = await upload(original.version);
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    const branding = uploaded.json();
    assert.ok(branding.invoiceLogoImage.startsWith("data:image/png;base64,"));
    const publicLogo = await inject({
      url: branding.invoiceLogoUrl.replace("/api", ""),
    });
    assert.equal(publicLogo.statusCode, 200);
    assert.equal(publicLogo.headers["content-type"], "image/png");
    assert.equal((await upload(original.version)).statusCode, 409);
    const { invoiceSnapshot, invoicePdf } =
      await import("../src/lib/invoice.js");
    const { amountInWords } = await import("../src/lib/invoice-pdf.js");
    assert.equal(
      amountInWords(4951.28),
      "Rupees Four Thousand Nine Hundred Fifty-One and Twenty-Eight Paise Only.",
    );
    assert.equal(amountInWords(199.999), "Rupees Two Hundred Only.");
    const photoKey = `${randomUUID()}.webp`;
    await writeFile(
      join(uploadDir, photoKey),
      await sharp(png).webp().toBuffer(),
    );
    const snapshot = invoiceSnapshot(
      {
        reference: "UA-LOGO-TEST",
        paymentMethod: "COD",
        customerName: "Test Customer",
        customerEmail: "test@example.com",
        customerPhone: "919876543210",
        shippingAddress: {
          line1: "Station Road",
          city: "Bardoli",
          state: "Gujarat",
          pincode: "394601",
        },
        subtotal: 199,
        discount: 0,
        shippingFee: 0,
        total: 199,
        items: Array.from({ length: 32 }, (_, i) => ({
          imageUrl: `/api/media/products/${photoKey}`,
          productName: `Accessory ${i + 1}`,
          sku: `TEST-${i}`,
          variantLabel: "Black",
          quantity: 1,
          unitPrice: 199,
        })),
      },
      await prisma.storeSettings.findUniqueOrThrow({ where: { id: "store" } }),
    );
    const removed = await inject({
      method: "DELETE",
      url: "/admin/settings/invoice-logo",
      headers: headers(),
      payload: { version: branding.version },
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(removed.json().invoiceLogoImage, null);
    assert.equal(snapshot.seller.logoImage, branding.invoiceLogoImage);
    const { PDFDocument, PDFDict, PDFName } = await import("pdf-lib");
    const pdf = await PDFDocument.load(await invoicePdf(snapshot));
    assert.ok(pdf.getPageCount() > 1);
    const images = pdf
      .getPages()[0]
      .node.Resources()!
      .lookup(PDFName.of("XObject"), PDFDict);
    assert.ok(
      images.keys().length >= 2,
      "Invoice embeds its logo and actual managed product photo",
    );
    assert.equal(
      (await inject({ url: branding.invoiceLogoUrl.replace("/api", "") }))
        .statusCode,
      200,
    );
    const catalog = await inject({ url: "/settings" });
    assert.ok(!catalog.body.includes("data:image/png"));
  } finally {
    await prisma.storeSettings.update({
      where: { id: "store" },
      data: {
        invoiceLogoImage: original.invoiceLogoImage,
        invoiceLogoKey: original.invoiceLogoKey,
        invoiceLogoUrl: original.invoiceLogoUrl,
      },
    });
  }
});
