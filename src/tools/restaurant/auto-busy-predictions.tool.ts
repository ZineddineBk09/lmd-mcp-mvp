import { z } from "zod";
import { Order } from "../../schemas/order.schema.js";
import { Restaurant } from "../../schemas/restaurant.schema.js";
import { City } from "../../schemas/city.schema.js";
import { wrapToolResponse, formatAggregation } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import { ORDER_STATUS } from "../../constants/order-status.js";

export const autoBusyPredictionsSchema = z.object({
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

export type AutoBusyPredictionsInput = z.infer<
  typeof autoBusyPredictionsSchema
>;

export async function getAutoBusyPredictions(params: AutoBusyPredictionsInput) {
  const start = Date.now();

  const cityConfig = params.country_code
    ? await City.findOne({ country_code: params.country_code }).lean()
    : null;

  const maxRejectedOrders = cityConfig?.maxRejectedOrders || 5;
  const busySettings = cityConfig?.busySettings ?? false;
  const busyTime = cityConfig?.busyTime || 30;

  if (!busySettings) {
    return wrapToolResponse(
      {
        auto_busy_enabled: false,
        message: `Auto-busy feature is disabled for ${params.country_code ?? "all countries"}. busySettings=false in city config.`,
        at_risk: [],
        currently_busy: [],
      },
      {
        query: "City.findOne({country_code}).busySettings",
        collection: "cities",
        execution_time_ms: Date.now() - start,
        result_count: 0,
      },
    );
  }

  // Find active restaurants with recent orders
  const recentOrdersWindow = new Date(Date.now() - 2 * 3600 * 1000); // last 2h

  const restaurantFilter: Record<string, unknown> = {
    status: 1,
  };
  if (params.country_code)
    restaurantFilter["address.country_code"] = params.country_code;
  if (params.city) restaurantFilter["address.city"] = params.city;

  const activeRestaurants = await Restaurant.find(restaurantFilter, {
    _id: 1,
    restaurantname: 1,
    restaurantAvailability: 1,
    "address.city": 1,
  }).lean();

  const currentlyBusy = activeRestaurants.filter(
    (r) => r.restaurantAvailability?.isBusy,
  );

  // For non-busy restaurants, check consecutive rejections
  const nonBusyIds = activeRestaurants
    .filter((r) => !r.restaurantAvailability?.isBusy)
    .map((r) => r._id);

  const pipeline = [
    {
      $match: {
        restaurant_id: { $in: nonBusyIds },
        createdAt: { $gte: recentOrdersWindow },
      },
    },
    { $sort: { createdAt: -1 as const } },
    {
      $group: {
        _id: "$restaurant_id",
        recent_statuses: { $push: "$status" },
      },
    },
  ];

  const recentOrders = await Order.aggregate(pipeline);

  const atRisk: Array<{
    restaurant_id: string;
    name: string;
    city?: string;
    consecutive_rejections: number;
    threshold: number;
    rejections_until_busy: number;
  }> = [];

  const restaurantMap = new Map(
    activeRestaurants.map((r) => [r._id.toString(), r]),
  );

  for (const entry of recentOrders) {
    const statuses = entry.recent_statuses.slice(0, maxRejectedOrders);
    let consecutiveRejections = 0;

    for (const status of statuses) {
      if (
        status === ORDER_STATUS.RESTAURANT_REJECTED_ORDER ||
        status === ORDER_STATUS.ORDER_TIMEOUT
      ) {
        consecutiveRejections++;
      } else {
        break;
      }
    }

    if (consecutiveRejections >= maxRejectedOrders - 2) {
      const info = restaurantMap.get(entry._id?.toString());
      atRisk.push({
        restaurant_id: entry._id?.toString(),
        name: info?.restaurantname ?? "Unknown",
        city: info?.address?.city,
        consecutive_rejections: consecutiveRejections,
        threshold: maxRejectedOrders,
        rejections_until_busy: maxRejectedOrders - consecutiveRejections,
      });
    }
  }

  atRisk.sort((a, b) => a.rejections_until_busy - b.rejections_until_busy);

  const executionTime = Date.now() - start;

  logQuery({
    tool: "auto_busy_predictions",
    params,
    query: formatAggregation("orders", pipeline),
    execution_time_ms: executionTime,
    result_count: atRisk.length,
  });

  return wrapToolResponse(
    {
      auto_busy_enabled: true,
      threshold: maxRejectedOrders,
      busy_duration_minutes: busyTime,
      at_risk_restaurants: atRisk,
      at_risk_count: atRisk.length,
      currently_busy: currentlyBusy.map((r) => ({
        restaurant_id: r._id.toString(),
        name: r.restaurantname,
        city: r.address?.city,
        busy_until: r.restaurantAvailability?.busyUntil,
        is_post_rejection: r.restaurantAvailability?.isPostRejection,
      })),
      currently_busy_count: currentlyBusy.length,
      summary: `Auto-busy predictions for ${params.country_code}${params.city ? ` / ${params.city}` : ""}: ${atRisk.length} restaurants at risk (threshold: ${maxRejectedOrders} consecutive rejections). ${currentlyBusy.length} currently auto-busy. ${atRisk.filter((r) => r.rejections_until_busy <= 1).length} will trigger on next rejection.`,
    },
    {
      query: formatAggregation("orders", pipeline),
      collection: "orders + restaurant + cities",
      execution_time_ms: executionTime,
      result_count: atRisk.length,
    },
  );
}
