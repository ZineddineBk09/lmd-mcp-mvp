import { z } from "zod";
import { Order } from "../../schemas/order.schema.js";
import { Driver } from "../../schemas/driver.schema.js";
import { City } from "../../schemas/city.schema.js";
import { wrapToolResponse } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import { ACTIVE_ORDER_STATUSES } from "../../constants/order-status.js";
import { cacheGet, cacheSet, buildCacheKey } from "../../utils/cache.js";

export const supplyDemandSchema = z.object({
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

export type SupplyDemandInput = z.infer<typeof supplyDemandSchema>;

const STALE_THRESHOLD_MS = 300_000;
const CACHE_TTL_MS = 15_000;

export async function getSupplyDemandBalance(params: SupplyDemandInput) {
  const cacheKey = buildCacheKey(
    "supply_demand_balance",
    params as Record<string, unknown>,
  );
  const cached =
    cacheGet<Awaited<ReturnType<typeof wrapToolResponse>>>(cacheKey);
  if (cached) return cached;

  const start = Date.now();
  const freshThreshold = Date.now() - STALE_THRESHOLD_MS;

  const orderMatch: Record<string, unknown> = {
    status: { $in: [...ACTIVE_ORDER_STATUSES] },
  };
  if (params.country_code) orderMatch.country_code = params.country_code;
  if (params.city) orderMatch.main_city = params.city;

  const driverMatch: Record<string, unknown> = {
    status: 1,
    currentStatus: 1,
    logout: 0,
    last_update_time: { $gte: freshThreshold },
  };
  if (params.country_code)
    driverMatch["address.country_code"] = params.country_code;
  if (params.city) driverMatch["address.city"] = params.city;

  const busyMatch: Record<string, unknown> = {
    status: 1,
    currentStatus: 2,
    logout: 0,
    last_update_time: { $gte: freshThreshold },
  };
  if (params.country_code)
    busyMatch["address.country_code"] = params.country_code;
  if (params.city) busyMatch["address.city"] = params.city;

  const [activeOrders, onlineDrivers, busyDriverCount, cityConfig] =
    await Promise.all([
      Order.countDocuments(orderMatch),
      Driver.countDocuments(driverMatch),
      Driver.countDocuments(busyMatch),
      params.country_code
        ? City.findOne({ country_code: params.country_code }).lean()
        : Promise.resolve(null),
    ]);

  const maxOrders = cityConfig?.max_orders || 3;
  const availableCount = onlineDrivers;
  const totalCapacitySlots = onlineDrivers * maxOrders;

  const ratio =
    availableCount > 0
      ? Math.round((activeOrders / availableCount) * 10) / 10
      : activeOrders > 0
        ? Infinity
        : 0;

  let assessment: string;
  let severity: string;
  if (availableCount === 0 && activeOrders > 0) {
    assessment = "CRITICAL shortage -- no available drivers for active orders";
    severity = "CRITICAL";
  } else if (ratio > 5) {
    assessment = `Severe shortage -- ${ratio}x orders per available driver`;
    severity = "HIGH";
  } else if (ratio > 3) {
    assessment = `Moderate pressure -- ${ratio}x orders per available driver`;
    severity = "MEDIUM";
  } else if (ratio > 1.5) {
    assessment = `Slightly busy -- ${ratio}x orders per available driver`;
    severity = "LOW";
  } else {
    assessment = `Balanced -- ${ratio}x orders per available driver`;
    severity = "HEALTHY";
  }

  const recommendations: string[] = [];
  if (severity === "CRITICAL" || severity === "HIGH") {
    recommendations.push(
      `Widen dispatch radius from ${cityConfig?.driver_radius || 20} to ${(cityConfig?.driver_radius || 20) + 10}`,
    );
    recommendations.push("Send push notification to offline drivers");
    recommendations.push("Consider activating surge incentives");
  } else if (severity === "MEDIUM") {
    recommendations.push("Monitor closely -- could escalate in 15-30 minutes");
  }

  const executionTime = Date.now() - start;

  const queryDesc = `orders.countDocuments({status:{$in:[1,3,5,6,17]}${params.country_code ? `,country_code:'${params.country_code}'` : ""}}) + drivers.countDocuments({currentStatus:1,logout:0})`;

  logQuery({
    tool: "supply_demand_balance",
    params,
    query: queryDesc,
    execution_time_ms: executionTime,
    result_count: activeOrders + onlineDrivers,
  });

  const response = wrapToolResponse(
    {
      active_orders: activeOrders,
      online_drivers: onlineDrivers,
      busy_drivers: busyDriverCount,
      available_drivers: availableCount,
      total_remaining_capacity_slots: totalCapacitySlots,
      orders_per_available_driver_ratio: ratio,
      severity,
      assessment,
      recommendations,
      city_config: {
        driver_radius: cityConfig?.driver_radius || 20,
        max_orders: maxOrders,
        dispatch_delay: cityConfig?.dispatch_delay_time,
      },
      summary: `Supply/demand${params.country_code ? ` in ${params.country_code}` : ""}${params.city ? ` / ${params.city}` : ""}: ${activeOrders} active orders, ${availableCount} online drivers (${busyDriverCount} busy), ratio ${ratio}x. ${assessment}.`,
    },
    {
      query: queryDesc,
      collection: "orders + drivers",
      execution_time_ms: executionTime,
      result_count: activeOrders,
    },
  );
  cacheSet(cacheKey, response, CACHE_TTL_MS);
  return response;
}
