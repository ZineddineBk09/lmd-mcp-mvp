import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from './tools/registry.js';
import { ORDER_STATUS_LABELS } from './constants/order-status.js';
import { City } from './schemas/city.schema.js';
import { COLLECTION_SCHEMAS, getAllSchemasCompact } from './resources/collection-schemas.js';
import type { AuthContext } from './auth/types.js';
import { filterToolsByPermissions } from './auth/tool-filter.js';
import { HttpClient } from './api/http-client.js';
import { fetchCurrentUser } from './api/auth.api.js';

interface McpServerOptions {
  authContext?: AuthContext;
}

export async function initAuthContext(): Promise<AuthContext | undefined> {
  const token = process.env.YASSIR_AUTH_TOKEN;
  const baseURL = process.env.YASSIR_API_BASE_URL;
  const countryCode = process.env.YASSIR_COUNTRY_CODE ?? 'DZ';

  if (!token || !baseURL) {
    console.warn('[mcp] YASSIR_AUTH_TOKEN or YASSIR_API_BASE_URL not set — running without auth (all tools available)');
    return undefined;
  }

  try {
    const client = new HttpClient({ baseURL, token, countryCode });
    const ctx = await fetchCurrentUser(client, token, countryCode);
    console.log(`[mcp] Authenticated as ${ctx.username} (${ctx.role}) — ${ctx.countryName} (${ctx.countryCode})`);
    console.log(`[mcp] Privileges: ${ctx.privileges.length} modules`);
    return ctx;
  } catch (err) {
    console.error('[mcp] Failed to authenticate — running without auth:', err instanceof Error ? err.message : err);
    return undefined;
  }
}

export function createMcpServer(options?: McpServerOptions): McpServer {
  const server = new McpServer({
    name: 'lmd-ops-command-center',
    version: '0.3.0',
  });

  const ctx = options?.authContext;

  let tools: ToolDefinition[] = TOOL_DEFINITIONS;
  if (ctx) {
    tools = filterToolsByPermissions(TOOL_DEFINITIONS, ctx.privileges);
    console.log(`[mcp] Registered ${tools.length}/${TOOL_DEFINITIONS.length} tools (filtered by permissions)`);
  } else {
    console.log(`[mcp] Registered all ${tools.length} tools (no auth — unfiltered)`);
  }

  for (const tool of tools) {
    server.tool(tool.name, tool.description, tool.schema.shape, async (params) => {
      const response = await tool.handler(params, ctx);
      const data = response && typeof response === 'object' && 'result' in response ? (response as Record<string, unknown>).result : response;
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    });
  }

  // --- MCP Resources ---

  server.resource('status-codes', 'lmd://status-codes', async () => ({
    contents: [
      {
        uri: 'lmd://status-codes',
        mimeType: 'application/json',
        text: JSON.stringify({
          description: 'Yassir LMD order status codes and their meanings',
          statuses: ORDER_STATUS_LABELS,
          active_statuses: '1, 3, 5, 6, 17 (orders currently in progress)',
          terminal_statuses: '2, 7, 9, 10, 11, 90 (final states)',
        }),
      },
    ],
  }));

  server.resource('dispatch-algorithms', 'lmd://dispatch-algorithms', async () => ({
    contents: [
      {
        uri: 'lmd://dispatch-algorithms',
        mimeType: 'application/json',
        text: JSON.stringify({
          description: 'Yassir LMD dispatch algorithm types',
          algorithms: {
            normal: 'V1 dispatch: simple geo-based driver selection with batching',
            yassir_dispatch_v2: 'V2 dispatch: route optimization with distance + penalty ranking',
            next_mv: 'NextMV external API for advanced route optimization',
          },
          config_fields: {
            auto_dispatch: 'Boolean - is auto-dispatch enabled for the city',
            dispatch_delay_time: 'Minutes to wait before starting dispatch',
            max_dispatch_time: 'Max minutes to try dispatching before giving up',
            max_rejected_drivers: 'Max driver rejections before dispatch fails (default 10)',
            driver_radius: 'Search radius in km for finding drivers (default 20)',
            max_orders: 'Max concurrent orders per driver',
          },
        }),
      },
    ],
  }));

  server.resource('city-configs', 'lmd://city-configs', async () => {
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
          uri: 'lmd://city-configs',
          mimeType: 'application/json',
          text: JSON.stringify({
            description: 'City-level dispatch and operations configurations',
            cities,
          }),
        },
      ],
    };
  });

  for (const [key, schema] of Object.entries(COLLECTION_SCHEMAS)) {
    server.resource(`schema-${key}`, `lmd://schema/${schema.collection}`, async () => ({
      contents: [
        {
          uri: `lmd://schema/${schema.collection}`,
          mimeType: 'application/json',
          text: JSON.stringify(schema),
        },
      ],
    }));
  }

  server.resource('all-schemas', 'lmd://schemas', async () => ({
    contents: [
      {
        uri: 'lmd://schemas',
        mimeType: 'application/json',
        text: getAllSchemasCompact(),
      },
    ],
  }));

  return server;
}
