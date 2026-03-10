import type { HttpClient } from './http-client.js';

// ── Cycle Status Labels ─────────────────────────────────────────────

export const CYCLE_STATUS_LABELS: Record<number, string> = {
  0: 'Invalid',
  1: 'Active',
  2: 'In Review',
  3: 'Settled',
  4: 'Paid',
  5: 'Interrupted',
  6: 'Cancelled',
  7: 'Settling',
  8: 'Manually Settled',
};

// ── Admin Earnings ──────────────────────────────────────────────────

export interface AdminEarningsParams {
  city?: string;
  area?: string;
  service?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
  ofse?: boolean;
  page?: number;
  pageSize?: number;
  countryCode?: string;
}

export interface AdminEarningsOrderDetail {
  _id: string;
  order_id?: string;
  status: number;
  createdAt?: string;
  Country?: string;
  City?: string;
  Area?: string;
  restaurant_address?: string;
  customer_address?: string;
  driver_name?: string;
  restaurant?: Record<string, unknown>;
  user?: Record<string, unknown>;
  billings?: {
    client?: Record<string, unknown>;
    restaurant?: Record<string, unknown>;
    driver?: Record<string, unknown>;
    admin?: Record<string, unknown>;
  };
  categories?: string[];
  for_someone_else?: boolean;
  store_type?: string;
  [key: string]: unknown;
}

export interface AdminEarningsResult {
  count: number;
  orderDetails: AdminEarningsOrderDetail[];
  restaurant_total: Record<string, unknown>;
  driver_total: Record<string, unknown>;
  admin_total: Record<string, unknown>;
  defaultDateRangeApplied?: boolean;
  defaultDateRange?: { start: string; end: string };
}

function buildFilterString(params: AdminEarningsParams): string {
  const parts: string[] = [];
  if (params.city) parts.push(`c:${params.city}`);
  if (params.area) parts.push(`l:${params.area}`);
  if (params.startDate) parts.push(`s:${params.startDate}`);
  if (params.endDate) parts.push(`e:${params.endDate}`);
  if (params.service) parts.push(`sc:${params.service}`);
  if (params.search) parts.push(`q:${params.search}`);
  if (params.ofse) parts.push('ofse:true');
  return parts.join('|');
}

export async function getAdminEarnings(client: HttpClient, params: AdminEarningsParams): Promise<AdminEarningsResult> {
  const query: Record<string, string> = {
    pageId: String(params.page ?? 1),
    limit: String(params.pageSize ?? 20),
  };

  const filters = buildFilterString(params);
  if (filters) query.filters = filters;

  const response = await client.get<Record<string, unknown>>('/billing/adminEarnings', query, params.countryCode);

  return {
    count: (response.count as number) ?? 0,
    orderDetails: (response.orderDetails as AdminEarningsOrderDetail[]) ?? [],
    restaurant_total: (response.restaurant_total as Record<string, unknown>) ?? {},
    driver_total: (response.driver_total as Record<string, unknown>) ?? {},
    admin_total: (response.admin_total as Record<string, unknown>) ?? {},
    defaultDateRangeApplied: response.defaultDateRangeApplied as boolean | undefined,
    defaultDateRange: response.defaultDateRange as { start: string; end: string } | undefined,
  };
}

// ── Billing Cycles (Driver prerequisite) ────────────────────────────

export interface FetchCyclesParams {
  city: string;
  limit?: number;
  countryCode?: string;
}

export interface BillingCycle {
  _id: string;
  start_date: string;
  end_date: string;
  main_city?: string;
  city_name?: string;
  [key: string]: unknown;
}

export interface FetchCyclesResult {
  cycles: BillingCycle[];
}

export async function fetchCyclesByCity(client: HttpClient, params: FetchCyclesParams): Promise<FetchCyclesResult> {
  const response = await client.post<Record<string, unknown>>('/billing/fetchCyclesByCity', { cityname: params.city, limit: params.limit ?? 20 }, params.countryCode);

  if (response.success === 0) {
    throw new Error((response.err as string) ?? 'Failed to fetch billing cycles');
  }

  return {
    cycles: (response.cycles as BillingCycle[]) ?? [],
  };
}

// ── Driver Earnings ─────────────────────────────────────────────────

export interface DriverEarningsParams {
  billingCycle: string;
  status?: string;
  search?: string;
  page?: number;
  pageSize?: number;
  countryCode?: string;
}

export interface DriverPayoutEntry {
  _id?: string;
  driver_id?: string;
  driver_name?: string;
  driver_type?: string;
  phone?: string;
  location?: string;
  completed_deliveries?: number;
  returned_orders?: number;
  original_delivery_charge?: number;
  delivery_charge?: number;
  driver_brut?: number;
  driver_tax?: number;
  total_tip?: number;
  driver_bonus?: number;
  driver_net?: number;
  platform_earnings?: number;
  adjustments?: number;
  cash_co?: number;
  paid_status?: number | string;
  cycle_status?: number;
  [key: string]: unknown;
}

export interface DriverEarningsResult {
  driverDetails: DriverPayoutEntry[];
  count: number;
  driver_total: Record<string, unknown>;
  count_drivers?: number;
}

export async function getDriverEarnings(client: HttpClient, params: DriverEarningsParams): Promise<DriverEarningsResult> {
  const query: Record<string, string> = {
    billingCycle: params.billingCycle,
    pageId: String(params.page ?? 1),
    limit: String(params.pageSize ?? 50),
  };

  if (params.status) query.cycleStatus = params.status;
  if (params.search) query.searchString = params.search;

  const response = await client.get<Record<string, unknown>>('/billing/v2/getDriverEarnings', query, params.countryCode);

  return {
    driverDetails: (response.driverDetails as DriverPayoutEntry[]) ?? [],
    count: (response.count as number) ?? 0,
    driver_total: (response.driver_total as Record<string, unknown>) ?? {},
    count_drivers: response.count_drivers as number | undefined,
  };
}

// ── Driver Earnings Details ─────────────────────────────────────────

export interface DriverEarningsDetailsParams {
  driverId: string;
  billingId?: string;
  page?: number;
  pageSize?: number;
  countryCode?: string;
}

export interface DriverOrderDetail {
  _id?: string;
  order_id?: string;
  createdAt?: string;
  billings?: Record<string, unknown>;
  store_type?: string;
  payment_type?: string;
  [key: string]: unknown;
}

export interface DriverPayoutSummary {
  _id?: string;
  driver_id?: string;
  orders?: number;
  returned_orders?: number;
  billing_cycle?: string;
  paid_status?: number;
  billings?: Record<string, unknown>;
  status?: number;
  transaction_id?: string;
  configuration_snapshot?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface DriverEarningsDetailsResult {
  orderDetails: DriverOrderDetail[];
  count: number;
  driver_total: Record<string, unknown>;
  payoutDetails?: DriverPayoutSummary;
}

export async function getDriverEarningsDetails(client: HttpClient, params: DriverEarningsDetailsParams): Promise<DriverEarningsDetailsResult> {
  const query: Record<string, string> = {
    driver_id: params.driverId,
    pageId: String(params.page ?? 1),
    limit: String(params.pageSize ?? 20),
  };

  if (params.billingId) query.billing_id = params.billingId;

  const response = await client.get<Record<string, unknown>>('/billing/getDriverEarningsDetails', query, params.countryCode);

  return {
    orderDetails: (response.orderDetails as DriverOrderDetail[]) ?? [],
    count: (response.count as number) ?? 0,
    driver_total: (response.driver_total as Record<string, unknown>) ?? {},
    payoutDetails: response.payoutDetails as DriverPayoutSummary | undefined,
  };
}

// ── Restaurant Cycle Date Ranges ────────────────────────────────────

export interface RestaurantCycleRangesParams {
  city: string;
  skip?: number;
  limit?: number;
  countryCode?: string;
}

export interface RestaurantCycleRange {
  _id?: string;
  start_date: string;
  end_date: string;
  cycle_ids?: string[];
  [key: string]: unknown;
}

export async function fetchRestaurantCycleDateRanges(client: HttpClient, params: RestaurantCycleRangesParams): Promise<RestaurantCycleRange[]> {
  const query: Record<string, string> = {
    city: params.city,
    skip: String(params.skip ?? 0),
    limit: String(params.limit ?? 20),
  };

  const response = await client.get<Record<string, unknown>>('/restaurant/cycles', query, params.countryCode);

  const cycles = response.cycles ?? response;
  return Array.isArray(cycles) ? (cycles as RestaurantCycleRange[]) : [];
}

// ── Restaurant Cycles List ──────────────────────────────────────────

export interface RestaurantCyclesListParams {
  cycleIds: string[];
  skip?: number;
  limit?: number;
  status?: number;
  countryCode?: string;
}

export interface RestaurantCycleEntry {
  _id: string;
  restaurant_id?: string;
  restaurantname?: string;
  start_date?: string;
  end_date?: string;
  status?: number;
  yassir_pay_store?: boolean;
  logs?: unknown[];
  childCyclesIds?: string[];
  [key: string]: unknown;
}

export interface RestaurantCyclesListResult {
  data: RestaurantCycleEntry[];
  count: number;
}

export async function fetchRestaurantCyclesList(client: HttpClient, params: RestaurantCyclesListParams): Promise<RestaurantCyclesListResult> {
  const body: Record<string, unknown> = {
    cycle_ids: params.cycleIds,
    skip: params.skip ?? 0,
    limit: params.limit ?? 20,
  };

  if (params.status !== undefined) body.status = params.status;

  const response = await client.post<Record<string, unknown>>('/restaurant/cycles-list', body, params.countryCode);

  return {
    data: (response.data as RestaurantCycleEntry[]) ?? [],
    count: (response.count as number) ?? 0,
  };
}

// ── Restaurant Cycle Orders ─────────────────────────────────────────

export interface RestaurantCycleOrdersParams {
  cycleId: string;
  skip?: number;
  limit?: number;
  countryCode?: string;
}

export interface RestaurantOrderEntry {
  _id?: string;
  order_id?: string;
  createdAt?: string;
  payment_type?: string;
  restaurant?: Record<string, unknown>;
  billings?: Record<string, unknown>;
  foods?: Array<Record<string, unknown>>;
  status?: number;
  [key: string]: unknown;
}

export interface RestaurantCycleOrdersResult {
  data: RestaurantOrderEntry[];
  count: number;
}

export async function getRestaurantCycleOrders(client: HttpClient, params: RestaurantCycleOrdersParams): Promise<RestaurantCycleOrdersResult> {
  const query: Record<string, string> = {
    skip: String(params.skip ?? 0),
    limit: String(params.limit ?? 20),
  };

  const response = await client.get<Record<string, unknown>>(`/cycles/${params.cycleId}/orders`, query, params.countryCode);

  return {
    data: (response.data as RestaurantOrderEntry[]) ?? [],
    count: (response.count as number) ?? 0,
  };
}
