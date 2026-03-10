import { z } from 'zod';
import type { AuthContext } from '../../auth/types.js';
import { getHttpClient } from '../../api/http-client.js';
import { getDriverEarnings, CYCLE_STATUS_LABELS } from '../../api/finance.api.js';

export const getDriverPayoutsSchema = z.object({
  billing_cycle: z.string().describe('Billing cycle ID — MUST come from list_billing_cycles. ' + 'You MUST call list_billing_cycles(city) first to get available cycle IDs before calling this tool.'),
  status: z.enum(['all', 'paid', 'not_paid']).optional().describe('Filter by payout status: "paid", "not_paid", or "all" (default)'),
  search: z.string().optional().describe('Search by driver name, phone, address, or action ID'),
  page: z.number().min(1).optional().describe('Page number (default 1)'),
  page_size: z.number().min(1).max(100).optional().describe('Results per page (default 50)'),
  country_code: z.string().optional().describe('Country code (DZ, MA, TN, FR, ZA, SN)'),
});

type Params = z.infer<typeof getDriverPayoutsSchema>;

function statusLabel(val: unknown): string {
  if (val === 1 || val === 'paid') return 'Paid';
  if (val === 0 || val === 'not_paid') return 'Not Paid';
  return String(val ?? 'Unknown');
}

export async function getDriverPayoutsHandler(params: Params, ctx?: AuthContext) {
  const start = Date.now();
  const client = getHttpClient();
  if (ctx?.token) client.updateToken(ctx.token);

  const cycleStatus = params.status === 'paid' ? 'paid' : params.status === 'not_paid' ? 'not_paid' : undefined;

  const result = await getDriverEarnings(client, {
    billingCycle: params.billing_cycle,
    status: cycleStatus,
    search: params.search,
    page: params.page,
    pageSize: params.page_size,
    countryCode: params.country_code ?? ctx?.countryCode,
  });

  const drivers = result.driverDetails.map((d) => ({
    driver_id: d.driver_id ?? d._id,
    name: d.driver_name ?? 'N/A',
    type: d.driver_type ?? 'N/A',
    phone: d.phone ?? 'N/A',
    location: d.location ?? 'N/A',
    completed_deliveries: d.completed_deliveries ?? 0,
    returned_orders: d.returned_orders ?? 0,
    delivery_charge: d.delivery_charge ?? 0,
    driver_brut: d.driver_brut ?? 0,
    driver_tax: d.driver_tax ?? 0,
    tip: d.total_tip ?? 0,
    bonus: d.driver_bonus ?? 0,
    driver_net: d.driver_net ?? 0,
    platform_earnings: d.platform_earnings ?? 0,
    adjustments: d.adjustments ?? 0,
    cash_co: d.cash_co ?? 0,
    payout_status: statusLabel(d.paid_status),
    cycle_status: CYCLE_STATUS_LABELS[d.cycle_status ?? -1] ?? String(d.cycle_status ?? ''),
  }));

  return {
    result: {
      summary: `${result.count_drivers ?? result.count} drivers in cycle. Showing ${drivers.length}.`,
      total_drivers: result.count_drivers ?? result.count,
      showing: drivers.length,
      totals: result.driver_total,
      drivers,
      display_hint:
        'Show totals first, then a markdown table of drivers with columns: Name, Type, Deliveries, Returned, Delivery Charge, Brut, Tax, Tip, Bonus, Net, Platform Earnings, Adjustments, Cash-co, Status. ' +
        'To see a specific driver breakdown, use get_driver_payout_details with the driver_id.',
    },
    _debug: {
      query: `API GET /billing/v2/getDriverEarnings?billingCycle=${params.billing_cycle}`,
      execution_time_ms: Date.now() - start,
      result_count: drivers.length,
      timestamp: new Date().toISOString(),
    },
  };
}
