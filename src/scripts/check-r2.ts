import { randomUUID, createHash } from "node:crypto";
import sharp from "sharp";
import { productStorage } from "../lib/product-storage.js";

async function check() {
  if (productStorage.kind !== "r2")
    throw new Error(
      "R2 is not configured. Fill the five R2 values in the backend .env, then run pnpm storage:check again.",
    );
  const key = `${randomUUID()}.webp`;
  const bytes = await sharp({
    create: { width: 1, height: 1, channels: 4, background: "#2563eb" },
  })
    .webp()
    .toBuffer();
  try {
    await productStorage.put(key, bytes);
    const response = await fetch(productStorage.url(key), {
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error(
        `R2 write succeeded but the public image returned HTTP ${response.status}. Enable public access and check R2_PUBLIC_URL.`,
      );
    const received = Buffer.from(await response.arrayBuffer());
    const hash = (value: Buffer) =>
      createHash("sha256").update(value).digest("hex");
    if (hash(bytes) !== hash(received))
      throw new Error(
        "The public URL did not return the uploaded image. Check that the URL points to this bucket.",
      );
    console.log("R2 upload and public image delivery verified.");
  } finally {
    try {
      await productStorage.remove(key);
    } finally {
      productStorage.close();
    }
  }
  console.log(
    "Temporary check image deleted. Admin product uploads are ready.",
  );
}
check().catch((error: Error) => {
  console.error(`Storage check failed: ${error.message}`);
  process.exitCode = 1;
});
