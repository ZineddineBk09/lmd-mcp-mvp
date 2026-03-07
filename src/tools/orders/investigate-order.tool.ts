import { z } from "zod";
import mongoose from "mongoose";
import { Order } from "../../schemas/order.schema.js";
import { Driver } from "../../schemas/driver.schema.js";
import { Restaurant } from "../../schemas/restaurant.schema.js";
import { City } from "../../schemas/city.schema.js";
import { wrapToolResponse } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";
import { ORDER_STATUS_LABELS } from "../../constants/order-status.js";

export const investigateOrderSchema = z.object({
  order_id: z
    .string()
    .describe(
      "REQUIRED. The order's MongoDB _id (24-char hex string). Investigates what happened and why.",
    ),
});

export type InvestigateOrderInput = z.infer<typeof investigateOrderSchema>;

interface TimelineEvent {
  time: string;
  event: string;
  detail?: string;
  duration_since_start_min?: number;
}

export async function investigateOrder(params: InvestigateOrderInput) {
  const start = Date.now();

  let objectId: mongoose.Types.ObjectId;
  try {
    objectId = new mongoose.Types.ObjectId(params.order_id);
  } catch {
    return wrapToolResponse(
      { error: `Invalid order_id: "${params.order_id}"` },
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
  const status = raw.status as number;
  const createdAt = new Date(raw.createdAt as Date);
  const rejectedList = (raw.rejectedDriversList ?? []) as unknown[];

  const [driverDoc, restaurantDoc, cityDoc] = await Promise.all([
    raw.driver_id
      ? Driver.findById(raw.driver_id, {
          username: 1,
          last_name: 1,
          currentStatus: 1,
          last_update_time: 1,
        }).lean()
      : null,
    raw.restaurant_id
      ? Restaurant.findById(raw.restaurant_id, {
          restaurantname: 1,
          status: 1,
          restaurantAvailability: 1,
        }).lean()
      : null,
    raw.main_city
      ? City.findOne(
          {
            $or: [{ state: raw.main_city }, { cityname: raw.main_city }],
            country_code: raw.country_code,
          },
          {
            max_dispatch_time: 1,
            timer_config: 1,
            dispatch_delay_time: 1,
            state: 1,
          },
        ).lean()
      : null,
  ]);

  const driver = driverDoc as Record<string, unknown> | null;
  const restaurant = restaurantDoc as Record<string, unknown> | null;
  const city = cityDoc as Record<string, unknown> | null;

  const timeline: TimelineEvent[] = [];
  const addEvent = (event: string, time: unknown, detail?: string) => {
    if (!time) return;
    const t = new Date(time as Date);
    const minsSinceStart = Math.round(
      (t.getTime() - createdAt.getTime()) / 60000,
    );
    timeline.push({
      time: t.toISOString(),
      event,
      detail,
      duration_since_start_min: minsSinceStart,
    });
  };

  addEvent("Order placed", raw.createdAt);
  addEvent("Restaurant accepted", history.restaurant_accepted);
  addEvent(
    "Restaurant rejected",
    history.restaurant_rejected,
    "Restaurant declined the order",
  );
  addEvent(
    "Driver accepted",
    history.driver_accepted,
    driver
      ? `Driver: ${[driver.username, driver.last_name].filter(Boolean).join(" ")}`
      : undefined,
  );
  addEvent("Driver at restaurant", history.driver_at_restaurant);
  addEvent("Driver picked up", history.driver_pickedup);
  addEvent("Driver at client", history.driver_at_client);
  addEvent("Delivered", history.food_delivered);

  timeline.sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
  );

  const findings: string[] = [];
  const statusLabel = ORDER_STATUS_LABELS[status] ?? `Unknown(${status})`;

  if (rejectedList.length > 0) {
    findings.push(
      `${rejectedList.length} drivers rejected this order before ${raw.driver_id ? "one accepted" : "it failed dispatch"}.`,
    );
  }

  if (rejectedList.length >= 5) {
    findings.push(
      `HIGH rejection count (${rejectedList.length}) suggests difficult pickup location, low driver payout, or restaurant too far.`,
    );
  }

  if (history.restaurant_rejected) {
    findings.push(
      "Restaurant rejected the order — check if menu was out of stock or restaurant was overloaded.",
    );
  }

  if (status === 11) {
    findings.push(
      "Order timed out — no driver accepted within the dispatch window.",
    );
    if (city) {
      const maxTime = (city as Record<string, unknown>).max_dispatch_time;
      findings.push(
        `City dispatch timeout is ${maxTime ?? "unknown"} minutes.`,
      );
    }
  }

  if (status === 9) findings.push("Cancelled by the customer.");
  if (status === 10) findings.push("Cancelled by admin/ops.");
  if (status === 90)
    findings.push(
      "Cancelled AFTER pickup — likely a delivery issue or customer dispute.",
    );

  if (history.driver_accepted && history.driver_at_restaurant) {
    const acceptTime = new Date(history.driver_accepted as Date).getTime();
    const atRestTime = new Date(history.driver_at_restaurant as Date).getTime();
    const travelMins = Math.round((atRestTime - acceptTime) / 60000);
    if (travelMins > 20) {
      findings.push(
        `Driver took ${travelMins} minutes to reach restaurant (expected <15 min). Possibly far away or traffic.`,
      );
    }
  }

  if (history.driver_at_restaurant && history.driver_pickedup) {
    const atRestTime = new Date(history.driver_at_restaurant as Date).getTime();
    const pickupTime = new Date(history.driver_pickedup as Date).getTime();
    const waitMins = Math.round((pickupTime - atRestTime) / 60000);
    if (waitMins > 15) {
      findings.push(
        `Driver waited ${waitMins} minutes at restaurant (expected <10 min). Restaurant may be slow to prepare.`,
      );
    }
  }

  if (history.food_delivered) {
    const totalMins = Math.round(
      (new Date(history.food_delivered as Date).getTime() -
        createdAt.getTime()) /
        60000,
    );
    const timerConfig = city?.timer_config as
      | Record<string, unknown>
      | undefined;
    const slaMin = timerConfig?.restaurantTimer as number | undefined;
    if (slaMin && totalMins > slaMin) {
      findings.push(
        `Total delivery time ${totalMins} min exceeded SLA of ${slaMin} min.`,
      );
    }
  }

  if (restaurant) {
    const avail = (restaurant as Record<string, unknown>)
      .restaurantAvailability as Record<string, unknown> | undefined;
    if (avail?.isBusy) {
      findings.push(
        `Restaurant is currently busy${avail.isPostRejection ? " (auto-busied due to rejections)" : ""}.`,
      );
    }
  }

  if (driver) {
    const lastUpdate = driver.last_update_time as number | undefined;
    if (lastUpdate) {
      const staleMins = Math.round((Date.now() - lastUpdate) / 60000);
      if (staleMins > 5) {
        findings.push(
          `Assigned driver's GPS is stale (${staleMins} min ago) — possible ghost driver.`,
        );
      }
    }
  }

  const rootCause =
    findings.length > 0 ? findings[0] : "No obvious issues detected.";

  const result = {
    order_id: params.order_id,
    status,
    status_label: statusLabel,
    country_code: raw.country_code,
    city: raw.main_city ?? null,
    created_at: raw.createdAt,
    timeline,
    driver: driver
      ? {
          id: String(driver._id),
          name:
            [driver.username, driver.last_name].filter(Boolean).join(" ") ||
            null,
        }
      : null,
    restaurant: restaurant
      ? {
          id: String((restaurant as Record<string, unknown>)._id),
          name: (restaurant as Record<string, unknown>).restaurantname,
        }
      : null,
    rejected_drivers_count: rejectedList.length,
    findings,
    root_cause: rootCause,
    summary: `Order ${params.order_id.slice(-6)} — ${statusLabel}. ${findings.length} findings. Root cause: ${rootCause}`,
  };

  const executionTime = Date.now() - start;
  logQuery({
    tool: "investigate_order",
    params,
    query: `order + driver + restaurant + city lookups for ${params.order_id}`,
    execution_time_ms: executionTime,
    result_count: 1,
  });

  return wrapToolResponse(result, {
    query: `RCA for order ${params.order_id}`,
    collection: "orders",
    execution_time_ms: executionTime,
    result_count: 1,
  });
}
