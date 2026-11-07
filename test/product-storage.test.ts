import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createProductStorage } from "../src/lib/product-storage.js";

test("R2 uploads use signed S3 requests, immutable WebP metadata and public URLs; deletion removes both sizes", async () => {
  const objects = new Map<string, Buffer>();
  const key = `${randomUUID()}.webp`,
    thumb = key.replace(".webp", "-thumb.webp");
  const requests: {
    method: string;
    path: string;
    signed: boolean;
    contentType?: string;
    cache?: string;
  }[] = [];
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, "http://localhost").pathname;
    requests.push({
      method: req.method!,
      path,
      signed:
        req.headers.authorization?.startsWith("AWS4-HMAC-SHA256") ?? false,
      contentType: req.headers["content-type"],
      cache: req.headers["cache-control"],
    });
    const object = path.replace(/^\/bucket\//, "/");
    if (req.method === "PUT") {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      objects.set(object, Buffer.concat(chunks));
      res.writeHead(200, { ETag: '"fixture"' }).end();
    } else if (req.method === "DELETE") {
      objects.delete(object);
      res.writeHead(204).end();
    } else {
      const bytes = objects.get(object);
      res
        .writeHead(bytes ? 200 : 404, { "Content-Type": "image/webp" })
        .end(bytes);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const storage = createProductStorage({
    directory: tmpdir(),
    r2: {
      accountId: "fixture",
      accessKeyId: "fixture-key",
      secretAccessKey: "fixture-secret",
      bucket: "bucket",
      publicUrl: origin + "/",
      endpoint: origin,
    },
  });
  try {
    const bytes = Buffer.from("processed-webp-fixture");
    await storage.put(key, bytes);
    await storage.put(thumb, bytes);
    assert.equal(storage.kind, "r2");
    assert.equal(storage.url(key), `${origin}/products/${key}`);
    assert.deepEqual(
      Buffer.from(await (await fetch(storage.url(key))).arrayBuffer()),
      bytes,
    );
    const uploads = requests.filter((r) => r.method === "PUT");
    assert.equal(uploads.length, 2);
    assert.ok(
      uploads.every(
        (r) =>
          r.signed &&
          r.contentType === "image/webp" &&
          r.cache?.includes("immutable"),
      ),
    );
    const logoKey = `${randomUUID()}.png`;
    await storage.putInvoiceLogo(logoKey, bytes);
    assert.equal(
      storage.invoiceLogoUrl(logoKey),
      `${origin}/branding/invoices/${logoKey}`,
    );
    assert.ok(objects.has(`/branding/invoices/${logoKey}`));
    const logoRequest = requests.find((r) => r.path.endsWith(logoKey));
    assert.equal(logoRequest?.contentType, "image/png");
    assert.equal(logoRequest?.signed, true);
    await storage.removeInvoiceLogo(logoKey);
    await storage.remove(key);
    await storage.remove(thumb);
    assert.equal(objects.size, 0);
    await assert.rejects(storage.put("../../escape.webp", bytes), /Invalid/);
  } finally {
    storage.close();
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  }
});

test("local photos remain readable, removable and path-scoped before R2 is configured", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ua-media-"));
  const storage = createProductStorage({ directory });
  const key = `${randomUUID()}.webp`;
  try {
    await storage.put(key, Buffer.from("fixture"));
    assert.equal(await readFile(join(directory, key), "utf8"), "fixture");
    assert.equal(storage.url(key), `/api/media/products/${key}`);
    await storage.remove(key);
    await storage.remove(key);
    await assert.rejects(storage.remove("../escape.webp"), /Invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
