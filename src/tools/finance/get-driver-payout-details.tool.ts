import { z } from 'zod';
import type { AuthContext } from '../../auth/types.js';
import { getHttpClient } from '../../api/http-client.js';
import { getDriverEarningsDetails, CYCLE_STATUS_LABELS } from '../../api/finance.api.js';
import { ORDER_STATUS_LABELS } from '../../constants/order-status.js';

export const getDriverPayoutDetailsSchema = z.object({
  driver_id: z.string().describe('Driver ID (MongoDB _id). Required.'),
  billing_id: z.string().optional().describe('Billing cycle ID. If omitted, shows unbilled earnings since last cycle.'),
  page: z.number().min(1).optional().describe('Page number (default 1)'),
  page_size: z.number().min(1).max(50).optional().describe('Results per page (default 20)'),
  country_code: z.string().optional().describe('Country code (DZ, MA, TN, FR, ZA, SN)'),
});

type Params = z.infer<typeof getDriverPayoutDetailsSchema>;

export async function getDriverPayoutDetailsHandler(params: Params, ctx?: AuthContext) {
  const start = Date.now();
  const client = getHttpClient();
  if (ctx?.token) client.updateToken(ctx.token);

  const result = await getDriverEarningsDetails(client, {
    driverId: params.driver_id,
    billingId: params.billing_id,
    page: params.page,
    pageSize: params.page_size,
    countryCode: params.country_code ?? ctx?.countryCode,
  });

  const orders = result.orderDetails.map((o) => {
    const b = (o.billings ?? {}) as Record<string, Record<string, unknown>>;
    const clientB = b.client ?? b.amount ?? {};
    const driverB = b.driver ?? {};
    const adminB = b.admin ?? {};
    const tipB = b.tip ?? {};
    const epayB = b.epay ?? {};

    return {
      order_id: o.order_id ?? o._id,
      date: o.createdAt,
      payment_method: o.payment_type ?? (epayB.method as string) ?? 'N/A',
      store_type: o.store_type ?? 'N/A',
      customer_paid: clientB.grand_total ?? clientB.total ?? 0,
      delivery_charge: clientB.delivery_amount ?? 0,
      driver_earnings: driverB.driver_payout ?? driverB.driver_commission ?? 0,
      driver_tax: driverB.driver_tax ?? 0,
      tip: tipB.amount ?? tipB.total ?? 0,
      site_commission: adminB.admin_commission ?? 0,
      restaurant_payout: (b.restaurant ?? {}).restaurant_payout ?? 0,
    };
  });

  const payout = result.payoutDetails;
  const payoutBillings = (payout?.billings ?? {}) as Record<string, unknown>;

  const summary: Record<string, unknown> = {
    total_orders: result.count,
    showing: orders.length,
    driver_totals: result.driver_total,
  };

  if (payout) {
    summary.payout_summary = {
      cycle_id: payout.billing_cycle,
      orders: payout.orders,
      returned_orders: payout.returned_orders,
      status: CYCLE_STATUS_LABELS[payout.status ?? -1] ?? String(payout.status ?? ''),
      paid_status: payout.paid_status === 1 ? 'Paid' : 'Not Paid',
      cash_co: payoutBillings.cash_co ?? payoutBillings.total_cash_co,
      driver_earnings: payoutBillings.total_driver_earnings ?? payoutBillings.driver_payout,
      driver_bonus: payoutBillings.driver_bonus,
      driver_tax: payoutBillings.sum_tax_driver ?? payoutBillings.driver_tax,
      total_tip: payoutBillings.driver_tip ?? payoutBillings.total_tip,
      adjustments: payoutBillings.total_adjustments,
      platform_earnings: payoutBillings.final_admin_earnings ?? payoutBillings.admin_earnings,
      transaction_id: payout.transaction_id,
    };
  }

  return {
    result: {
      summary: params.billing_id ? `Driver payout details: ${result.count} orders in cycle` : `Unbilled driver earnings: ${result.count} orders since last cycle`,
      ...summary,
      orders,
      display_hint:
        'Show the payout summary first (cash-co, driver earnings, bonus, tax, tip, adjustments, platform earnings, status). ' +
        'Then show orders as a markdown table: Order ID, Date, Payment, Store Type, Customer Paid, Delivery Charge, Driver Earnings, Tax, Tip, Site Commission.',
    },
    _debug: {
      query: `API GET /billing/getDriverEarningsDetails?driver_id=${params.driver_id}${params.billing_id ? `&billing_id=${params.billing_id}` : ''}`,
      execution_time_ms: Date.now() - start,
      result_count: orders.length,
      timestamp: new Date().toISOString(),
    },
  };
}
