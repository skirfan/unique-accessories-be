import { Prisma } from "@prisma/client";
import { prisma } from "./prisma.js";
import { getSettings } from "./settings.js";
const DAY = 86400000;
const acceptedStatuses = [
  "CONFIRMED",
  "PACKED",
  "SHIPPED",
  "DELIVERED",
] as const;
export async function getAdminOverview(days: 7 | 30 | 180 | 365 = 30) {
  const dayKey = (date: Date) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  const today = new Date(`${dayKey(new Date())}T00:00:00+05:30`);
  const end = new Date(today.getTime() + DAY);
  const firstDay = new Date(today.getTime() - 6 * DAY);
  const start = new Date(end.getTime() - days * DAY);
  const previousStart = new Date(start.getTime() - days * DAY);
  const [
    orders,
    pendingApproval,
    paymentVerification,
    paid,
    readyToPack,
    paymentMethods,
    weekOrders,
    recent,
    settings,
    inventory,
    products,
    publishedProducts,
    rangeOrders,
    rangePayments,
    ranked,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({ where: { status: "AWAITING_APPROVAL" } }),
    prisma.order.count({
      where: { manualPaymentStatus: "PENDING_VERIFICATION" },
    }),
    prisma.order.aggregate({
      where: { manualPaymentStatus: "PAID" },
      _sum: { total: true },
    }),
    prisma.order.count({
      where: {
        status: "CONFIRMED",
        OR: [{ paymentMethod: "COD" }, { manualPaymentStatus: "PAID" }],
      },
    }),
    prisma.order.groupBy({ by: ["paymentMethod"], _count: { _all: true } }),
    prisma.order.findMany({
      where: { createdAt: { gte: firstDay, lt: end } },
      select: { createdAt: true },
    }),
    prisma.order.findMany({
      take: 5,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: {
        reference: true,
        customerName: true,
        customerPhone: true,
        status: true,
        paymentMethod: true,
        manualPaymentStatus: true,
        total: true,
        createdAt: true,
        items: { select: { quantity: true } },
      },
    }),
    getSettings(),
    prisma.inventory.findMany({
      where: {
        variant: { isActive: true, product: { status: { not: "ARCHIVED" } } },
      },
      select: { quantity: true, reserved: true },
    }),
    prisma.product.count({ where: { status: { not: "ARCHIVED" } } }),
    prisma.product.count({
      where: { status: "PUBLISHED", variants: { some: { isActive: true } } },
    }),
    prisma.order.findMany({
      where: { createdAt: { gte: previousStart, lt: end } },
      select: { createdAt: true, status: true },
    }),
    prisma.order.findMany({
      where: {
        manualPaymentStatus: "PAID",
        OR: [
          { paymentVerifiedAt: { gte: previousStart, lt: end } },
          {
            paymentVerifiedAt: null,
            createdAt: { gte: previousStart, lt: end },
          },
        ],
      },
      select: { paymentVerifiedAt: true, createdAt: true, total: true },
    }),
    prisma.$queryRaw<
      { id: string; sold: bigint; revenue: Prisma.Decimal }[]
    >(Prisma.sql`
      SELECT p.id, SUM(oi.quantity)::bigint AS sold, SUM(oi.quantity * oi."unitPrice") AS revenue
      FROM "OrderItem" oi JOIN "Order" o ON o.id=oi."orderId"
      JOIN "ProductVariant" v ON v.id=oi."variantId" JOIN "Product" p ON p.id=v."productId"
      WHERE o.status IN ('CONFIRMED','PACKED','SHIPPED','DELIVERED') AND o."createdAt">=${start} AND o."createdAt"<${end}
      GROUP BY p.id ORDER BY revenue DESC, sold DESC, p.id ASC LIMIT 5`),
  ]);
  const activity = Array.from({ length: 7 }, (_, i) => {
    const date = new Date(firstDay.getTime() + i * DAY);
    return {
      date: dayKey(date),
      label: date.toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata",
        weekday: "short",
      }),
      orders: weekOrders.filter((o) => dayKey(o.createdAt) === dayKey(date))
        .length,
    };
  });
  const currentOrders = rangeOrders.filter((o) => o.createdAt >= start);
  const previousOrders = rangeOrders.filter((o) => o.createdAt < start);
  const currentPayments = rangePayments.filter(
    (o) => (o.paymentVerifiedAt ?? o.createdAt) >= start,
  );
  const previousPayments = rangePayments.filter(
    (o) => (o.paymentVerifiedAt ?? o.createdAt) < start,
  );
  const sum = (rows: typeof rangePayments) =>
    rows.reduce((n, o) => n + Math.round(Number(o.total) * 100), 0) / 100;
  const rate = (rows: typeof rangeOrders) =>
    rows.length
      ? (rows.filter((o) =>
          acceptedStatuses.some((status) => status === o.status),
        ).length /
          rows.length) *
        100
      : null;
  const change = (value: number, previous: number) =>
    previous > 0 ? ((value - previous) / previous) * 100 : null;
  const currentRevenue = sum(currentPayments);
  const previousRevenue = sum(previousPayments);
  const currentRate = rate(currentOrders);
  const previousRate = rate(previousOrders);
  const bucketDays = days <= 30 ? 1 : days === 180 ? 7 : 14;
  const revenueActivity = Array.from(
    { length: Math.ceil(days / bucketDays) },
    (_, index) => {
      const from = new Date(start.getTime() + index * bucketDays * DAY);
      const until = new Date(
        Math.min(end.getTime(), from.getTime() + bucketDays * DAY),
      );
      const payments = currentPayments.filter((o) => {
        const d = o.paymentVerifiedAt ?? o.createdAt;
        return d >= from && d < until;
      });
      return {
        date: dayKey(from),
        label: from.toLocaleDateString("en-IN", {
          timeZone: "Asia/Kolkata",
          month: "short",
          day: "numeric",
        }),
        revenue: sum(payments),
        orders: currentOrders.filter(
          (o) => o.createdAt >= from && o.createdAt < until,
        ).length,
      };
    },
  );
  const productDetails = ranked.length
    ? await prisma.product.findMany({
        where: { id: { in: ranked.map((p) => p.id) } },
        select: {
          id: true,
          name: true,
          slug: true,
          images: {
            orderBy: { position: "asc" },
            take: 1,
            select: { url: true, thumbnailUrl: true },
          },
        },
      })
    : [];
  return {
    orders,
    pendingApproval,
    paymentVerification,
    paymentsRecorded: Number(paid._sum.total ?? 0),
    readyToPack,
    lowStock: inventory.filter((i) => i.quantity - i.reserved <= 5).length,
    activity,
    weekOrders: weekOrders.length,
    paymentMethods: {
      COD:
        paymentMethods.find((m) => m.paymentMethod === "COD")?._count._all ?? 0,
      UPI:
        paymentMethods.find((m) => m.paymentMethod === "UPI")?._count._all ?? 0,
    },
    recentOrders: recent.map(({ items, ...order }) => ({
      ...order,
      paymentStatus: order.manualPaymentStatus,
      total: Number(order.total),
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    })),
    configuration: {
      minimumOrderEnabled: settings.minimumOrderEnabled,
      minimumOrderAmount: Number(settings.minimumOrderAmount),
      codEnabled: settings.codEnabled,
      upiEnabled: settings.upiEnabled,
      whatsappConfigured: Boolean(settings.whatsappNumber),
    },
    dashboard: {
      days,
      startDate: dayKey(start),
      endDate: dayKey(today),
      revenue: currentRevenue,
      revenueChange: change(currentRevenue, previousRevenue),
      orderCount: currentOrders.length,
      orderChange: change(currentOrders.length, previousOrders.length),
      products,
      publishedProducts,
      acceptanceRate: currentRate,
      acceptanceChange:
        currentRate !== null && previousRate !== null
          ? currentRate - previousRate
          : null,
      revenueActivity,
      topProducts: ranked.flatMap((row) => {
        const p = productDetails.find((p) => p.id === row.id);
        return p
          ? [
              {
                id: p.id,
                name: p.name,
                slug: p.slug,
                imageUrl: p.images[0]?.thumbnailUrl ?? p.images[0]?.url ?? null,
                sold: Number(row.sold),
                revenue: Number(row.revenue),
              },
            ]
          : [];
      }),
    },
  };
}
