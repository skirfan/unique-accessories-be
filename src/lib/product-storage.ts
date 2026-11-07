import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { env } from "../env.js";

export type StorageOptions = {
  directory: string;
  r2?: {
    accountId: string;
    accessKeyId: string;
    secretAccessKey: string;
    bucket: string;
    publicUrl: string;
    endpoint?: string;
  };
};
/** Server-side uploads only: credentials never enter the browser. */
export function createProductStorage(options: StorageOptions) {
  const config = options.r2;
  const root = resolve(options.directory);
  const client = config
    ? new S3Client({
        region: "auto",
        endpoint:
          config.endpoint ??
          `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: config.accessKeyId,
          secretAccessKey: config.secretAccessKey,
        },
        // R2 supports signed payloads; avoid optional AWS checksum trailers.
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
        forcePathStyle: true,
        maxAttempts: 2,
        requestHandler: { connectionTimeout: 5000, requestTimeout: 20000 },
      })
    : null;
  const validate = (key: string) => {
    if (!/^[0-9a-f-]{36}(?:-thumb)?\.webp$/.test(key))
      throw new Error("Invalid product media key.");
  };
  const logoKey = (key: string) => {
    if (!/^[0-9a-f-]{36}\.png$/.test(key))
      throw new Error("Invalid invoice logo key.");
    return `branding/invoices/${key}`;
  };
  return {
    kind: config ? ("r2" as const) : ("local" as const),
    async putInvoiceLogo(key: string, bytes: Buffer) {
      const path = logoKey(key);
      if (client && config)
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: path,
            Body: bytes,
            ContentType: "image/png",
            CacheControl: "public, max-age=31536000, immutable",
          }),
        );
      else {
        const directory = join(root, "invoice-logos");
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, key), bytes, { flag: "wx" });
      }
    },
    async removeInvoiceLogo(key: string) {
      const path = logoKey(key);
      if (client && config)
        await client.send(
          new DeleteObjectCommand({ Bucket: config.bucket, Key: path }),
        );
      else
        await unlink(join(root, "invoice-logos", key)).catch(
          (e: NodeJS.ErrnoException) => {
            if (e.code !== "ENOENT") throw e;
          },
        );
    },
    invoiceLogoUrl(key: string) {
      const path = logoKey(key);
      return config
        ? `${config.publicUrl.replace(/\/+$/, "")}/${path}`
        : `/api/media/invoice-logos/${key}`;
    },
    async put(key: string, bytes: Buffer) {
      validate(key);
      if (client && config)
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: `products/${key}`,
            Body: bytes,
            ContentType: "image/webp",
            CacheControl: "public, max-age=31536000, immutable",
          }),
        );
      else {
        await mkdir(root, { recursive: true });
        await writeFile(join(root, key), bytes, { flag: "wx" });
      }
    },
    async remove(key: string) {
      validate(key);
      if (client && config)
        await client.send(
          new DeleteObjectCommand({
            Bucket: config.bucket,
            Key: `products/${key}`,
          }),
        );
      else
        await unlink(join(root, key)).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
        });
    },
    url(key: string) {
      validate(key);
      return config
        ? `${config.publicUrl.replace(/\/+$/, "")}/products/${key}`
        : `/api/media/products/${key}`;
    },
    close() {
      client?.destroy();
    },
  };
}
export const localProductStorage = createProductStorage({
  directory: env.UPLOAD_DIR,
});
export const productStorage = env.R2_ACCOUNT_ID
  ? createProductStorage({
      directory: env.UPLOAD_DIR,
      r2: {
        accountId: env.R2_ACCOUNT_ID,
        accessKeyId: env.R2_ACCESS_KEY_ID!,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
        bucket: env.R2_BUCKET!,
        publicUrl: env.R2_PUBLIC_URL!,
        endpoint: env.R2_ENDPOINT,
      },
    })
  : localProductStorage;

/** Local photos remain deletable after switching new uploads to R2. */
export function storageForImage(url: string) {
  if (url.startsWith("/api/media/products/")) return localProductStorage;
  if (productStorage.kind !== "r2")
    throw new Error("Configure R2 to remove an R2 photo from storage.");
  return productStorage;
}
