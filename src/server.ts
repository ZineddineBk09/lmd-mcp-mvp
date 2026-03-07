import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { queryOrdersSchema, queryOrders } from "./tools/orders/query-orders.tool.js";
import { needsAttentionSchema, getNeedsAttention } from "./tools/orders/needs-attention.tool.js";
import { orderSlaSchema, getOrderSlaStatus } from "./tools/orders/order-sla.tool.js";
import { fleetStatusSchema, fleetStatus } from "./tools/fleet/fleet-status.tool.js";
import { supplyDemandSchema, getSupplyDemandBalance } from "./tools/fleet/supply-demand.tool.js";
import { ghostDriversSchema, getGhostDrivers } from "./tools/fleet/ghost-drivers.tool.js";
import { rejectionAnalysisSchema, getRejectionAnalysis } from "./tools/dispatch/rejection-analysis.tool.js";
import { restaurantHealthSchema, getRestaurantHealth } from "./tools/restaurant/restaurant-health.tool.js";
import { autoBusyPredictionsSchema, getAutoBusyPredictions } from "./tools/restaurant/auto-busy-predictions.tool.js";
import { shiftReportSchema, getShiftReport } from "./tools/infra/shift-report.tool.js";
import { flexibleQuerySchema, flexibleQuery } from "./tools/general/flexible-query.tool.js";
import { describeCollectionSchema, describeCollection } from "./tools/general/describe-collection.tool.js";
import { listCollectionsSchema, listCollections } from "./tools/general/list-collections.tool.js";
import { lookupOrderSchema, lookupOrder } from "./tools/orders/lookup-order.tool.js";
import { investigateOrderSchema, investigateOrder } from "./tools/orders/investigate-order.tool.js";
import { lookupUserSchema, lookupUser } from "./tools/users/lookup-user.tool.js";
import { lookupDriverSchema, lookupDriver } from "./tools/fleet/lookup-driver.tool.js";
import { lookupRestaurantSchema, lookupRestaurant } from "./tools/restaurant/lookup-restaurant.tool.js";
import { comparePeriodsSchema, comparePeriods } from "./tools/analytics/compare-periods.tool.js";
import { topBottomSchema, topBottom } from "./tools/analytics/top-bottom.tool.js";
import { detectAnomaliesSchema, detectAnomalies } from "./tools/analytics/detect-anomalies.tool.js";
import { cityConfigSchema, cityConfig } from "./tools/config/city-config.tool.js";
import { ORDER_STATUS_LABELS } from "./constants/order-status.js";
import { City } from "./schemas/city.schema.js";
import { COLLECTION_SCHEMAS, getAllSchemasCompact } from "./resources/collection-schemas.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "lmd-ops-command-center",
    version: "0.1.0",
  });

  // --- TOOL: query_orders ---
  // BEST TOOL for: "how many orders", "active orders in DZ", "show orders", "order count"
  server.tool(
    "query_orders",
    `Count and list Yassir food delivery orders. USE THIS TOOL when the user asks about order counts, active orders, or order details.
Only country_code is required. City, status, and time range are all optional.
For "active orders" use status [1,3,5,6,17]. For "delivered" use [7]. For "cancelled" use [9,10]. Omit status to get all.
Example: "active orders in DZ" → call with {country_code:"DZ", status:[1,3,5,6,17]}`,
    queryOrdersSchema.shape,
    async (params) => {
      const result = await queryOrders(queryOrdersSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: get_needs_attention ---
  server.tool(
    "get_needs_attention",
    `Find orders needing urgent ops attention: orders waiting too long without a driver, or driver accepted but hasn't picked up.
USE THIS when user asks about "stuck orders", "unassigned orders", "orders needing attention", or "delayed pickup".
Only country_code is required. City is optional.`,
    needsAttentionSchema.shape,
    async (params) => {
      const result = await getNeedsAttention(needsAttentionSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: get_order_sla_status ---
  server.tool(
    "get_order_sla_status",
    `Check which active orders are breaching or close to breaching delivery time SLA.
USE THIS when user asks about "SLA", "late orders", "breached orders", or "order delays".
Only country_code is required. City is optional.`,
    orderSlaSchema.shape,
    async (params) => {
      const result = await getOrderSlaStatus(orderSlaSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: rejection_analysis ---
  server.tool(
    "rejection_analysis",
    `Analyze driver rejection patterns: which orders have most rejections, which drivers reject most.
USE THIS when user asks about "rejections", "driver rejections", or "why orders are stuck".
Only country_code is required. City and time range are optional.`,
    rejectionAnalysisSchema.shape,
    async (params) => {
      const result = await getRejectionAnalysis(rejectionAnalysisSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: fleet_status ---
  server.tool(
    "fleet_status",
    `Get driver fleet breakdown: online, offline, ghost (stale GPS), at-capacity counts.
USE THIS when user asks about "drivers", "fleet", "how many drivers online", or "driver availability".
Only country_code is required. City is optional.`,
    fleetStatusSchema.shape,
    async (params) => {
      const result = await fleetStatus(fleetStatusSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: supply_demand_balance ---
  server.tool(
    "supply_demand_balance",
    `Compare active orders vs available drivers to detect shortage or surplus.
USE THIS when user asks about "supply and demand", "driver shortage", "capacity", or "are we short on drivers".
Only country_code is required. City is optional.`,
    supplyDemandSchema.shape,
    async (params) => {
      const result = await getSupplyDemandBalance(supplyDemandSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: ghost_drivers ---
  server.tool(
    "ghost_drivers",
    `Find ghost drivers: appear online but GPS data is stale (>5 min). They cause dispatch failures.
USE THIS when user asks about "ghost drivers", "stale drivers", or "drivers not responding".
Only country_code is required. City is optional.`,
    ghostDriversSchema.shape,
    async (params) => {
      const result = await getGhostDrivers(ghostDriversSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: restaurant_health ---
  server.tool(
    "restaurant_health",
    `Restaurant performance: acceptance rate, rejection rate, prep time, auto-busy status.
USE THIS when user asks about "restaurant health", "restaurant performance", "which restaurants are bad", or "busy restaurants".
Only country_code is required. City, restaurant_id, time range are optional.`,
    restaurantHealthSchema.shape,
    async (params) => {
      const result = await getRestaurantHealth(restaurantHealthSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: auto_busy_predictions ---
  server.tool(
    "auto_busy_predictions",
    `Predict which restaurants will soon auto-disable due to consecutive rejections.
USE THIS when user asks about "auto-busy", "restaurants about to go busy", or "rejection risk".
Only country_code is required. City is optional.`,
    autoBusyPredictionsSchema.shape,
    async (params) => {
      const result = await getAutoBusyPredictions(autoBusyPredictionsSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: shift_report ---
  server.tool(
    "shift_report",
    `Full operational shift report: order volumes, delivery/timeout rates, fleet status, restaurant performance — all in one call.
USE THIS when user asks for "shift report", "daily report", "summary", or "how is the shift going".
Only country_code is required. City and time window (hours) are optional (default 8h).`,
    shiftReportSchema.shape,
    async (params) => {
      const result = await getShiftReport(shiftReportSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: flexible_query (escape hatch) ---
  server.tool(
    "flexible_query",
    `Run a custom read-only query on ANY MongoDB collection. Supports count, find, and distinct.
USE THIS when no other tool fits. Filter fields are AUTO-CORRECTED if they don't match the actual document structure.
If you don't know a collection's fields, call describe_collection FIRST to discover them.
Collection names: restaurant (NOT restaurants), drivers (NOT driver), city (NOT cities), cartv2 (NOT cart), countrycurrency (NOT countries).
Other collections: orders, food, users, offer, dispatch, billing_cycles, picker_history, billing, coupon, ratings, etc.
Results capped at 50. Empty filters blocked.`,
    flexibleQuerySchema.shape,
    async (params) => {
      const result = await flexibleQuery(flexibleQuerySchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: describe_collection (schema discovery) ---
  server.tool(
    "describe_collection",
    `Discover the fields and structure of any MongoDB collection by sampling recent documents.
USE THIS FIRST before using flexible_query on any collection you haven't queried before.
Returns all field names, their types, and sample values so you know the correct field names to use in filters.`,
    describeCollectionSchema.shape,
    async (params) => {
      const result = await describeCollection(describeCollectionSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: list_collections (discovery) ---
  server.tool(
    "list_collections",
    `List ALL available MongoDB collections with document counts and short descriptions.
USE THIS FIRST when you don't know which collection to query. Shows every collection in the database.
After finding the right collection, call describe_collection to see its fields, then flexible_query to query it.`,
    listCollectionsSchema.shape,
    async (params) => {
      const result = await listCollections(listCollectionsSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: lookup_order ---
  server.tool(
    "lookup_order",
    `Deep-dive into a single order by its _id. Returns full lifecycle timeline, driver/restaurant info, rejection count, payment, delivery time.
USE THIS when user asks about a specific order: "what happened to order X?", "show me order X", "order details for X".`,
    lookupOrderSchema.shape,
    async (params) => {
      const result = await lookupOrder(lookupOrderSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: investigate_order ---
  server.tool(
    "investigate_order",
    `Root cause analysis for a single order. Fetches order + driver + restaurant + city config, builds timeline, and identifies what went wrong.
USE THIS when user asks "why was order X cancelled?", "investigate order X", or "what went wrong with order X?".
More thorough than lookup_order — includes automated findings and root cause.`,
    investigateOrderSchema.shape,
    async (params) => {
      const result = await investigateOrder(investigateOrderSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: lookup_user ---
  server.tool(
    "lookup_user",
    `Look up a customer/user by phone, email, user_id, or name/username (partial match). Returns profile, order history (last 10), order stats, and active cart.
USE THIS when user asks about a customer: "orders for eslam", "orders for phone +213...", "find user X", "customer lookup". Pass the name parameter for username or name searches.`,
    lookupUserSchema.shape,
    async (params) => {
      const result = await lookupUser(lookupUserSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: lookup_driver ---
  server.tool(
    "lookup_driver",
    `Deep-dive into a single driver by driver_id, phone, or username. Returns current status, GPS freshness, active orders, today's delivery/rejection stats.
USE THIS when user asks about a specific driver: "what is driver X doing?", "driver status for X", "find driver by phone".`,
    lookupDriverSchema.shape,
    async (params) => {
      const result = await lookupDriver(lookupDriverSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: lookup_restaurant ---
  server.tool(
    "lookup_restaurant",
    `Deep-dive into a restaurant by restaurant_id or name (partial match). Returns availability, active orders, today's stats, menu item count.
USE THIS when user asks about a specific restaurant: "how is restaurant X doing?", "is restaurant X busy?", "find restaurant named X".`,
    lookupRestaurantSchema.shape,
    async (params) => {
      const result = await lookupRestaurant(lookupRestaurantSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: compare_periods ---
  server.tool(
    "compare_periods",
    `Compare a metric between two time periods: today vs yesterday, this week vs last, last 1h vs prev 1h, last 4h vs prev 4h.
USE THIS when user asks "how are we doing vs yesterday?", "orders today compared to yesterday", "are cancellations up?", "week over week trend".`,
    comparePeriodsSchema.shape,
    async (params) => {
      const result = await comparePeriods(comparePeriodsSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: top_bottom_performers ---
  server.tool(
    "top_bottom_performers",
    `Rank cities, restaurants, or drivers by a metric (orders, deliveries, cancellations, rejections, avg_delivery_time).
USE THIS when user asks "top 5 restaurants by orders", "worst cities for cancellations", "which driver delivered the most today?", "best performing city".`,
    topBottomSchema.shape,
    async (params) => {
      const result = await topBottom(topBottomSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: detect_anomalies ---
  server.tool(
    "detect_anomalies",
    `Proactive anomaly detection: compares current hour's metrics against the same hour over the last 7 days.
Flags unusual order volume, spikes in cancellations/timeouts/rejections. Returns severity and message.
USE THIS when user asks "anything abnormal?", "what looks wrong?", "any issues right now?", "health check".`,
    detectAnomaliesSchema.shape,
    async (params) => {
      const result = await detectAnomalies(detectAnomaliesSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- TOOL: city_config_lookup ---
  server.tool(
    "city_config_lookup",
    `Query and compare city-level operational settings: dispatch config, SLA timers, driver radius, max orders, busy settings.
USE THIS when user asks "which cities have auto-dispatch?", "what's the dispatch radius in Oran?", "compare city configs", "city settings".`,
    cityConfigSchema.shape,
    async (params) => {
      const result = await cityConfig(cityConfigSchema.parse(params));
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );

  // --- MCP Resources (read-only context for the LLM) ---

  server.resource(
    "status-codes",
    "lmd://status-codes",
    async () => ({
      contents: [
        {
          uri: "lmd://status-codes",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              description: "Yassir LMD order status codes and their meanings",
              statuses: ORDER_STATUS_LABELS,
              active_statuses: "1, 3, 5, 6, 17 (orders currently in progress)",
              terminal_statuses: "2, 7, 9, 10, 11, 90 (final states)",
            },
            null,
            2
          ),
        },
      ],
    })
  );

  server.resource(
    "dispatch-algorithms",
    "lmd://dispatch-algorithms",
    async () => ({
      contents: [
        {
          uri: "lmd://dispatch-algorithms",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              description: "Yassir LMD dispatch algorithm types",
              algorithms: {
                normal:
                  "V1 dispatch: simple geo-based driver selection with batching",
                yassir_dispatch_v2:
                  "V2 dispatch: route optimization with distance + penalty ranking. Pickup penalty=1.25, dropoff penalty=0.25",
                next_mv:
                  "NextMV external API for advanced route optimization",
              },
              config_fields: {
                auto_dispatch: "Boolean - is auto-dispatch enabled for the city",
                dispatch_delay_time: "Minutes to wait before starting dispatch after restaurant accepts",
                max_dispatch_time: "Max minutes to try dispatching before giving up",
                max_rejected_drivers: "Max driver rejections before dispatch fails (default 10)",
                driver_radius: "Search radius in km for finding drivers (default 20)",
                max_orders: "Max concurrent orders per driver",
              },
            },
            null,
            2
          ),
        },
      ],
    })
  );

  server.resource(
    "city-configs",
    "lmd://city-configs",
    async () => {
      const cities = await City.find(
        {},
        {
          country_code: 1,
          cityname: 1,
          state: 1,
          auto_dispatch: 1,
          dispatch_delay_time: 1,
          max_dispatch_time: 1,
          auto_dispatch_algorithm: 1,
          driver_radius: 1,
          max_orders: 1,
          timer_config: 1,
          busySettings: 1,
          maxRejectedOrders: 1,
          busyTime: 1,
        }
      ).lean();

      return {
        contents: [
          {
            uri: "lmd://city-configs",
            mimeType: "application/json",
            text: JSON.stringify(
              {
                description:
                  "City-level dispatch and operations configurations",
                cities,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // --- Collection Schema Resources ---
  // Each collection's field guide as an MCP resource so the LLM
  // knows exact field paths and types before querying.

  for (const [key, schema] of Object.entries(COLLECTION_SCHEMAS)) {
    server.resource(
      `schema-${key}`,
      `lmd://schema/${schema.collection}`,
      async () => ({
        contents: [
          {
            uri: `lmd://schema/${schema.collection}`,
            mimeType: "application/json",
            text: JSON.stringify(schema, null, 2),
          },
        ],
      })
    );
  }

  server.resource(
    "all-schemas",
    "lmd://schemas",
    async () => ({
      contents: [
        {
          uri: "lmd://schemas",
          mimeType: "application/json",
          text: getAllSchemasCompact(),
        },
      ],
    })
  );

  return server;
}
