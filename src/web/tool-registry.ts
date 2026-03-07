import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";

import { queryOrdersSchema, queryOrders } from "../tools/orders/query-orders.tool.js";
import { needsAttentionSchema, getNeedsAttention } from "../tools/orders/needs-attention.tool.js";
import { orderSlaSchema, getOrderSlaStatus } from "../tools/orders/order-sla.tool.js";
import { fleetStatusSchema, fleetStatus } from "../tools/fleet/fleet-status.tool.js";
import { supplyDemandSchema, getSupplyDemandBalance } from "../tools/fleet/supply-demand.tool.js";
import { ghostDriversSchema, getGhostDrivers } from "../tools/fleet/ghost-drivers.tool.js";
import { rejectionAnalysisSchema, getRejectionAnalysis } from "../tools/dispatch/rejection-analysis.tool.js";
import { restaurantHealthSchema, getRestaurantHealth } from "../tools/restaurant/restaurant-health.tool.js";
import { autoBusyPredictionsSchema, getAutoBusyPredictions } from "../tools/restaurant/auto-busy-predictions.tool.js";
import { shiftReportSchema, getShiftReport } from "../tools/infra/shift-report.tool.js";
import { flexibleQuerySchema, flexibleQuery } from "../tools/general/flexible-query.tool.js";
import { describeCollectionSchema, describeCollection } from "../tools/general/describe-collection.tool.js";
import { listCollectionsSchema, listCollections } from "../tools/general/list-collections.tool.js";
import { lookupOrderSchema, lookupOrder } from "../tools/orders/lookup-order.tool.js";
import { investigateOrderSchema, investigateOrder } from "../tools/orders/investigate-order.tool.js";
import { lookupUserSchema, lookupUser } from "../tools/users/lookup-user.tool.js";
import { lookupDriverSchema, lookupDriver } from "../tools/fleet/lookup-driver.tool.js";
import { lookupRestaurantSchema, lookupRestaurant } from "../tools/restaurant/lookup-restaurant.tool.js";
import { comparePeriodsSchema, comparePeriods } from "../tools/analytics/compare-periods.tool.js";
import { topBottomSchema, topBottom } from "../tools/analytics/top-bottom.tool.js";
import { detectAnomaliesSchema, detectAnomalies } from "../tools/analytics/detect-anomalies.tool.js";
import { cityConfigSchema, cityConfig } from "../tools/config/city-config.tool.js";

interface ToolEntry {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  handler: (params: unknown) => Promise<unknown>;
}

const TOOLS: ToolEntry[] = [
  {
    name: "query_orders",
    description: "Count and list orders. For active orders use status [1,3,5,6,17]. For delivered use [7]. For cancelled use [9,10].",
    schema: queryOrdersSchema,
    handler: (p) => queryOrders(queryOrdersSchema.parse(p)),
  },
  {
    name: "get_needs_attention",
    description: "Find orders needing urgent attention: stuck without driver or delayed pickup.",
    schema: needsAttentionSchema,
    handler: (p) => getNeedsAttention(needsAttentionSchema.parse(p)),
  },
  {
    name: "get_order_sla_status",
    description: "Check which active orders are breaching or close to breaching delivery time SLA.",
    schema: orderSlaSchema,
    handler: (p) => getOrderSlaStatus(orderSlaSchema.parse(p)),
  },
  {
    name: "fleet_status",
    description: "Driver fleet breakdown: online, busy, ghost (stale GPS), offline counts.",
    schema: fleetStatusSchema,
    handler: (p) => fleetStatus(fleetStatusSchema.parse(p)),
  },
  {
    name: "supply_demand_balance",
    description: "Compare active orders vs available drivers to detect shortage or surplus.",
    schema: supplyDemandSchema,
    handler: (p) => getSupplyDemandBalance(supplyDemandSchema.parse(p)),
  },
  {
    name: "ghost_drivers",
    description: "Find ghost drivers: online but GPS stale >5 min, causing dispatch failures.",
    schema: ghostDriversSchema,
    handler: (p) => getGhostDrivers(ghostDriversSchema.parse(p)),
  },
  {
    name: "rejection_analysis",
    description: "Analyze driver rejection patterns: most-rejected orders, top-rejecting drivers.",
    schema: rejectionAnalysisSchema,
    handler: (p) => getRejectionAnalysis(rejectionAnalysisSchema.parse(p)),
  },
  {
    name: "restaurant_health",
    description: "Restaurant performance: acceptance rate, rejection rate, prep time, auto-busy status.",
    schema: restaurantHealthSchema,
    handler: (p) => getRestaurantHealth(restaurantHealthSchema.parse(p)),
  },
  {
    name: "auto_busy_predictions",
    description: "Predict which restaurants will soon auto-disable due to consecutive rejections.",
    schema: autoBusyPredictionsSchema,
    handler: (p) => getAutoBusyPredictions(autoBusyPredictionsSchema.parse(p)),
  },
  {
    name: "shift_report",
    description: "Full shift report: order volumes, delivery/timeout rates, fleet status, restaurant performance.",
    schema: shiftReportSchema,
    handler: (p) => getShiftReport(shiftReportSchema.parse(p)),
  },
  {
    name: "lookup_order",
    description: "Deep-dive into a single order by _id. Returns lifecycle timeline, driver/restaurant info, payment, delivery time.",
    schema: lookupOrderSchema,
    handler: (p) => lookupOrder(lookupOrderSchema.parse(p)),
  },
  {
    name: "investigate_order",
    description: "Root cause analysis for an order. Builds timeline and identifies what went wrong.",
    schema: investigateOrderSchema,
    handler: (p) => investigateOrder(investigateOrderSchema.parse(p)),
  },
  {
    name: "lookup_user",
    description: "Look up a customer by phone, email, user_id, or name. Returns profile, order stats, active cart.",
    schema: lookupUserSchema,
    handler: (p) => lookupUser(lookupUserSchema.parse(p)),
  },
  {
    name: "lookup_driver",
    description: "Look up a driver by ID, phone, or username. Returns status, GPS freshness, today's stats.",
    schema: lookupDriverSchema,
    handler: (p) => lookupDriver(lookupDriverSchema.parse(p)),
  },
  {
    name: "lookup_restaurant",
    description: "Look up a restaurant by ID or name. Returns availability, active orders, today's stats.",
    schema: lookupRestaurantSchema,
    handler: (p) => lookupRestaurant(lookupRestaurantSchema.parse(p)),
  },
  {
    name: "compare_periods",
    description: "Compare metrics between two periods: today vs yesterday, this week vs last, hourly.",
    schema: comparePeriodsSchema,
    handler: (p) => comparePeriods(comparePeriodsSchema.parse(p)),
  },
  {
    name: "top_bottom_performers",
    description: "Rank cities, restaurants, or drivers by a metric (orders, deliveries, cancellations, etc.).",
    schema: topBottomSchema,
    handler: (p) => topBottom(topBottomSchema.parse(p)),
  },
  {
    name: "detect_anomalies",
    description: "Proactive anomaly detection: flags unusual volumes, spikes in cancellations/timeouts.",
    schema: detectAnomaliesSchema,
    handler: (p) => detectAnomalies(detectAnomaliesSchema.parse(p)),
  },
  {
    name: "city_config_lookup",
    description: "Query city-level settings: dispatch config, SLA timers, driver radius, max orders.",
    schema: cityConfigSchema,
    handler: (p) => cityConfig(cityConfigSchema.parse(p)),
  },
  {
    name: "flexible_query",
    description: "Run a read-only query on ANY MongoDB collection (count, find, distinct). Use describe_collection first if unsure of fields.",
    schema: flexibleQuerySchema,
    handler: (p) => flexibleQuery(flexibleQuerySchema.parse(p)),
  },
  {
    name: "describe_collection",
    description: "Discover fields and structure of any collection by sampling documents.",
    schema: describeCollectionSchema,
    handler: (p) => describeCollection(describeCollectionSchema.parse(p)),
  },
  {
    name: "list_collections",
    description: "List all available MongoDB collections with document counts.",
    schema: listCollectionsSchema,
    handler: (p) => listCollections(listCollectionsSchema.parse(p)),
  },
];

const handlerMap = new Map<string, (params: unknown) => Promise<unknown>>();
for (const tool of TOOLS) {
  handlerMap.set(tool.name, tool.handler);
}

export function getOpenAITools(): ChatCompletionTool[] {
  return TOOLS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.schema, { target: "openApi3" }) as Record<string, unknown>,
    },
  }));
}

export async function executeTool(name: string, args: unknown): Promise<string> {
  const handler = handlerMap.get(name);
  if (!handler) return JSON.stringify({ error: `Unknown tool: ${name}` });
  try {
    const result = await handler(args);
    const text = JSON.stringify(result);
    return text.length > 6000 ? text.slice(0, 6000) + "...(truncated)" : text;
  } catch (err) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
  }
}

export function getToolCount(): number {
  return TOOLS.length;
}
