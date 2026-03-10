import { z } from 'zod';
import type { AuthContext } from '../../auth/types.js';
import { getHttpClient } from '../../api/http-client.js';
import { getRestaurantCycleOrders } from '../../api/finance.api.js';
import { ORDER_STATUS_LABELS } from '../../constants/order-status.js';

export const getRestaurantCycleOrdersSchema = z.object({
  cycle_id: z.string().describe('Restaurant billing cycle ID (from list_restaurant_cycles). Required.'),
  page: z.number().min(1).optional().describe('Page number (default 1)'),
  page_size: z.number().min(1).max(50).optional().describe('Results per page (default 20)'),
  country_code: z.string().optional().describe('Country code (DZ, MA, TN, FR, ZA, SN)'),
});

type Params = z.infer<typeof getRestaurantCycleOrdersSchema>;

export async function getRestaurantCycleOrdersHandler(params: Params, ctx?: AuthContext) {
  const start = Date.now();
  const client = getHttpClient();
  if (ctx?.token) client.updateToken(ctx.token);

  const skip = ((params.page ?? 1) - 1) * (params.page_size ?? 20);

  const result = await getRestaurantCycleOrders(client, {
    cycleId: params.cycle_id,
    skip,
    limit: params.page_size ?? 20,
    countryCode: params.country_code ?? ctx?.countryCode,
  });

  const orders = result.data.map((o) => {
    const b = (o.billings ?? {}) as Record<string, Record<string, unknown>>;
    const clientB = b.client ?? b.amount ?? {};
    const restB = b.restaurant ?? {};
    const adminB = b.admin ?? {};

    const foods = Array.isArray(o.foods)
      ? o.foods.map((f) => ({
          name: f.name ?? f.food_name ?? 'N/A',
          price: f.price ?? 0,
          quantity: f.quantity ?? 1,
        }))
      : [];

    return {
      order_id: o.order_id ?? o._id,
      date: o.createdAt,
      status: ORDER_STATUS_LABELS[(o.status ?? -1) as number] ?? String(o.status ?? 'Unknown'),
      payment_method: o.payment_type ?? 'N/A',
      item_amount: clientB.total ?? clientB.food_total ?? 0,
      customer_paid: clientB.grand_total ?? 0,
      ya_commission_ht: adminB.admin_commission ?? 0,
      restaurant_earnings: restB.restaurant_payout ?? 0,
      tax: restB.tax ?? clientB.service_tax ?? 0,
      service_charge: clientB.service_charge ?? 0,
      items_count: foods.length,
    };
  });

  return {
    result: {
      summary: `${result.count} orders in restaurant cycle (showing ${orders.length})`,
      total_count: result.count,
      showing: orders.length,
      cycle_id: params.cycle_id,
      orders,
      display_hint: 'Show as a markdown table: Order ID, Date, Status, Payment, Item Amount, Customer Paid, Ya Commission, Restaurant Earnings, Tax, Service Charge.',
    },
    _debug: {
      query: `API GET /cycles/${params.cycle_id}/orders`,
      execution_time_ms: Date.now() - start,
      result_count: orders.length,
      timestamp: new Date().toISOString(),
    },
  };
}
