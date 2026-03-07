import { z } from "zod";
import { Order } from "../../schemas/order.schema.js";
import { City } from "../../schemas/city.schema.js";
import { wrapToolResponse, formatAggregation } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import {
  ORDER_STATUS,
  ORDER_STATUS_LABELS,
  ACTIVE_ORDER_STATUSES,
} from "../../constants/order-status.js";

const DEFAULT_SLA_MINUTES = 25; // ORDER_ETA_FALLBACK_MINUTES

export const orderSlaSchema = z.object({
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
  limit: z.number().default(50).describe("OPTIONAL. Max results (default 50)."),
});

export type OrderSlaInput = z.infer<typeof orderSlaSchema>;

export async function getOrderSlaStatus(params: OrderSlaInput) {
  const start = Date.now();

  const cityConfigs = await City.find(
    params.country_code ? { country_code: params.country_code } : {},
    { timer_config: 1, cityname: 1, state: 1 },
  ).lean();

  const timerEnabled = cityConfigs.some((c) => c.timer_config?.isEnabled);
  const slaMinutes = timerEnabled
    ? Math.max(
        ...cityConfigs.map(
          (c) => c.timer_config?.storeTimer || DEFAULT_SLA_MINUTES,
        ),
      )
    : DEFAULT_SLA_MINUTES;

  const match: Record<string, unknown> = {
    status: { $in: [...ACTIVE_ORDER_STATUSES] },
  };
  if (params.country_code) match.country_code = params.country_code;

  if (params.city) {
    match.main_city = params.city;
  }

  const pipeline = [
    { $match: match },
    {
      $addFields: {
        total_age_minutes: {
          $dateDiff: {
            startDate: "$createdAt",
            endDate: "$$NOW",
            unit: "minute",
          },
        },
        sla_threshold: slaMinutes,
        sla_pct: {
          $multiply: [
            {
              $divide: [
                {
                  $dateDiff: {
                    startDate: "$createdAt",
                    endDate: "$$NOW",
                    unit: "minute",
                  },
                },
                slaMinutes,
              ],
            },
            100,
          ],
        },
      },
    },
    {
      $addFields: {
        sla_status: {
          $cond: [
            { $gte: ["$sla_pct", 100] },
            "BREACHED",
            { $cond: [{ $gte: ["$sla_pct", 80] }, "AT_RISK", "HEALTHY"] },
          ],
        },
      },
    },
    {
      $project: {
        _id: 1,
        status: 1,
        createdAt: 1,
        main_city: 1,
        driver_id: 1,
        restaurant_id: 1,
        total_age_minutes: 1,
        sla_pct: 1,
        sla_status: 1,
        order_history: 1,
      },
    },
    { $sort: { sla_pct: -1 as const } },
    { $limit: params.limit },
  ];

  const orders = await Order.aggregate(pipeline);

  const breached = orders.filter((o) => o.sla_status === "BREACHED");
  const atRisk = orders.filter((o) => o.sla_status === "AT_RISK");
  const healthy = orders.filter((o) => o.sla_status === "HEALTHY");

  const totalActive = await Order.countDocuments(match);

  const executionTime = Date.now() - start;

  logQuery({
    tool: "get_order_sla_status",
    params,
    query: formatAggregation("orders", pipeline),
    execution_time_ms: executionTime,
    result_count: orders.length,
  });

  return wrapToolResponse(
    {
      sla_threshold_minutes: slaMinutes,
      timer_config_enabled: timerEnabled,
      total_active_orders: totalActive,
      breached: {
        count: breached.length,
        orders: breached.map((o) => ({
          _id: o._id.toString(),
          status_label: ORDER_STATUS_LABELS[o.status],
          city: o.main_city,
          age_minutes: Math.round(o.total_age_minutes),
          sla_pct: Math.round(o.sla_pct),
        })),
      },
      at_risk: {
        count: atRisk.length,
        orders: atRisk.map((o) => ({
          _id: o._id.toString(),
          status_label: ORDER_STATUS_LABELS[o.status],
          city: o.main_city,
          age_minutes: Math.round(o.total_age_minutes),
          sla_pct: Math.round(o.sla_pct),
        })),
      },
      healthy_count: healthy.length,
      health_pct:
        totalActive > 0
          ? Math.round(((totalActive - breached.length) / totalActive) * 100)
          : 100,
      summary: `SLA status for ${params.country_code}${params.city ? ` / ${params.city}` : ""}: ${breached.length} breached, ${atRisk.length} at risk, ${healthy.length} healthy out of ${totalActive} active orders (threshold: ${slaMinutes} min). Health: ${totalActive > 0 ? Math.round(((totalActive - breached.length) / totalActive) * 100) : 100}%.`,
    },
    {
      query: formatAggregation("orders", pipeline),
      collection: "orders",
      execution_time_ms: executionTime,
      result_count: orders.length,
    },
  );
}
