import { z } from "zod";
import { Order } from "../../schemas/order.schema.js";
import { wrapToolResponse } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";

const PERIOD_PRESETS = {
  today_vs_yesterday: { currentHours: 0, previousHours: 24 },
  this_week_vs_last: { currentHours: 0, previousHours: 168 },
  last_1h_vs_prev_1h: { currentHours: 1, previousHours: 1 },
  last_4h_vs_prev_4h: { currentHours: 4, previousHours: 4 },
} as const;

export const comparePeriodsSchema = z.object({
  country_code: z
    .string()
    .optional()
    .describe(
      "OPTIONAL. Country code: DZ, MA, TN, FR, SN, ZA, etc. Omit to search all countries.",
    ),
  city: z.string().optional().describe("OPTIONAL. City name to filter."),
  metric: z
    .enum(["orders", "deliveries", "cancellations", "timeouts"])
    .describe(
      "REQUIRED. Metric to compare: orders (total), deliveries (status=7), cancellations (status 9,10,90), timeouts (status 11).",
    ),
  period: z
    .enum([
      "today_vs_yesterday",
      "this_week_vs_last",
      "last_1h_vs_prev_1h",
      "last_4h_vs_prev_4h",
    ])
    .default("today_vs_yesterday")
    .describe("OPTIONAL. Comparison period (default: today_vs_yesterday)."),
  group_by_country: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "OPTIONAL. If true, returns breakdown per country in one call instead of aggregate total.",
    ),
});

export type ComparePeriodsInput = z.infer<typeof comparePeriodsSchema>;

function getStatusFilter(metric: string): Record<string, unknown> | null {
  switch (metric) {
    case "deliveries":
      return { status: 7 };
    case "cancellations":
      return { status: { $in: [9, 10, 90] } };
    case "timeouts":
      return { status: 11 };
    default:
      return null;
  }
}

function getTimeRanges(period: keyof typeof PERIOD_PRESETS): {
  current: { start: Date; end: Date };
  previous: { start: Date; end: Date };
} {
  const now = new Date();

  if (period === "today_vs_yesterday") {
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setDate(yesterdayStart.getDate() - 1);
    return {
      current: { start: todayStart, end: now },
      previous: { start: yesterdayStart, end: todayStart },
    };
  }

  if (period === "this_week_vs_last") {
    const dayOfWeek = now.getDay();
    const weekStart = new Date(now);
    weekStart.setDate(weekStart.getDate() - dayOfWeek);
    weekStart.setHours(0, 0, 0, 0);
    const prevWeekStart = new Date(weekStart);
    prevWeekStart.setDate(prevWeekStart.getDate() - 7);
    return {
      current: { start: weekStart, end: now },
      previous: { start: prevWeekStart, end: weekStart },
    };
  }

  const preset = PERIOD_PRESETS[period];
  const currentEnd = now;
  const currentStart = new Date(now.getTime() - preset.currentHours * 3600000);
  const previousEnd = currentStart;
  const previousStart = new Date(
    currentStart.getTime() - preset.previousHours * 3600000,
  );

  return {
    current: { start: currentStart, end: currentEnd },
    previous: { start: previousStart, end: previousEnd },
  };
}

function computeDelta(current: number, previous: number) {
  const delta = current - previous;
  const deltaPct =
    previous > 0
      ? Math.round((delta / previous) * 100)
      : current > 0
        ? 100
        : 0;
  const trend = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  return { delta, delta_pct: deltaPct, trend };
}

const PERIOD_LABELS: Record<string, [string, string]> = {
  today_vs_yesterday: ["today", "yesterday"],
  this_week_vs_last: ["this week", "last week"],
  last_1h_vs_prev_1h: ["last 1h", "previous 1h"],
  last_4h_vs_prev_4h: ["last 4h", "previous 4h"],
};

export async function comparePeriods(params: ComparePeriodsInput) {
  const start = Date.now();
  const ranges = getTimeRanges(params.period);
  const statusFilter = getStatusFilter(params.metric);
  const [currentLabel, previousLabel] = PERIOD_LABELS[params.period];

  const baseFilter: Record<string, unknown> = {};
  if (params.country_code) baseFilter.country_code = params.country_code;
  if (params.city) baseFilter.main_city = params.city;
  if (statusFilter) Object.assign(baseFilter, statusFilter);

  if (params.group_by_country) {
    const [currentAgg, previousAgg] = await Promise.all([
      Order.aggregate([
        { $match: { ...baseFilter, createdAt: { $gte: ranges.current.start, $lt: ranges.current.end } } },
        { $group: { _id: "$country_code", count: { $sum: 1 } } },
      ]).exec(),
      Order.aggregate([
        { $match: { ...baseFilter, createdAt: { $gte: ranges.previous.start, $lt: ranges.previous.end } } },
        { $group: { _id: "$country_code", count: { $sum: 1 } } },
      ]).exec(),
    ]);

    const prevMap = new Map(previousAgg.map((r: { _id: string; count: number }) => [r._id, r.count]));
    const countries = new Set([
      ...currentAgg.map((r: { _id: string }) => r._id),
      ...previousAgg.map((r: { _id: string }) => r._id),
    ]);

    const breakdown = [...countries].sort().map((cc) => {
      const cur = currentAgg.find((r: { _id: string }) => r._id === cc)?.count ?? 0;
      const prev = prevMap.get(cc) ?? 0;
      return { country_code: cc, current: cur, previous: prev, ...computeDelta(cur, prev) };
    });

    const totalCur = breakdown.reduce((s, r) => s + r.current, 0);
    const totalPrev = breakdown.reduce((s, r) => s + r.previous, 0);

    const result = {
      metric: params.metric,
      period: params.period,
      current_label: currentLabel,
      previous_label: previousLabel,
      breakdown,
      total: { current: totalCur, previous: totalPrev, ...computeDelta(totalCur, totalPrev) },
      summary: `${params.metric} by country (${currentLabel} vs ${previousLabel}): ${breakdown.map((r) => `${r.country_code}: ${r.current} vs ${r.previous} (${r.delta >= 0 ? "+" : ""}${r.delta_pct}%)`).join(", ")}.`,
    };

    const executionTime = Date.now() - start;
    logQuery({ tool: "compare_periods", params, query: `aggregate x2 grouped by country (${params.period})`, execution_time_ms: executionTime, result_count: breakdown.length });
    return wrapToolResponse(result, { query: `orders.aggregate x2 group by country_code (${params.period})`, collection: "orders", execution_time_ms: executionTime, result_count: breakdown.length });
  }

  const [currentCount, previousCount] = await Promise.all([
    Order.countDocuments({
      ...baseFilter,
      createdAt: { $gte: ranges.current.start, $lt: ranges.current.end },
    }),
    Order.countDocuments({
      ...baseFilter,
      createdAt: { $gte: ranges.previous.start, $lt: ranges.previous.end },
    }),
  ]);

  const { delta, delta_pct: deltaPct, trend } = computeDelta(currentCount, previousCount);

  const result = {
    metric: params.metric,
    country_code: params.country_code,
    city: params.city ?? "all",
    current_period: {
      label: currentLabel,
      count: currentCount,
      range: ranges.current,
    },
    previous_period: {
      label: previousLabel,
      count: previousCount,
      range: ranges.previous,
    },
    delta,
    delta_pct: deltaPct,
    trend,
    summary: `${params.metric} ${trend === "up" ? "increased" : trend === "down" ? "decreased" : "unchanged"}: ${currentCount} ${currentLabel} vs ${previousCount} ${previousLabel} (${delta >= 0 ? "+" : ""}${deltaPct}%) in ${params.country_code ?? "all"}${params.city ? `/${params.city}` : ""}.`,
  };

  const executionTime = Date.now() - start;
  logQuery({
    tool: "compare_periods",
    params,
    query: `countDocuments x2 on orders for ${params.period}`,
    execution_time_ms: executionTime,
    result_count: 2,
  });

  return wrapToolResponse(result, {
    query: `orders.countDocuments x2 (${params.period})`,
    collection: "orders",
    execution_time_ms: executionTime,
    result_count: currentCount + previousCount,
  });
}
