import { z } from "zod";
import { Driver } from "../../schemas/driver.schema.js";
import { wrapToolResponse, formatMongoQuery } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import { cacheGet, cacheSet, buildCacheKey } from "../../utils/cache.js";

export const fleetStatusSchema = z.object({
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
});

export type FleetStatusInput = z.infer<typeof fleetStatusSchema>;

const STALE_THRESHOLD_MS = 300_000;

const CACHE_TTL_MS = 15_000;

export async function fleetStatus(params: FleetStatusInput) {
  const cacheKey = buildCacheKey(
    "fleet_status",
    params as Record<string, unknown>,
  );
  const cached = cacheGet<ReturnType<typeof wrapToolResponse>>(cacheKey);
  if (cached) return cached;

  const start = Date.now();

  const baseFilter: Record<string, unknown> = {
    status: 1,
  };
  if (params.country_code)
    baseFilter["address.country_code"] = params.country_code;
  if (params.city) {
    baseFilter["address.city"] = params.city;
  }

  const freshThreshold = Date.now() - STALE_THRESHOLD_MS;

  const [onlineCount, busyCount, ghostCount, offlineCount, totalCount] =
    await Promise.all([
      Driver.countDocuments({
        ...baseFilter,
        currentStatus: 1,
        logout: 0,
        last_update_time: { $gte: freshThreshold },
      }),
      Driver.countDocuments({
        ...baseFilter,
        currentStatus: 2,
        logout: 0,
        last_update_time: { $gte: freshThreshold },
      }),
      Driver.countDocuments({
        ...baseFilter,
        currentStatus: 1,
        logout: 0,
        last_update_time: { $lt: freshThreshold },
      }),
      Driver.countDocuments({
        ...baseFilter,
        $or: [{ currentStatus: 0 }, { logout: 1 }],
      }),
      Driver.countDocuments(baseFilter),
    ]);

  const availableCount = onlineCount;

  const executionTime = Date.now() - start;

  const queryDesc = formatMongoQuery("drivers", "countDocuments", [
    {
      ...baseFilter,
      currentStatus: 1,
      logout: 0,
      last_update_time: { $gte: `Date.now() - ${STALE_THRESHOLD_MS}` },
    },
  ]);

  logQuery({
    tool: "fleet_status",
    params,
    query: queryDesc,
    execution_time_ms: executionTime,
    result_count: totalCount,
  });

  const supplyHealth =
    availableCount === 0
      ? "CRITICAL"
      : availableCount < 5
        ? "LOW"
        : availableCount < 15
          ? "MODERATE"
          : "HEALTHY";

  const response = wrapToolResponse(
    {
      country_code: params.country_code ?? "all",
      city: params.city ?? "all",
      total_registered: totalCount,
      online: onlineCount,
      busy: busyCount,
      online_available: availableCount,
      ghost_online: ghostCount,
      offline: offlineCount,
      supply_health: supplyHealth,
      summary: `Fleet${params.country_code ? ` in ${params.country_code}` : ""}${params.city ? ` / ${params.city}` : ""}: ${onlineCount} online (${availableCount} available), ${busyCount} busy, ${ghostCount} ghost, ${offlineCount} offline out of ${totalCount} total. Supply: ${supplyHealth}.`,
    },
    {
      query: queryDesc,
      collection: "drivers",
      execution_time_ms: executionTime,
      result_count: totalCount,
    },
  );
  cacheSet(cacheKey, response, CACHE_TTL_MS);
  return response;
}
