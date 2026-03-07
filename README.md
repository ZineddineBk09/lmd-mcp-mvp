# LMD Ops Command Center — MCP Server

An MCP (Model Context Protocol) server that exposes Yassir LMD operational data as AI-consumable tools. Connect it to any MCP-compatible client (Cursor, Claude Desktop, ollmcp + Ollama) to query orders, fleet status, dispatch health, and restaurant performance using natural language.

## Quick Start

```bash
# 1. Install dependencies
cd mcp-ops-server
npm install

# 2. Build
npm run build

# 3. Copy env and fill in staging credentials
cp .env.example .env
# Edit .env with your DB_URI and REDIS_HOST

# 4. Test it works (will connect and exit — needs valid DB_URI)
node dist/index.js
```

## LLM Client Setup (Zero Cost)

### Option A: Cursor (Recommended — Already Installed)

The MCP config is already created at `.cursor/mcp.json` in the workspace root.
Edit it to add your staging `DB_URI`:

```json
{
  "mcpServers": {
    "lmd-ops": {
      "command": "node",
      "args": ["mcp-ops-server/dist/index.js"],
      "env": {
        "DB_URI": "<your_staging_mongo_uri>",
        "REDIS_HOST": "<your_staging_redis_host>"
      }
    }
  }
}
```

Then restart Cursor. The tools will appear in Agent mode.

### Option B: Ollama + ollmcp (100% Free, Fully Local)

```bash
# Install Ollama
brew install ollama

# Pull a model with tool-calling support
ollama pull qwen3:8b
# or: ollama pull llama3.1:8b
# or: ollama pull mistral:7b-instruct-v0.3

# Install the MCP client for Ollama
pip install ollmcp

# Run with the MCP server
ollmcp --model qwen3:8b \
  --mcp "node /Users/yassirit/Documents/GitHub/yacool_website/mcp-ops-server/dist/index.js"
```

> Requires 8GB+ RAM. Qwen3 8B has the best tool-calling accuracy among open models.

### Option C: Claude Desktop (Free Tier — Native MCP)

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "lmd-ops": {
      "command": "node",
      "args": ["/Users/yassirit/Documents/GitHub/yacool_website/mcp-ops-server/dist/index.js"],
      "env": {
        "DB_URI": "<your_staging_mongo_uri>",
        "REDIS_HOST": "<your_staging_redis_host>"
      }
    }
  }
}
```

Restart Claude Desktop. The 12 tools will appear under the hammer icon.

## Available Tools (12)

### Order Intelligence
| Tool | Description |
|------|-------------|
| `query_orders` | Query orders by country, city, status, time range |
| `get_needs_attention` | Find unassigned or pickup-delayed orders |
| `get_order_sla_status` | Check SLA health for active orders |

### Dispatch Intelligence
| Tool | Description |
|------|-------------|
| `dispatch_queue_status` | Dispatch queue health (Redis orderDispatchQueue) |
| `rejection_analysis` | Analyze driver rejection patterns |

### Fleet Intelligence
| Tool | Description |
|------|-------------|
| `fleet_status` | Real-time driver online/offline/ghost/capacity counts |
| `supply_demand_balance` | Compare active orders vs available drivers |
| `ghost_drivers` | Find drivers with stale GPS data |

### Restaurant Health
| Tool | Description |
|------|-------------|
| `restaurant_health` | Acceptance rate, prep time, auto-busy risk |
| `auto_busy_predictions` | Predict which restaurants will trigger auto-busy |

### Infrastructure
| Tool | Description |
|------|-------------|
| `queue_health` | BullMQ job queue status |
| `shift_report` | Comprehensive operational shift summary |

## MCP Resources (3)

Provide contextual knowledge to the LLM without tool calls:

- `lmd://status-codes` — order status enum with labels
- `lmd://dispatch-algorithms` — V1/V2/NextMV algorithm descriptions
- `lmd://city-configs` — city-level dispatch and operations configs

## Example Conversations

**"Why are orders timing out in Algiers?"**
→ Agent calls `query_orders` (status 11) + `fleet_status` + `dispatch_queue_status`

**"Give me a shift summary for today"**
→ Agent calls `shift_report`

**"Which restaurants are about to go auto-busy?"**
→ Agent calls `auto_busy_predictions` + `restaurant_health`

**"Are there enough drivers in Casablanca?"**
→ Agent calls `supply_demand_balance`

## Fact-Checking

Every tool response includes a `_debug` field with the raw MongoDB/Redis query.
Paste it into `mongosh` or `redis-cli` to verify independently.

Standalone verification scripts are in `fact-check/`:

```bash
# MongoDB
mongosh "<DB_URI>" --eval 'load("fact-check/orders.mongosh.js")'
mongosh "<DB_URI>" --eval 'load("fact-check/fleet.mongosh.js")'
mongosh "<DB_URI>" --eval 'load("fact-check/restaurant.mongosh.js")'

# Redis
REDIS_HOST=<host> bash fact-check/dispatch.redis.sh
```

See [fact-check/README.md](fact-check/README.md) for the full verification guide.

## Development

```bash
npm run dev       # Watch mode (recompile on changes)
npm run typecheck # Type check without emitting
npm run build     # Full build to dist/
```

## Architecture

```
MCP Client (Cursor/Claude/ollmcp)
        │ stdio
        ▼
  MCP Server (src/index.ts)
        │
   ┌────┼────┬──────────┐
   ▼    ▼    ▼          ▼
MongoDB Redis BullMQ  Sentry
(orders, (dispatch  (job    (future)
 drivers, queue,    health)
 restaurant, capacity)
 cities)
```
