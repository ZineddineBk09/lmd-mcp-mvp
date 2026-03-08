import { z } from "zod";
import mongoose from "mongoose";
import { Order } from "../../schemas/order.schema.js";
import { wrapToolResponse } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import { ORDER_STATUS_LABELS } from "../../constants/order-status.js";
import { getCurrencyForCountry } from "../../utils/currency.js";

export const lookupUserSchema = z.object({
  phone: z
    .string()
    .optional()
    .describe(
      "Phone number (e.g. +213666666666). Provide exactly one of phone, email, user_id, or name.",
    ),
  email: z
    .string()
    .optional()
    .describe(
      "Email address. Provide exactly one of phone, email, user_id, or name.",
    ),
  user_id: z
    .string()
    .optional()
    .describe(
      "MongoDB _id of the user. Provide exactly one of phone, email, user_id, or name.",
    ),
  name: z
    .string()
    .optional()
    .describe(
      "User's name or username (partial match, case-insensitive). Provide exactly one of phone, email, user_id, or name.",
    ),
});

export type LookupUserInput = z.infer<typeof lookupUserSchema>;

export async function lookupUser(params: LookupUserInput) {
  const start = Date.now();

  if (!params.phone && !params.email && !params.user_id && !params.name) {
    return wrapToolResponse(
      { error: "Provide at least one of: phone, email, user_id, or name." },
      { query: "N/A", execution_time_ms: 0, result_count: 0 },
    );
  }

  const db = mongoose.connection.db;
  if (!db) {
    return wrapToolResponse(
      { error: "Database not connected" },
      { query: "N/A", execution_time_ms: 0, result_count: 0 },
    );
  }

  const usersCol = db.collection("users");

  const userFilter: Record<string, unknown> = {};
  let isNameSearch = false;

  if (params.user_id) {
    try {
      userFilter._id = new mongoose.Types.ObjectId(params.user_id);
    } catch {
      return wrapToolResponse(
        { error: `Invalid user_id format: "${params.user_id}"` },
        { query: "N/A", execution_time_ms: 0, result_count: 0 },
      );
    }
  } else if (params.phone) {
    const phone = params.phone.replace(/\s+/g, "");
    userFilter.$or = [
      { full_phone: phone },
      { full_phone: { $regex: phone.replace(/^\+/, ""), $options: "i" } },
      { "phone.number": phone },
      { "phone.number": phone.replace(/^\+\d{1,3}/, "") },
    ];
  } else if (params.email) {
    userFilter.email = params.email.toLowerCase();
  } else if (params.name) {
    isNameSearch = true;
    const nameRegex = { $regex: params.name, $options: "i" };
    userFilter.$or = [
      { username: nameRegex },
      { first_name: nameRegex },
      { last_name: nameRegex },
      { full_name: nameRegex },
    ];
  }

  const safeProjection = { password: 0, otp: 0, card_details: 0 };

  const user = isNameSearch
    ? await usersCol.findOne(userFilter, {
        projection: safeProjection,
        sort: { createdAt: -1 },
      } as Record<string, unknown>)
    : await usersCol.findOne(userFilter, {
        projection: safeProjection,
      });

  if (!user) {
    const searchBy =
      params.phone || params.email || params.user_id || params.name;
    return wrapToolResponse(
      { error: `User not found for: ${searchBy}` },
      {
        query: `db.users.findOne(${JSON.stringify(userFilter)})`,
        execution_time_ms: Date.now() - start,
        result_count: 0,
      },
    );
  }

  const userId = user._id;

  const [recentOrders, orderStats, activeCart] = await Promise.all([
    Order.find(
      { $or: [{ user_id: userId }, { "user._id": userId }] },
      {
        order_id: 1,
        status: 1,
        createdAt: 1,
        main_city: 1,
        country_code: 1,
        currency_symbol: 1,
        "billings.amount.grand_total": 1,
        restaurant_id: 1,
        "restaurant.restaurantname": 1,
        payment_type: 1,
      },
    )
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),

    Order.aggregate([
      { $match: { $or: [{ user_id: userId }, { "user._id": userId }] } },
      {
        $group: {
          _id: null,
          total_orders: { $sum: 1 },
          active: {
            $sum: { $cond: [{ $in: ["$status", [1, 3, 5, 6, 17]] }, 1, 0] },
          },
          delivered: { $sum: { $cond: [{ $eq: ["$status", 7] }, 1, 0] } },
          cancelled: {
            $sum: { $cond: [{ $in: ["$status", [9, 10, 90]] }, 1, 0] },
          },
          rejected: { $sum: { $cond: [{ $eq: ["$status", 2] }, 1, 0] } },
          timed_out: { $sum: { $cond: [{ $eq: ["$status", 11] }, 1, 0] } },
        },
      },
    ]),

    db.collection("cartv2").findOne(
      { user_id: userId },
      {
        projection: {
          cart_details: 1,
          total_ttc: 1,
          sub_total: 1,
          restaurant_id: 1,
          updatedAt: 1,
        },
      },
    ),
  ]);

  const stats = orderStats[0] ?? {
    total_orders: 0,
    active: 0,
    delivered: 0,
    cancelled: 0,
    rejected: 0,
    timed_out: 0,
  };

  const userPhone = (user.phone ?? {}) as Record<string, unknown>;
  const userAddress = (user.address ?? {}) as Record<string, unknown>;

  const userCountry = (userAddress.country_code as string) ?? null;
  const userCurrency = userCountry
    ? await getCurrencyForCountry(userCountry)
    : null;

  const result = {
    user_id: String(userId),
    username: user.username ?? null,
    first_name: user.first_name ?? null,
    last_name: user.last_name ?? null,
    full_name: user.full_name ?? null,
    phone:
      user.full_phone ??
      (userPhone.code && userPhone.number
        ? `${userPhone.code}${userPhone.number}`
        : null),
    email: user.email ?? null,
    yassir_id: user.yassir_id ?? null,
    country_code: userCountry,
    currency_code: userCurrency?.currency_code ?? null,
    currency_symbol: userCurrency?.currency_symbol ?? null,
    city: userAddress.city ?? null,
    status: user.status ?? null,
    avg_ratings: user.avg_ratings ?? null,
    created_at: user.createdAt ?? null,
    order_stats: {
      total: stats.total_orders,
      active: stats.active,
      delivered: stats.delivered,
      cancelled: stats.cancelled,
      rejected_by_restaurant: stats.rejected,
      timed_out: stats.timed_out,
    },
    recent_orders: recentOrders.map((o: Record<string, unknown>) => {
      const billings = (o.billings ?? {}) as Record<string, unknown>;
      const amounts = (billings.amount ?? {}) as Record<string, unknown>;
      const rest = (o.restaurant ?? {}) as Record<string, unknown>;
      return {
        _id: String(o._id),
        order_id: (o as Record<string, unknown>).order_id ?? null,
        status: o.status,
        status_label:
          ORDER_STATUS_LABELS[o.status as number] ?? `Unknown(${o.status})`,
        created_at: o.createdAt,
        city: o.main_city ?? null,
        country_code: o.country_code ?? null,
        currency_symbol: o.currency_symbol ?? null,
        restaurant: rest.restaurantname ?? null,
        grand_total: amounts.grand_total ?? null,
        payment_type: o.payment_type ?? null,
      };
    }),
    active_cart: activeCart
      ? {
          items_count: Array.isArray(activeCart.cart_details)
            ? activeCart.cart_details.length
            : 0,
          total: activeCart.total_ttc ?? activeCart.sub_total ?? null,
          restaurant_id: activeCart.restaurant_id
            ? String(activeCart.restaurant_id)
            : null,
          updated_at: activeCart.updatedAt ?? null,
        }
      : null,
    summary: `${user.username ?? user.full_name ?? String(userId).slice(-6)} | Phone: ${user.full_phone ?? (userPhone.code && userPhone.number ? `${userPhone.code}${userPhone.number}` : "N/A")} | ${stats.total_orders} orders (${stats.active} active, ${stats.delivered} delivered, ${stats.cancelled} cancelled, ${stats.rejected} rejected, ${stats.timed_out} timed out). ${activeCart ? "Has active cart." : "No active cart."}`,
  };

  const executionTime = Date.now() - start;
  logQuery({
    tool: "lookup_user",
    params: { ...params, user_id: params.user_id ?? String(userId) },
    query: `db.users.findOne(${JSON.stringify(userFilter)})`,
    execution_time_ms: executionTime,
    result_count: 1,
  });

  return wrapToolResponse(result, {
    query: `db.users.findOne(...) + orders aggregation + cartv2 lookup`,
    collection: "users",
    execution_time_ms: executionTime,
    result_count: 1,
  });
}
