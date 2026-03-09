import { z } from 'zod';
import mongoose from 'mongoose';
import { Order } from '../../schemas/order.schema.js';
import { wrapToolResponse, formatAggregation } from '../../utils/fact-check.js';
import { logQuery } from '../../utils/query-logger.js';

export const topBottomSchema = z.object({
  country_code: z.string().optional().describe('OPTIONAL. Country code: DZ, MA, TN, FR, SN, ZA, etc. Omit to search all countries.'),
  entity: z.enum(['city', 'restaurant', 'driver', 'user']).describe('REQUIRED. What to rank: city, restaurant, driver, or user.'),
  metric: z.enum(['orders', 'deliveries', 'cancellations', 'rejections', 'avg_delivery_time']).describe('REQUIRED. Metric to rank by.'),
  direction: z.enum(['top', 'bottom']).default('top').describe("OPTIONAL. 'top' for highest, 'bottom' for lowest (default: top)."),
  top_n: z.number().default(5).describe('OPTIONAL. Number of results (default 5, max 20).'),
  since_hours: z.number().default(24).describe('OPTIONAL. Time window in hours (default 24).'),
});

export type TopBottomInput = z.infer<typeof topBottomSchema>;

const ENTITY_GROUP_FIELD: Record<string, string> = {
  city: '$main_city',
  restaurant: '$restaurant_id',
  driver: '$driver_id',
  user: '$user_id',
};

function buildMetricStage(metric: string): Record<string, unknown> {
  switch (metric) {
    case 'deliveries':
      return { count: { $sum: { $cond: [{ $eq: ['$status', 7] }, 1, 0] } } };
    case 'cancellations':
      return {
        count: { $sum: { $cond: [{ $in: ['$status', [9, 10, 90]] }, 1, 0] } },
      };
    case 'rejections':
      return {
        count: { $sum: { $size: { $ifNull: ['$rejectedDriversList', []] } } },
      };
    case 'avg_delivery_time':
      return {
        count: { $sum: 1 },
        avg_minutes: {
          $avg: {
            $cond: [
              {
                $and: [{ $eq: ['$status', 7] }, { $ne: ['$order_history.food_delivered', null] }],
              },
              {
                $divide: [
                  {
                    $subtract: ['$order_history.food_delivered', '$createdAt'],
                  },
                  60000,
                ],
              },
              null,
            ],
          },
        },
      };
    default:
      return { count: { $sum: 1 } };
  }
}

export async function topBottom(params: TopBottomInput) {
  const start = Date.now();
  const cappedN = Math.min(params.top_n, 20);
  const sinceDate = new Date(Date.now() - params.since_hours * 3600000);

  const match: Record<string, unknown> = {
    createdAt: { $gte: sinceDate },
  };
  if (params.country_code) match.country_code = params.country_code;

  const groupField = ENTITY_GROUP_FIELD[params.entity];
  const metricAccumulator = buildMetricStage(params.metric);
  const sortField = params.metric === 'avg_delivery_time' ? 'avg_minutes' : 'count';
  const sortDir = params.direction === 'top' ? -1 : 1;

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: groupField,
        ...metricAccumulator,
      },
    },
    { $match: { _id: { $ne: null } } },
    { $sort: { [sortField]: sortDir as 1 | -1 } },
    { $limit: cappedN },
  ];

  const results = await Order.aggregate(pipeline as never[]);

  let enrichedResults = results;

  if (params.entity === 'restaurant' && results.length > 0) {
    const ids = results.map((r) => r._id).filter(Boolean);
    const db = mongoose.connection.db;
    if (db) {
      const restaurants = await db
        .collection('restaurant')
        .find({ _id: { $in: ids } }, { projection: { restaurantname: 1 } })
        .toArray();
      const nameMap = new Map(restaurants.map((r) => [String(r._id), r.restaurantname]));
      enrichedResults = results.map((r) => ({
        ...r,
        name: nameMap.get(String(r._id)) ?? String(r._id),
      }));
    }
  } else if (params.entity === 'driver' && results.length > 0) {
    const ids = results.map((r) => r._id).filter(Boolean);
    const db = mongoose.connection.db;
    if (db) {
      const drivers = await db
        .collection('drivers')
        .find({ _id: { $in: ids } }, { projection: { first_name: 1, last_name: 1, username: 1 } })
        .toArray();
      const nameMap = new Map(drivers.map((d: any) => [String(d._id), [d.username, d.last_name].filter(Boolean).join(' ') || String(d._id)]));
      enrichedResults = results.map((r) => ({
        ...r,
        name: nameMap.get(String(r._id)) ?? String(r._id),
      }));
    }
  } else if (params.entity === 'user' && results.length > 0) {
    const ids = results.map((r) => r._id).filter(Boolean);
    const db = mongoose.connection.db;
    if (db) {
      const users = await db
        .collection('users')
        .find({ _id: { $in: ids } }, { projection: { username: 1, 'phone.number': 1 } })
        .toArray();
      const nameMap = new Map(users.map((u: any) => [String(u._id), { name: u.username || String(u._id), phone: u.phone?.number }]));
      enrichedResults = results.map((r) => {
        const info = nameMap.get(String(r._id));
        return { ...r, name: info?.name ?? String(r._id), phone: info?.phone };
      });
    }
  }

  const ranked = enrichedResults.map((r, i) => ({
    rank: i + 1,
    id: String(r._id),
    name: r.name ?? String(r._id),
    ...(r.phone ? { phone: r.phone } : {}),
    value: params.metric === 'avg_delivery_time' ? Math.round(r.avg_minutes ?? 0) : r.count,
    metric_label: params.metric === 'avg_delivery_time' ? 'avg minutes' : params.metric,
  }));

  const result = {
    entity: params.entity,
    metric: params.metric,
    direction: params.direction,
    country_code: params.country_code,
    time_window_hours: params.since_hours,
    rankings: ranked,
    summary: `${params.direction === 'top' ? 'Top' : 'Bottom'} ${ranked.length} ${params.entity}s by ${params.metric} in ${params.country_code} (last ${params.since_hours}h): ${ranked.map((r) => `${r.rank}. ${r.name} (${r.value})`).join(', ')}.`,
  };

  const executionTime = Date.now() - start;
  logQuery({
    tool: 'top_bottom_performers',
    params,
    query: formatAggregation('orders', pipeline),
    execution_time_ms: executionTime,
    result_count: ranked.length,
  });

  return wrapToolResponse(result, {
    query: formatAggregation('orders', pipeline),
    collection: 'orders',
    execution_time_ms: executionTime,
    result_count: ranked.length,
  });
}
