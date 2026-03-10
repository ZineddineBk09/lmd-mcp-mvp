import { z } from 'zod';
import type { AuthContext } from '../../auth/types.js';
import { getHttpClient } from '../../api/http-client.js';
import { getAdminEarnings } from '../../api/finance.api.js';
import { ORDER_STATUS_LABELS } from '../../constants/order-status.js';

export const getAdminEarningsSchema = z.object({
  city: z
    .string()
    .optional()
    .describe('City name to filter by, using backend city names (e.g. DZ → "Alger Center", "Oran"; MA → "Casablanca"). ' + 'Omit to get all cities.'),
  area: z.string().optional().describe('Sub-city / area filter'),
  service: z.string().optional().describe('Service type filter'),
  start_date: z.string().optional().describe('Start date as ISO string or Unix timestamp in ms. Defaults to 30 days ago if omitted.'),
  end_date: z.string().optional().describe('End date as ISO string or Unix timestamp in ms. Defaults to now if omitted.'),
  search: z.string().optional().describe('Search by order ID, customer name, or phone'),
  ofse: z.boolean().optional().describe('Set to true to get OFSE (Order For Someone Else) earnings instead of regular admin earnings'),
  page: z.number().min(1).optional().describe('Page number (default 1)'),
  page_size: z.number().min(1).max(50).optional().describe('Results per page (default 20, max 50)'),
  country_code: z.string().optional().describe('Country code (DZ, MA, TN, FR, ZA, SN)'),
});

type Params = z.infer<typeof getAdminEarningsSchema>;

function parseTimestamp(val: string): string {
  const num = Number(val);
  if (!isNaN(num) && num > 1e12) return val;
  if (!isNaN(num)) return String(num * 1000);
  const d = new Date(val);
  if (!isNaN(d.getTime())) return String(d.getTime());
  return val;
}

export async function getAdminEarningsHandler(params: Params, ctx?: AuthContext) {
  const start = Date.now();
  const client = getHttpClient();
  if (ctx?.token) client.updateToken(ctx.token);

  const result = await getAdminEarnings(client, {
    city: params.city,
    area: params.area,
    service: params.service,
    startDate: params.start_date ? parseTimestamp(params.start_date) : undefined,
    endDate: params.end_date ? parseTimestamp(params.end_date) : undefined,
    search: params.search,
    ofse: params.ofse,
    page: params.page,
    pageSize: params.page_size,
    countryCode: params.country_code ?? ctx?.countryCode,
  });

  const label = params.ofse ? 'OFSE' : 'Admin';

  const orders = result.orderDetails.map((o) => ({
    order_id: o.order_id ?? o._id,
    status: ORDER_STATUS_LABELS[o.status] ?? `Unknown (${o.status})`,
    date: o.createdAt,
    country: o.Country,
    city: o.City,
    area: o.Area,
    restaurant: (o.restaurant as Record<string, unknown>)?.restaurantname ?? 'N/A',
    driver: o.driver_name ?? 'N/A',
    customer: (o.user as Record<string, unknown>)?.username ?? 'N/A',
    store_type: o.store_type,
    billings: o.billings,
    for_someone_else: o.for_someone_else,
  }));

  const dateNote = result.defaultDateRangeApplied ? ' (default: last 30 days)' : '';

  return {
    result: {
      summary: `${label} Earnings: ${result.count} orders${dateNote}`,
      total_orders: result.count,
      showing: orders.length,
      totals: {
        restaurant: result.restaurant_total,
        driver: result.driver_total,
        admin: result.admin_total,
      },
      orders,
      display_hint:
        `Show the ${label} earnings summary with totals (restaurant, driver, admin/platform). ` +
        'Then show the orders as a markdown table with columns: Order ID, Date, Status, Restaurant, Driver, Customer, and key billing amounts.',
    },
    _debug: {
      query: `API GET /billing/adminEarnings${params.ofse ? ' (OFSE)' : ''}`,
      execution_time_ms: Date.now() - start,
      result_count: orders.length,
      timestamp: new Date().toISOString(),
    },
  };
}
