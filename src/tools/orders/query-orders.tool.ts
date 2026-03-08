import { z } from "zod";
import { Order } from "../../schemas/order.schema.js";
import { wrapToolResponse, formatAggregation } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import { ORDER_STATUS_LABELS } from "../../constants/order-status.js";

export const queryOrdersSchema = z.object({
  country_code: z
    .string()
    .optional()
    .describe(
      "OPTIONAL. Country code: DZ, MA, TN, FR, SN, ZA, etc. Omit to search all countries.",
    ),
  city: z
    .string()
    .optional()
    .describe(
      "OPTIONAL. City name (main_city). Omit to query the entire country.",
    ),
  status: z
    .preprocess((val) => {
      if (val == null) return undefined;
      if (Array.isArray(val)) return val.map(Number);
      return [Number(val)];
    }, z.array(z.number()).optional())
    .describe(
      "OPTIONAL. Filter by status codes. For ACTIVE orders use [1,3,5,6,17]. For DELIVERED use [7]. For CANCELLED use [9,10]. All codes: 1=received, 2=restaurant_rejected, 3=restaurant_accepted, 5=driver_accepted, 6=driver_at_restaurant, 7=delivered, 9=cancelled_user, 10=cancelled_admin, 11=timeout, 17=driver_picked_up, 90=cancelled_after_pickup. Omit to get all statuses.",
    ),
  since_minutes: z
    .number()
    .optional()
    .describe(
      "OPTIONAL. Only orders created in the last N minutes. Omit for no time filter.",
    ),
  restaurant_id: z
    .string()
    .optional()
    .describe("OPTIONAL. Filter by specific restaurant ObjectId."),
  limit: z.number().default(25).describe("OPTIONAL. Max results (default 25)."),
});

export type QueryOrdersInput = z.infer<typeof queryOrdersSchema>;

export async function queryOrders(params: QueryOrdersInput) {
  const start = Date.now();

  const match: Record<string, unknown> = {};
  if (params.country_code) match.country_code = params.country_code;

  if (params.status && params.status.length > 0) {
    match.status = { $in: params.status };
  }

  if (params.city) {
    match.main_city = params.city;
  }

  if (params.since_minutes) {
    const sinceDate = new Date(Date.now() - params.since_minutes * 60 * 1000);
    match.createdAt = { $gte: sinceDate };
  }

  if (params.restaurant_id) {
    const mongoose = await import("mongoose");
    match.restaurant_id = new mongoose.Types.ObjectId(params.restaurant_id);
  }

  const pipeline = [
    { $match: match },
    {
      $project: {
        _id: 1,
        order_id: 1,
        status: 1,
        createdAt: 1,
        updatedAt: 1,
        main_city: 1,
        sub_city: 1,
        country_code: 1,
        driver_id: 1,
        restaurant_id: 1,
        rejectedDriversList: 1,
        order_history: 1,
        ept: 1,
      },
    },
    { $sort: { createdAt: -1 as const } },
    { $limit: params.limit },
  ];

  const orders = await Order.aggregate(pipeline);

  const statusBreakdown: Record<string, number> = {};
  for (const order of orders) {
    const label =
      ORDER_STATUS_LABELS[order.status] || `Unknown(${order.status})`;
    statusBreakdown[label] = (statusBreakdown[label] || 0) + 1;
  }

  const totalCount = await Order.countDocuments(match);

  const executionTime = Date.now() - start;

  logQuery({
    tool: "query_orders",
    params,
    query: formatAggregation("orders", pipeline),
    execution_time_ms: executionTime,
    result_count: orders.length,
  });

  return wrapToolResponse(
    {
      orders: orders.map((o) => ({
        _id: o._id.toString(),
        order_id: o.order_id ?? null,
        status: o.status,
        status_label: ORDER_STATUS_LABELS[o.status] || `Unknown(${o.status})`,
        created_at: o.createdAt,
        updated_at: o.updatedAt,
        country_code: o.country_code ?? null,
        city: o.main_city,
        driver_id: o.driver_id?.toString() ?? null,
        restaurant_id: o.restaurant_id?.toString() ?? null,
        rejected_drivers_count: o.rejectedDriversList?.length ?? 0,
        order_history: o.order_history,
      })),
      total_matching: totalCount,
      returned: orders.length,
      status_breakdown: statusBreakdown,
      summary: `Found ${totalCount} orders matching filters in ${params.country_code}${params.city ? ` / ${params.city}` : ""}. Returned top ${orders.length}.`,
    },
    {
      query: formatAggregation("orders", pipeline),
      collection: "orders",
      execution_time_ms: executionTime,
      result_count: totalCount,
    },
  );
}
