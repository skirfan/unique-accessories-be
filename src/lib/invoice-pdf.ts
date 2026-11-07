import "regenerator-runtime/runtime.js";
import sharp from "sharp";
import { join } from "node:path";
import { env } from "../env.js";
import { readFile } from "node:fs/promises";
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { InvoiceSnapshot } from "./invoice.js";
import { getSettings } from "./settings.js";

export function amountInWords(value: number): string {
  const units = [
    "Zero",
    "One",
    "Two",
    "Three",
    "Four",
    "Five",
    "Six",
    "Seven",
    "Eight",
    "Nine",
    "Ten",
    "Eleven",
    "Twelve",
    "Thirteen",
    "Fourteen",
    "Fifteen",
    "Sixteen",
    "Seventeen",
    "Eighteen",
    "Nineteen",
  ];
  const tens = [
    "",
    "",
    "Twenty",
    "Thirty",
    "Forty",
    "Fifty",
    "Sixty",
    "Seventy",
    "Eighty",
    "Ninety",
  ];
  function words(n: number): string {
    if (n < 20) return units[n];
    if (n < 100)
      return `${tens[Math.floor(n / 10)]}${n % 10 ? `-${units[n % 10]}` : ""}`;
    for (const [base, label] of [
      [10_000_000, "Crore"],
      [100_000, "Lakh"],
      [1000, "Thousand"],
      [100, "Hundred"],
    ] as const)
      if (n >= base)
        return `${words(Math.floor(n / base))} ${label}${n % base ? ` ${words(n % base)}` : ""}`;
    return "";
  }
  const paise = Math.round(value * 100);
  return `Rupees ${words(Math.floor(paise / 100))}${paise % 100 ? ` and ${words(paise % 100)} Paise` : ""} Only.`;
}

export async function invoicePdf(invoice: InvoiceSnapshot) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Invoice ${invoice.number}`);
  pdf.setAuthor(invoice.seller.name);
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(
    await readFile(
      new URL("../../assets/fonts/NotoSans-Regular.ttf", import.meta.url),
    ),
  );
  const hindi = await pdf.embedFont(
    await readFile(
      new URL(
        "../../assets/fonts/NotoSansDevanagari-Regular.ttf",
        import.meta.url,
      ),
    ),
  );
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.035, 0.14, 0.29),
    ink = rgb(0.12, 0.16, 0.23),
    muted = rgb(0.38, 0.43, 0.5),
    border = rgb(0.8, 0.84, 0.89),
    pale = rgb(0.93, 0.95, 0.97),
    white = rgb(1, 1, 1);
  const W = 595.28,
    H = 841.89,
    M = 29,
    CW = W - M * 2;
  let page = pdf.addPage([W, H]);
  const clean = (v: unknown) =>
    Array.from(String(v ?? ""))
      .filter(
        (c) =>
          c === "\n" || (c.codePointAt(0)! >= 32 && c.codePointAt(0) !== 127),
      )
      .join("");
  const selectFont = (v: string, strong = false): PDFFont =>
    /[\u0900-\u097f]/.test(v)
      ? hindi
      : strong && /^[\x20-\x7e]*$/.test(v)
        ? bold
        : font;
  function width(v: string, size: number, strong = false) {
    return v
      .split(/([\u0900-\u097f]+)/)
      .reduce(
        (w, run) => w + selectFont(run, strong).widthOfTextAtSize(run, size),
        0,
      );
  }
  function lines(value: unknown, max: number, size = 9, strong = false) {
    const result: string[] = [];
    for (const paragraph of clean(value).split("\n")) {
      let line = "";
      for (const word of paragraph.split(/\s+/)) {
        if (width(`${line} ${word}`.trim(), size, strong) > max && line) {
          result.push(line);
          line = "";
        }
        for (const char of word) {
          if (width(line + char, size, strong) > max && line) {
            result.push(line);
            line = "";
          }
          line += char;
        }
        line += " ";
      }
      result.push(line.trim());
    }
    return result;
  }
  function text(
    v: unknown,
    x: number,
    top: number,
    size = 9,
    strong = false,
    color = ink,
  ) {
    let offset = x;
    for (const run of clean(v)
      .split(/([\u0900-\u097f]+)/)
      .filter(Boolean)) {
      const f = selectFont(run, strong);
      page.drawText(run, {
        x: offset,
        y: H - top - size,
        size,
        font: f,
        color,
      });
      offset += f.widthOfTextAtSize(run, size);
    }
  }
  function wrapped(
    v: unknown,
    x: number,
    top: number,
    max: number,
    size = 9,
    strong = false,
    color = ink,
  ) {
    const rows = lines(v, max, size, strong);
    rows.forEach((line, i) =>
      text(line, x, top + i * (size + 4), size, strong, color),
    );
    return rows.length * (size + 4);
  }
  function box(
    x: number,
    top: number,
    w: number,
    h: number,
    fill = white,
    stroke = border,
  ) {
    page.drawRectangle({
      x,
      y: H - top - h,
      width: w,
      height: h,
      color: fill,
      borderColor: stroke,
      borderWidth: 0.6,
    });
  }
  function rule(top: number, x = M, w = CW) {
    page.drawLine({
      start: { x, y: H - top },
      end: { x: x + w, y: H - top },
      color: border,
      thickness: 0.7,
    });
  }
  const money = (n: number) =>
    `₹ ${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  function right(
    v: string,
    x: number,
    top: number,
    size = 10,
    strong = false,
    color = ink,
  ) {
    text(v, x - width(v, size, strong), top, size, strong, color);
  }
  // New snapshots freeze their logo. Previously issued v1 invoices use current branding.
  const logoData =
    invoice.version < 2
      ? (await getSettings()).invoiceLogoImage
      : invoice.seller.logoImage;
  const logoBytes = logoData
    ? Buffer.from(logoData.split(",")[1], "base64")
    : await readFile(
        new URL("../../assets/invoice/default-logo.png", import.meta.url),
      );
  const logo = await pdf.embedPng(logoBytes);
  const dim = logo.scaleToFit(304, 92);
  page.drawImage(logo, {
    x: M,
    y: H - 27 - dim.height,
    width: dim.width,
    height: dim.height,
  });
  let contactY = 37;
  for (const value of [
    invoice.seller.address,
    invoice.seller.phone,
    invoice.seller.email,
    invoice.seller.gstin ? `GSTIN: ${invoice.seller.gstin}` : "",
  ].filter(Boolean))
    contactY += wrapped(value, 365, contactY, 201, 9, false, ink) + 5;
  const headerEnd = Math.max(134, contactY + 7);
  rule(headerEnd);
  text("INVOICE", M, headerEnd + 13, 29, true, navy);
  right(invoice.number, W - M, headerEnd + 27, 10, true);
  const a = invoice.buyer.address as Record<string, string>;
  const address = [a.line1, a.line2, a.city, a.state, a.pincode, "India"]
    .filter(Boolean)
    .join(", ");
  const leftW = 293,
    gap = 9,
    rightW = CW - leftW - gap,
    top = headerEnd + 65;
  const buyerRows = [
    ["Customer", invoice.buyer.name],
    ["Address", address],
    ["Phone", invoice.buyer.phone],
    ["Email", invoice.buyer.email],
  ];
  const contentHeight = buyerRows.reduce(
    (h, [, value]) =>
      h + Math.max(18, lines(value, leftW - 88, 9).length * 13 + 5),
    0,
  );
  const panelH = Math.max(133, contentHeight + 44);
  box(M, top, leftW, panelH);
  box(M + leftW + gap, top, rightW, panelH);
  box(M, top, leftW, 27, pale, pale);
  box(M + leftW + gap, top, rightW, 27, pale, pale);
  text("BILL TO", M + 13, top + 7, 12, true, navy);
  text("INVOICE DETAILS", M + leftW + gap + 13, top + 7, 12, true, navy);
  let by = top + 40;
  for (const [label, value] of buyerRows) {
    text(label, M + 13, by, 9);
    by += Math.max(
      18,
      wrapped(value, M + 78, by, leftW - 90, 9, label === "Customer") + 5,
    );
  }
  const rx = M + leftW + gap + 13;
  const date = new Date(invoice.issuedAt).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kolkata",
  });
  let dy = top + 40;
  for (const [label, value] of [
    ["Invoice No.", invoice.number],
    ["Invoice Date", date],
    [
      "Payment Mode",
      invoice.paymentMethod === "COD"
        ? "Cash on delivery"
        : invoice.paymentMethod === "UPI"
          ? "UPI"
          : "See order details",
    ],
    ["Order No.", invoice.reference],
  ]) {
    text(label, rx, dy, 8.5);
    dy += Math.max(22, wrapped(value, rx + 83, dy, rightW - 109, 8.5) + 5);
  }
  const cols = [M, M + 37, M + 290, M + 337, M + 420, W - M];
  let y = top + panelH + 11;
  function tableHeader() {
    box(M, y, CW, 30, navy, navy);
    ["Sr. No.", "Item Description", "Qty", "Rate (₹)", "Amount (₹)"].forEach(
      (v, i) => {
        const size = i === 0 ? 8 : 10;
        text(
          v,
          cols[i] + (cols[i + 1] - cols[i] - width(v, size, true)) / 2,
          y + 8,
          size,
          true,
          white,
        );
      },
    );
    y += 30;
  }
  function continuation() {
    page = pdf.addPage([W, H]);
    text(invoice.seller.name, M, 27, 14, true, navy);
    right(invoice.number, W - M, 31, 9);
    rule(56);
    y = 69;
  }
  tableHeader();
  const productImages = new Map<
    string,
    Awaited<ReturnType<typeof pdf.embedPng>>
  >();
  // Only managed image paths are fetched; arbitrary catalog URLs cannot access internal services.
  const imageDeadline = Date.now() + 6000;
  for (const url of [
    ...new Set(
      invoice.items
        .map((i) => i.imageUrl)
        .filter((url): url is string => Boolean(url)),
    ),
  ].slice(0, 30)) {
    try {
      let bytes: Buffer;
      const local =
        /^\/api\/media\/products\/([0-9a-f-]{36}(?:-thumb)?\.webp)$/.exec(url);
      if (local) bytes = await readFile(join(env.UPLOAD_DIR, local[1]));
      else {
        const prefix = `${env.R2_PUBLIC_URL?.replace(/\/+$/, "")}/products/`;
        if (
          !env.R2_PUBLIC_URL ||
          !url.startsWith(prefix) ||
          !/^[0-9a-f-]{36}(?:-thumb)?\.webp$/.test(url.slice(prefix.length)) ||
          Date.now() >= imageDeadline
        )
          continue;
        const response = await fetch(url, {
          redirect: "error",
          signal: AbortSignal.timeout(Math.max(1, imageDeadline - Date.now())),
        });
        if (
          !response.ok ||
          Number(response.headers.get("content-length")) > 2 * 1024 * 1024
        )
          continue;
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body!) {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            await response.body?.cancel().catch(() => {});
            throw new Error("Image too large");
          }
          chunks.push(chunk);
        }
        bytes = Buffer.concat(chunks);
      }
      const png = await sharp(bytes, { limitInputPixels: 16_000_000 })
        .resize({ width: 120, height: 120, fit: "inside" })
        .png()
        .toBuffer();
      productImages.set(url, await pdf.embedPng(png));
    } catch {
      /* A missing product photo must never prevent invoice download. */
    }
  }
  invoice.items.forEach((item, index) => {
    const image = item.imageUrl ? productImages.get(item.imageUrl) : undefined;
    const descriptionX = cols[1] + 12 + (image ? 48 : 0);
    const descriptionWidth = image ? 177 : 225;
    const labelLines = lines(item.name, descriptionWidth, 10, true),
      optionLines = lines(
        `${item.option} · SKU ${item.sku}`,
        descriptionWidth,
        7.5,
      );
    const rowH = Math.max(
      57,
      18 + labelLines.length * 14 + optionLines.length * 11,
    );
    if (y + rowH > H - 60) {
      continuation();
      tableHeader();
    }
    box(M, y, CW, rowH);
    for (const x of cols.slice(1, -1))
      page.drawLine({
        start: { x, y: H - y },
        end: { x, y: H - y - rowH },
        color: border,
        thickness: 0.5,
      });
    text(index + 1, M + 14, y + 20, 10);
    if (image) {
      const d = image.scaleToFit(40, 40);
      page.drawImage(image, {
        x: cols[1] + 6 + (40 - d.width) / 2,
        y: H - y - 9 - d.height,
        width: d.width,
        height: d.height,
      });
    }
    labelLines.forEach((line, i) =>
      text(line, descriptionX, y + 12 + i * 14, 10, true),
    );
    optionLines.forEach((line, i) =>
      text(
        line,
        descriptionX,
        y + 14 + labelLines.length * 14 + i * 11,
        7.5,
        false,
        muted,
      ),
    );
    text(item.quantity, cols[2] + 17, y + 20, 10);
    right(money(item.price), cols[4] - 9, y + 20, 9);
    right(money(item.price * item.quantity), W - M - 10, y + 20, 9);
    y += rowH;
  });
  const summaryH = invoice.discount > 0 ? 110 : 89;
  if (y + summaryH + 190 > H - 45) continuation();
  y += 12;
  const summaryY = y,
    sumX = M + leftW + gap;
  box(M, y, leftW, summaryH, pale, pale);
  text("Amount in Words:", M + 12, y + 12, 11, true, navy);
  wrapped(amountInWords(invoice.total), M + 12, y + 34, leftW - 25, 10);
  const totals: [string, number][] = [
    ["Subtotal", invoice.subtotal],
    ...(invoice.discount > 0
      ? [["Discount", -invoice.discount] as [string, number]]
      : []),
    ["Shipping", invoice.shipping],
  ];
  for (const [label, value] of totals) {
    box(sumX, y, rightW, 25);
    text(label, sumX + 12, y + 7, 10);
    right(money(value), W - M - 12, y + 7, 10);
    y += 25;
  }
  box(sumX, y, rightW, 39, navy, navy);
  text("Total", sumX + 12, y + 8, 17, true, white);
  right(money(invoice.total), W - M - 12, y + 8, 17, false, white);
  y = summaryY + summaryH + 24;
  text("Notes:", M, y, 10, true, navy);
  wrapped(
    "1. This is a computer-generated invoice.\n2. Payment status and shipping updates are available on your order page.\n3. This invoice is not proof of payment. No separate GST amount is charged.",
    M,
    y + 20,
    310,
    8.5,
    false,
    muted,
  );
  rule(y + 59, 381, 175);
  text("Authorised signatory", 398, y + 66, 9);
  wrapped(invoice.seller.name, 381, y + 82, 175, 10, true, navy);
  y += 126;
  rule(y);
  wrapped(
    `Thank you for shopping with ${invoice.seller.name}.`,
    M,
    y + 12,
    CW,
    12,
    true,
    navy,
  );
  wrapped(
    [invoice.seller.phone, invoice.seller.email].filter(Boolean).join("  |  "),
    M,
    y + 37,
    CW,
    8,
    false,
    muted,
  );
  pdf.getPages().forEach((p, i) =>
    p.drawText(`${i + 1} / ${pdf.getPageCount()}`, {
      x: W - M - 28,
      y: 18,
      size: 7,
      font,
      color: muted,
    }),
  );
  return Buffer.from(await pdf.save());
}
