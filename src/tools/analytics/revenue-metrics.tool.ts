import { z } from "zod";
import { Order } from "../../schemas/order.schema.js";
import { wrapToolResponse, formatAggregation } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import { cacheGet, cacheSet, buildCacheKey } from "../../utils/cache.js";

export const revenueMetricsSchema = z.object({
  country_code: z
    .string()
    .optional()
    .describe("OPTIONAL. Country code filter."),
  city: z.string().optional().describe("OPTIONAL. City name filter."),
  since_hours: z
    .number()
    .default(24)
    .describe("OPTIONAL. Time window in hours (default 24)."),
  group_by: z
    .enum(["city", "country", "hour"])
    .optional()
    .describe("OPTIONAL. Group results by city, country, or hour."),
});

export type RevenueMetricsInput = z.infer<typeof revenueMetricsSchema>;

const CACHE_TTL_MS = 60_000;

export async function getRevenueMetrics(params: RevenueMetricsInput) {
  const cacheKey = buildCacheKey(
    "revenue_metrics",
    params as Record<string, unknown>,
  );
  const cached =
    cacheGet<Awaited<ReturnType<typeof wrapToolResponse>>>(cacheKey);
  if (cached) return cached;

  const start = Date.now();
  const sinceDate = new Date(Date.now() - params.since_hours * 3600000);

  const match: Record<string, unknown> = {
    status: 7,
    createdAt: { $gte: sinceDate },
  };
  if (params.country_code) match.country_code = params.country_code;
  if (params.city) match.main_city = params.city;

  const groupId = params.group_by
    ? params.group_by === "city"
      ? "$main_city"
      : params.group_by === "country"
        ? "$country_code"
        : { $hour: "$createdAt" }
    : null;

  const pipeline: Record<string, unknown>[] = [
    { $match: match },
    {
      $group: {
        _id: groupId,
        total_revenue: {
          $sum: { $ifNull: ["$billings.amount.grand_total", 0] },
        },
        total_delivery_fees: {
          $sum: { $ifNull: ["$billings.amount.delivery_amount", 0] },
        },
        avg_basket_size: {
          $avg: { $ifNull: ["$billings.amount.grand_total", 0] },
        },
        order_count: { $sum: 1 },
      },
    },
    { $sort: { total_revenue: -1 } },
  ];

  const results = await Order.aggregate(pipeline as never[]);

  const KNOWN_COUNTRIES = ["DZ", "MA", "TN", "FR", "ZA", "SN"];
  const ZERO_ROW = { total_revenue: 0, total_delivery_fees: 0, avg_basket_size: 0, order_count: 0 };

  let rows = results.map((r) => ({
    dimension: r._id ?? "total",
    total_revenue: Math.round((r.total_revenue ?? 0) * 100) / 100,
    total_delivery_fees: Math.round((r.total_delivery_fees ?? 0) * 100) / 100,
    avg_basket_size: Math.round((r.avg_basket_size ?? 0) * 100) / 100,
    order_count: r.order_count ?? 0,
  }));

  if (params.group_by === "country" && !params.country_code) {
    const seen = new Set(rows.map((r) => r.dimension));
    for (const cc of KNOWN_COUNTRIES) {
      if (!seen.has(cc)) rows.push({ dimension: cc, ...ZERO_ROW });
    }
    rows = rows.sort((a, b) => String(a.dimension).localeCompare(String(b.dimension)));
  }

  const totals = rows.reduce(
    (acc, r) => ({
      total_revenue: acc.total_revenue + r.total_revenue,
      total_delivery_fees: acc.total_delivery_fees + r.total_delivery_fees,
      order_count: acc.order_count + r.order_count,
    }),
    { total_revenue: 0, total_delivery_fees: 0, order_count: 0 },
  );
  const avgBasket =
    totals.order_count > 0 ? totals.total_revenue / totals.order_count : 0;

  const summary = `Revenue metrics (last ${params.since_hours}h${params.country_code ? `, ${params.country_code}` : ""}${params.city ? `, ${params.city}` : ""}): ${totals.order_count} delivered orders, GMV ${totals.total_revenue.toFixed(2)}, delivery fees ${totals.total_delivery_fees.toFixed(2)}, avg basket ${avgBasket.toFixed(2)}${params.group_by ? ` grouped by ${params.group_by}` : ""}.`;

  const executionTime = Date.now() - start;
  logQuery({
    tool: "revenue_metrics",
    params,
    query: formatAggregation("orders", pipeline),
    execution_time_ms: executionTime,
    result_count: rows.length,
  });

  const response = wrapToolResponse(
    {
      time_window_hours: params.since_hours,
      country_code: params.country_code,
      city: params.city,
      group_by: params.group_by,
      totals: {
        total_revenue: Math.round(totals.total_revenue * 100) / 100,
        total_delivery_fees: Math.round(totals.total_delivery_fees * 100) / 100,
        order_count: totals.order_count,
        avg_basket_size: Math.round(avgBasket * 100) / 100,
      },
      breakdown: rows,
      summary,
    },
    {
      query: formatAggregation("orders", pipeline),
      collection: "orders",
      execution_time_ms: executionTime,
      result_count: rows.length,
    },
  );
  cacheSet(cacheKey, response, CACHE_TTL_MS);
  return response;
}
