import { z } from 'zod';
import { Order } from '../../schemas/order.schema.js';
import { City } from '../../schemas/city.schema.js';
import { wrapToolResponse, formatAggregation } from '../../utils/fact-check.js';
import { logQuery } from '../../utils/query-logger.js';

export const rejectionAnalysisSchema = z.object({
  country_code: z.string().optional().describe('OPTIONAL. Country code: DZ, MA, TN, or CI. Omit to search all countries.'),
  city: z.string().optional().describe('OPTIONAL. City name. Omit for entire country.'),
  since_minutes: z.number().default(60).describe('OPTIONAL. Time window in minutes (default 60).'),
  limit: z.number().default(30).describe('OPTIONAL. Max results (default 30).'),
});

export type RejectionAnalysisInput = z.infer<typeof rejectionAnalysisSchema>;

export async function getRejectionAnalysis(params: RejectionAnalysisInput) {
  const start = Date.now();

  const sinceDate = new Date(Date.now() - params.since_minutes * 60 * 1000);

  const match: Record<string, unknown> = {
    createdAt: { $gte: sinceDate },
    'rejectedDriversList.0': { $exists: true },
  };
  if (params.country_code) match.country_code = params.country_code;
  if (params.city) match.main_city = params.city;

  const pipeline = [
    { $match: match },
    {
      $addFields: {
        rejection_count: {
          $size: { $ifNull: ['$rejectedDriversList', []] },
        },
      },
    },
    {
      $project: {
        _id: 1,
        status: 1,
        createdAt: 1,
        main_city: 1,
        restaurant_id: 1,
        driver_id: 1,
        rejectedDriversList: 1,
        rejection_count: 1,
      },
    },
    { $sort: { rejection_count: -1 as const } },
    { $limit: params.limit },
  ];

  const [orders, cityConfig] = await Promise.all([Order.aggregate(pipeline), params.country_code ? City.findOne({ country_code: params.country_code }).lean() : Promise.resolve(null)]);

  const maxRejections = cityConfig?.max_rejected_drivers || 10;

  // Aggregate: which drivers reject the most
  const driverRejectionMap: Record<string, number> = {};
  for (const order of orders) {
    for (const driverId of order.rejectedDriversList || []) {
      const id = driverId.toString();
      driverRejectionMap[id] = (driverRejectionMap[id] || 0) + 1;
    }
  }

  const topRejectingDrivers = Object.entries(driverRejectionMap)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([driverId, count]) => ({ driver_id: driverId, rejections: count }));

  // City breakdown
  const cityBreakdown: Record<string, { total_orders: number; total_rejections: number }> = {};
  for (const order of orders) {
    const city = order.main_city || 'unknown';
    if (!cityBreakdown[city]) {
      cityBreakdown[city] = { total_orders: 0, total_rejections: 0 };
    }
    cityBreakdown[city].total_orders++;
    cityBreakdown[city].total_rejections += order.rejection_count;
  }

  const atLimitOrders = orders.filter((o) => o.rejection_count >= maxRejections);
  const totalRejections = orders.reduce((sum, o) => sum + o.rejection_count, 0);
  const avgRejectionsPerOrder = orders.length > 0 ? Math.round((totalRejections / orders.length) * 10) / 10 : 0;

  const executionTime = Date.now() - start;

  logQuery({
    tool: 'rejection_analysis',
    params,
    query: formatAggregation('orders', pipeline),
    execution_time_ms: executionTime,
    result_count: orders.length,
  });

  return wrapToolResponse(
    {
      orders_with_rejections: orders.length,
      total_rejections: totalRejections,
      avg_rejections_per_order: avgRejectionsPerOrder,
      orders_at_rejection_limit: atLimitOrders.length,
      max_rejection_limit: maxRejections,
      top_rejected_orders: orders.slice(0, 10).map((o) => ({
        _id: o._id.toString(),
        status: o.status,
        city: o.main_city,
        rejection_count: o.rejection_count,
        at_limit: o.rejection_count >= maxRejections,
        restaurant_id: o.restaurant_id?.toString(),
      })),
      top_rejecting_drivers: topRejectingDrivers,
      city_breakdown: cityBreakdown,
      time_range_minutes: params.since_minutes,
      summary: `Rejection analysis for last ${params.since_minutes} min in ${params.country_code}${params.city ? ` / ${params.city}` : ''}: ${orders.length} orders with rejections, ${totalRejections} total rejections (avg ${avgRejectionsPerOrder}/order). ${atLimitOrders.length} orders hit the ${maxRejections}-rejection limit.`,
    },
    {
      query: formatAggregation('orders', pipeline),
      collection: 'orders',
      execution_time_ms: executionTime,
      result_count: orders.length,
    },
  );
}
