import { z } from 'zod';
import mongoose from 'mongoose';
import { wrapToolResponse, formatAggregation } from '../../utils/fact-check.js';
import { logQuery } from '../../utils/query-logger.js';

export const ratingsAnalysisSchema = z.object({
  country_code: z.string().optional().describe('OPTIONAL. Country code filter.'),
  min_rating: z.number().default(1).describe('OPTIONAL. Minimum rating to include (default 1).'),
  max_rating: z.number().default(3).describe('OPTIONAL. Maximum rating to include (default 3, for complaints).'),
  since_hours: z.number().default(168).describe('OPTIONAL. Time window in hours (default 168 = 7 days).'),
  group_by: z.enum(['restaurant', 'driver', 'rating']).default('restaurant').describe('OPTIONAL. Group results by restaurant, driver, or rating value.'),
  limit: z.number().default(20).describe('OPTIONAL. Max results (default 20).'),
});

export type RatingsAnalysisInput = z.infer<typeof ratingsAnalysisSchema>;

export async function getRatingsAnalysis(params: RatingsAnalysisInput) {
  const start = Date.now();
  const db = mongoose.connection.db;

  if (!db) {
    return wrapToolResponse({ error: 'Database not connected' }, { query: 'N/A', execution_time_ms: 0, result_count: 0 });
  }

  const sinceDate = new Date(Date.now() - params.since_hours * 3600000);

  const match: Record<string, unknown> = {
    rating: { $gte: params.min_rating, $lte: params.max_rating },
    createdAt: { $gte: sinceDate },
  };
  if (params.country_code) match.country_code = params.country_code;

  const groupField = params.group_by === 'restaurant' ? '$rating_to' : params.group_by === 'driver' ? '$driver_id' : '$rating';

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: groupField,
        count: { $sum: 1 },
        avg_rating: { $avg: '$rating' },
        sample_comments: { $push: { $ifNull: ['$comment', ''] } },
      },
    },
    { $sort: { count: -1 } },
    { $limit: params.limit },
    {
      $addFields: {
        sample_comments: { $slice: ['$sample_comments', 3] },
      },
    },
  ];

  const results = await db.collection('ratings').aggregate(pipeline).toArray();
  const totalCount = await db.collection('ratings').countDocuments(match);

  // Enrich with names if grouping by restaurant or driver
  let enriched = results;
  if (params.group_by === 'restaurant' && results.length > 0) {
    const ids = results.map((r) => r._id).filter(Boolean);
    try {
      const restaurants = await db
        .collection('restaurant')
        .find(
          {
            _id: {
              $in: ids.map((id: unknown) => new mongoose.Types.ObjectId(String(id))),
            },
          },
          { projection: { restaurantname: 1 } },
        )
        .toArray();
      const nameMap = new Map(restaurants.map((r) => [String(r._id), r.restaurantname]));
      enriched = results.map((r) => ({
        ...r,
        name: nameMap.get(String(r._id)) ?? String(r._id),
      }));
    } catch {
      // IDs may not be valid ObjectIds
    }
  }

  const rows = enriched.map((r) => ({
    id: String(r._id),
    name: r.name ?? String(r._id),
    complaint_count: r.count,
    avg_rating: Math.round((r.avg_rating ?? 0) * 10) / 10,
    sample_comments: (r.sample_comments ?? []).filter((c: string) => c.length > 0),
  }));

  const executionTime = Date.now() - start;
  const queryStr = formatAggregation('ratings', pipeline);
  logQuery({
    tool: 'ratings_analysis',
    params,
    query: queryStr,
    execution_time_ms: executionTime,
    result_count: rows.length,
  });

  return wrapToolResponse(
    {
      time_window_hours: params.since_hours,
      rating_range: [params.min_rating, params.max_rating],
      group_by: params.group_by,
      total_matching_ratings: totalCount,
      results: rows,
      summary: `${totalCount} ratings (${params.min_rating}-${params.max_rating} stars) in last ${params.since_hours}h, grouped by ${params.group_by}. Top: ${rows[0]?.name ?? 'N/A'} with ${rows[0]?.complaint_count ?? 0} ratings (avg ${rows[0]?.avg_rating ?? 'N/A'}).`,
    },
    {
      query: queryStr,
      collection: 'ratings',
      execution_time_ms: executionTime,
      result_count: rows.length,
    },
  );
}
