import type { HttpClient } from './http-client.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ListOrdersParams {
  limit?: number;
  skip?: number;
  sort?: Record<string, 1 | -1>;
  orderId?: string;
  userPhone?: string;
  userEmail?: string;
  userFirstName?: string;
  userLastName?: string;
  countryCode?: string;
  /** NOTE: Backend /orders/list-dashboard does NOT support status filtering. */
  status?: number | number[];
}

export interface OrderSummary {
  _id: string;
  order_id: string;
  status: number;
  user?: { username?: string; phone?: { number?: string } };
  restaurant?: { restaurantname?: string };
  driver?: { username?: string };
  billings?: { amount?: { grand_total?: number; delivery_amount?: number } };
  createdAt?: string;
  [key: string]: unknown;
}

export interface ListOrdersResult {
  orders: OrderSummary[];
  count: number;
}

export interface OrderFood {
  id?: string;
  name: string;
  price: number;
  quantity: number;
  offer_price?: number;
  instruction?: string;
  addons?: Array<{ name?: string; price?: number }>;
  type_pack?: Array<{
    t_name?: string;
    sub_pack?: Array<{ name?: string; price?: number }>;
  }>;
  main_category?: string;
  sub_category?: string;
  offert?: boolean;
  price_original?: number;
  categoryname?: string;
  food_name_i18n?: Record<string, string>;
}

export interface OrderDetails {
  _id: string;
  order_id: string;
  status: number;
  seen_status?: number;
  version?: string;
  createdAt?: string;

  // Unwrapped by our normalization (originally arrays from $lookup)
  user?: Record<string, unknown>;
  restaurant?: Record<string, unknown>;
  driver?: Record<string, unknown>;

  billings?: {
    amount?: {
      total?: number;
      grand_total?: number;
      delivery_amount?: number;
      service_charge?: number;
      service_tax?: number;
      driver_charge?: number;
      offer_discount?: number;
      coupon_discount?: number;
      food_offer_price?: number;
      night_fee?: number;
      surge_fee?: number;
      package_charge?: number;
    };
    restaurant?: {
      food_total?: number;
      restaurant_payout?: number;
      restaurant_commision?: number;
      admin_commission?: number;
    };
    driver?: {
      driver_payout?: number;
      driver_commission?: number;
    };
    epay?: { method?: string; status?: string };
  };

  foods?: OrderFood[];
  foods_purchased?: OrderFood[];
  cobrand_products?: unknown[];

  delivery_address?: {
    street?: string;
    fulladres?: string;
    building?: string;
    floor?: number | string;
    door?: number | string;
    landmark?: string;
    type?: string;
    loc?: { lat?: number | string; lng?: number | string };
  };

  order_log?: Record<string, unknown>;
  order_logs?: Array<Record<string, unknown>>;

  country_details?: {
    country_code?: string;
    country_name?: string;
    currency_symbol?: string;
  };

  is_pickup_order?: boolean;
  isReadyForPickup?: boolean;
  readyForPickupAt?: string;
  for_someone_else?: boolean;
  ofse_details?: Record<string, unknown>;
  fraud_suspecion?: boolean;
  coupon_code?: string;
  coupon_details?: Record<string, unknown>;
  discount_price?: number;
  free_delivery_coupon_code?: string;
  yassir_plus?: Record<string, unknown>;
  epayment?: Record<string, unknown>;
  ept?: number | string;
  needRefundAmount?: boolean;
  auto_accept_orders?: boolean;
  auto_accept_orders_minutes?: number;
  converted_money?: Record<string, unknown>;
  delivered_phone_numbers?: string[];

  [key: string]: unknown;
}

export interface ActionResult {
  success: boolean;
  message?: string;
  order?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ReasonOption {
  _id: string;
  reason?: string;
  sort_reason?: string;
  type?: string;
  status?: number;
  isOnlyAdmin?: boolean;
  /** Legacy alias fields — backend actually returns `reason` */
  title?: string;
  name?: string;
  [key: string]: unknown;
}

// ── API Functions ────────────────────────────────────────────────────

export async function listOrders(client: HttpClient, params: ListOrdersParams): Promise<ListOrdersResult> {
  const body: Record<string, unknown> = {
    limit: params.limit ?? 20,
    skip: params.skip ?? 0,
  };

  // Backend reads countryCode from req.body (not just the header)
  if (params.countryCode) body.countryCode = params.countryCode;

  // Backend expects sort as { sort_by: string, order_by: string }
  // e.g. { sort_by: "createdAt", order_by: "desc" }
  if (params.sort) {
    const entries = Object.entries(params.sort);
    if (entries.length > 0) {
      const [field, direction] = entries[0];
      body.sort = {
        sort_by: field,
        order_by: direction === -1 ? 'desc' : 'asc',
      };
    }
  }

  if (params.orderId) body.orderId = params.orderId;
  if (params.userPhone) body.userPhone = params.userPhone;
  if (params.userEmail) body.userEmail = params.userEmail;
  if (params.userFirstName) body.userFirstName = params.userFirstName;
  if (params.userLastName) body.userLastName = params.userLastName;

  const response = await client.post<[OrderSummary[], number] | { data: OrderSummary[]; count: number }>('/orders/list-dashboard', body, params.countryCode);

  // Backend always returns [ordersArray, count] tuple
  if (Array.isArray(response)) {
    return { orders: response[0] ?? [], count: response[1] ?? 0 };
  }
  return {
    orders: (response as { data: OrderSummary[] }).data ?? [],
    count: (response as { count: number }).count ?? 0,
  };
}

/**
 * Fetches full order details via the backend API.
 * Handles the array-wrapped response from getOrderDetailsOptimized
 * and normalizes $lookup arrays (user, restaurants, driver) into plain objects.
 */
export async function getOrderDetails(client: HttpClient, id: string, countryCode?: string): Promise<OrderDetails> {
  const response = await client.post<unknown>('/get/order-details', { id }, countryCode);

  let order: OrderDetails;

  // Backend wraps response in array: res.send([orderData])
  if (Array.isArray(response)) {
    if (response.length === 0) {
      throw new Error(`Order not found: ${id}`);
    }
    order = response[0] as OrderDetails;
  } else if (response && typeof response === 'object' && 'data' in response && (response as Record<string, unknown>).data) {
    order = (response as { data: OrderDetails }).data;
  } else {
    order = response as OrderDetails;
  }

  if (order.status === undefined || order.status === null) {
    throw new Error(`Order ${id} returned with no status — response may be malformed`);
  }

  // Backend $lookup stages return user/restaurants/driver as arrays — unwrap
  if (Array.isArray(order.user)) {
    order.user = order.user[0] ?? undefined;
  }
  const raw = order as Record<string, unknown>;
  if (Array.isArray(raw.restaurants)) {
    order.restaurant = (raw.restaurants as Record<string, unknown>[])[0] ?? undefined;
  }
  if (Array.isArray(order.driver)) {
    order.driver = order.driver[0] ?? undefined;
  }

  return order;
}

export async function acceptOrder(client: HttpClient, orderId: string, username: string, countryCode?: string): Promise<ActionResult> {
  const response = await client.post<Record<string, unknown>>(
    '/orders/accept/v2',
    {
      id: orderId,
      actionInfo: {
        status: 'order received',
        user: username,
        action: 'Adminacceptedorder',
      },
    },
    countryCode,
  );

  // Backend returns { status: 0, message } for validation errors (with 200 status)
  if (response.status === 0) {
    return { success: false, message: (response.message as string) ?? 'Accept failed' };
  }

  // Success: { message: "Successfully Accepted" }
  return { success: true, message: (response.message as string) ?? 'Successfully Accepted' };
}

export async function rejectOrder(client: HttpClient, orderId: string, username: string, cancelReason?: string, countryCode?: string): Promise<ActionResult> {
  const response = await client.post<Record<string, unknown>>(
    '/orders/reject',
    {
      id: orderId,
      cancelReason: cancelReason ?? '',
      actionInfo: { user: username },
    },
    countryCode,
  );

  // Backend returns { status: 0, message } for validation errors (with 200 status)
  if (response.status === 0) {
    return { success: false, message: (response.message as string) ?? 'Reject failed' };
  }

  // Revamp: { message: "Successfully Rejected" }, Legacy: full order document
  return { success: true, message: (response.message as string) ?? 'Successfully Rejected' };
}

export interface CancelOptions {
  returned?: boolean;
  defer_refund?: boolean;
  refund?: { method: 'wallet' | 'original'; refund_reason?: string };
}

export async function cancelOrder(client: HttpClient, orderId: string, role: string, username: string, reason?: string, countryCode?: string, options?: CancelOptions): Promise<ActionResult> {
  const body: Record<string, unknown> = {
    id: orderId,
    val: { role, username },
    values: reason ?? '',
  };

  if (options?.returned) body.returned = true;
  if (options?.defer_refund) body.defer_refund = true;
  if (options?.refund) body.refund = options.refund;

  const response = await client.post<unknown>('/get/cancel', body, countryCode);

  // Backend returns plain strings for specific error conditions (all with 200 status)
  if (typeof response === 'string') {
    if (response === 'Invalid') {
      return { success: false, message: 'Invalid order — order not found or cannot be cancelled' };
    }
    if (response === 'Assigned') {
      return { success: false, message: 'Order is assigned to a driver at status 10 — already cancelled' };
    }
    if (response === 'Delivered') {
      return { success: false, message: 'Order is delivered — refund method (wallet/original) must be specified' };
    }
    return { success: false, message: `Unexpected response: ${response}` };
  }

  // Backend returns { status: 0, message } for validation errors
  const res = response as Record<string, unknown>;
  if (res.status === 0) {
    return { success: false, message: (res.message as string) ?? 'Cancel failed' };
  }

  // On success, backend returns the full updated order document
  return { success: true, message: 'Order cancelled successfully', order: res };
}

export async function getCancellationReasons(client: HttpClient, countryCode?: string): Promise<ReasonOption[]> {
  const response = await client.post<unknown>('/cancellation/list', {}, countryCode);

  // Backend returns [documents, count] tuple — extract documents from index 0
  if (Array.isArray(response)) {
    const docs = response[0];
    return Array.isArray(docs) ? (docs as ReasonOption[]) : [];
  }
  if (response && typeof response === 'object' && 'data' in response) {
    return (response as { data: ReasonOption[] }).data ?? [];
  }
  return [];
}

export async function getRejectionReasons(client: HttpClient, countryCode?: string): Promise<ReasonOption[]> {
  const response = await client.post<unknown>('/rejection/list', {}, countryCode);

  // Backend returns [documents, count] tuple — extract documents from index 0
  if (Array.isArray(response)) {
    const docs = response[0];
    return Array.isArray(docs) ? (docs as ReasonOption[]) : [];
  }
  if (response && typeof response === 'object' && 'data' in response) {
    return (response as { data: ReasonOption[] }).data ?? [];
  }
  return [];
}
