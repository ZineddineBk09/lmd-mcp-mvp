import { z } from 'zod';
import type { AuthContext } from '../../auth/types.js';
import { getHttpClient } from '../../api/http-client.js';
import { rejectOrder, getOrderDetails, getRejectionReasons } from '../../api/orders.api.js';
import { ORDER_STATUS_LABELS } from '../../constants/order-status.js';

const REJECTABLE_STATUSES = [1, 3, 5, 6, 11, 13, 15, 17];

export const rejectOrderSchema = z.object({
  id: z.string().describe('Order ID to reject — MongoDB _id (24-char hex) or YAF-... order_id'),
  reason: z.string().optional().describe('Rejection reason text (from available_reasons list). If omitted during preview, available reasons will be listed.'),
  reason_id: z.string().optional().describe('The _id of the selected rejection reason from the available_reasons list. Pass alongside reason text.'),
  confirmed: z.boolean().optional().describe('Set to true to execute the rejection. Omit or false to get a preview first.'),
});

type RejectOrderParams = z.infer<typeof rejectOrderSchema>;

export async function rejectOrderHandler(params: RejectOrderParams, ctx?: AuthContext) {
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

  if (!REJECTABLE_STATUSES.includes(status)) {
    return {
      result: {
        success: false,
        action: 'reject_order',
        error: `Cannot reject this order. Current status is "${ORDER_STATUS_LABELS[status] ?? status}" which cannot be rejected.`,
        order_id: order.order_id,
        current_status: ORDER_STATUS_LABELS[status] ?? `Unknown (${status})`,
      },
    };
  }

  if (!params.confirmed) {
    let availableReasons: Array<{ id: string; reason: string }> = [];
    try {
      const reasons = await getRejectionReasons(client, ctx?.countryCode);
      availableReasons = reasons.map((r) => ({
        id: r._id,
        reason: r.reason ?? r.title ?? r.name ?? 'Unknown reason',
      }));
    } catch {
      // Reasons fetch is best-effort
    }

    return {
      result: {
        action: 'reject_order',
        requires_confirmation: true,
        preview: {
          message: `This will REJECT order #${order.order_id}`,
          order_id: order.order_id,
          current_status: ORDER_STATUS_LABELS[status] ?? `Unknown (${status})`,
          customer: (user?.username as string) ?? 'N/A',
          customer_phone: userPhone ? `${userPhone.code ?? ''}${userPhone.number ?? ''}` : 'N/A',
          restaurant: (rest?.restaurantname as string) ?? 'N/A',
          item_count: foods.length,
          total: amt?.grand_total ?? 0,
          effect: 'Order will be marked as Restaurant Rejected. Customer will be notified. Any assigned driver will be unassigned. This action is IRREVERSIBLE.',
          available_reasons: availableReasons,
        },
        instruction:
          'Present this preview to the user. Ask them to select a rejection reason from available_reasons (pass both reason text and reason_id). Then call reject_order again with confirmed=true.',
      },
    };
  }

  // Resolve actual reason text: prefer fetching from reasons list by ID
  let reasonText = params.reason ?? '';
  if (params.reason_id) {
    try {
      const reasons = await getRejectionReasons(client, ctx?.countryCode);
      const match = reasons.find((r) => r._id === params.reason_id);
      if (match) {
        reasonText = match.reason ?? match.title ?? match.name ?? reasonText;
      }
    } catch {
      // Fall back to provided reason text
    }
  }

  if (!reasonText) {
    return {
      result: {
        success: false,
        action: 'reject_order',
        error: 'A rejection reason is required. Please select one from the available_reasons list.',
        order_id: order.order_id,
      },
    };
  }

  const username = ctx?.username ?? 'mcp-agent';
  const result = await rejectOrder(client, params.id, username, reasonText, ctx?.countryCode);

  if (!result.success) {
    return {
      result: {
        success: false,
        action: 'reject_order',
        error: result.message ?? 'Reject failed',
        order_id: order.order_id,
        current_status: ORDER_STATUS_LABELS[status] ?? `Unknown (${status})`,
      },
      _debug: {
        query: `API POST /orders/reject { id: "${params.id}" }`,
        execution_time_ms: Date.now() - start,
        result_count: 0,
        timestamp: new Date().toISOString(),
      },
    };
  }

  return {
    result: {
      success: true,
      action: 'reject_order',
      message: `Order #${order.order_id} has been rejected.`,
      order_id: order.order_id,
      previous_status: ORDER_STATUS_LABELS[status],
      new_status: 'Restaurant Rejected',
      reason: reasonText || 'No reason provided',
      performed_by: username,
    },
    _debug: {
      query: `API POST /orders/reject { id: "${params.id}" }`,
      execution_time_ms: Date.now() - start,
      result_count: 1,
      timestamp: new Date().toISOString(),
    },
  };
}
