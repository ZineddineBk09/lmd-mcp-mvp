import { z } from 'zod';
import type { AuthContext } from '../../auth/types.js';
import { getHttpClient } from '../../api/http-client.js';
import { cancelOrder, getOrderDetails, getCancellationReasons, type CancelOptions } from '../../api/orders.api.js';
import { ORDER_STATUS_LABELS } from '../../constants/order-status.js';

const FINAL_STATES = [0, 2, 9, 10, 11, 14, 90];
const DELIVERED_STATUS = 7;
const NOT_AUTHORIZED_STATUS = 0;
const ORDER_RECEIVED_STATUS = 1;
const RETURN_BLOCKED_STATUSES = [NOT_AUTHORIZED_STATUS, ORDER_RECEIVED_STATUS];

export const cancelOrderSchema = z.object({
  id: z.string().describe('Order ID to cancel — MongoDB _id (24-char hex) or YAF-... order_id'),
  reason_number: z
    .number()
    .optional()
    .describe(
      'The 1-indexed number of the reason from the available_reasons list displayed in the preview. ' +
        "When the user picks a number (e.g. '3' for 'Duplicate order'), pass that number here. " +
        'The tool will resolve it to the correct reason text automatically.',
    ),
  reason: z
    .string()
    .optional()
    .describe("Custom cancellation reason text. Required when reason_number points to 'Other' or 'Retour'. " + 'For standard reasons, this is auto-resolved from reason_number — no need to set it.'),
  refund_method: z.enum(['wallet', 'original']).optional().describe("For delivered or e-payment orders: refund to 'wallet' (Yassir Cash) or 'original' (original payment method). Default: wallet."),
  confirmed: z.boolean().optional().describe('Set to true to execute the cancellation. Omit or false to get a preview first.'),
});

type CancelOrderParams = z.infer<typeof cancelOrderSchema>;

interface NumberedReason {
  number: number;
  id: string;
  reason: string;
  type: 'api' | 'custom_other' | 'custom_return';
}

async function buildReasonsList(client: ReturnType<typeof getHttpClient>, countryCode?: string, orderStatus?: number): Promise<NumberedReason[]> {
  const list: NumberedReason[] = [];
  let idx = 1;

  try {
    const apiReasons = await getCancellationReasons(client, countryCode);
    for (const r of apiReasons) {
      list.push({
        number: idx++,
        id: r._id,
        reason: r.reason ?? r.title ?? r.name ?? 'Unknown reason',
        type: 'api',
      });
    }
  } catch {
    // Best-effort
  }

  list.push({
    number: idx++,
    id: '__custom_reason_other__',
    reason: 'Other (custom reason)',
    type: 'custom_other',
  });

  const allowReturn = orderStatus == null || !RETURN_BLOCKED_STATUSES.includes(orderStatus);
  if (allowReturn) {
    list.push({
      number: idx++,
      id: '__custom_reason_return__',
      reason: 'Retour (mark order as returned)',
      type: 'custom_return',
    });
  }

  return list;
}

export async function cancelOrderHandler(params: CancelOrderParams, ctx?: AuthContext) {
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
  const driver = order.driver as Record<string, unknown> | undefined;
  const amt = order.billings?.amount;
  const epay = order.billings?.epay ?? (order.epayment as Record<string, unknown> | undefined);
  const foods = order.foods ?? order.foods_purchased ?? [];
  const isDelivered = status === DELIVERED_STATUS;
  const needRefundAmount = Boolean(order.needRefundAmount);

  const paymentMethod = ((epay?.method as string) ?? '').toUpperCase();
  const isEpayment = paymentMethod && paymentMethod !== 'CASH' && paymentMethod !== 'COD';
  const requiresRefundFlow = isEpayment || isDelivered;

  // ── Block final states ──
  if (FINAL_STATES.includes(status)) {
    const statusLabel = ORDER_STATUS_LABELS[status] ?? `Unknown (${status})`;
    let reason = `it is already in a final state (${statusLabel})`;
    if (status === 0) reason = 'it has been deleted';
    else if (status === 2) reason = 'it has been rejected by the restaurant';
    else if (status === 9) reason = 'it has already been cancelled by the user';
    else if (status === 10) reason = 'it has already been cancelled by admin';
    else if (status === 11) reason = 'it has timed out';
    else if (status === 14) reason = 'payment is pending';
    else if (status === 90) reason = 'it was already cancelled after pickup';

    return {
      result: {
        success: false,
        action: 'cancel_order',
        error: `Cannot cancel this order — ${reason}.`,
        order_id: order.order_id,
        current_status: statusLabel,
      },
    };
  }

  // ── Block delivered orders with pending refund ──
  if (isDelivered && needRefundAmount) {
    return {
      result: {
        success: false,
        action: 'cancel_order',
        error: 'Cannot cancel this delivered order — it already has a pending refund. The refund must be processed or resolved first.',
        order_id: order.order_id,
        current_status: 'Order Delivered',
        has_pending_refund: true,
      },
    };
  }

  // ── Build numbered reasons list (used in both preview and confirmation) ──
  const reasonsList = await buildReasonsList(client, ctx?.countryCode, status);

  // ── PREVIEW MODE ──
  if (!params.confirmed) {
    let effect: string;
    if (isDelivered) {
      effect = "WARNING: This order is already DELIVERED. Cancelling it will flag it for refund processing. You must specify a refund_method ('wallet' or 'original'). This action is IRREVERSIBLE.";
    } else if (isEpayment) {
      effect = "This is an e-payment order. Cancelling will trigger a refund. You must specify a refund_method ('wallet' or 'original'). This action is IRREVERSIBLE.";
    } else {
      effect = 'Order will be cancelled by admin. Customer, restaurant, and driver (if assigned) will be notified. This action is IRREVERSIBLE.';
    }

    return {
      result: {
        action: 'cancel_order',
        requires_confirmation: true,
        preview: {
          message: `This will CANCEL order #${order.order_id}`,
          order_id: order.order_id,
          current_status: ORDER_STATUS_LABELS[status] ?? `Unknown (${status})`,
          customer: (user?.username as string) ?? 'N/A',
          customer_phone: userPhone ? `${userPhone.code ?? ''}${userPhone.number ?? ''}` : 'N/A',
          restaurant: (rest?.restaurantname as string) ?? 'N/A',
          driver: driver ? ((driver.username as string) ?? 'N/A') : 'Not assigned',
          item_count: foods.length,
          total: amt?.grand_total ?? 0,
          payment_method: paymentMethod || 'CASH',
          is_delivered: isDelivered,
          requires_refund: requiresRefundFlow,
          effect,
          available_reasons: reasonsList.map((r) => ({
            number: r.number,
            reason: r.reason,
            type: r.type,
          })),
        },
        instruction:
          'Present this preview to the user and list available_reasons by number. ' +
          'Ask the user to pick a reason number. ' +
          'Then call cancel_order again with confirmed=true and reason_number=<the number the user chose>. ' +
          "If the user picks 'Other' or 'Retour', ALSO ask for a custom reason text and pass it in the 'reason' parameter. " +
          (requiresRefundFlow ? "This order requires a refund — also ask for refund_method: 'wallet' (recommended) or 'original'. " : ''),
      },
    };
  }

  // ── CONFIRMATION MODE ──

  // Resolve the selected reason from reason_number
  let selectedReason: NumberedReason | undefined;
  let reasonText = '';
  let isReturn = false;

  if (params.reason_number != null) {
    selectedReason = reasonsList.find((r) => r.number === params.reason_number);
    if (!selectedReason) {
      return {
        result: {
          success: false,
          action: 'cancel_order',
          error: `Invalid reason_number ${params.reason_number}. Valid range: 1–${reasonsList.length}. Please pick from the available_reasons list.`,
          order_id: order.order_id,
          available_reasons: reasonsList.map((r) => ({
            number: r.number,
            reason: r.reason,
          })),
        },
      };
    }

    if (selectedReason.type === 'custom_other') {
      // "Other" — user MUST provide custom text
      const customText = params.reason?.trim();
      const GENERIC_LABELS = ['other', 'autre', 'other (custom reason)'];
      if (!customText || GENERIC_LABELS.includes(customText.toLowerCase())) {
        return {
          result: {
            success: false,
            action: 'cancel_order',
            requires_custom_reason: true,
            reason_type: 'other',
            order_id: order.order_id,
            error:
              "You selected 'Other' — please ask the user to type a specific cancellation reason, then call cancel_order again with that text in the 'reason' parameter and the same reason_number.",
          },
        };
      }
      reasonText = customText;
    } else if (selectedReason.type === 'custom_return') {
      // "Retour" — user MUST provide custom text
      isReturn = true;
      const customText = params.reason?.trim();
      const GENERIC_LABELS = ['retour', 'return', 'retour (mark order as returned)'];
      if (!customText || GENERIC_LABELS.includes(customText.toLowerCase())) {
        return {
          result: {
            success: false,
            action: 'cancel_order',
            requires_custom_reason: true,
            reason_type: 'return',
            order_id: order.order_id,
            error: "You selected 'Retour' — please ask the user for a return reason, then call cancel_order again with that text in the 'reason' parameter, the same reason_number.",
          },
        };
      }
      reasonText = customText;
    } else {
      // Standard API reason — use the reason text from the list
      reasonText = selectedReason.reason;
    }
  } else if (params.reason) {
    // Fallback: LLM passed reason text directly without reason_number
    reasonText = params.reason;
  }

  if (!reasonText) {
    return {
      result: {
        success: false,
        action: 'cancel_order',
        error: 'A cancellation reason is required. Call cancel_order with confirmed=false first to see available reasons, then pass reason_number.',
        order_id: order.order_id,
      },
    };
  }

  // ── Execute cancellation ──
  const username = ctx?.username ?? 'mcp-agent';
  const role = ctx?.role ?? 'admin';

  const cancelOptions: CancelOptions = {};
  if (isReturn) {
    cancelOptions.returned = true;
  }
  if (isDelivered && requiresRefundFlow) {
    cancelOptions.defer_refund = true;
    cancelOptions.refund = {
      method: params.refund_method ?? 'wallet',
      refund_reason: reasonText,
    };
  }

  const result = await cancelOrder(client, params.id, role, username, reasonText, ctx?.countryCode, cancelOptions);

  if (!result.success) {
    return {
      result: {
        success: false,
        action: 'cancel_order',
        error: result.message ?? 'Cancellation failed',
        order_id: order.order_id,
        current_status: ORDER_STATUS_LABELS[status] ?? `Unknown (${status})`,
      },
      _debug: {
        query: `API POST /get/cancel { id: "${params.id}" }`,
        execution_time_ms: Date.now() - start,
        result_count: 0,
        timestamp: new Date().toISOString(),
      },
    };
  }

  let successMessage = `Order #${order.order_id} has been cancelled by admin.`;
  if (isReturn) {
    successMessage = `Order #${order.order_id} has been marked as returned and cancelled.`;
  } else if (isDelivered) {
    successMessage = `Order #${order.order_id} has been cancelled. Refund has been flagged for manual processing in "Orders To Refund".`;
  }

  return {
    result: {
      success: true,
      action: 'cancel_order',
      message: successMessage,
      order_id: order.order_id,
      previous_status: ORDER_STATUS_LABELS[status],
      new_status: isReturn ? 'Returned' : 'Cancelled by Admin',
      reason: reasonText,
      refund_method: requiresRefundFlow ? (params.refund_method ?? 'wallet') : undefined,
      is_return: isReturn,
      performed_by: username,
    },
    _debug: {
      query: `API POST /get/cancel { id: "${params.id}" }`,
      execution_time_ms: Date.now() - start,
      result_count: 1,
      timestamp: new Date().toISOString(),
    },
  };
}
