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
    .describe("OPTIONAL. Country code: DZ, MA, TN, FR, SN, ZA, etc. Omit to search all countries."),
  city: z
    .string()
    .optional()
    .describe("OPTIONAL. City name to filter."),
  metric: z
    .enum(["orders", "deliveries", "cancellations", "timeouts"])
    .describe("REQUIRED. Metric to compare: orders (total), deliveries (status=7), cancellations (status 9,10,90), timeouts (status 11)."),
  period: z
    .enum(["today_vs_yesterday", "this_week_vs_last", "last_1h_vs_prev_1h", "last_4h_vs_prev_4h"])
    .default("today_vs_yesterday")
    .describe("OPTIONAL. Comparison period (default: today_vs_yesterday)."),
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

function getTimeRanges(period: keyof typeof PERIOD_PRESETS): { current: { start: Date; end: Date }; previous: { start: Date; end: Date } } {
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
  const previousStart = new Date(currentStart.getTime() - preset.previousHours * 3600000);

  return {
    current: { start: currentStart, end: currentEnd },
    previous: { start: previousStart, end: previousEnd },
  };
}

export async function comparePeriods(params: ComparePeriodsInput) {
  const start = Date.now();

  const ranges = getTimeRanges(params.period);
  const statusFilter = getStatusFilter(params.metric);

  const baseFilter: Record<string, unknown> = {};
  if (params.country_code) baseFilter.country_code = params.country_code;
  if (params.city) baseFilter.main_city = params.city;
  if (statusFilter) Object.assign(baseFilter, statusFilter);

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

  const delta = currentCount - previousCount;
  const deltaPct = previousCount > 0 ? Math.round((delta / previousCount) * 100) : currentCount > 0 ? 100 : 0;
  const trend = delta > 0 ? "up" : delta < 0 ? "down" : "flat";

  const periodLabels: Record<string, string[]> = {
    today_vs_yesterday: ["today", "yesterday"],
    this_week_vs_last: ["this week", "last week"],
    last_1h_vs_prev_1h: ["last 1h", "previous 1h"],
    last_4h_vs_prev_4h: ["last 4h", "previous 4h"],
  };
  const [currentLabel, previousLabel] = periodLabels[params.period];

  const result = {
    metric: params.metric,
    country_code: params.country_code,
    city: params.city ?? "all",
    current_period: { label: currentLabel, count: currentCount, range: ranges.current },
    previous_period: { label: previousLabel, count: previousCount, range: ranges.previous },
    delta,
    delta_pct: deltaPct,
    trend,
    summary: `${params.metric} ${trend === "up" ? "increased" : trend === "down" ? "decreased" : "unchanged"}: ${currentCount} ${currentLabel} vs ${previousCount} ${previousLabel} (${delta >= 0 ? "+" : ""}${deltaPct}%) in ${params.country_code}${params.city ? `/${params.city}` : ""}.`,
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
