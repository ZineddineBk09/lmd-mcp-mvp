import { z } from 'zod';
import type { AuthContext } from '../../auth/types.js';
import { getHttpClient } from '../../api/http-client.js';
import { acceptOrder, getOrderDetails } from '../../api/orders.api.js';
import { ORDER_STATUS_LABELS } from '../../constants/order-status.js';

const ACCEPTABLE_STATUSES = [1, 2, 11];

export const acceptOrderSchema = z.object({
  id: z.string().describe('Order ID to accept — MongoDB _id (24-char hex) or YAF-... order_id'),
  confirmed: z.boolean().optional().describe('Set to true to execute the action. Omit or false to get a preview first.'),
});

type AcceptOrderParams = z.infer<typeof acceptOrderSchema>;

export async function acceptOrderHandler(params: AcceptOrderParams, ctx?: AuthContext) {
  const start = Date.now();
  const client = getHttpClient();

  if (ctx?.token) {
    client.updateToken(ctx.token);
  }

  const order = await getOrderDetails(client, params.id, ctx?.countryCode);
  const status = order.status;
  const user = order.user as Record<string, unknown> | undefined;
  const userPhone = user?.phone as Record<string, unknown> | undefined;
  const rest = order.restaurant as Record<string, unknown> | undefined;
  const amt = order.billings?.amount;
  const foods = order.foods ?? order.foods_purchased ?? [];

  if (Boolean(order.is_pickup_order)) {
    return {
      result: {
        success: false,
        action: 'accept_order',
        error: 'Cannot accept this order — it is a pickup order. Pickup orders are auto-accepted and cannot be manually accepted.',
        order_id: order.order_id,
        current_status: ORDER_STATUS_LABELS[status] ?? `Unknown (${status})`,
        is_pickup_order: true,
      },
    };
  }

  if (!ACCEPTABLE_STATUSES.includes(status)) {
    return {
      result: {
        success: false,
        action: 'accept_order',
        error: `Cannot accept this order. Current status is "${ORDER_STATUS_LABELS[status] ?? status}" which is not in an acceptable state. Only orders with status Order Received, Restaurant Rejected, or Timeout can be accepted.`,
        order_id: order.order_id,
        current_status: ORDER_STATUS_LABELS[status] ?? `Unknown (${status})`,
      },
    };
  }

  if (!params.confirmed) {
    return {
      result: {
        action: 'accept_order',
        requires_confirmation: true,
        preview: {
          message: `This will ACCEPT order #${order.order_id}`,
          order_id: order.order_id,
          current_status: ORDER_STATUS_LABELS[status] ?? `Unknown (${status})`,
          customer: (user?.username as string) ?? 'N/A',
          customer_phone: userPhone ? `${userPhone.code ?? ''}${userPhone.number ?? ''}` : 'N/A',
          restaurant: (rest?.restaurantname as string) ?? 'N/A',
          item_count: foods.length,
          total: amt?.grand_total ?? 0,
          effect: 'Order will be accepted and dispatched to a driver. Restaurant and customer will be notified.',
        },
        instruction: 'Present this preview to the user. If they confirm, call accept_order again with confirmed=true.',
      },
    };
  }

  const username = ctx?.username ?? 'mcp-agent';
  const result = await acceptOrder(client, params.id, username, ctx?.countryCode);

  if (!result.success) {
    return {
      result: {
        success: false,
        action: 'accept_order',
        error: result.message ?? 'Accept failed',
        order_id: order.order_id,
        current_status: ORDER_STATUS_LABELS[status] ?? `Unknown (${status})`,
      },
      _debug: {
        query: `API POST /orders/accept/v2 { id: "${params.id}" }`,
        execution_time_ms: Date.now() - start,
        result_count: 0,
        timestamp: new Date().toISOString(),
      },
    };
  }

  return {
    result: {
      success: true,
      action: 'accept_order',
      message: `Order #${order.order_id} has been accepted successfully.`,
      order_id: order.order_id,
      previous_status: ORDER_STATUS_LABELS[status],
      new_status: 'Restaurant Accepted',
      performed_by: username,
    },
    _debug: {
      query: `API POST /orders/accept/v2 { id: "${params.id}" }`,
      execution_time_ms: Date.now() - start,
      result_count: 1,
      timestamp: new Date().toISOString(),
    },
  };
}
