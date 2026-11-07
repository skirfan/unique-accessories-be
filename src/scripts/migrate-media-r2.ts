import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "../env.js";
import { prisma } from "../lib/prisma.js";
import { productStorage } from "../lib/product-storage.js";

async function migrate() {
  if (productStorage.kind !== "r2")
    throw new Error("Configure all five R2 values before migrating images.");
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--product" || !args[1]))
    throw new Error("Usage: pnpm storage:migrate [--product <product-id>]");
  const images = await prisma.productImage.findMany({
    where: {
      ...(args[1] ? { productId: args[1] } : {}),
      url: { startsWith: "/api/media/products/" },
      storageKey: { not: null },
    },
  });
  let migrated = 0;
  for (const image of images) {
    const original = image.storageKey!;
    if (!/^[0-9a-f-]{36}\.webp$/.test(original))
      throw new Error(`Image ${image.id} has an unsupported local key.`);
    const root = resolve(env.UPLOAD_DIR);
    const [full, thumb] = await Promise.all([
      readFile(join(root, original)),
      readFile(join(root, original.replace(".webp", "-thumb.webp"))),
    ]);
    const key = `${randomUUID()}.webp`,
      thumbKey = key.replace(".webp", "-thumb.webp");
    try {
      await productStorage.put(key, full);
      await productStorage.put(thumbKey, thumb);
      const changed = await prisma.$transaction(async (tx) => {
        const update = await tx.productImage.updateMany({
          where: { id: image.id, url: image.url, storageKey: original },
          data: {
            url: productStorage.url(key),
            thumbnailUrl: productStorage.url(thumbKey),
            storageKey: key,
          },
        });
        if (update.count)
          await tx.product.update({
            where: { id: image.productId },
            data: { version: { increment: 1 } },
          });
        return update.count;
      });
      if (changed) {
        migrated++;
        console.log(`Migrated image ${image.id}`);
      } else
        await Promise.all([
          productStorage.remove(key),
          productStorage.remove(thumbKey),
        ]);
    } catch (error) {
      await Promise.allSettled([
        productStorage.remove(key),
        productStorage.remove(thumbKey),
      ]);
      throw error;
    }
  }
  console.log(
    `${migrated} images migrated to R2. Local originals retained. Re-running skips migrated records.`,
  );
}
migrate()
  .catch((error: Error) => {
    console.error(`Migration failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    productStorage.close();
    await prisma.$disconnect();
  });
