import { z } from 'zod';
import type { AuthContext } from '../../auth/types.js';
import { getHttpClient } from '../../api/http-client.js';
import { fetchCyclesByCity } from '../../api/finance.api.js';

export const listBillingCyclesSchema = z.object({
  city: z
    .string()
    .describe(
      'City name exactly as known by the backend (required). ' +
        'Examples by country: DZ → "Alger Center", "Oran", "Constantine"; MA → "Casablanca", "Rabat"; TN → "Tunis". ' +
        'If unsure, use flexible_query on the "city" collection filtered by country_code to discover valid city names.',
    ),
  limit: z.number().min(1).max(100).optional().describe('Max cycles to return (default 20)'),
  country_code: z.string().optional().describe('Country code (DZ, MA, TN, FR, ZA, SN) — auto-filled from user settings if omitted'),
});

type Params = z.infer<typeof listBillingCyclesSchema>;

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

export async function listBillingCyclesHandler(params: Params, ctx?: AuthContext) {
  const start = Date.now();
  const client = getHttpClient();
  if (ctx?.token) client.updateToken(ctx.token);

  const result = await fetchCyclesByCity(client, {
    city: params.city,
    limit: params.limit ?? 20,
    countryCode: params.country_code ?? ctx?.countryCode,
  });

  const cycles = result.cycles.map((c, i) => ({
    number: i + 1,
    cycle_id: c._id,
    start_date: formatDate(c.start_date),
    end_date: formatDate(c.end_date),
    city: c.main_city ?? c.city_name ?? params.city,
    range: `${formatDate(c.start_date)} – ${formatDate(c.end_date)}`,
  }));

  if (cycles.length === 0) {
    return {
      result: {
        summary: `No billing cycles found for city "${params.city}"`,
        city: params.city,
        cycles: [],
        suggestion:
          'This may mean the city name does not match the backend. ' +
          'Try using flexible_query on the "city" collection with filter {"country_code":"' +
          (params.country_code ?? ctx?.countryCode ?? 'DZ') +
          '"} to discover the exact city names available. ' +
          'Common names: DZ uses "Alger Center" (not "Algiers"), MA uses "Casablanca", TN uses "Tunis".',
      },
      _debug: {
        query: `API POST /billing/fetchCyclesByCity { cityname: "${params.city}" }`,
        execution_time_ms: Date.now() - start,
        result_count: 0,
        timestamp: new Date().toISOString(),
      },
    };
  }

  return {
    result: {
      summary: `Found ${cycles.length} billing cycles for ${params.city}`,
      city: params.city,
      cycles,
      display_hint: 'Show as a numbered list or table: #, Date Range, Cycle ID. ' + 'Tell the user to pick a cycle number so you can load driver payouts via get_driver_payouts.',
    },
    _debug: {
      query: `API POST /billing/fetchCyclesByCity { cityname: "${params.city}" }`,
      execution_time_ms: Date.now() - start,
      result_count: cycles.length,
      timestamp: new Date().toISOString(),
    },
  };
}
