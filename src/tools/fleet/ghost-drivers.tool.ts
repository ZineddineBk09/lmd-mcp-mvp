import { z } from "zod";
import { Driver } from "../../schemas/driver.schema.js";
import { wrapToolResponse, formatMongoQuery } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";

export const ghostDriversSchema = z.object({
  country_code: z
    .string()
    .optional()
    .describe(
      "OPTIONAL. Country code: DZ, MA, TN, or CI. Omit to search all countries.",
    ),
  city: z
    .string()
    .optional()
    .describe("OPTIONAL. City name. Omit for entire country."),
  stale_threshold_minutes: z
    .number()
    .default(5)
    .describe("OPTIONAL. Inactivity threshold in minutes (default 5)."),
  limit: z.number().default(50).describe("OPTIONAL. Max results (default 50)."),
});

export type GhostDriversInput = z.infer<typeof ghostDriversSchema>;

export async function getGhostDrivers(params: GhostDriversInput) {
  const start = Date.now();

  const staleThreshold =
    Date.now() - params.stale_threshold_minutes * 60 * 1000;

  const filter: Record<string, unknown> = {
    status: 1,
    currentStatus: 1,
    logout: 0,
    last_update_time: { $lt: staleThreshold, $gt: 0 },
  };
  if (params.country_code) filter["address.country_code"] = params.country_code;
  if (params.city) {
    filter["address.city"] = params.city;
  }

  const [ghosts, totalCount] = await Promise.all([
    Driver.find(filter, {
      _id: 1,
      username: 1,
      first_name: 1,
      last_name: 1,
      last_update_time: 1,
      "address.city": 1,
      currentOrders: 1,
    })
      .sort({ last_update_time: 1 })
      .limit(params.limit)
      .lean(),
    Driver.countDocuments(filter),
  ]);

  const executionTime = Date.now() - start;

  logQuery({
    tool: "ghost_drivers",
    params,
    query: formatMongoQuery("drivers", "find", [filter]),
    execution_time_ms: executionTime,
    result_count: totalCount,
  });

  return wrapToolResponse(
    {
      ghost_drivers: ghosts.map((d) => {
        const lastSeen = new Date(d.last_update_time);
        const minutesAgo = Math.round(
          (Date.now() - d.last_update_time) / 60000,
        );
        return {
          _id: d._id.toString(),
          username: d.username,
          name: [d.username, d.last_name].filter(Boolean).join(" ") || null,
          city: d.address?.city,
          last_seen: lastSeen.toISOString(),
          minutes_since_update: minutesAgo,
          ongoing_orders: d.currentOrders?.onGoingOrdersCount ?? 0,
        };
      }),
      total_ghost_count: totalCount,
      threshold_minutes: params.stale_threshold_minutes,
      recommendations:
        totalCount > 0
          ? [
              `${totalCount} ghost drivers detected — they appear online but have stale GPS data`,
              "These drivers will receive dispatch requests but won't respond, causing delays",
              "Consider: force-logout, send ping notification, or exclude from dispatch",
            ]
          : ["No ghost drivers detected — fleet GPS data is fresh"],
      summary: `${totalCount} ghost drivers in ${params.country_code}${params.city ? ` / ${params.city}` : ""} (no GPS update in >${params.stale_threshold_minutes} min).`,
    },
    {
      query: formatMongoQuery("drivers", "find", [filter]),
      collection: "drivers",
      execution_time_ms: executionTime,
      result_count: totalCount,
    },
  );
}
