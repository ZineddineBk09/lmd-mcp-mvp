import { z } from "zod";
import mongoose from "mongoose";
import { Order } from "../../schemas/order.schema.js";
import { wrapToolResponse } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import { ORDER_STATUS_LABELS } from "../../constants/order-status.js";
import { getCurrencyForCountry } from "../../utils/currency.js";

export const lookupOrderSchema = z.object({
  order_id: z
    .string()
    .describe(
      "REQUIRED. The order's MongoDB _id (24-char hex string). Use this to look up a single order.",
    ),
});

export type LookupOrderInput = z.infer<typeof lookupOrderSchema>;

function buildTimeline(
  history: Record<string, unknown>,
  createdAt: Date,
): Array<{ event: string; time: string; minutes_from_start: number }> {
  const entries: Array<{ event: string; time: Date; sortKey: number }> = [
    { event: "Order placed", time: createdAt, sortKey: 0 },
  ];

  const eventMap: Record<string, [string, number]> = {
    restaurant_accepted: ["Restaurant accepted", 1],
    restaurant_rejected: ["Restaurant rejected", 1],
    driver_accepted: ["Driver accepted", 2],
    driver_confirmed: ["Driver confirmed", 2.5],
    driver_at_restaurant: ["Driver at restaurant", 3],
    driver_pickedup: ["Driver picked up", 4],
    driver_at_client: ["Driver at client", 5],
    food_delivered: ["Delivered", 6],
  };

  for (const [key, [label, sort]] of Object.entries(eventMap)) {
    if (history[key]) {
      entries.push({
        event: label,
        time: new Date(history[key] as Date),
        sortKey: sort,
      });
    }
  }

  return entries
    .sort((a, b) => a.sortKey - b.sortKey)
    .map((e) => ({
      event: e.event,
      time: e.time.toISOString(),
      minutes_from_start: Math.round(
        (e.time.getTime() - createdAt.getTime()) / 60000,
      ),
    }));
}

export async function lookupOrder(params: LookupOrderInput) {
  const start = Date.now();

  let objectId: mongoose.Types.ObjectId;
  try {
    objectId = new mongoose.Types.ObjectId(params.order_id);
  } catch {
    return wrapToolResponse(
      {
        error: `Invalid order_id format: "${params.order_id}". Must be a 24-character hex string.`,
      },
      { query: "N/A", execution_time_ms: 0, result_count: 0 },
    );
  }

  const order = await Order.findById(objectId).lean();
  if (!order) {
    return wrapToolResponse(
      { error: `Order not found: ${params.order_id}` },
      {
        query: `db.orders.findById("${params.order_id}")`,
        execution_time_ms: Date.now() - start,
        result_count: 0,
      },
    );
  }

  const raw = order as Record<string, unknown>;
  const history = (raw.order_history ?? {}) as Record<string, unknown>;
  const billings = (raw.billings ?? {}) as Record<string, unknown>;
  const amounts = (billings.amount ?? {}) as Record<string, unknown>;
  const epay = (billings.epay ?? {}) as Record<string, unknown>;
  const user = (raw.user ?? {}) as Record<string, unknown>;
  const userPhone = (user.phone ?? {}) as Record<string, unknown>;
  const userAddr = (user.address ?? {}) as Record<string, unknown>;
  const rest = (raw.restaurant ?? {}) as Record<string, unknown>;
  const restPhone = (rest.phone ?? {}) as Record<string, unknown>;
  const driverEmbed = (raw.driver ?? {}) as Record<string, unknown>;
  const driverPhone = (driverEmbed.phone ?? {}) as Record<string, unknown>;
  const foods = (raw.foods ?? []) as Array<Record<string, unknown>>;
  const rejectedList = (raw.rejectedDriversList ?? []) as unknown[];
  const deliveryAddr = (raw.delivery_address ?? raw.location ?? {}) as Record<
    string,
    unknown
  >;
  const createdAt = new Date(raw.createdAt as Date);

  const statusLabel =
    ORDER_STATUS_LABELS[raw.status as number] ?? `Unknown(${raw.status})`;
  const timeline = buildTimeline(history, createdAt);

  if (!raw.currency_symbol && raw.country_code) {
    const cur = await getCurrencyForCountry(raw.country_code as string);
    raw.currency_symbol = cur.currency_symbol;
  }

  const deliveredAt = history.food_delivered as Date | undefined;
  const deliveryMinutes = deliveredAt
    ? Math.round(
        (new Date(deliveredAt).getTime() - createdAt.getTime()) / 60000,
      )
    : null;

  const resolveI18nName = (i18n: unknown): string | null => {
    if (!i18n || typeof i18n !== "object") return null;
    const map = i18n as Record<string, string>;
    return map.en ?? map.fr ?? map.ar ?? Object.values(map)[0] ?? null;
  };

  const foodItems = foods.slice(0, 20).map((f) => ({
    name: f.name ?? resolveI18nName(f.food_name_i18n) ?? null,
    quantity: f.quantity ?? 1,
    price: f.price ?? null,
    offer_price: f.offer_price ?? null,
    addons: Array.isArray(f.addons)
      ? f.addons.map((a: Record<string, unknown>) => ({
          name: a.name ?? resolveI18nName(a.addon_name_i18n) ?? null,
          price: a.price,
        }))
      : [],
  }));

  const result = {
    order_id: String(raw._id),
    order_number: raw.order_id ?? null,
    status: raw.status,
    status_label: statusLabel,
    country_code: raw.country_code,
    city: raw.main_city ?? null,
    sub_city: raw.sub_city ?? null,
    source: raw.source ?? null,
    app_version: raw.app_version ?? null,
    created_at: createdAt.toISOString(),
    is_scheduled: raw.is_scheduled ?? false,

    customer: {
      user_id: user._id
        ? String(user._id)
        : raw.user_id
          ? String(raw.user_id)
          : null,
      name: user.username ?? null,
      last_name: user.last_name ?? null,
      email: user.email ?? null,
      phone:
        userPhone.code && userPhone.number
          ? `${userPhone.code}${userPhone.number}`
          : null,
      yassir_id: user.yassir_id ?? null,
      address: userAddr.fulladres ?? null,
    },

    restaurant: {
      restaurant_id: rest._id
        ? String(rest._id)
        : raw.restaurant_id
          ? String(raw.restaurant_id)
          : null,
      name: rest.restaurantname ?? null,
      store_type: rest.store_type ?? null,
      phone:
        restPhone.code && restPhone.number
          ? `${restPhone.code}${restPhone.number}`
          : null,
      city: rest.main_city ?? null,
    },

    driver: raw.driver_id
      ? {
          driver_id: String(raw.driver_id),
          name: driverEmbed.username ?? null,
          phone:
            driverPhone.code && driverPhone.number
              ? `${driverPhone.code}${driverPhone.number}`
              : null,
        }
      : null,

    food_items: foodItems,
    food_items_count: foods.length,

    billing: {
      food_total: amounts.total ?? null,
      delivery_fee: amounts.delivery_amount ?? null,
      service_charge: amounts.service_charge ?? null,
      package_charge: amounts.package_charge ?? null,
      surge_fee: amounts.surge_fee ?? null,
      night_fee: amounts.night_fee ?? null,
      coupon_discount: amounts.coupon_discount ?? null,
      offer_discount: amounts.offer_discount ?? null,
      wallet_usage: amounts.wallet_usage ?? null,
      grand_total: amounts.grand_total ?? null,
      currency_symbol: (raw.currency_symbol as string) ?? null,
    },

    payment: {
      type: raw.payment_type ?? null,
      method: epay.method ?? null,
      status: (epay.status as Record<string, unknown>)?.current ?? null,
      transaction_id: epay.transaction_id ?? null,
    },

    coupon_code: raw.coupon_code ?? null,

    delivery: {
      address: (deliveryAddr as Record<string, unknown>).fulladres ?? null,
      pickup_distance_km: raw.pickup_distance ?? null,
      dropoff_distance_km: raw.deliver_distance ?? null,
      delivery_time_minutes: deliveryMinutes,
      ept_minutes: raw.ept ?? raw.estimated_preparation_time ?? null,
    },

    dispatch: {
      auto_dispatch: raw.auto_dispatch ?? false,
      rejected_drivers_count: rejectedList.length,
    },

    cancellation:
      raw.cancellation_comment || raw.cancellationreason
        ? {
            reason: raw.cancellation_comment ?? raw.cancellationreason ?? null,
            cancelled_role: raw.cancelled_role ?? null,
            cancelled_name: raw.cancelled_name ?? null,
          }
        : null,

    timeline,

    summary: [
      `Order ${String(raw._id).slice(-6)} — ${statusLabel}`,
      `${raw.country_code ?? "?"}/${raw.main_city ?? "?"}`,
      rest.restaurantname ? `Restaurant: ${rest.restaurantname}` : null,
      user.username
        ? `Customer: ${user.username}${user.last_name ? " " + user.last_name : ""} (${userPhone.code && userPhone.number ? `${userPhone.code}${userPhone.number}` : "no phone"})`
        : null,
      `${foods.length} item(s)`,
      amounts.grand_total != null
        ? `Total: ${amounts.grand_total} ${(raw.currency_symbol as string) ?? ""}`
        : null,
      raw.payment_type ? `Payment: ${raw.payment_type}` : null,
      rejectedList.length > 0
        ? `${rejectedList.length} driver rejections`
        : null,
      deliveryMinutes ? `Delivered in ${deliveryMinutes} min` : null,
    ]
      .filter(Boolean)
      .join(" | "),
  };

  const executionTime = Date.now() - start;
  logQuery({
    tool: "lookup_order",
    params,
    query: `db.orders.findById("${params.order_id}")`,
    execution_time_ms: executionTime,
    result_count: 1,
  });

  return wrapToolResponse(result, {
    query: `db.orders.findById("${params.order_id}")`,
    collection: "orders",
    execution_time_ms: executionTime,
    result_count: 1,
  });
}
