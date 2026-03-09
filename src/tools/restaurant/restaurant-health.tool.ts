import { z } from 'zod';
import mongoose from 'mongoose';
import { Order } from '../../schemas/order.schema.js';
import { Restaurant } from '../../schemas/restaurant.schema.js';
import { wrapToolResponse, formatAggregation } from '../../utils/fact-check.js';
import { logQuery } from '../../utils/query-logger.js';
import { ORDER_STATUS } from '../../constants/order-status.js';

export const restaurantHealthSchema = z.object({
  country_code: z.string().optional().describe('OPTIONAL. Country code: DZ, MA, TN, or CI. Omit to search all countries.'),
  city: z.string().optional().describe('OPTIONAL. City name. Omit for entire country.'),
  restaurant_id: z.string().optional().describe('OPTIONAL. Specific restaurant ObjectId.'),
  since_hours: z.number().default(24).describe('OPTIONAL. Time window in hours (default 24).'),
  top_n: z.number().default(10).describe('OPTIONAL. Number of top/bottom restaurants (default 10).'),
});

export type RestaurantHealthInput = z.infer<typeof restaurantHealthSchema>;

export async function getRestaurantHealth(params: RestaurantHealthInput) {
  const start = Date.now();
  const sinceDate = new Date(Date.now() - params.since_hours * 3600 * 1000);

  const match: Record<string, unknown> = {
    createdAt: { $gte: sinceDate },
  };
  if (params.country_code) match.country_code = params.country_code;

  if (params.restaurant_id) {
    match.restaurant_id = new mongoose.Types.ObjectId(params.restaurant_id);
  }

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: '$restaurant_id',
        total_orders: { $sum: 1 },
        accepted: {
          $sum: {
            $cond: [{ $in: ['$status', [3, 5, 6, 7, 8, 16, 17]] }, 1, 0],
          },
        },
        rejected: {
          $sum: {
            $cond: [
              {
                $in: ['$status', [ORDER_STATUS.RESTAURANT_REJECTED_ORDER, ORDER_STATUS.ORDER_TIMEOUT]],
              },
              1,
              0,
            ],
          },
        },
        delivered: {
          $sum: {
            $cond: [{ $eq: ['$status', ORDER_STATUS.ORDER_DELIVERED] }, 1, 0],
          },
        },
        avg_ept: { $avg: '$ept' },
      },
    },
    {
      $addFields: {
        acceptance_rate: {
          $cond: [
            { $gt: ['$total_orders', 0] },
            {
              $round: [
                {
                  $multiply: [{ $divide: ['$accepted', '$total_orders'] }, 100],
                },
                1,
              ],
            },
            0,
          ],
        },
        rejection_rate: {
          $cond: [
            { $gt: ['$total_orders', 0] },
            {
              $round: [
                {
                  $multiply: [{ $divide: ['$rejected', '$total_orders'] }, 100],
                },
                1,
              ],
            },
            0,
          ],
        },
      },
    },
    { $sort: { rejection_rate: -1 as const } },
  ];

  const results = await Order.aggregate(pipeline);

  // Enrich with restaurant names and availability
  const restaurantIds = results.map((r) => r._id);
  const restaurants = await Restaurant.find(
    { _id: { $in: restaurantIds } },
    {
      restaurantname: 1,
      restaurantAvailability: 1,
      store_type: 1,
      'address.city': 1,
    },
  ).lean();

  const restaurantMap = new Map(restaurants.map((r) => [r._id.toString(), r]));

  const enriched = results.map((r) => {
    const info = restaurantMap.get(r._id?.toString());
    return {
      restaurant_id: r._id?.toString(),
      name: info?.restaurantname ?? 'Unknown',
      city: info?.address?.city,
      store_type: info?.store_type,
      is_busy: info?.restaurantAvailability?.isBusy ?? false,
      is_post_rejection_busy: info?.restaurantAvailability?.isPostRejection ?? false,
      busy_until: info?.restaurantAvailability?.busyUntil,
      total_orders: r.total_orders,
      accepted: r.accepted,
      rejected: r.rejected,
      delivered: r.delivered,
      acceptance_rate: r.acceptance_rate,
      rejection_rate: r.rejection_rate,
      avg_prep_time_minutes: r.avg_ept ? Math.round(r.avg_ept) : null,
    };
  });

  const worstPerformers = enriched.slice(0, params.top_n);
  const bestPerformers = [...enriched].sort((a, b) => a.rejection_rate - b.rejection_rate).slice(0, params.top_n);
  const currentlyBusy = enriched.filter((r) => r.is_busy);

  const executionTime = Date.now() - start;

  logQuery({
    tool: 'restaurant_health',
    params,
    query: formatAggregation('orders', pipeline),
    execution_time_ms: executionTime,
    result_count: results.length,
  });

  return wrapToolResponse(
    {
      total_restaurants_with_orders: results.length,
      time_range_hours: params.since_hours,
      worst_performers: worstPerformers,
      best_performers: bestPerformers,
      currently_busy: currentlyBusy,
      currently_busy_count: currentlyBusy.length,
      summary: `Restaurant health for last ${params.since_hours}h in ${params.country_code}${params.city ? ` / ${params.city}` : ''}: ${results.length} restaurants active. ${currentlyBusy.length} currently busy. Worst rejection rate: ${worstPerformers[0]?.rejection_rate ?? 0}% (${worstPerformers[0]?.name ?? 'N/A'}).`,
    },
    {
      query: formatAggregation('orders', pipeline),
      collection: 'orders + restaurant',
      execution_time_ms: executionTime,
      result_count: results.length,
    },
  );
}
