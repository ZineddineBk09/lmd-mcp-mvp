import { z } from "zod";
import { queryOrdersSchema, queryOrders } from "./orders/query-orders.tool.js";
import {
  needsAttentionSchema,
  getNeedsAttention,
} from "./orders/needs-attention.tool.js";
import { orderSlaSchema, getOrderSlaStatus } from "./orders/order-sla.tool.js";
import { fleetStatusSchema, fleetStatus } from "./fleet/fleet-status.tool.js";
import {
  supplyDemandSchema,
  getSupplyDemandBalance,
} from "./fleet/supply-demand.tool.js";
import {
  ghostDriversSchema,
  getGhostDrivers,
} from "./fleet/ghost-drivers.tool.js";
import {
  rejectionAnalysisSchema,
  getRejectionAnalysis,
} from "./dispatch/rejection-analysis.tool.js";
import {
  restaurantHealthSchema,
  getRestaurantHealth,
} from "./restaurant/restaurant-health.tool.js";
import {
  autoBusyPredictionsSchema,
  getAutoBusyPredictions,
} from "./restaurant/auto-busy-predictions.tool.js";
import {
  shiftReportSchema,
  getShiftReport,
} from "./infra/shift-report.tool.js";
import {
  flexibleQuerySchema,
  flexibleQuery,
} from "./general/flexible-query.tool.js";
import {
  describeCollectionSchema,
  describeCollection,
} from "./general/describe-collection.tool.js";
import {
  listCollectionsSchema,
  listCollections,
} from "./general/list-collections.tool.js";
import { lookupOrderSchema, lookupOrder } from "./orders/lookup-order.tool.js";
import {
  investigateOrderSchema,
  investigateOrder,
} from "./orders/investigate-order.tool.js";
import { lookupUserSchema, lookupUser } from "./users/lookup-user.tool.js";
import {
  lookupDriverSchema,
  lookupDriver,
} from "./fleet/lookup-driver.tool.js";
import {
  lookupRestaurantSchema,
  lookupRestaurant,
} from "./restaurant/lookup-restaurant.tool.js";
import {
  comparePeriodsSchema,
  comparePeriods,
} from "./analytics/compare-periods.tool.js";
import { topBottomSchema, topBottom } from "./analytics/top-bottom.tool.js";
import {
  detectAnomaliesSchema,
  detectAnomalies,
} from "./analytics/detect-anomalies.tool.js";
import {
  revenueMetricsSchema,
  getRevenueMetrics,
} from "./analytics/revenue-metrics.tool.js";
import {
  etaAccuracySchema,
  getEtaAccuracy,
} from "./analytics/eta-accuracy.tool.js";
import {
  geoAnalysisSchema,
  getGeoAnalysis,
} from "./analytics/geo-analysis.tool.js";
import {
  ratingsAnalysisSchema,
  getRatingsAnalysis,
} from "./analytics/ratings-analysis.tool.js";
import {
  promoPerformanceSchema,
  getPromoPerformance,
} from "./analytics/promo-performance.tool.js";
import { cityConfigSchema, cityConfig } from "./config/city-config.tool.js";
import {
  dispatchQueueSchema,
  getDispatchQueue,
} from "./dispatch/dispatch-queue.tool.js";
import {
  scheduledReportSchema,
  manageScheduledReports,
} from "./infra/scheduled-reports.tool.js";
import { setAlertSchema, setAlert } from "./alerts/set-alert.tool.js";

export interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
}

export type ToolNamespace =
  | "orders"
  | "fleet"
  | "restaurant"
  | "analytics"
  | "dispatch"
  | "config"
  | "general"
  | "infra"
  | "alerts";

export interface ToolDefinition {
  name: string;
  namespace: ToolNamespace;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (params: unknown) => Promise<unknown>;
  annotations?: ToolAnnotations;
}

const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // --- Orders ---
  {
    name: "query_orders",
    namespace: "orders",
    description:
      "Count and list orders with filters by country, city, status, and time range.",
    schema: queryOrdersSchema,
    handler: (p) => queryOrders(queryOrdersSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "get_needs_attention",
    namespace: "orders",
    description: "Find orders stuck without a driver or with delayed pickup.",
    schema: needsAttentionSchema,
    handler: (p) => getNeedsAttention(needsAttentionSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "get_order_sla_status",
    namespace: "orders",
    description: "Check which active orders are breaching delivery time SLA.",
    schema: orderSlaSchema,
    handler: (p) => getOrderSlaStatus(orderSlaSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "lookup_order",
    namespace: "orders",
    description:
      "Deep-dive into a single order by _id with full lifecycle timeline.",
    schema: lookupOrderSchema,
    handler: (p) => lookupOrder(lookupOrderSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "investigate_order",
    namespace: "orders",
    description: "Root cause analysis for an order with automated findings.",
    schema: investigateOrderSchema,
    handler: (p) => investigateOrder(investigateOrderSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "lookup_user",
    namespace: "orders",
    description:
      "Look up a customer by phone, email, user_id, or name with order stats.",
    schema: lookupUserSchema,
    handler: (p) => lookupUser(lookupUserSchema.parse(p)),
    annotations: READ_ONLY,
  },
  // --- Fleet ---
  {
    name: "fleet_status",
    namespace: "fleet",
    description:
      "Get driver fleet breakdown: online, busy, ghost, offline counts.",
    schema: fleetStatusSchema,
    handler: (p) => fleetStatus(fleetStatusSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "supply_demand_balance",
    namespace: "fleet",
    description:
      "Compare active orders vs available drivers to detect shortage.",
    schema: supplyDemandSchema,
    handler: (p) => getSupplyDemandBalance(supplyDemandSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "ghost_drivers",
    namespace: "fleet",
    description:
      "Find drivers online but with stale GPS causing dispatch failures.",
    schema: ghostDriversSchema,
    handler: (p) => getGhostDrivers(ghostDriversSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "lookup_driver",
    namespace: "fleet",
    description:
      "Look up a driver by ID, phone, or username with today's stats.",
    schema: lookupDriverSchema,
    handler: (p) => lookupDriver(lookupDriverSchema.parse(p)),
    annotations: READ_ONLY,
  },
  // --- Restaurant ---
  {
    name: "restaurant_health",
    namespace: "restaurant",
    description:
      "Restaurant performance: acceptance rate, rejection rate, prep time.",
    schema: restaurantHealthSchema,
    handler: (p) => getRestaurantHealth(restaurantHealthSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "auto_busy_predictions",
    namespace: "restaurant",
    description:
      "Predict which restaurants will auto-disable from consecutive rejections.",
    schema: autoBusyPredictionsSchema,
    handler: (p) => getAutoBusyPredictions(autoBusyPredictionsSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "lookup_restaurant",
    namespace: "restaurant",
    description:
      "Look up a restaurant by ID or name with availability and stats.",
    schema: lookupRestaurantSchema,
    handler: (p) => lookupRestaurant(lookupRestaurantSchema.parse(p)),
    annotations: READ_ONLY,
  },
  // --- Dispatch ---
  {
    name: "rejection_analysis",
    namespace: "dispatch",
    description: "Analyze driver rejection patterns and most-rejected orders.",
    schema: rejectionAnalysisSchema,
    handler: (p) => getRejectionAnalysis(rejectionAnalysisSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "dispatch_queue",
    namespace: "dispatch",
    description:
      "Monitor Redis dispatch queue: depth, stuck orders, processing counts.",
    schema: dispatchQueueSchema,
    handler: (p) => getDispatchQueue(dispatchQueueSchema.parse(p)),
    annotations: READ_ONLY,
  },
  // --- Analytics ---
  {
    name: "compare_periods",
    namespace: "analytics",
    description:
      "Compare a metric between two time periods. Set group_by_country=true for per-country breakdown in one call.",
    schema: comparePeriodsSchema,
    handler: (p) => comparePeriods(comparePeriodsSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "top_bottom_performers",
    namespace: "analytics",
    description: "Rank cities, restaurants, or drivers by a metric.",
    schema: topBottomSchema,
    handler: (p) => topBottom(topBottomSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "detect_anomalies",
    namespace: "analytics",
    description:
      "Detect unusual patterns by comparing current hour to 7-day baseline.",
    schema: detectAnomaliesSchema,
    handler: (p) => detectAnomalies(detectAnomaliesSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "revenue_metrics",
    namespace: "analytics",
    description:
      "Get GMV/revenue metrics for delivered orders: total revenue, delivery fees, avg basket size.",
    schema: revenueMetricsSchema,
    handler: (p) => getRevenueMetrics(revenueMetricsSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "eta_accuracy",
    namespace: "analytics",
    description:
      "Measure ETA accuracy: on-time rate, avg actual delivery time, breakdown by city.",
    schema: etaAccuracySchema,
    handler: (p) => getEtaAccuracy(etaAccuracySchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "geo_analysis",
    namespace: "analytics",
    description:
      "Analyze driver and order density by geographic zones: driver_density or unassigned_hotspots.",
    schema: geoAnalysisSchema,
    handler: (p) => getGeoAnalysis(geoAnalysisSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "ratings_analysis",
    namespace: "analytics",
    description:
      "Find low-rated orders and correlate with restaurants/drivers; group by restaurant, driver, or rating.",
    schema: ratingsAnalysisSchema,
    handler: (p) => getRatingsAnalysis(ratingsAnalysisSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "promo_performance",
    namespace: "analytics",
    description:
      "Analyze promo/coupon performance: redemption rates, top coupons by usage, generated vs used.",
    schema: promoPerformanceSchema,
    handler: (p) => getPromoPerformance(promoPerformanceSchema.parse(p)),
    annotations: READ_ONLY,
  },
  // --- Config ---
  {
    name: "city_config_lookup",
    namespace: "config",
    description: "Query and compare city-level operational settings.",
    schema: cityConfigSchema,
    handler: (p) => cityConfig(cityConfigSchema.parse(p)),
    annotations: READ_ONLY,
  },
  // --- Infra ---
  {
    name: "shift_report",
    namespace: "infra",
    description:
      "Full shift report: orders, delivery rates, fleet, restaurant performance.",
    schema: shiftReportSchema,
    handler: (p) => getShiftReport(shiftReportSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "scheduled_reports",
    namespace: "infra",
    description:
      "Manage scheduled reports: list, add, or remove webhook-based report schedules.",
    schema: scheduledReportSchema,
    handler: (p) => manageScheduledReports(scheduledReportSchema.parse(p)),
  },
  // --- Alerts ---
  {
    name: "set_alert",
    namespace: "alerts",
    description:
      "Configure proactive alerts: list, add, or remove threshold-based alerts.",
    schema: setAlertSchema,
    handler: (p) => setAlert(setAlertSchema.parse(p)),
  },
  // --- General ---
  {
    name: "flexible_query",
    namespace: "general",
    description:
      "Run a read-only query on any MongoDB collection (count, find, distinct).",
    schema: flexibleQuerySchema,
    handler: (p) => flexibleQuery(flexibleQuerySchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "describe_collection",
    namespace: "general",
    description:
      "Discover fields and structure of any collection by sampling documents.",
    schema: describeCollectionSchema,
    handler: (p) => describeCollection(describeCollectionSchema.parse(p)),
    annotations: READ_ONLY,
  },
  {
    name: "list_collections",
    namespace: "general",
    description: "List all available MongoDB collections with document counts.",
    schema: listCollectionsSchema,
    handler: (p) => listCollections(listCollectionsSchema.parse(p)),
    annotations: READ_ONLY,
  },
];
