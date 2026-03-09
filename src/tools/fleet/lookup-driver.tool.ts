import { z } from 'zod';
import mongoose from 'mongoose';
import { Driver } from '../../schemas/driver.schema.js';
import { Order } from '../../schemas/order.schema.js';
import { wrapToolResponse } from '../../utils/fact-check.js';
import { logQuery } from '../../utils/query-logger.js';
import { ORDER_STATUS_LABELS, ACTIVE_ORDER_STATUSES } from '../../constants/order-status.js';

export const lookupDriverSchema = z.object({
  driver_id: z.string().optional().describe('MongoDB _id of the driver. Provide exactly one of driver_id, phone, or username.'),
  phone: z.string().optional().describe('Driver phone number. Provide exactly one of driver_id, phone, or username.'),
  username: z.string().optional().describe('Driver username. Provide exactly one of driver_id, phone, or username.'),
});

export type LookupDriverInput = z.infer<typeof lookupDriverSchema>;

const DRIVER_STATUS_LABELS: Record<number, string> = {
  0: 'offline',
  1: 'online',
  2: 'busy',
};

export async function lookupDriver(params: LookupDriverInput) {
  const start = Date.now();

  if (!params.driver_id && !params.phone && !params.username) {
    return wrapToolResponse({ error: 'Provide at least one of: driver_id, phone, or username.' }, { query: 'N/A', execution_time_ms: 0, result_count: 0 });
  }

  const filter: Record<string, unknown> = {};
  if (params.driver_id) {
    try {
      filter._id = new mongoose.Types.ObjectId(params.driver_id);
    } catch {
      return wrapToolResponse({ error: `Invalid driver_id format: "${params.driver_id}"` }, { query: 'N/A', execution_time_ms: 0, result_count: 0 });
    }
  } else if (params.phone) {
    const phone = params.phone.replace(/\s+/g, '');
    filter.$or = [{ 'phone.number': phone }, { 'phone.number': phone.replace(/^\+\d{1,3}/, '') }];
  } else if (params.username) {
    filter.$or = [
      { username: { $regex: params.username, $options: 'i' } },
      { first_name: { $regex: params.username, $options: 'i' } },
      { last_name: { $regex: params.username, $options: 'i' } },
      { email: params.username.toLowerCase() },
    ];
  }

  const driver = await Driver.findOne(filter).lean();
  if (!driver) {
    const searchBy = params.driver_id || params.phone || params.username;
    return wrapToolResponse(
      { error: `Driver not found for: ${searchBy}` },
      {
        query: `db.drivers.findOne(${JSON.stringify(filter)})`,
        execution_time_ms: Date.now() - start,
        result_count: 0,
      },
    );
  }

  const raw = driver as Record<string, unknown>;
  const driverId = raw._id as mongoose.Types.ObjectId;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [activeOrders, todayStats] = await Promise.all([
    Order.find({ driver_id: driverId, status: { $in: ACTIVE_ORDER_STATUSES } }, { _id: 1, status: 1, main_city: 1, createdAt: 1, restaurant_id: 1 })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean(),

    Order.aggregate([
      { $match: { driver_id: driverId, createdAt: { $gte: todayStart } } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          delivered: { $sum: { $cond: [{ $eq: ['$status', 7] }, 1, 0] } },
          cancelled: {
            $sum: { $cond: [{ $in: ['$status', [9, 10, 90]] }, 1, 0] },
          },
        },
      },
    ]),
  ]);

  const rejectedToday = await Order.countDocuments({
    rejectedDriversList: driverId,
    createdAt: { $gte: todayStart },
  });

  const stats = todayStats[0] ?? { total: 0, delivered: 0, cancelled: 0 };
  const lastUpdate = raw.last_update_time as number | undefined;
  const gpsStaleMins = lastUpdate ? Math.round((Date.now() - lastUpdate) / 60000) : null;

  const address = raw.address as Record<string, unknown> | undefined;
  const currentOrders = raw.currentOrders as Record<string, unknown> | undefined;
  const location = raw.location as Record<string, unknown> | undefined;

  const driverPhone = (raw.phone ?? {}) as Record<string, unknown>;
  const displayName = [raw.username, raw.last_name].filter(Boolean).join(' ') || null;

  const result = {
    driver_id: String(driverId),
    username: raw.username ?? null,
    first_name: raw.first_name ?? null,
    last_name: raw.last_name ?? null,
    email: raw.email ?? null,
    phone: driverPhone.code && driverPhone.number ? `${driverPhone.code}${driverPhone.number}` : null,
    main_city: raw.main_city ?? null,
    status: raw.currentStatus,
    status_label: DRIVER_STATUS_LABELS[raw.currentStatus as number] ?? 'unknown',
    is_logged_in: raw.logout === 0,
    availability: raw.avail ?? null,
    country_code: address?.country_code ?? null,
    city: address?.city ?? null,
    avg_ratings: raw.avg_ratings ?? null,
    vehicle_brand: raw.vehicle_brand ?? null,
    vehicle_model: raw.vehicle_model ?? null,
    location: location ? { lat: location.lat, lng: location.lng } : null,
    gps_stale_minutes: gpsStaleMins,
    current_load: {
      ongoing: currentOrders?.onGoingOrdersCount ?? 0,
      processing: currentOrders?.processingOrdersCount ?? 0,
      picked_up: currentOrders?.pickedUpOrdersCount ?? 0,
    },
    lifetime_stats: {
      total_requests: raw.tot_req ?? 0,
      delivered: raw.deliverd ?? 0,
      cancelled: raw.cancelled ?? 0,
    },
    active_orders: activeOrders.map((o: Record<string, unknown>) => ({
      _id: String(o._id),
      status: o.status,
      status_label: ORDER_STATUS_LABELS[o.status as number] ?? `Unknown(${o.status})`,
      city: o.main_city ?? null,
      created_at: o.createdAt,
    })),
    today_stats: {
      total_assigned: stats.total,
      delivered: stats.delivered,
      cancelled: stats.cancelled,
      rejected: rejectedToday,
    },
    store_types: raw.driver_store_type ?? [],
    summary: `Driver ${displayName ?? String(driverId).slice(-6)} — ${DRIVER_STATUS_LABELS[raw.currentStatus as number] ?? 'unknown'}. Today: ${stats.delivered} delivered, ${rejectedToday} rejected. ${activeOrders.length} active orders. GPS ${gpsStaleMins !== null ? `${gpsStaleMins}min ago` : 'unknown'}.`,
  };

  const executionTime = Date.now() - start;
  logQuery({
    tool: 'lookup_driver',
    params,
    query: `db.drivers.findOne(${JSON.stringify(filter)})`,
    execution_time_ms: executionTime,
    result_count: 1,
  });

  return wrapToolResponse(result, {
    query: `db.drivers.findOne(...) + orders aggregation`,
    collection: 'drivers',
    execution_time_ms: executionTime,
    result_count: 1,
  });
}
