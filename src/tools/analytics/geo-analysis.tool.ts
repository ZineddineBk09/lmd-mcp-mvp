import { z } from "zod";
import { Driver } from "../../schemas/driver.schema.js";
import { Order } from "../../schemas/order.schema.js";
import { wrapToolResponse } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";

export const geoAnalysisSchema = z.object({
  country_code: z
    .string()
    .optional()
    .describe("OPTIONAL. Country code filter."),
  city: z.string().optional().describe("OPTIONAL. City name filter."),
  analysis: z
    .enum(["driver_density", "unassigned_hotspots"])
    .default("driver_density")
    .describe("OPTIONAL. Type of analysis."),
});

export type GeoAnalysisInput = z.infer<typeof geoAnalysisSchema>;

export async function getGeoAnalysis(params: GeoAnalysisInput) {
  const start = Date.now();

  if (params.analysis === "driver_density") {
    // Group online drivers by city to show density
    const driverFilter: Record<string, unknown> = {
      status: 1,
      currentStatus: { $in: [1, 2] },
      logout: 0,
    };
    if (params.country_code)
      driverFilter["address.country_code"] = params.country_code;
    if (params.city) driverFilter["address.city"] = params.city;

    const pipeline = [
      { $match: driverFilter },
      {
        $group: {
          _id: "$address.city",
          total_drivers: { $sum: 1 },
          online_available: {
            $sum: { $cond: [{ $eq: ["$currentStatus", 1] }, 1, 0] },
          },
          busy: { $sum: { $cond: [{ $eq: ["$currentStatus", 2] }, 1, 0] } },
        },
      },
      { $match: { _id: { $ne: null } } },
      { $sort: { total_drivers: -1 } },
    ];

    const results = await Driver.aggregate(pipeline as never[]);

    const zones = results.map((r) => ({
      city: r._id,
      total_drivers: r.total_drivers,
      online_available: r.online_available,
      busy: r.busy,
      utilization_pct:
        r.total_drivers > 0 ? Math.round((r.busy / r.total_drivers) * 100) : 0,
    }));

    const executionTime = Date.now() - start;
    logQuery({
      tool: "geo_analysis",
      params,
      query: "drivers.aggregate group by city",
      execution_time_ms: executionTime,
      result_count: zones.length,
    });

    return wrapToolResponse(
      {
        analysis: "driver_density",
        zones,
        total_zones: zones.length,
        summary: `Driver density across ${zones.length} zones${params.country_code ? ` in ${params.country_code}` : ""}. Top zone: ${zones[0]?.city ?? "N/A"} with ${zones[0]?.total_drivers ?? 0} drivers (${zones[0]?.utilization_pct ?? 0}% utilization).`,
      },
      {
        query: "drivers.aggregate group by city",
        collection: "drivers",
        execution_time_ms: executionTime,
        result_count: zones.length,
      },
    );
  }

  // unassigned_hotspots
  const orderFilter: Record<string, unknown> = {
    status: { $in: [1] }, // only status 1 = received, no driver yet
    driver_id: null,
  };
  if (params.country_code) orderFilter.country_code = params.country_code;
  if (params.city) orderFilter.main_city = params.city;

  const pipeline = [
    { $match: orderFilter },
    {
      $group: {
        _id: "$main_city",
        unassigned_count: { $sum: 1 },
        oldest_order: { $min: "$createdAt" },
      },
    },
    { $match: { _id: { $ne: null } } },
    { $sort: { unassigned_count: -1 } },
  ];

  const results = await Order.aggregate(pipeline as never[]);
  const now = Date.now();

  const hotspots = results.map((r) => ({
    city: r._id,
    unassigned_count: r.unassigned_count,
    oldest_order_minutes_ago: r.oldest_order
      ? Math.round((now - new Date(r.oldest_order).getTime()) / 60000)
      : null,
  }));

  const totalUnassigned = hotspots.reduce((s, h) => s + h.unassigned_count, 0);
  const executionTime = Date.now() - start;
  logQuery({
    tool: "geo_analysis",
    params,
    query: "orders.aggregate unassigned by city",
    execution_time_ms: executionTime,
    result_count: hotspots.length,
  });

  return wrapToolResponse(
    {
      analysis: "unassigned_hotspots",
      hotspots,
      total_unassigned: totalUnassigned,
      summary: `${totalUnassigned} unassigned orders across ${hotspots.length} zones. Worst: ${hotspots[0]?.city ?? "N/A"} with ${hotspots[0]?.unassigned_count ?? 0} unassigned (oldest ${hotspots[0]?.oldest_order_minutes_ago ?? 0} min ago).`,
    },
    {
      query: "orders.aggregate unassigned by city",
      collection: "orders",
      execution_time_ms: executionTime,
      result_count: hotspots.length,
    },
  );
}
