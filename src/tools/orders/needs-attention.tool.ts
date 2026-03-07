import { z } from "zod";
import { Order } from "../../schemas/order.schema.js";
import { wrapToolResponse, formatAggregation } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import { ORDER_STATUS, ORDER_STATUS_LABELS } from "../../constants/order-status.js";

export const needsAttentionSchema = z.object({
  country_code: z.string().optional().describe("OPTIONAL. Country code: DZ, MA, TN, or CI. Omit to search all countries."),
  city: z.string().optional().describe("OPTIONAL. City name. Omit for entire country."),
  unassigned_threshold_minutes: z
    .number()
    .default(5)
    .describe("OPTIONAL. Minutes threshold for unassigned orders (default 5)."),
  pickup_threshold_minutes: z
    .number()
    .default(20)
    .describe("OPTIONAL. Minutes threshold for pickup delay (default 20)."),
  limit: z.number().default(30).describe("OPTIONAL. Max results (default 30)."),
});

export type NeedsAttentionInput = z.infer<typeof needsAttentionSchema>;

export async function getNeedsAttention(params: NeedsAttentionInput) {
  const start = Date.now();

  const baseMatch: Record<string, unknown> = {
    status: {
      $in: [
        ORDER_STATUS.RESTAURANT_ACCEPTED,
        ORDER_STATUS.DRIVER_REJECTED,
        ORDER_STATUS.DRIVER_ACCEPTED,
        ORDER_STATUS.DRIVER_AT_RESTAURANT,
      ],
    },
  };
  if (params.country_code) baseMatch.country_code = params.country_code;
  if (params.city) {
    baseMatch.main_city = params.city;
  }

  const unassignedPipeline = [
    { $match: baseMatch },
    {
      $addFields: {
        minutes_waiting: {
          $dateDiff: {
            startDate: "$createdAt",
            endDate: "$$NOW",
            unit: "minute",
          },
        },
        has_driver: {
          $cond: [
            { $ifNull: ["$order_history.driver_accepted", false] },
            true,
            false,
          ],
        },
      },
    },
    {
      $match: {
        has_driver: false,
        minutes_waiting: { $gt: params.unassigned_threshold_minutes },
      },
    },
    {
      $project: {
        _id: 1,
        status: 1,
        createdAt: 1,
        main_city: 1,
        restaurant_id: 1,
        rejectedDriversList: 1,
        minutes_waiting: 1,
      },
    },
    { $sort: { minutes_waiting: -1 as const } },
    { $limit: params.limit },
  ];

  const pickupDelayPipeline = [
    { $match: baseMatch },
    {
      $addFields: {
        has_driver: {
          $cond: [
            { $ifNull: ["$order_history.driver_accepted", false] },
            true,
            false,
          ],
        },
        has_pickup: {
          $cond: [
            { $ifNull: ["$order_history.driver_pickedup", false] },
            true,
            false,
          ],
        },
        minutes_since_accept: {
          $cond: [
            { $ifNull: ["$order_history.driver_accepted", false] },
            {
              $dateDiff: {
                startDate: "$order_history.driver_accepted",
                endDate: "$$NOW",
                unit: "minute",
              },
            },
            0,
          ],
        },
      },
    },
    {
      $match: {
        has_driver: true,
        has_pickup: false,
        minutes_since_accept: { $gt: params.pickup_threshold_minutes },
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
        minutes_since_accept: 1,
        order_history: 1,
      },
    },
    { $sort: { minutes_since_accept: -1 as const } },
    { $limit: params.limit },
  ];

  const [unassigned, pickupDelayed] = await Promise.all([
    Order.aggregate(unassignedPipeline),
    Order.aggregate(pickupDelayPipeline),
  ]);

  const executionTime = Date.now() - start;

  logQuery({
    tool: "get_needs_attention",
    params,
    query: formatAggregation("orders", unassignedPipeline),
    execution_time_ms: executionTime,
    result_count: unassigned.length + pickupDelayed.length,
  });

  return wrapToolResponse(
    {
      unassigned_orders: unassigned.map((o) => ({
        _id: o._id.toString(),
        status: o.status,
        status_label: ORDER_STATUS_LABELS[o.status],
        city: o.main_city,
        minutes_waiting: o.minutes_waiting,
        rejected_drivers_count: o.rejectedDriversList?.length ?? 0,
        restaurant_id: o.restaurant_id?.toString(),
      })),
      pickup_delayed_orders: pickupDelayed.map((o) => ({
        _id: o._id.toString(),
        status: o.status,
        status_label: ORDER_STATUS_LABELS[o.status],
        city: o.main_city,
        minutes_since_driver_accepted: o.minutes_since_accept,
        driver_id: o.driver_id?.toString(),
        restaurant_id: o.restaurant_id?.toString(),
      })),
      total_needs_attention: unassigned.length + pickupDelayed.length,
      unassigned_count: unassigned.length,
      pickup_delayed_count: pickupDelayed.length,
      thresholds: {
        unassigned_minutes: params.unassigned_threshold_minutes,
        pickup_minutes: params.pickup_threshold_minutes,
      },
      summary: `${unassigned.length + pickupDelayed.length} orders need attention in ${params.country_code}${params.city ? ` / ${params.city}` : ""}: ${unassigned.length} unassigned (>${params.unassigned_threshold_minutes} min), ${pickupDelayed.length} pickup delayed (>${params.pickup_threshold_minutes} min).`,
    },
    {
      query: formatAggregation("orders", unassignedPipeline),
      collection: "orders",
      execution_time_ms: executionTime,
      result_count: unassigned.length + pickupDelayed.length,
    }
  );
}
