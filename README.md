# Unique Accessories — Backend

Fastify + Prisma + PostgreSQL API for the initial launch: database-backed catalog,
guest/customer orders, automatic confirmation, Google accounts, invoices, Shiprocket shipping,
COD/manual UPI, and configurable store rules.
See [the launch checkout plan](../doc/01-launch-checkout-plan.md). Razorpay remains
planned in [Phase 6](../doc/phases/06-payments-integration.md).

## Local setup

Node 22+ and pnpm are required. The existing local `.env` uses the newly created
`unique_accessories_launch_dev` database, owned by `unique_accessories`. The older
`unique_accessories_dev` database has been preserved.

For a new checkout, copy `.env.example` to `.env` and fill in your database URL,
admin email, a unique password (12+ characters), and a random session secret
(32+ characters). Never commit credentials. The generated local admin credentials
are in the ignored `.env`; sign in at the frontend's `/admin` page. Rotate the
session secret when revoking all operator sessions; it also protects idempotent
order access-token derivation, so keep it stable between restarts.

```bash
pnpm install
pnpm db:generate
pnpm db:migrate:deploy
pnpm db:seed
pnpm dev
```

The API listens on port 4000. Run the frontend separately on port 3000. Its
same-origin `/api/*` proxy forwards requests here. Set `CORS_ORIGIN` to the exact
frontend origin(s), comma separated. Production sessions require HTTPS.
`TRUST_PROXY` accepts the literal `true` or `false`; enable it only behind a trusted proxy.

## Current API

- `GET /health` — live database check.
- `GET /catalog` — published catalog/taxonomy and storefront settings, consumed by the frontend.
- `GET /settings`, `/categories`, `/brands`, `/device-models`, `/products`, `/products/:slug`.
- `POST /checkout/review` — authoritative prices, coupon, stock, shipping, minimum and quote fingerprint.
- `POST /orders` — guest or signed-in checkout; requires the reviewed quote and an idempotency UUID.
- `GET /orders/:reference` — private order details, requires its Bearer access token or the owning customer session.
- `POST /orders/:reference/payment-reference` — submit a 12-digit UPI UTR for verification.
- `GET /auth/session`, `GET /auth/google/start`, `GET /auth/google/callback`, `POST /auth/logout`.
- `GET /account/orders`, `GET /account/wishlist`, `POST /account/wishlist/merge`, `PUT/DELETE /account/wishlist/:id`.
- `GET /orders/:reference/invoice`, `POST /orders/:reference/claim`, `POST /orders/:reference/pay-with-upi`.
- `GET /admin/integrations`, `GET /admin/orders/:reference/invoice`.
- `GET/POST /admin/orders/:reference/shipment`, `POST /admin/orders/:reference/shipment/action` and `/reconcile`, `DELETE /admin/orders/:reference/shipment/failed`.
- `POST /shipping/events` — authenticated Shiprocket webhook.
- `POST /admin/login`, `POST /admin/logout`, `GET /admin/session` — operator sessions.
- `GET/PATCH /admin/settings` — versioned store settings, including minimum-order toggle and amount.
- `GET /admin/overview?days=30` — protected dashboard aggregates; accepts 7, 30, 180 or 365 days (default 30).
- `GET /admin/orders?page=&status=&q=&paymentStatus=`, `GET /admin/orders/:reference`.
- `POST /admin/orders/:reference/action` — accept/reject/cancel, pack/ship/deliver,
  verify UPI, record COD collection, or record a completed manual refund.

The minimum starts at **₹199 after discounts, excluding shipping**. Disabling the
rule preserves the configured amount. Stock is allocated atomically at checkout
when automatic confirmation is enabled (the default), or on admin acceptance in manual mode.
Concurrent orders cannot oversell. Pending manual requests do not reserve stock. Rejected/cancelled orders cannot proceed to fulfillment. COD can fulfill
while unpaid; UPI requires verification. Customer-submitted payment references
never mark an order paid automatically.

UPI starts disabled. Configure merchant UPI ID/name and enable it in **Store settings**
to offer it at checkout. Accepted UPI orders receive an amount-specific QR (or the configured merchant QR image). Configure
a real WhatsApp business number (country code + digits) to show follow-up links.
Opening WhatsApp is never treated as proof a message was sent. No automatic email,
SMS, payment collection, refund transfer or background expiry is implemented.

Google customer login, account orders and server wishlists are implemented. Multiple admin roles remain later work. The current catalog endpoint loads the small launch catalog
as one snapshot; large catalogs will need server pagination/caching.

## Checks and integration tests

```bash
pnpm lint
pnpm typecheck
pnpm build
TEST_DATABASE_URL='postgresql://<role>:<password>@localhost:5432/unique_accessories_launch_test' pnpm test:integration
```

Tests refuse any database whose name does not end in `_test`. They apply migrations,
seed fixtures and exercise real Fastify/Postgres behavior: minimum boundaries,
admin authorization, idempotent requests, private links, COD/UPI states and concurrent
stock allocation. Use a dedicated disposable test database. CI supplies one.

The seed is development/sample content, including placeholder reviews and imagery.
Repeated seeding preserves existing catalog edits by default. `SEED_OVERWRITE=true` explicitly
restores fixture values for development/testing. Seeding is disabled under `NODE_ENV=production`;
do not point a development seed at a live database.
Migrations add mandatory fields to the empty pre-launch order baseline. A database
with existing real orders needs a reviewed backfill before applying these changes.


## Catalog, media and inventory

Protected catalog routes support product creation/versioned updates, variants, compatibility and
category/subcategory/brand/device-model CRUD. Products are archived and saved variants disabled to
preserve order/audit references. See `../doc/phases/04-product-catalog-management.md` for contracts.
`GET /products` now returns a paginated `{products,total,page,pages,pageSize}` object; `/catalog`
retains the storefront snapshot response. Both exclude unpublished products and disabled variants.

`POST /admin/inventory/adjust` atomically applies `{idempotencyKey,reason,items:[{variantId,version,delta}]}`.
Versions advance on adjustments and order allocations/releases. Movement history records before/after,
reason, actor and order reference. SQL constraints preserve stock bounds and case-insensitive SKU uniqueness.

Images are uploaded through authenticated multipart endpoints (one JPEG/PNG/WebP, at most 5 MB/40 MP),
normalized with sharp into full/thumbnail WebP assets, and named with generated UUIDs. Local development
uses ignored `uploads/products` (`UPLOAD_DIR` can override the directory). Back up both the database and
that directory if you need to preserve local product media.

Production requires a real R2 bucket/CDN: configure `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET` and `R2_PUBLIC_URL` together. Set `R2_PUBLIC_URL` to your public HTTPS
media origin. Live R2 delivery needs verification after those credentials are supplied. Re-upload/migrate
local media when switching to R2. No cloud account has been created or changed by local implementation.

Integration coverage includes authoring/validation, variant ownership, stale writes, draft/archived
visibility, atomic/replayed/concurrent adjustments, allocation conflict/history, image normalization,
image ownership/deletion, and taxonomy integrity in addition to the launch checkout tests. Test media
is stored in a temporary directory and removed after the run.


## Dashboard aggregates

`GET /admin/overview?days=7|30|180|365` preserves the original overview fields and adds `dashboard`
with real revenue, order totals, current catalog counts, acceptance rate, previous-period comparisons,
revenue/order activity and top five products. Recent orders include summed item quantity.

Date boundaries use Asia/Kolkata. Revenue counts currently PAID orders by `paymentVerifiedAt`
(creation fallback); it is an operational snapshot, not a refund accounting ledger. Order totals and
acceptance rate use the creation-date cohort. Acceptance means CONFIRMED/PACKED/SHIPPED/DELIVERED.
Top products use those same accepted statuses, exclude rejected/cancelled orders and sum item value
before discounts. Seven/thirty-day activity is daily; 180-day activity uses seven-day buckets and
365-day activity uses fourteen-day buckets. Missing previous-period baselines return null.

## Cloudflare R2 setup

Fill the five `R2_*` slots in the ignored backend `.env` and restart the API. Blank slots retain local
uploads in development; partial R2 configuration is rejected. `R2_ENDPOINT` is an optional override.
See [the complete R2 setup guide](../doc/02-cloudflare-r2-setup.md) for bucket/token/public-domain setup.

- `pnpm storage:check`: temporary upload → public delivery check → deletion.
- `pnpm storage:migrate`: copy existing local product photos to R2 and update their URLs, retaining local originals.
- `pnpm test:storage`: local S3 fixture coverage, without live Cloudflare credentials.
- `GET /admin/media`: protected active media provider and upload limits; no secrets are returned.

Uploads are processed server-side. Storefront clients receive image URLs, never storage credentials.
Local photo deletion continues to work after enabling R2. Real Cloudflare connectivity must be checked
after the owner supplies values. No Cloudflare resources have been provisioned by this local change.


## Customer orders, login and shipping — 23 October 2026

See [current commerce setup](../doc/04-customer-orders-shipping.md) for Google OAuth environment values,
Shiprocket credentials/webhook setup, seller invoice settings, automatic confirmation and current limits.
This module supersedes the original manual-approval default. New orders allocate stock and receive
an invoice snapshot automatically; UPI remains manually verified. Guests retain private order links,
while signed-in customers use account ownership and synchronized server wishlists. Restart the backend
manually after applying migrations/configuration. A provider configuration status is not a live test.

Invoice branding: protected multipart `POST /admin/settings/invoice-logo?version=…` and
`DELETE /admin/settings/invoice-logo` (JSON version) manage the optimized R2/local invoice logo.
See [invoice design, snapshot branding and deployment](../doc/05-invoice-branding-light-product.md).
