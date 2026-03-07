import { z } from "zod";
import { Order } from "../../schemas/order.schema.js";
import { Driver } from "../../schemas/driver.schema.js";
import { Restaurant } from "../../schemas/restaurant.schema.js";
import { wrapToolResponse, formatAggregation } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import {
  ORDER_STATUS,
  ORDER_STATUS_LABELS,
} from "../../constants/order-status.js";

export const shiftReportSchema = z.object({
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
  hours: z
    .number()
    .default(8)
    .describe("OPTIONAL. Report window in hours (default 8)."),
});

export type ShiftReportInput = z.infer<typeof shiftReportSchema>;

export async function getShiftReport(params: ShiftReportInput) {
  const start = Date.now();
  const sinceDate = new Date(Date.now() - params.hours * 3600 * 1000);

  const match: Record<string, unknown> = {
    createdAt: { $gte: sinceDate },
  };
  if (params.country_code) match.country_code = params.country_code;
  if (params.city) match.main_city = params.city;

  // --- Orders Summary ---
  const ordersPipeline = [
    { $match: match },
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 },
      },
    },
  ];

  const ordersByStatus = await Order.aggregate(ordersPipeline);

  const statusMap: Record<number, number> = {};
  let totalOrders = 0;
  for (const entry of ordersByStatus) {
    statusMap[entry._id] = entry.count;
    totalOrders += entry.count;
  }

  const ordersReceived = statusMap[ORDER_STATUS.ORDER_RECEIVED] ?? 0;
  const ordersDelivered = statusMap[ORDER_STATUS.ORDER_DELIVERED] ?? 0;
  const ordersTimedOut = statusMap[ORDER_STATUS.ORDER_TIMEOUT] ?? 0;
  const ordersCancelledUser = statusMap[ORDER_STATUS.CANCELLED_BY_USER] ?? 0;
  const ordersCancelledAdmin = statusMap[ORDER_STATUS.CANCELLED_BY_ADMIN] ?? 0;
  const ordersRejected = statusMap[ORDER_STATUS.RESTAURANT_REJECTED_ORDER] ?? 0;
  const ordersCancelledAfterPickup =
    statusMap[ORDER_STATUS.CANCELLED_AFTER_PICKUP] ?? 0;

  const deliveryRate =
    totalOrders > 0
      ? Math.round((ordersDelivered / totalOrders) * 1000) / 10
      : 0;
  const timeoutRate =
    totalOrders > 0
      ? Math.round((ordersTimedOut / totalOrders) * 1000) / 10
      : 0;

  // --- Rejection analysis ---
  const rejectionPipeline = [
    {
      $match: {
        ...match,
        "rejectedDriversList.0": { $exists: true },
      },
    },
    {
      $group: {
        _id: null,
        total_orders_with_rejections: { $sum: 1 },
        total_rejections: {
          $sum: { $size: { $ifNull: ["$rejectedDriversList", []] } },
        },
      },
    },
  ];

  const rejectionData = await Order.aggregate(rejectionPipeline);
  const rejectionStats = rejectionData[0] || {
    total_orders_with_rejections: 0,
    total_rejections: 0,
  };

  // --- Restaurant performance ---
  const restaurantPipeline = [
    { $match: match },
    {
      $group: {
        _id: "$restaurant_id",
        total: { $sum: 1 },
        rejected: {
          $sum: {
            $cond: [{ $in: ["$status", [2, 11]] }, 1, 0],
          },
        },
      },
    },
    {
      $addFields: {
        rejection_rate: {
          $cond: [
            { $gt: ["$total", 0] },
            {
              $round: [
                { $multiply: [{ $divide: ["$rejected", "$total"] }, 100] },
                1,
              ],
            },
            0,
          ],
        },
      },
    },
    { $sort: { rejection_rate: -1 as const } },
    { $limit: 5 },
  ];

  const worstRestaurants = await Order.aggregate(restaurantPipeline);

  const restIds = worstRestaurants.map((r) => r._id);
  const restInfo = await Restaurant.find(
    { _id: { $in: restIds } },
    { restaurantname: 1, restaurantAvailability: 1 },
  ).lean();
  const restMap = new Map(restInfo.map((r) => [r._id.toString(), r]));

  // --- Fleet snapshot ---
  const freshThreshold = Date.now() - 300_000;
  const driverFilter: Record<string, unknown> = {
    status: 1,
  };
  if (params.country_code)
    driverFilter["address.country_code"] = params.country_code;
  if (params.city) driverFilter["address.city"] = params.city;

  const [onlineNow, totalDrivers] = await Promise.all([
    Driver.countDocuments({
      ...driverFilter,
      currentStatus: 1,
      logout: 0,
      last_update_time: { $gte: freshThreshold },
    }),
    Driver.countDocuments(driverFilter),
  ]);

  // --- Auto-busy count ---
  const restFilter: Record<string, unknown> = {
    "restaurantAvailability.isBusy": true,
  };
  if (params.country_code)
    restFilter["address.country_code"] = params.country_code;
  if (params.city) restFilter["address.city"] = params.city;

  const autoBusyCount = await Restaurant.countDocuments(restFilter);

  const executionTime = Date.now() - start;

  logQuery({
    tool: "shift_report",
    params,
    query: formatAggregation("orders", ordersPipeline),
    execution_time_ms: executionTime,
    result_count: totalOrders,
  });

  return wrapToolResponse(
    {
      period: {
        from: sinceDate.toISOString(),
        to: new Date().toISOString(),
        hours: params.hours,
      },
      orders: {
        total: totalOrders,
        received_pending: ordersReceived,
        delivered: ordersDelivered,
        timed_out: ordersTimedOut,
        cancelled_by_user: ordersCancelledUser,
        cancelled_by_admin: ordersCancelledAdmin,
        restaurant_rejected: ordersRejected,
        cancelled_after_pickup: ordersCancelledAfterPickup,
        delivery_rate_pct: deliveryRate,
        timeout_rate_pct: timeoutRate,
        status_breakdown: ordersByStatus.map((s) => ({
          status: s._id,
          label: ORDER_STATUS_LABELS[s._id] || `Unknown(${s._id})`,
          count: s.count,
        })),
      },
      dispatch: {
        orders_with_rejections: rejectionStats.total_orders_with_rejections,
        total_driver_rejections: rejectionStats.total_rejections,
        avg_rejections_per_rejected_order:
          rejectionStats.total_orders_with_rejections > 0
            ? Math.round(
                (rejectionStats.total_rejections /
                  rejectionStats.total_orders_with_rejections) *
                  10,
              ) / 10
            : 0,
      },
      fleet: {
        drivers_online_now: onlineNow,
        total_registered_drivers: totalDrivers,
      },
      restaurants: {
        currently_auto_busy: autoBusyCount,
        worst_performers: worstRestaurants.map((r) => {
          const info = restMap.get(r._id?.toString());
          return {
            restaurant_id: r._id?.toString(),
            name: info?.restaurantname ?? "Unknown",
            total_orders: r.total,
            rejected: r.rejected,
            rejection_rate: r.rejection_rate,
          };
        }),
      },
      summary: `Shift report for ${params.country_code}${params.city ? ` / ${params.city}` : ""} (last ${params.hours}h): ${totalOrders} orders — ${ordersDelivered} delivered (${deliveryRate}%), ${ordersTimedOut} timed out (${timeoutRate}%), ${ordersCancelledUser + ordersCancelledAdmin} cancelled. Fleet: ${onlineNow} online now. ${autoBusyCount} restaurants auto-busy. ${rejectionStats.total_rejections} driver rejections across ${rejectionStats.total_orders_with_rejections} orders.`,
    },
    {
      query: formatAggregation("orders", ordersPipeline),
      collection: "orders + drivers + restaurant",
      execution_time_ms: executionTime,
      result_count: totalOrders,
    },
  );
}
