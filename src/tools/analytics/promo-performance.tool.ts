import { z } from 'zod';
import mongoose from 'mongoose';
import { wrapToolResponse, formatAggregation } from '../../utils/fact-check.js';
import { logQuery } from '../../utils/query-logger.js';
import { getCurrencyForCountry } from '../../utils/currency.js';

export const promoPerformanceSchema = z.object({
  country_code: z.string().optional().describe('OPTIONAL. Country code filter.'),
  since_hours: z.number().default(168).describe('OPTIONAL. Time window in hours (default 168 = 7 days).'),
  limit: z.number().default(20).describe('OPTIONAL. Max results (default 20).'),
});

export type PromoPerformanceInput = z.infer<typeof promoPerformanceSchema>;

export async function getPromoPerformance(params: PromoPerformanceInput) {
  const start = Date.now();
  const db = mongoose.connection.db;

  if (!db) {
    return wrapToolResponse({ error: 'Database not connected' }, { query: 'N/A', execution_time_ms: 0, result_count: 0 });
  }

  const sinceDate = new Date(Date.now() - params.since_hours * 3600000);

  const match: Record<string, unknown> = {
    createdAt: { $gte: sinceDate },
  };
  if (params.country_code) match.country_code = params.country_code;

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: '$code',
        total_generated: { $sum: { $ifNull: ['$generated', 0] } },
        total_used: { $sum: { $ifNull: ['$used', 0] } },
        discount_type: { $first: '$amount_percentage' },
        min_order_amount: { $first: '$min_order' },
        country_code: { $first: '$country_code' },
        currency_symbol: { $first: '$currency_symbol' },
        status: { $first: '$status' },
        sample_description: { $first: '$description' },
      },
    },
    { $sort: { total_used: -1 } },
    { $limit: params.limit },
  ];

  const results = await db.collection('coupon').aggregate(pipeline).toArray();
  const totalCoupons = await db.collection('coupon').countDocuments(match);

  const currency = params.country_code ? await getCurrencyForCountry(params.country_code) : null;

  const rows = results.map((r) => ({
    code: r._id ?? 'N/A',
    total_generated: r.total_generated ?? 0,
    total_used: r.total_used ?? 0,
    redemption_rate_pct: (r.total_generated ?? 0) > 0 ? Math.round(((r.total_used ?? 0) / (r.total_generated ?? 1)) * 100) : 0,
    discount_type: r.discount_type ?? 'N/A',
    min_order_amount: r.min_order_amount ?? null,
    currency_symbol: (r.currency_symbol as string) ?? currency?.currency_symbol ?? null,
    status: r.status,
    description: r.sample_description ?? null,
  }));

  const totalUsed = rows.reduce((s, r) => s + r.total_used, 0);
  const totalGenerated = rows.reduce((s, r) => s + r.total_generated, 0);

  const executionTime = Date.now() - start;
  const queryStr = formatAggregation('coupon', pipeline);
  logQuery({
    tool: 'promo_performance',
    params,
    query: queryStr,
    execution_time_ms: executionTime,
    result_count: rows.length,
  });

  return wrapToolResponse(
    {
      time_window_hours: params.since_hours,
      total_coupons: totalCoupons,
      total_generated: totalGenerated,
      total_used: totalUsed,
      overall_redemption_rate_pct: totalGenerated > 0 ? Math.round((totalUsed / totalGenerated) * 100) : 0,
      top_coupons: rows,
      summary: `Promo performance (last ${params.since_hours}h): ${totalCoupons} coupons, ${totalGenerated} generated, ${totalUsed} used (${totalGenerated > 0 ? Math.round((totalUsed / totalGenerated) * 100) : 0}% redemption). Top: ${rows[0]?.code ?? 'N/A'} (${rows[0]?.total_used ?? 0} uses).`,
    },
    {
      query: queryStr,
      collection: 'coupon',
      execution_time_ms: executionTime,
      result_count: rows.length,
    },
  );
}
