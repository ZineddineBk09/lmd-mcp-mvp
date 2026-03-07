# Fact-Checking Guide for LMD Ops MCP Server

Every MCP tool includes a `_debug` field in its response with the raw query used.
You can copy-paste these queries into `mongosh` or `redis-cli` to verify results independently.

This directory also provides standalone verification scripts.

## How to Use

### 1. MongoDB Scripts (run in `mongosh`)

```bash
# Connect to staging
mongosh "<your_staging_DB_URI>"

# Then load a script
load("fact-check/orders.mongosh.js")
load("fact-check/fleet.mongosh.js")
load("fact-check/restaurant.mongosh.js")
```

### 2. Redis Scripts (run in terminal)

```bash
# Make executable
chmod +x fact-check/dispatch.redis.sh

# Run against staging Redis
REDIS_HOST=<staging_host> REDIS_PORT=6379 bash fact-check/dispatch.redis.sh
```

### 3. Cross-Validate Against Admin APIs

| MCP Tool                | Admin API Equivalent                              |
|-------------------------|--------------------------------------------------|
| `query_orders`          | `POST /orders/list-dashboard`                    |
| `get_needs_attention`   | `POST /orders/needsAttentionCount`               |
| `fleet_status`          | `POST /orders/availabledriverslist`               |
| `rejection_analysis`    | `POST /orders/driversWhoRejected`                |
| `queue_health`          | Bull Board UI at `/admin/bull/jobs`              |

### 4. Built-in Debug Output

Every tool response includes `_debug` when `ENABLE_DEBUG_OUTPUT=true`:

```json
{
  "result": { ... },
  "_debug": {
    "query": "db.orders.aggregate([...])",
    "collection": "orders",
    "execution_time_ms": 45,
    "result_count": 23,
    "timestamp": "2026-03-03T12:00:00.000Z"
  }
}
```

Copy the `query` value directly into `mongosh` to verify.
