import { z } from "zod";
import { Order } from "../../schemas/order.schema.js";
import { Driver } from "../../schemas/driver.schema.js";
import { wrapToolResponse } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import { cacheGet, cacheSet, buildCacheKey } from "../../utils/cache.js";

export const detectAnomaliesSchema = z.object({
  country_code: z
    .string()
    .optional()
    .describe(
      "OPTIONAL. Country code: DZ, MA, TN, FR, SN, ZA, etc. Omit to search all countries.",
    ),
  city: z.string().optional().describe("OPTIONAL. City name to focus on."),
});

export type DetectAnomaliesInput = z.infer<typeof detectAnomaliesSchema>;

interface AnomalyResult {
  metric: string;
  severity: "high" | "medium" | "low";
  current_value: number;
  baseline_avg: number;
  deviation_pct: number;
  message: string;
}

async function getHourlyCount(
  baseFilter: Record<string, unknown>,
  statusFilter: Record<string, unknown> | null,
  startDate: Date,
  endDate: Date,
): Promise<number> {
  const filter: Record<string, unknown> = {
    ...baseFilter,
    createdAt: { $gte: startDate, $lt: endDate },
  };
  if (statusFilter) Object.assign(filter, statusFilter);
  return Order.countDocuments(filter);
}

const BASELINE_CACHE_TTL_MS = 3_600_000; // 1 hour

export async function detectAnomalies(params: DetectAnomaliesInput) {
  const start = Date.now();
  const now = new Date();
  const currentHour = now.getHours();

  const currentHourStart = new Date(now);
  currentHourStart.setMinutes(0, 0, 0);
  const currentHourEnd = now;

  const baseFilter: Record<string, unknown> = {};
  if (params.country_code) baseFilter.country_code = params.country_code;
  if (params.city) baseFilter.main_city = params.city;

  const metrics = [
    { name: "total_orders", statusFilter: null },
    { name: "deliveries", statusFilter: { status: 7 } },
    { name: "cancellations", statusFilter: { status: { $in: [9, 10, 90] } } },
    { name: "timeouts", statusFilter: { status: 11 } },
    { name: "restaurant_rejections", statusFilter: { status: 2 } },
  ];

  const driverFilter: Record<string, unknown> = {
    "address.country_code": params.country_code,
    logout: 0,
  };
  if (params.city) driverFilter["address.city"] = params.city;

  // Build ALL queries upfront, then run in parallel
  const currentQueries = metrics.map((m) =>
    getHourlyCount(
      baseFilter,
      m.statusFilter,
      currentHourStart,
      currentHourEnd,
    ),
  );

  const baselineCacheKey = buildCacheKey("anomaly_baseline", {
    ...params,
    hour: currentHour,
  } as Record<string, unknown>);
  let baselineData = cacheGet<number[][]>(baselineCacheKey);

  if (!baselineData) {
    const historicalQueries: Promise<number>[] = [];
    for (const metric of metrics) {
      for (let d = 1; d <= 7; d++) {
        const dayStart = new Date(currentHourStart);
        dayStart.setDate(dayStart.getDate() - d);
        const dayEnd = new Date(dayStart);
        dayEnd.setHours(currentHour + 1, 0, 0, 0);
        historicalQueries.push(
          getHourlyCount(baseFilter, metric.statusFilter, dayStart, dayEnd),
        );
      }
    }

    const allHistorical = await Promise.all(historicalQueries);

    baselineData = [];
    for (let m = 0; m < metrics.length; m++) {
      baselineData.push(allHistorical.slice(m * 7, (m + 1) * 7));
    }
    cacheSet(baselineCacheKey, baselineData, BASELINE_CACHE_TTL_MS);
  }

  const [currentValues, onlineDrivers] = await Promise.all([
    Promise.all(currentQueries),
    Driver.countDocuments(driverFilter),
  ]);

  const anomalies: AnomalyResult[] = [];

  for (let i = 0; i < metrics.length; i++) {
    const metric = metrics[i];
    const currentValue = currentValues[i];
    const historicalCounts = baselineData[i];

    const baselineAvg =
      historicalCounts.length > 0
        ? Math.round(
            historicalCounts.reduce((a, b) => a + b, 0) /
              historicalCounts.length,
          )
        : 0;

    if (baselineAvg === 0 && currentValue === 0) continue;

    const deviationPct =
      baselineAvg > 0
        ? Math.round(((currentValue - baselineAvg) / baselineAvg) * 100)
        : currentValue > 0
          ? 100
          : 0;

    const absDeviation = Math.abs(deviationPct);
    let severity: "high" | "medium" | "low" | null = null;

    if (absDeviation >= 50) severity = "high";
    else if (absDeviation >= 30) severity = "medium";
    else if (
      absDeviation >= 20 &&
      (metric.name === "cancellations" ||
        metric.name === "timeouts" ||
        metric.name === "restaurant_rejections")
    ) {
      severity = "low";
    }

    if (severity) {
      const direction = deviationPct > 0 ? "higher" : "lower";
      anomalies.push({
        metric: metric.name,
        severity,
        current_value: currentValue,
        baseline_avg: baselineAvg,
        deviation_pct: deviationPct,
        message: `${metric.name} is ${absDeviation}% ${direction} than usual this hour (${currentValue} vs avg ${baselineAvg}).`,
      });
    }
  }

  anomalies.sort((a, b) => {
    const sevOrder = { high: 0, medium: 1, low: 2 };
    return sevOrder[a.severity] - sevOrder[b.severity];
  });

  const highCount = anomalies.filter((a) => a.severity === "high").length;
  const mediumCount = anomalies.filter((a) => a.severity === "medium").length;

  const result = {
    country_code: params.country_code,
    city: params.city ?? "all",
    current_hour: `${currentHour}:00`,
    baseline_days: 7,
    online_drivers: onlineDrivers,
    anomalies_found: anomalies.length,
    anomalies,
    summary:
      anomalies.length === 0
        ? `No anomalies detected in ${params.country_code}${params.city ? `/${params.city}` : ""} this hour. All metrics within normal range. ${onlineDrivers} drivers online.`
        : `${anomalies.length} anomalies in ${params.country_code}${params.city ? `/${params.city}` : ""}: ${highCount} high, ${mediumCount} medium severity. ${anomalies
            .slice(0, 2)
            .map((a) => a.message)
            .join(" ")} ${onlineDrivers} drivers online.`,
  };

  const executionTime = Date.now() - start;
  logQuery({
    tool: "detect_anomalies",
    params,
    query: `7-day baseline comparison across ${metrics.length} metrics`,
    execution_time_ms: executionTime,
    result_count: anomalies.length,
  });

  return wrapToolResponse(result, {
    query: `Hourly anomaly detection: ${metrics.length} metrics x 7 days baseline (parallelized)`,
    collection: "orders",
    execution_time_ms: executionTime,
    result_count: anomalies.length,
  });
}
