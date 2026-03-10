import { z } from 'zod';
import type { AuthContext } from '../../auth/types.js';
import { getHttpClient } from '../../api/http-client.js';
import { fetchRestaurantCycleDateRanges, fetchRestaurantCyclesList, CYCLE_STATUS_LABELS } from '../../api/finance.api.js';

export const listRestaurantCyclesSchema = z.object({
  city: z
    .string()
    .describe(
      'City name exactly as known by the backend (required). ' +
        'Examples by country: DZ → "Alger Center", "Oran", "Constantine"; MA → "Casablanca", "Rabat"; TN → "Tunis". ' +
        'If unsure, use flexible_query on the "city" collection filtered by country_code to discover valid city names.',
    ),
  status: z.number().min(0).max(8).optional().describe('Filter by cycle status: 0=Invalid, 1=Active, 2=In Review, 3=Settled, 4=Paid, 5=Interrupted, 6=Cancelled, 7=Settling, 8=Manually Settled'),
  page: z.number().min(1).optional().describe('Page number (default 1)'),
  page_size: z.number().min(1).max(50).optional().describe('Results per page (default 20)'),
  country_code: z.string().optional().describe('Country code (DZ, MA, TN, FR, ZA, SN)'),
});

type Params = z.infer<typeof listRestaurantCyclesSchema>;

function formatDate(d: string): string {
  try {
    return new Date(d).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    });
  } catch {
    return d;
  }
}

export async function listRestaurantCyclesHandler(params: Params, ctx?: AuthContext) {
  const start = Date.now();
  const client = getHttpClient();
  if (ctx?.token) client.updateToken(ctx.token);

  const cc = params.country_code ?? ctx?.countryCode;

  // Step 1: Get cycle date ranges for the city
  const dateRanges = await fetchRestaurantCycleDateRanges(client, {
    city: params.city,
    countryCode: cc,
  });

  if (!dateRanges.length) {
    return {
      result: {
        summary: `No restaurant billing cycles found for city "${params.city}"`,
        cycles: [],
        suggestion:
          'This may mean the city name does not match the backend. ' +
          'Try using flexible_query on the "city" collection with filter {"country_code":"' +
          (cc ?? 'DZ') +
          '"} to discover the exact city names available. ' +
          'Common names: DZ uses "Alger Center" (not "Algiers"), MA uses "Casablanca", TN uses "Tunis".',
      },
      _debug: {
        query: `API GET /restaurant/cycles?city=${params.city}`,
        execution_time_ms: Date.now() - start,
        result_count: 0,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Collect all cycle IDs from the date ranges
  const allCycleIds = dateRanges.flatMap((r) => r.cycle_ids ?? [r._id]).filter(Boolean) as string[];

  if (!allCycleIds.length) {
    return {
      result: {
        summary: `Found ${dateRanges.length} date ranges for ${params.city} but no cycle IDs`,
        date_ranges: dateRanges.map((r) => ({
          start: formatDate(r.start_date),
          end: formatDate(r.end_date),
        })),
      },
      _debug: {
        query: `API GET /restaurant/cycles?city=${params.city}`,
        execution_time_ms: Date.now() - start,
        result_count: dateRanges.length,
        timestamp: new Date().toISOString(),
      },
    };
  }

  // Step 2: Fetch actual cycles with details
  const skip = ((params.page ?? 1) - 1) * (params.page_size ?? 20);
  const cyclesResult = await fetchRestaurantCyclesList(client, {
    cycleIds: allCycleIds,
    skip,
    limit: params.page_size ?? 20,
    status: params.status,
    countryCode: cc,
  });

  const cycles = cyclesResult.data.map((c) => ({
    cycle_id: c._id,
    restaurant: c.restaurantname ?? 'N/A',
    restaurant_id: c.restaurant_id,
    start_date: c.start_date ? formatDate(c.start_date) : 'N/A',
    end_date: c.end_date ? formatDate(c.end_date) : 'N/A',
    status: CYCLE_STATUS_LABELS[c.status ?? -1] ?? String(c.status ?? 'Unknown'),
    yassir_pay: c.yassir_pay_store ? 'Yes' : 'No',
    has_children: (c.childCyclesIds?.length ?? 0) > 0,
  }));

  return {
    result: {
      summary: `Found ${cyclesResult.count} restaurant cycles for ${params.city} (showing ${cycles.length})`,
      total_count: cyclesResult.count,
      showing: cycles.length,
      city: params.city,
      cycles,
      display_hint: 'Show as a markdown table: Restaurant, Date Range, Status, Yassir Pay, Has Children. ' + 'To view orders in a cycle, use get_restaurant_cycle_orders with the cycle_id.',
    },
    _debug: {
      query: `API GET /restaurant/cycles + POST /restaurant/cycles-list (city=${params.city}, ${allCycleIds.length} cycle IDs)`,
      execution_time_ms: Date.now() - start,
      result_count: cycles.length,
      timestamp: new Date().toISOString(),
    },
  };
}
