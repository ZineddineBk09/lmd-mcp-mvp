import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_DEFINITIONS } from "./tools/registry.js";
import { ORDER_STATUS_LABELS } from "./constants/order-status.js";
import { City } from "./schemas/city.schema.js";
import {
  COLLECTION_SCHEMAS,
  getAllSchemasCompact,
} from "./resources/collection-schemas.js";

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "lmd-ops-command-center",
    version: "0.2.0",
  });

  for (const tool of TOOL_DEFINITIONS) {
    server.tool(
      tool.name,
      tool.description,
      tool.schema.shape,
      async (params) => {
        const response = await tool.handler(params);
        const data =
          response && typeof response === "object" && "result" in response
            ? (response as Record<string, unknown>).result
            : response;
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      },
    );
  }

  // --- MCP Resources ---

  server.resource("status-codes", "lmd://status-codes", async () => ({
    contents: [
      {
        uri: "lmd://status-codes",
        mimeType: "application/json",
        text: JSON.stringify({
          description: "Yassir LMD order status codes and their meanings",
          statuses: ORDER_STATUS_LABELS,
          active_statuses: "1, 3, 5, 6, 17 (orders currently in progress)",
          terminal_statuses: "2, 7, 9, 10, 11, 90 (final states)",
        }),
      },
    ],
  }));

  server.resource(
    "dispatch-algorithms",
    "lmd://dispatch-algorithms",
    async () => ({
      contents: [
        {
          uri: "lmd://dispatch-algorithms",
          mimeType: "application/json",
          text: JSON.stringify({
            description: "Yassir LMD dispatch algorithm types",
            algorithms: {
              normal:
                "V1 dispatch: simple geo-based driver selection with batching",
              yassir_dispatch_v2:
                "V2 dispatch: route optimization with distance + penalty ranking",
              next_mv: "NextMV external API for advanced route optimization",
            },
            config_fields: {
              auto_dispatch: "Boolean - is auto-dispatch enabled for the city",
              dispatch_delay_time: "Minutes to wait before starting dispatch",
              max_dispatch_time:
                "Max minutes to try dispatching before giving up",
              max_rejected_drivers:
                "Max driver rejections before dispatch fails (default 10)",
              driver_radius:
                "Search radius in km for finding drivers (default 20)",
              max_orders: "Max concurrent orders per driver",
            },
          }),
        },
      ],
    }),
  );

  server.resource("city-configs", "lmd://city-configs", async () => {
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
      },
    ).lean();

    return {
      contents: [
        {
          uri: "lmd://city-configs",
          mimeType: "application/json",
          text: JSON.stringify({
            description: "City-level dispatch and operations configurations",
            cities,
          }),
        },
      ],
    };
  });

  for (const [key, schema] of Object.entries(COLLECTION_SCHEMAS)) {
    server.resource(
      `schema-${key}`,
      `lmd://schema/${schema.collection}`,
      async () => ({
        contents: [
          {
            uri: `lmd://schema/${schema.collection}`,
            mimeType: "application/json",
            text: JSON.stringify(schema),
          },
        ],
      }),
    );
  }

  server.resource("all-schemas", "lmd://schemas", async () => ({
    contents: [
      {
        uri: "lmd://schemas",
        mimeType: "application/json",
        text: getAllSchemasCompact(),
      },
    ],
  }));

  return server;
}
