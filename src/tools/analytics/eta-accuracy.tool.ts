import { z } from "zod";
import { Order } from "../../schemas/order.schema.js";
import { wrapToolResponse, formatAggregation } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import { cacheGet, cacheSet, buildCacheKey } from "../../utils/cache.js";

export const etaAccuracySchema = z.object({
  country_code: z
    .string()
    .optional()
    .describe("OPTIONAL. Country code filter."),
  city: z.string().optional().describe("OPTIONAL. City name filter."),
  since_hours: z
    .number()
    .default(24)
    .describe("OPTIONAL. Time window in hours (default 24)."),
});

export type EtaAccuracyInput = z.infer<typeof etaAccuracySchema>;

const CACHE_TTL_MS = 120_000;
const ON_TIME_THRESHOLD_MINUTES = 45;

export async function getEtaAccuracy(params: EtaAccuracyInput) {
  const cacheKey = buildCacheKey(
    "eta_accuracy",
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
    "order_history.food_delivered": { $exists: true, $ne: null },
  };
  if (params.country_code) match.country_code = params.country_code;
  if (params.city) match.main_city = params.city;

  const addFieldsStage = {
    $addFields: {
      actual_delivery_minutes: {
        $divide: [
          { $subtract: ["$order_history.food_delivered", "$createdAt"] },
          60000,
        ],
      },
      estimated_delivery_minutes: { $ifNull: ["$drop_off_ETA", null] },
    },
  };

  const overallPipeline: Record<string, unknown>[] = [
    { $match: match },
    addFieldsStage,
    {
      $group: {
        _id: null,
        total_delivered: { $sum: 1 },
        avg_actual_minutes: { $avg: "$actual_delivery_minutes" },
        on_time_count: {
          $sum: {
            $cond: [
              { $lte: ["$actual_delivery_minutes", ON_TIME_THRESHOLD_MINUTES] },
              1,
              0,
            ],
          },
        },
        min_actual_minutes: { $min: "$actual_delivery_minutes" },
        max_actual_minutes: { $max: "$actual_delivery_minutes" },
      },
    },
  ];

  const byCityPipeline: Record<string, unknown>[] = [
    { $match: match },
    addFieldsStage,
    {
      $group: {
        _id: "$main_city",
        total_delivered: { $sum: 1 },
        avg_actual_minutes: { $avg: "$actual_delivery_minutes" },
        on_time_count: {
          $sum: {
            $cond: [
              { $lte: ["$actual_delivery_minutes", ON_TIME_THRESHOLD_MINUTES] },
              1,
              0,
            ],
          },
        },
      },
    },
    { $match: { _id: { $ne: null } } },
    { $sort: { total_delivered: -1 } },
  ];

  const [overallResult, byCityResult] = await Promise.all([
    Order.aggregate(overallPipeline as never[]),
    Order.aggregate(byCityPipeline as never[]),
  ]);

  const overall = overallResult[0];
  const totalDelivered = overall?.total_delivered ?? 0;
  const onTimeCount = overall?.on_time_count ?? 0;
  const onTimeRate =
    totalDelivered > 0 ? Math.round((onTimeCount / totalDelivered) * 100) : 0;

  const byCity = byCityResult.map((r) => ({
    city: r._id,
    total_delivered: r.total_delivered,
    avg_actual_minutes: Math.round((r.avg_actual_minutes ?? 0) * 10) / 10,
    on_time_count: r.on_time_count,
    on_time_rate_pct:
      (r.total_delivered ?? 0) > 0
        ? Math.round(((r.on_time_count ?? 0) / (r.total_delivered ?? 1)) * 100)
        : 0,
  }));

  const summary = `ETA accuracy (last ${params.since_hours}h${params.country_code ? `, ${params.country_code}` : ""}${params.city ? `, ${params.city}` : ""}): ${totalDelivered} delivered orders, ${onTimeRate}% on-time (≤${ON_TIME_THRESHOLD_MINUTES}min), avg actual delivery ${Math.round((overall?.avg_actual_minutes ?? 0) * 10) / 10} min.`;

  const executionTime = Date.now() - start;
  logQuery({
    tool: "eta_accuracy",
    params,
    query: formatAggregation("orders", overallPipeline),
    execution_time_ms: executionTime,
    result_count: totalDelivered,
  });

  const response = wrapToolResponse(
    {
      time_window_hours: params.since_hours,
      country_code: params.country_code,
      city: params.city,
      on_time_threshold_minutes: ON_TIME_THRESHOLD_MINUTES,
      overall: {
        total_delivered: totalDelivered,
        on_time_count: onTimeCount,
        on_time_rate_pct: onTimeRate,
        avg_actual_minutes:
          Math.round((overall?.avg_actual_minutes ?? 0) * 10) / 10,
        min_actual_minutes:
          overall?.min_actual_minutes != null
            ? Math.round((overall.min_actual_minutes as number) * 10) / 10
            : null,
        max_actual_minutes:
          overall?.max_actual_minutes != null
            ? Math.round((overall.max_actual_minutes as number) * 10) / 10
            : null,
      },
      by_city: byCity,
      summary,
    },
    {
      query: `Overall: ${formatAggregation("orders", overallPipeline)}\nBy city: ${formatAggregation("orders", byCityPipeline)}`,
      collection: "orders",
      execution_time_ms: executionTime,
      result_count: totalDelivered,
    },
  );
  cacheSet(cacheKey, response, CACHE_TTL_MS);
  return response;
}
