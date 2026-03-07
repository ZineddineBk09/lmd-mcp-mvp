import { z } from "zod";
import mongoose from "mongoose";
import { Restaurant } from "../../schemas/restaurant.schema.js";
import { Order } from "../../schemas/order.schema.js";
import { wrapToolResponse } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import {
  ORDER_STATUS_LABELS,
  ACTIVE_ORDER_STATUSES,
} from "../../constants/order-status.js";

export const lookupRestaurantSchema = z.object({
  restaurant_id: z
    .string()
    .optional()
    .describe(
      "MongoDB _id of the restaurant. Provide exactly one of restaurant_id or name.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "Restaurant name (partial match, case-insensitive). Provide exactly one of restaurant_id or name.",
    ),
});

export type LookupRestaurantInput = z.infer<typeof lookupRestaurantSchema>;

export async function lookupRestaurant(params: LookupRestaurantInput) {
  const start = Date.now();

  if (!params.restaurant_id && !params.name) {
    return wrapToolResponse(
      { error: "Provide at least one of: restaurant_id or name." },
      { query: "N/A", execution_time_ms: 0, result_count: 0 },
    );
  }

  const filter: Record<string, unknown> = {};
  if (params.restaurant_id) {
    try {
      filter._id = new mongoose.Types.ObjectId(params.restaurant_id);
    } catch {
      return wrapToolResponse(
        { error: `Invalid restaurant_id format: "${params.restaurant_id}"` },
        { query: "N/A", execution_time_ms: 0, result_count: 0 },
      );
    }
  } else if (params.name) {
    filter.restaurantname = { $regex: params.name, $options: "i" };
  }

  const restaurants = await Restaurant.find(filter)
    .limit(params.name ? 5 : 1)
    .lean();

  if (restaurants.length === 0) {
    const searchBy = params.restaurant_id || params.name;
    return wrapToolResponse(
      { error: `Restaurant not found for: ${searchBy}` },
      {
        query: `db.restaurant.find(${JSON.stringify(filter)})`,
        execution_time_ms: Date.now() - start,
        result_count: 0,
      },
    );
  }

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const allIds = restaurants.map(
    (r) => (r as Record<string, unknown>)._id as mongoose.Types.ObjectId,
  );

  // Batch: single aggregation for today's stats across all restaurants
  // Batch: single query for active orders across all restaurants
  // Batch: single count for food items across all restaurants
  const [activeOrdersBatch, todayStatsBatch, menuCountsBatch] =
    await Promise.all([
      Order.find(
        {
          restaurant_id: { $in: allIds },
          status: { $in: ACTIVE_ORDER_STATUSES },
        },
        { _id: 1, status: 1, createdAt: 1, restaurant_id: 1 },
      )
        .sort({ createdAt: -1 })
        .lean(),

      Order.aggregate([
        {
          $match: {
            restaurant_id: { $in: allIds },
            createdAt: { $gte: todayStart },
          },
        },
        {
          $group: {
            _id: "$restaurant_id",
            total: { $sum: 1 },
            delivered: { $sum: { $cond: [{ $eq: ["$status", 7] }, 1, 0] } },
            rejected_by_restaurant: {
              $sum: { $cond: [{ $eq: ["$status", 2] }, 1, 0] },
            },
            cancelled: {
              $sum: { $cond: [{ $in: ["$status", [9, 10, 90]] }, 1, 0] },
            },
            timed_out: { $sum: { $cond: [{ $eq: ["$status", 11] }, 1, 0] } },
          },
        },
      ]),

      mongoose.connection.db
        ? mongoose.connection.db
            .collection("food")
            .aggregate([
              { $match: { restaurant_id: { $in: allIds } } },
              { $group: { _id: "$restaurant_id", count: { $sum: 1 } } },
            ])
            .toArray()
        : [],
    ]);

  const activeByRestaurant = new Map<string, Array<Record<string, unknown>>>();
  for (const order of activeOrdersBatch) {
    const rid = String((order as Record<string, unknown>).restaurant_id);
    if (!activeByRestaurant.has(rid)) activeByRestaurant.set(rid, []);
    activeByRestaurant.get(rid)!.push(order as Record<string, unknown>);
  }

  const statsByRestaurant = new Map<string, Record<string, number>>();
  for (const s of todayStatsBatch) {
    statsByRestaurant.set(String(s._id), s);
  }

  const menuByRestaurant = new Map<string, number>();
  for (const m of menuCountsBatch) {
    menuByRestaurant.set(String(m._id), m.count);
  }

  const results = restaurants.map((doc) => {
    const raw = doc as Record<string, unknown>;
    const restId = raw._id as mongoose.Types.ObjectId;
    const restIdStr = String(restId);
    const availability = raw.restaurantAvailability as
      | Record<string, unknown>
      | undefined;
    const address = raw.address as Record<string, unknown> | undefined;
    const restPhone = (raw.phone ?? {}) as Record<string, unknown>;

    const activeOrders = activeByRestaurant.get(restIdStr) ?? [];
    const stats = statsByRestaurant.get(restIdStr) ?? {
      total: 0,
      delivered: 0,
      rejected_by_restaurant: 0,
      cancelled: 0,
      timed_out: 0,
    };
    const menuCount = menuByRestaurant.get(restIdStr) ?? 0;

    const acceptRate =
      stats.total > 0
        ? Math.round(
            ((stats.total - stats.rejected_by_restaurant) / stats.total) * 100,
          )
        : null;

    const isBusy = availability?.isBusy ?? false;
    const busyUntil = availability?.busyUntil ?? null;
    const isPostRejection = availability?.isPostRejection ?? false;

    let statusLabel = "online";
    if (raw.status === 0) statusLabel = "disabled";
    else if (isBusy)
      statusLabel = isPostRejection
        ? "auto-busy (rejections)"
        : "manually busy";

    return {
      restaurant_id: restIdStr,
      name: raw.restaurantname ?? null,
      email: raw.email ?? null,
      phone:
        restPhone.code && restPhone.number
          ? `${restPhone.code}${restPhone.number}`
          : null,
      status: raw.status,
      availability_label: statusLabel,
      is_busy: isBusy,
      busy_until: busyUntil,
      is_post_rejection_busy: isPostRejection,
      country_code: address?.country_code ?? null,
      main_city: raw.main_city ?? null,
      sub_city: raw.sub_city ?? null,
      address_city: address?.city ?? null,
      store_type: raw.store_type ?? null,
      avg_ratings: raw.avg_ratings ?? null,
      efp_time: raw.efp_time ?? null,
      efp_time2: raw.efp_time2 ?? null,
      minimum_cart: raw.minimum_cart ?? null,
      is_pickup: raw.isPickup ?? false,
      auto_accept_orders: raw.auto_accept_orders ?? false,
      menu_items: menuCount,
      lifetime_stats: {
        total_requests: raw.tot_req ?? 0,
        delivered: raw.deliverd ?? 0,
        cancelled: raw.cancelled ?? 0,
      },
      active_orders_count: activeOrders.length,
      active_orders: activeOrders.slice(0, 5).map((o) => ({
        _id: String(o._id),
        status: o.status,
        status_label:
          ORDER_STATUS_LABELS[o.status as number] ?? `Unknown(${o.status})`,
        created_at: o.createdAt,
      })),
      today_stats: {
        total_orders: stats.total,
        delivered: stats.delivered,
        rejected_by_restaurant: stats.rejected_by_restaurant,
        cancelled: stats.cancelled,
        timed_out: stats.timed_out,
        acceptance_rate_pct: acceptRate,
      },
      summary: `${raw.restaurantname ?? "?"} — ${statusLabel}. Today: ${stats.total} orders (${stats.delivered} delivered, ${stats.rejected_by_restaurant} rejected). ${activeOrders.length} active now. ${menuCount} menu items.`,
    };
  });

  const executionTime = Date.now() - start;
  logQuery({
    tool: "lookup_restaurant",
    params,
    query: `db.restaurant.find(${JSON.stringify(filter)}) (batched)`,
    execution_time_ms: executionTime,
    result_count: results.length,
  });

  return wrapToolResponse(
    results.length === 1
      ? results[0]
      : { restaurants: results, count: results.length },
    {
      query: `db.restaurant.find(...) + batched orders/food queries`,
      collection: "restaurant",
      execution_time_ms: executionTime,
      result_count: results.length,
    },
  );
}
