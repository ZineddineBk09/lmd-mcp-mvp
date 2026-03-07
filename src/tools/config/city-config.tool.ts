import { z } from "zod";
import { City } from "../../schemas/city.schema.js";
import { wrapToolResponse } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";

export const cityConfigSchema = z.object({
  country_code: z
    .string()
    .optional()
    .describe("OPTIONAL. Country code: DZ, MA, TN, FR, SN, ZA, etc. Omit to see all countries."),
  city: z
    .string()
    .optional()
    .describe("OPTIONAL. City name (exact or partial match)."),
  field: z
    .string()
    .optional()
    .describe("OPTIONAL. Specific config field to focus on (e.g. 'auto_dispatch', 'max_orders', 'driver_radius', 'dispatch_delay_time', 'timer_config')."),
});

export type CityConfigInput = z.infer<typeof cityConfigSchema>;

const CONFIG_FIELDS = {
  country_code: 1,
  cityname: 1,
  state: 1,
  auto_dispatch: 1,
  auto_dispatch_algorithm: 1,
  dispatch_delay_time: 1,
  max_dispatch_time: 1,
  max_rejected_drivers: 1,
  driver_radius: 1,
  max_orders: 1,
  timer_config: 1,
  busySettings: 1,
  maxRejectedOrders: 1,
  busyTime: 1,
};

export async function cityConfig(params: CityConfigInput) {
  const start = Date.now();

  const filter: Record<string, unknown> = {};
  if (params.country_code) filter.country_code = params.country_code;
  if (params.city) filter.cityname = { $regex: params.city, $options: "i" };

  const cities = await City.find(filter, CONFIG_FIELDS).sort({ country_code: 1, cityname: 1 }).lean();

  if (cities.length === 0) {
    return wrapToolResponse(
      { error: `No cities found matching filters.`, filter },
      { query: `db.cities.find(${JSON.stringify(filter)})`, execution_time_ms: Date.now() - start, result_count: 0 }
    );
  }

  let result: unknown;

  if (params.field) {
    const comparison = cities.map((c: Record<string, unknown>) => ({
      city: c.cityname,
      country: c.country_code,
      [params.field!]: c[params.field!] ?? null,
    }));

    const uniqueValues = [...new Set(comparison.map((c: Record<string, unknown>) => JSON.stringify(c[params.field!])))];

    result = {
      field: params.field,
      cities_count: comparison.length,
      comparison,
      unique_values: uniqueValues.length,
      summary: `${params.field} across ${comparison.length} cities: ${uniqueValues.length} distinct values. ${comparison.slice(0, 3).map((c: Record<string, unknown>) => `${c.city}=${JSON.stringify(c[params.field!])}`).join(", ")}${comparison.length > 3 ? "..." : ""}`,
    };
  } else {
    const formatted = cities.map((c: Record<string, unknown>) => ({
      city: c.cityname,
      country: c.country_code,
      state: c.state,
      auto_dispatch: c.auto_dispatch ?? false,
      algorithm: c.auto_dispatch_algorithm ?? "normal",
      dispatch_delay_min: c.dispatch_delay_time ?? null,
      max_dispatch_min: c.max_dispatch_time ?? null,
      driver_radius_km: c.driver_radius ?? 20,
      max_orders_per_driver: c.max_orders ?? null,
      sla_enabled: (c.timer_config as Record<string, unknown>)?.isEnabled ?? false,
      busy_settings_enabled: c.busySettings ?? false,
      max_rejected_before_busy: c.maxRejectedOrders ?? null,
    }));

    result = {
      cities_count: formatted.length,
      cities: formatted,
      summary: `${formatted.length} cities found. ${formatted.filter((c) => c.auto_dispatch).length} have auto-dispatch ON. ${formatted.filter((c) => c.sla_enabled).length} have SLA timers enabled.`,
    };
  }

  const executionTime = Date.now() - start;
  logQuery({
    tool: "city_config_lookup",
    params,
    query: `db.cities.find(${JSON.stringify(filter)})`,
    execution_time_ms: executionTime,
    result_count: cities.length,
  });

  return wrapToolResponse(result, {
    query: `db.cities.find(${JSON.stringify(filter)})`,
    collection: "cities",
    execution_time_ms: executionTime,
    result_count: cities.length,
  });
}
