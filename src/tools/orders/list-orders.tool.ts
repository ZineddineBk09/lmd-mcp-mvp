import { z } from 'zod';
import type { AuthContext } from '../../auth/types.js';
import { getHttpClient } from '../../api/http-client.js';
import { listOrders } from '../../api/orders.api.js';
import { ORDER_STATUS_LABELS } from '../../constants/order-status.js';

export const listOrdersSchema = z.object({
  limit: z.number().min(1).max(50).optional().describe('Max results to return (1-50, default 20)'),
  skip: z.number().min(0).optional().describe('Number of results to skip for pagination'),
  order_id: z.string().optional().describe('Filter by specific order ID (YAF-... or MongoDB _id)'),
  user_phone: z.string().optional().describe('Filter by customer phone number'),
  user_email: z.string().optional().describe('Filter by customer email'),
  user_first_name: z.string().optional().describe('Filter by customer first name'),
  user_last_name: z.string().optional().describe('Filter by customer last name'),
  country_code: z.string().optional().describe('Country code filter (DZ, MA, TN, FR, ZA, SN)'),
  status: z
    .union([z.number(), z.array(z.number())])
    .optional()
    .describe(
      'Status code(s) for reference only — backend does NOT filter by status. Use to guide post-processing. 1=Received, 3=Accepted, 5=Driver Accepted, 6=Picked Up, 7=Delivered, 9=Cancelled by User, 10=Cancelled by Admin',
    ),
});

type ListOrdersParams = z.infer<typeof listOrdersSchema>;

export async function listOrdersHandler(params: ListOrdersParams, ctx?: AuthContext) {
  const start = Date.now();
  const client = getHttpClient();

  if (ctx?.token) {
    client.updateToken(ctx.token);
  }

  const result = await listOrders(client, {
    limit: params.limit ?? 20,
    skip: params.skip ?? 0,
    orderId: params.order_id,
    userPhone: params.user_phone,
    userEmail: params.user_email,
    userFirstName: params.user_first_name,
    userLastName: params.user_last_name,
    countryCode: params.country_code ?? ctx?.countryCode,
    status: params.status,
  });

  const orders = result.orders.map((o) => ({
    _id: o._id,
    order_id: o.order_id,
    status: o.status,
    status_label: ORDER_STATUS_LABELS[o.status] ?? `Unknown (${o.status})`,
    customer: o.user?.username ?? 'N/A',
    customer_phone: o.user?.phone?.number ?? 'N/A',
    restaurant: o.restaurant?.restaurantname ?? 'N/A',
    driver: o.driver?.username ?? 'N/A',
    total: o.billings?.amount?.grand_total ?? 0,
    delivery_fee: o.billings?.amount?.delivery_amount ?? 0,
    created_at: o.createdAt,
  }));

  return {
    result: {
      summary: `Found ${result.count} orders (showing ${orders.length})`,
      total_count: result.count,
      showing: orders.length,
      orders,
    },
    _debug: {
      query: `API POST /orders/list-dashboard`,
      execution_time_ms: Date.now() - start,
      result_count: orders.length,
      timestamp: new Date().toISOString(),
    },
  };
}
