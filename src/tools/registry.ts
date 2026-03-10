import { z } from 'zod';
import type { AuthContext, ToolSource } from '../auth/types.js';
import { queryOrdersSchema, queryOrders } from './orders/query-orders.tool.js';
import { needsAttentionSchema, getNeedsAttention } from './orders/needs-attention.tool.js';
import { orderSlaSchema, getOrderSlaStatus } from './orders/order-sla.tool.js';
import { fleetStatusSchema, fleetStatus } from './fleet/fleet-status.tool.js';
import { supplyDemandSchema, getSupplyDemandBalance } from './fleet/supply-demand.tool.js';
import { ghostDriversSchema, getGhostDrivers } from './fleet/ghost-drivers.tool.js';
import { rejectionAnalysisSchema, getRejectionAnalysis } from './dispatch/rejection-analysis.tool.js';
import { restaurantHealthSchema, getRestaurantHealth } from './restaurant/restaurant-health.tool.js';
import { autoBusyPredictionsSchema, getAutoBusyPredictions } from './restaurant/auto-busy-predictions.tool.js';
import { shiftReportSchema, getShiftReport } from './infra/shift-report.tool.js';
import { flexibleQuerySchema, flexibleQuery } from './general/flexible-query.tool.js';
import { describeCollectionSchema, describeCollection } from './general/describe-collection.tool.js';
import { listCollectionsSchema, listCollections } from './general/list-collections.tool.js';
import { lookupOrderSchema, lookupOrder } from './orders/lookup-order.tool.js';
import { investigateOrderSchema, investigateOrder } from './orders/investigate-order.tool.js';
import { lookupUserSchema, lookupUser } from './users/lookup-user.tool.js';
import { lookupDriverSchema, lookupDriver } from './fleet/lookup-driver.tool.js';
import { lookupRestaurantSchema, lookupRestaurant } from './restaurant/lookup-restaurant.tool.js';
import { comparePeriodsSchema, comparePeriods } from './analytics/compare-periods.tool.js';
import { topBottomSchema, topBottom } from './analytics/top-bottom.tool.js';
import { detectAnomaliesSchema, detectAnomalies } from './analytics/detect-anomalies.tool.js';
import { revenueMetricsSchema, getRevenueMetrics } from './analytics/revenue-metrics.tool.js';
import { etaAccuracySchema, getEtaAccuracy } from './analytics/eta-accuracy.tool.js';
import { geoAnalysisSchema, getGeoAnalysis } from './analytics/geo-analysis.tool.js';
import { ratingsAnalysisSchema, getRatingsAnalysis } from './analytics/ratings-analysis.tool.js';
import { promoPerformanceSchema, getPromoPerformance } from './analytics/promo-performance.tool.js';
import { cityConfigSchema, cityConfig } from './config/city-config.tool.js';
import { dispatchQueueSchema, getDispatchQueue } from './dispatch/dispatch-queue.tool.js';
import { scheduledReportSchema, manageScheduledReports } from './infra/scheduled-reports.tool.js';
import { setAlertSchema, setAlert } from './alerts/set-alert.tool.js';
import { listOrdersSchema, listOrdersHandler } from './orders/list-orders.tool.js';
import { getOrderDetailsSchema, getOrderDetailsHandler } from './orders/get-order-details.tool.js';
import { acceptOrderSchema, acceptOrderHandler } from './orders/accept-order.tool.js';
import { rejectOrderSchema, rejectOrderHandler } from './orders/reject-order.tool.js';
import { cancelOrderSchema, cancelOrderHandler } from './orders/cancel-order.tool.js';
import { getAdminEarningsSchema, getAdminEarningsHandler } from './finance/get-admin-earnings.tool.js';
import { listBillingCyclesSchema, listBillingCyclesHandler } from './finance/list-billing-cycles.tool.js';
import { getDriverPayoutsSchema, getDriverPayoutsHandler } from './finance/get-driver-payouts.tool.js';
import { getDriverPayoutDetailsSchema, getDriverPayoutDetailsHandler } from './finance/get-driver-payout-details.tool.js';
import { listRestaurantCyclesSchema, listRestaurantCyclesHandler } from './finance/list-restaurant-cycles.tool.js';
import { getRestaurantCycleOrdersSchema, getRestaurantCycleOrdersHandler } from './finance/get-restaurant-cycle-orders.tool.js';

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolNamespace = 'orders' | 'fleet' | 'restaurant' | 'analytics' | 'dispatch' | 'config' | 'general' | 'infra' | 'alerts' | 'finance';

export interface ToolDefinition {
  name: string;
  namespace: ToolNamespace;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (params: unknown, ctx?: AuthContext) => Promise<unknown>;
  annotations?: ToolAnnotations;
  source: ToolSource;
}

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

const WRITE_DESTRUCTIVE: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ── API-backed Order Tools (new in phase 2) ──────────────────────
  {
    name: 'list_orders',
    namespace: 'orders',
    description: 'List orders from the dashboard API with filters: status, customer phone/email/name, order ID. Uses the same endpoint as the admin dashboard.',
    schema: listOrdersSchema,
    handler: (p, ctx) => listOrdersHandler(listOrdersSchema.parse(p), ctx),
    annotations: READ_ONLY,
    source: 'api',
  },
  {
    name: 'get_order_details',
    namespace: 'orders',
    description: 'Fetch full order details via the API by _id or YAF-... order_id. Returns customer, restaurant, driver, billing, and timeline data.',
    schema: getOrderDetailsSchema,
    handler: (p, ctx) => getOrderDetailsHandler(getOrderDetailsSchema.parse(p), ctx),
    annotations: READ_ONLY,
    source: 'api',
  },
  {
    name: 'accept_order',
    namespace: 'orders',
    description:
      'Accept an order via the admin API. First call returns a preview for confirmation. Call again with confirmed=true to execute. Only works for orders in Order Received, Restaurant Rejected, or Timeout status.',
    schema: acceptOrderSchema,
    handler: (p, ctx) => acceptOrderHandler(acceptOrderSchema.parse(p), ctx),
    annotations: WRITE_DESTRUCTIVE,
    source: 'api',
  },
  {
    name: 'reject_order',
    namespace: 'orders',
    description:
      'Reject an order on behalf of the restaurant via the admin API. First call returns a preview with available rejection reasons. Call again with confirmed=true and a reason to execute. IRREVERSIBLE.',
    schema: rejectOrderSchema,
    handler: (p, ctx) => rejectOrderHandler(rejectOrderSchema.parse(p), ctx),
    annotations: WRITE_DESTRUCTIVE,
    source: 'api',
  },
  {
    name: 'cancel_order',
    namespace: 'orders',
    description:
      'Cancel an order as admin via the admin API. First call returns a preview with available cancellation reasons. Call again with confirmed=true and a reason to execute. IRREVERSIBLE — triggers notifications and potential refunds.',
    schema: cancelOrderSchema,
    handler: (p, ctx) => cancelOrderHandler(cancelOrderSchema.parse(p), ctx),
    annotations: WRITE_DESTRUCTIVE,
    source: 'api',
  },

  // ── Direct DB Order Tools (kept from phase 1) ────────────────────
  {
    name: 'query_orders',
    namespace: 'orders',
    description: 'Count and list orders with filters by country, city, status, and time range.',
    schema: queryOrdersSchema,
    handler: (p) => queryOrders(queryOrdersSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'get_needs_attention',
    namespace: 'orders',
    description: 'Find orders stuck without a driver or with delayed pickup.',
    schema: needsAttentionSchema,
    handler: (p) => getNeedsAttention(needsAttentionSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'get_order_sla_status',
    namespace: 'orders',
    description: 'Check which active orders are breaching delivery time SLA.',
    schema: orderSlaSchema,
    handler: (p) => getOrderSlaStatus(orderSlaSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'lookup_order',
    namespace: 'orders',
    description: 'Deep-dive into a single order by _id or YAF-... order_id with full lifecycle timeline. (Direct DB fallback — prefer get_order_details for API-backed data.)',
    schema: lookupOrderSchema,
    handler: (p) => lookupOrder(lookupOrderSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'investigate_order',
    namespace: 'orders',
    description: 'Root cause analysis for an order (by _id or YAF-... order_id) with automated findings.',
    schema: investigateOrderSchema,
    handler: (p) => investigateOrder(investigateOrderSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'lookup_user',
    namespace: 'orders',
    description: 'Look up a customer by phone, email, user_id, or name with order stats.',
    schema: lookupUserSchema,
    handler: (p) => lookupUser(lookupUserSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  // --- Fleet ---
  {
    name: 'fleet_status',
    namespace: 'fleet',
    description: 'Get driver fleet breakdown: online, busy, ghost, offline counts.',
    schema: fleetStatusSchema,
    handler: (p) => fleetStatus(fleetStatusSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'supply_demand_balance',
    namespace: 'fleet',
    description: 'Compare active orders vs available drivers to detect shortage.',
    schema: supplyDemandSchema,
    handler: (p) => getSupplyDemandBalance(supplyDemandSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'ghost_drivers',
    namespace: 'fleet',
    description: 'Find drivers online but with stale GPS causing dispatch failures.',
    schema: ghostDriversSchema,
    handler: (p) => getGhostDrivers(ghostDriversSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'lookup_driver',
    namespace: 'fleet',
    description: "Look up a driver by ID, phone, or username with today's stats.",
    schema: lookupDriverSchema,
    handler: (p) => lookupDriver(lookupDriverSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  // --- Restaurant ---
  {
    name: 'restaurant_health',
    namespace: 'restaurant',
    description: 'Restaurant performance: acceptance rate, rejection rate, prep time.',
    schema: restaurantHealthSchema,
    handler: (p) => getRestaurantHealth(restaurantHealthSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'auto_busy_predictions',
    namespace: 'restaurant',
    description: 'Predict which restaurants will auto-disable from consecutive rejections.',
    schema: autoBusyPredictionsSchema,
    handler: (p) => getAutoBusyPredictions(autoBusyPredictionsSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'lookup_restaurant',
    namespace: 'restaurant',
    description: 'Look up a restaurant by ID or name with availability and stats.',
    schema: lookupRestaurantSchema,
    handler: (p) => lookupRestaurant(lookupRestaurantSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  // --- Dispatch ---
  {
    name: 'rejection_analysis',
    namespace: 'dispatch',
    description: 'Analyze driver rejection patterns and most-rejected orders.',
    schema: rejectionAnalysisSchema,
    handler: (p) => getRejectionAnalysis(rejectionAnalysisSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'dispatch_queue',
    namespace: 'dispatch',
    description: 'Monitor Redis dispatch queue: depth, stuck orders, processing counts.',
    schema: dispatchQueueSchema,
    handler: (p) => getDispatchQueue(dispatchQueueSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  // --- Analytics ---
  {
    name: 'compare_periods',
    namespace: 'analytics',
    description: 'Compare a metric between two time periods. Set group_by_country=true for per-country breakdown in one call.',
    schema: comparePeriodsSchema,
    handler: (p) => comparePeriods(comparePeriodsSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'top_bottom_performers',
    namespace: 'analytics',
    description: 'Rank cities, restaurants, drivers, or users by a metric.',
    schema: topBottomSchema,
    handler: (p) => topBottom(topBottomSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'detect_anomalies',
    namespace: 'analytics',
    description: 'Detect unusual patterns by comparing current hour to 7-day baseline.',
    schema: detectAnomaliesSchema,
    handler: (p) => detectAnomalies(detectAnomaliesSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'revenue_metrics',
    namespace: 'analytics',
    description: 'Get GMV/revenue metrics for delivered orders: total revenue, delivery fees, avg basket size.',
    schema: revenueMetricsSchema,
    handler: (p) => getRevenueMetrics(revenueMetricsSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'eta_accuracy',
    namespace: 'analytics',
    description: 'Measure ETA accuracy: on-time rate, avg actual delivery time, breakdown by city.',
    schema: etaAccuracySchema,
    handler: (p) => getEtaAccuracy(etaAccuracySchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'geo_analysis',
    namespace: 'analytics',
    description: 'Analyze driver and order density by geographic zones: driver_density or unassigned_hotspots.',
    schema: geoAnalysisSchema,
    handler: (p) => getGeoAnalysis(geoAnalysisSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'ratings_analysis',
    namespace: 'analytics',
    description: 'Find low-rated orders and correlate with restaurants/drivers; group by restaurant, driver, or rating.',
    schema: ratingsAnalysisSchema,
    handler: (p) => getRatingsAnalysis(ratingsAnalysisSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'promo_performance',
    namespace: 'analytics',
    description: 'Analyze promo/coupon performance: redemption rates, top coupons by usage, generated vs used.',
    schema: promoPerformanceSchema,
    handler: (p) => getPromoPerformance(promoPerformanceSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  // --- Config ---
  {
    name: 'city_config_lookup',
    namespace: 'config',
    description: 'Query and compare city-level operational settings.',
    schema: cityConfigSchema,
    handler: (p) => cityConfig(cityConfigSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  // --- Infra ---
  {
    name: 'shift_report',
    namespace: 'infra',
    description: 'Full shift report: orders, delivery rates, fleet, restaurant performance.',
    schema: shiftReportSchema,
    handler: (p) => getShiftReport(shiftReportSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'scheduled_reports',
    namespace: 'infra',
    description: 'Manage scheduled reports: list, add, or remove webhook-based report schedules.',
    schema: scheduledReportSchema,
    handler: (p) => manageScheduledReports(scheduledReportSchema.parse(p)),
    source: 'db',
  },
  // --- Alerts ---
  {
    name: 'set_alert',
    namespace: 'alerts',
    description: 'Configure proactive alerts: list, add, or remove threshold-based alerts.',
    schema: setAlertSchema,
    handler: (p) => setAlert(setAlertSchema.parse(p)),
    source: 'db',
  },
  // --- General ---
  {
    name: 'flexible_query',
    namespace: 'general',
    description: 'Run a read-only query on any MongoDB collection (count, find, distinct). Fallback for queries not covered by specific tools.',
    schema: flexibleQuerySchema,
    handler: (p) => flexibleQuery(flexibleQuerySchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'describe_collection',
    namespace: 'general',
    description: 'Discover fields and structure of any collection by sampling documents.',
    schema: describeCollectionSchema,
    handler: (p) => describeCollection(describeCollectionSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  {
    name: 'list_collections',
    namespace: 'general',
    description: 'List all available MongoDB collections with document counts.',
    schema: listCollectionsSchema,
    handler: (p) => listCollections(listCollectionsSchema.parse(p)),
    annotations: READ_ONLY,
    source: 'db',
  },
  // ── Finance / Earnings (API-backed) ───────────────────────────────
  {
    name: 'get_admin_earnings',
    namespace: 'finance',
    description:
      'Get platform (Yassir) earnings with filters: city, area, date range, service. Shows order-level breakdown with restaurant/driver/admin totals. Set ofse=true for OFSE (Order For Someone Else) earnings. Defaults to last 30 days if no date range.',
    schema: getAdminEarningsSchema,
    handler: (p, ctx) => getAdminEarningsHandler(getAdminEarningsSchema.parse(p), ctx),
    annotations: READ_ONLY,
    source: 'api',
  },
  {
    name: 'list_billing_cycles',
    namespace: 'finance',
    description: 'List driver billing cycles for a city. Returns recent cycles with date ranges. Use this first to get a cycle_id, then call get_driver_payouts to see driver earnings for that cycle.',
    schema: listBillingCyclesSchema,
    handler: (p, ctx) => listBillingCyclesHandler(listBillingCyclesSchema.parse(p), ctx),
    annotations: READ_ONLY,
    source: 'api',
  },
  {
    name: 'get_driver_payouts',
    namespace: 'finance',
    description:
      'Get driver payouts for a billing cycle. Shows all drivers with earnings breakdown: deliveries, charges, tax, tip, bonus, net, platform earnings, adjustments, cash-co, payout status. Requires a billing_cycle ID from list_billing_cycles.',
    schema: getDriverPayoutsSchema,
    handler: (p, ctx) => getDriverPayoutsHandler(getDriverPayoutsSchema.parse(p), ctx),
    annotations: READ_ONLY,
    source: 'api',
  },
  {
    name: 'get_driver_payout_details',
    namespace: 'finance',
    description:
      'Get detailed earnings for a single driver: per-order breakdown (customer paid, delivery charge, driver earnings, tax, tip, commission) and payout summary. If billing_id is omitted, shows unbilled earnings since last cycle.',
    schema: getDriverPayoutDetailsSchema,
    handler: (p, ctx) => getDriverPayoutDetailsHandler(getDriverPayoutDetailsSchema.parse(p), ctx),
    annotations: READ_ONLY,
    source: 'api',
  },
  {
    name: 'list_restaurant_cycles',
    namespace: 'finance',
    description:
      'List restaurant payout cycles for a city. Shows restaurant name, date range, cycle status (Active/Settled/Paid/Interrupted), and Yassir Pay flag. Use cycle_id with get_restaurant_cycle_orders to see orders.',
    schema: listRestaurantCyclesSchema,
    handler: (p, ctx) => listRestaurantCyclesHandler(listRestaurantCyclesSchema.parse(p), ctx),
    annotations: READ_ONLY,
    source: 'api',
  },
  {
    name: 'get_restaurant_cycle_orders',
    namespace: 'finance',
    description:
      'Get orders in a restaurant payout cycle. Shows order-level billing: item amount, customer paid, Yassir commission, restaurant earnings, tax, service charge. Requires cycle_id from list_restaurant_cycles.',
    schema: getRestaurantCycleOrdersSchema,
    handler: (p, ctx) => getRestaurantCycleOrdersHandler(getRestaurantCycleOrdersSchema.parse(p), ctx),
    annotations: READ_ONLY,
    source: 'api',
  },
];
