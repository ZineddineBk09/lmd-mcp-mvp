# Yassir LMD Ops Copilot

AI-powered operations assistant for Yassir's Last Mile Delivery team. Uses an LLM with 30 specialized tools connected to MongoDB to answer operational questions in real-time via a chat interface.

**Target audience:** PMs, Operations, Stakeholders, and Developers.
**Access mode:** Read-only. No writes, no mutations, no deletes.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [How It Works (Agent Flow)](#how-it-works-agent-flow)
- [Quick Start](#quick-start)
- [Environment Variables](#environment-variables)
- [LLM Providers](#llm-providers)
- [Project Structure](#project-structure)
- [Tools Reference (30 tools)](#tools-reference-30-tools)
- [API Endpoints](#api-endpoints)
- [Web UI Features](#web-ui-features)
- [Security & Data Protection](#security--data-protection)
- [Currency Handling](#currency-handling)
- [Caching](#caching)
- [Redis (Optional)](#redis-optional)
- [Conversation Storage](#conversation-storage)
- [Deployment](#deployment)
- [FAQ](#faq)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────┐
│                    Web UI (index.html)                │
│         Chat interface + Charts + Dev Mode            │
└────────────────────────┬─────────────────────────────┘
                         │ SSE (Server-Sent Events)
                         ▼
┌──────────────────────────────────────────────────────┐
│              Express API Server (api-server.ts)       │
│  Helmet CSP │ CORS │ Rate Limit │ API Key Auth        │
│                                                       │
│  POST /api/chat ──► LLM (tool calling loop)           │
│                      │                                │
│                      ▼                                │
│               30 Read-Only Tools                      │
│       ┌──────────┬──────────┬──────────┐              │
│       │ MongoDB  │  Redis   │ In-Memory│              │
│       │ (yacool) │(optional)│ (alerts) │              │
│       └──────────┴──────────┴──────────┘              │
└──────────────────────────────────────────────────────┘
```

| Component | Technology |
|-----------|-----------|
| Backend | Node.js + Express + TypeScript |
| LLM | OpenAI-compatible API (Cerebras, Groq, Qwen, Gemini, OpenAI) |
| Database | MongoDB (Mongoose, read-only, secondary preferred) |
| Cache | Redis (optional, for dispatch queue) |
| Protocol | MCP (Model Context Protocol) for stdio clients |
| Frontend | Single HTML file, vanilla JS, Chart.js, marked.js |

---

## How It Works (Agent Flow)

```
User question
    │
    ▼
Express backend receives message via POST /api/chat
    │
    ▼
Backend sends message + system prompt + 30 tool definitions to LLM
    │
    ▼
LLM decides which tool(s) to call (function calling)
    │
    ▼
Backend executes tool → READ-ONLY MongoDB query
    │
    ▼
Tool result sent back to LLM
    │
    ▼
LLM formulates human-friendly response (tables, charts, summaries)
    │
    ▼
Response streams back to user via SSE
```

Steps 3-6 can loop up to **12 rounds** for complex questions. A **2-minute server-side timeout** and a **90-second client-side timeout** prevent runaway requests.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your DB_URI and at least one LLM API key

# 3. Build TypeScript
npm run build

# 4. Start the web server
npm run web
# → http://localhost:3737
```

### Available Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `npm run build` | `tsc` | Compile TypeScript to `dist/` |
| `npm run dev` | `tsc --watch` | Watch mode for development |
| `npm run web` | `node dist/web/api-server.js` | Start the web chat server |
| `npm run start` | `node dist/index.js` | Start MCP stdio server (for MCP clients) |
| `npm run typecheck` | `tsc --noEmit` | Type-check without emitting |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DB_URI` | Yes | MongoDB connection string (preprod/staging) |
| `DB_NAME` | No | Database name override (default: from URI). Set to `yacool` |
| **LLM (pick one)** | | |
| `CEREBRAS_API_KEY` | - | Cerebras API key (1M tokens/day free) |
| `GEMINI_API_KEY` | - | Google Gemini API key (1500 req/day free) |
| `GROQ_API_KEY` | - | Groq API key (100K tokens/day free) |
| `QWEN_API_KEY` | - | Alibaba Cloud / DashScope API key |
| `OPENAI_API_KEY` | - | OpenAI API key (paid) |
| `QWEN_MODEL` | No | Override Qwen model (default: `qwen-plus`) |
| `OPENAI_MODEL` | No | Override model for any provider |
| **Redis (optional)** | | |
| `REDIS_HOST` | No | Redis host for dispatch queue monitoring |
| `REDIS_PORT` | No | Redis port (default: 6379) |
| `REDIS_PASSWORD` | No | Redis password |
| **Security** | | |
| `API_KEY` | No | If set, requires `X-Api-Key` header on `/api/chat` and `/api/export` |
| `CORS_ORIGIN` | No | CORS origin (default: allow all) |
| `RATE_LIMIT_RPM` | No | Max chat requests per minute (default: 60) |
| **Server** | | |
| `WEB_PORT` | No | HTTP port (default: 3737) |

---

## LLM Providers

The server auto-detects the provider from environment variables (first key found wins):

| Priority | Provider | Env Var | Free Tier | Default Model |
|----------|----------|---------|-----------|---------------|
| 1 | Cerebras | `CEREBRAS_API_KEY` | 1M tokens/day | qwen-3-32b |
| 2 | Gemini | `GEMINI_API_KEY` | 1,500 req/day | gemini-2.0-flash |
| 3 | Groq | `GROQ_API_KEY` | 100K tokens/day | llama-3.3-70b-versatile |
| 4 | Qwen (DashScope) | `QWEN_API_KEY` | Generous free quota | qwen-plus |
| 5 | OpenAI | `OPENAI_API_KEY` | Paid | gpt-4o-mini |

All providers use the **OpenAI-compatible API** format. Token usage is logged per request in the terminal.

---

## Project Structure

```
lmd-mcp-mvp/
├── public/
│   ├── index.html              # Web chat UI (single file)
│   ├── favicon.svg             # Yassir 'Y' favicon
│   └── yassir-logo.svg         # Full Yassir logo
├── src/
│   ├── connections/
│   │   ├── mongodb.ts          # MongoDB connection (secondaryPreferred)
│   │   └── redis.ts            # Redis connection (optional, graceful fallback)
│   ├── constants/
│   │   └── order-status.ts     # Status code → label mapping
│   ├── resources/
│   │   └── collection-schemas.ts  # Field guides for LLM context
│   ├── schemas/                # Mongoose schema definitions
│   │   ├── order.schema.ts
│   │   ├── driver.schema.ts
│   │   ├── restaurant.schema.ts
│   │   └── city.schema.ts
│   ├── tools/                  # All 30 tools organized by domain
│   │   ├── alerts/             # set_alert
│   │   ├── analytics/          # 9 analytics tools
│   │   ├── config/             # city_config_lookup
│   │   ├── dispatch/           # rejection_analysis, dispatch_queue
│   │   ├── fleet/              # fleet_status, supply_demand, ghost_drivers, lookup_driver
│   │   ├── general/            # flexible_query, describe_collection, list_collections
│   │   ├── infra/              # shift_report, scheduled_reports
│   │   ├── orders/             # query_orders, needs_attention, sla_status, lookup/investigate
│   │   ├── restaurant/         # restaurant_health, auto_busy, lookup_restaurant
│   │   ├── users/              # lookup_user
│   │   └── registry.ts         # Single source of truth for all tool definitions
│   ├── utils/
│   │   ├── cache.ts            # In-memory cache with TTL
│   │   ├── currency.ts         # Country → currency resolver
│   │   ├── fact-check.ts       # Debug query formatting
│   │   ├── query-logger.ts     # Query logging utility
│   │   └── tool-error.ts       # Structured tool errors
│   ├── web/
│   │   ├── api-server.ts       # Express server (main entry for web mode)
│   │   ├── tool-registry.ts    # OpenAI function calling adapter
│   │   ├── csv-export.ts       # JSON → CSV export utility
│   │   └── conversation-store.ts  # File-based conversation persistence (legacy)
│   ├── server.ts               # MCP server setup
│   └── index.ts                # MCP stdio entry point
├── schema/                     # Original backend Mongoose schemas (reference)
├── system-prompt.txt           # LLM system prompt with rules and tool routing
├── package.json
└── tsconfig.json
```

---

## Tools Reference (30 tools)

### Orders (6 tools)

| Tool | Description |
|------|-------------|
| `query_orders` | Count and list orders with filters by country, city, status, and time range |
| `get_needs_attention` | Find orders stuck without a driver or with delayed pickup |
| `get_order_sla_status` | Check which active orders are breaching delivery time SLA |
| `lookup_order` | Deep-dive into a single order by `_id` with full lifecycle timeline, billing with currency |
| `investigate_order` | Root cause analysis for an order with automated findings |
| `lookup_user` | Look up a customer by phone, email, user_id, or name with order stats and currency |

### Fleet (4 tools)

| Tool | Description |
|------|-------------|
| `fleet_status` | Driver fleet breakdown: online, busy, ghost, offline counts |
| `supply_demand_balance` | Compare active orders vs available drivers to detect shortage |
| `ghost_drivers` | Find drivers online but with stale GPS causing dispatch failures |
| `lookup_driver` | Look up a driver by ID, phone, or username with today's stats |

### Restaurant (3 tools)

| Tool | Description |
|------|-------------|
| `restaurant_health` | Restaurant performance: acceptance rate, rejection rate, prep time |
| `auto_busy_predictions` | Predict which restaurants will auto-disable from consecutive rejections |
| `lookup_restaurant` | Look up a restaurant by ID or name with availability, stats, and currency |

### Analytics (9 tools)

| Tool | Description |
|------|-------------|
| `compare_periods` | Compare a metric between two time periods (supports `group_by_country`) |
| `top_bottom_performers` | Rank cities, restaurants, drivers, or users by a metric |
| `detect_anomalies` | Detect unusual patterns by comparing current hour to 7-day baseline |
| `revenue_metrics` | GMV, delivery fees, avg basket size — with currency per country |
| `eta_accuracy` | ETA accuracy: on-time rate, avg delivery time, breakdown by city |
| `geo_analysis` | Driver and order density by geographic zones |
| `ratings_analysis` | Low-rated orders correlated with restaurants/drivers |
| `promo_performance` | Promo/coupon performance: redemption rates, top coupons |
| `shift_report` | Full shift report: orders, delivery rates, fleet, restaurant performance |

### Dispatch (2 tools)

| Tool | Description |
|------|-------------|
| `rejection_analysis` | Analyze driver rejection patterns and most-rejected orders |
| `dispatch_queue` | Monitor Redis dispatch queue depth and stuck orders (requires Redis) |

### Config & Infra (4 tools)

| Tool | Description |
|------|-------------|
| `city_config_lookup` | Query and compare city-level operational settings |
| `scheduled_reports` | Manage webhook-based scheduled report schedules |
| `set_alert` | Configure threshold-based proactive alerts |

### General (3 tools)

| Tool | Description |
|------|-------------|
| `flexible_query` | Run a read-only query on **any** MongoDB collection (count, find, distinct) |
| `describe_collection` | Discover fields and structure of any collection |
| `list_collections` | List all available MongoDB collections with document counts |

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/health` | No | Health check (DB status, provider, model, tool count) |
| `POST` | `/api/chat` | API Key | SSE streaming chat endpoint |
| `POST` | `/api/export` | API Key | Export tool results as CSV |
| `GET` | `/api/stats` | No | Usage stats (unique visitors, total chats, uptime) |

### SSE Event Types (`/api/chat`)

| Event | Payload | Description |
|-------|---------|-------------|
| `tool_call` | `{ name }` | Tool execution started |
| `tool_result` | `{ name }` | Tool execution completed |
| `content` | `{ text }` | Final LLM response |
| `meta` | `{ queries, tokens }` | Debug queries and token usage |
| `error` | `{ message }` | Error occurred |

---

## Web UI Features

- **Chat interface** with markdown rendering (tables, bold, links)
- **Chart rendering** — ask "show as a chart" and the AI outputs interactive Chart.js visualizations (bar, line, pie, doughnut)
- **Quick actions** — preset buttons for common queries (Active Orders, Fleet Status, Shift Report, etc.)
- **Country focus** — sidebar dropdown to scope queries to a specific country
- **Dev mode** — toggle to show raw MongoDB queries used by each tool (for fact-checking)
- **Conversation persistence** — chat history saved in `localStorage`, resumable from the sidebar
- **Stop button** — cancel in-flight requests (Escape key or click the stop button)
- **Dark theme** — Yassir brand colors

---

## Security & Data Protection

### 1. Read-Only Database Access

- MongoDB connection uses `readPreference: "secondaryPreferred"`
- All tools only execute `find`, `countDocuments`, `distinct`, and `aggregate` operations
- **No insert, update, delete, or drop operations are possible**
- All schemas use `strict: false` for read flexibility but no write schemas exist

### 2. Sensitive Field Blocking

All query results are **recursively sanitized** before being sent to the LLM or user.

**Global blocked patterns** (any field name containing these strings is redacted):

```
password, token, secret, credit_card, card_number, cvv, pin, otp,
refresh_token, access_token, api_key, apikey, client_secret, auth_code,
approval_code, transaction_id, payment_order_id, action_id, device_token
```

**Collection-specific redaction** for payment collections:

| Collection | Redacted Fields |
|------------|----------------|
| `cart_payment_transactions` | `CLIENT_SECRET_KEY`, `PAYMENT_ORDER_ID`, `MICRO_SERVICE_TRANSACTION_ID`, `YASSIR_ACTION_ID`, `AUTH_CODE`, `APPROVAL_CODE`, `TRACKER`, `END_MESSAGES`, error messages |
| `courier_payments` | Same payment secrets |
| `payment_gateway` | Same payment secrets |
| `temp_payment` | Same payment secrets |

Blocked fields appear as `"[REDACTED]"` in results.

### 3. Query Safety

- **Blocked operators**: `$where`, `$function`, `$accumulator` (no arbitrary code execution)
- **Max filter depth**: 3 levels of nesting
- **Max results**: 50 documents per query
- **Blocked collections**: `system.views`, `system.profile`, `system.js`

### 4. API Security

- **API key authentication** — when `API_KEY` is set, `/api/chat` and `/api/export` require `X-Api-Key` header
- **Rate limiting** — `express-rate-limit` on `/api/chat` (default: 60 req/min)
- **Helmet CSP** — Content Security Policy restricting scripts, styles, and connections
- **CORS** — configurable origin restriction
- **Webhook URL validation** — scheduled reports block internal/private IPs (SSRF prevention)

### 5. What the AI CAN and CANNOT see

| Can See | Cannot See |
|---------|------------|
| Order status, timestamps, city, country | Passwords, tokens, secrets |
| Customer name, phone, email (ops needs these) | Credit card numbers, CVVs |
| Billing amounts (with currency) | Payment gateway transaction IDs |
| Driver name, phone, location | Auth codes, approval codes |
| Restaurant name, phone, status | Client secret keys |

---

## Currency Handling

Each country has its own currency. The system ensures monetary values are always displayed with the correct currency symbol.

| Country | Code | Currency | Symbol |
|---------|------|----------|--------|
| Algeria | DZ | DZD | د.ج |
| Morocco | MA | MAD | DH |
| Tunisia | TN | TND | DT |
| France | FR | EUR | € |
| Senegal | SN | XOF | CFA |
| South Africa | ZA | ZAR | R |

**How it works:**

1. `src/utils/currency.ts` resolves `country_code` → `{ currency_code, currency_symbol }` from the `countrycurrency` collection (cached for 5 minutes, hardcoded fallbacks)
2. All monetary tools (`revenue_metrics`, `lookup_order`, `lookup_user`, `lookup_restaurant`, `promo_performance`) include `currency_code` and `currency_symbol` in their responses
3. When revenue is grouped by country, **no cross-currency totals are computed** — you cannot sum DZD + MAD + EUR
4. The system prompt instructs the AI to always display currency symbols and never sum across currencies

---

## Caching

In-memory cache (`src/utils/cache.ts`) reduces database load for frequently accessed data.

| Data | TTL | Description |
|------|-----|-------------|
| Currency map | 5 min | Country → currency mapping |
| Revenue metrics | 1 min | Revenue aggregation results |
| Anomaly baseline | 1 hour | 7-day historical counts |
| Collection field samples | 30 sec | `describe_collection` results |

- Max cache entries: 200 (LRU eviction)
- Cache is per-process, resets on restart

---

## Redis (Optional)

Redis is **optional** and only used by the `dispatch_queue` tool to monitor dispatch queues.

- If Redis is not configured: the tool returns a clear error message instead of crashing
- If Redis is down: 60-second cooldown before retrying, no app crash
- If Redis is available: provides dispatch queue depth, stuck orders, and processing counts

Configure via `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` environment variables.

---

## Conversation Storage

Chat conversations are stored in the browser's `localStorage` under the key `yassir_conversations`.

- **Auto-saved** after each assistant reply
- **Resumable** from the sidebar (up to 30 recent conversations)
- **Deletable** via the × button next to each conversation
- **Per-browser** — conversations don't sync across devices
- **Survives deploys** — unlike server-side storage, localStorage persists across server restarts

---

## Deployment

### Render (Free Tier)

The app is designed to work on Render's free tier:

- No persistent filesystem needed (conversations are in localStorage)
- Single `npm run build && npm run web` command
- Graceful degradation: Redis, alerts, and scheduled reports work in-memory and degrade gracefully
- Environment variables configured via Render dashboard

### Build Command

```bash
npm install && npm run build
```

### Start Command

```bash
npm run web
```

### Health Check

```
GET /api/health
```

Returns `200` if MongoDB is connected, `503` if degraded.

---

## FAQ

### Is it read-only?

**Yes, 100%.** The server only runs `find`, `countDocuments`, `distinct`, and `aggregate` MongoDB operations. There are no write schemas, no insert/update/delete handlers, and the connection uses `readPreference: "secondaryPreferred"` which routes to replica set secondaries.

### Can it leak passwords or payment info?

**No.** All query results are recursively sanitized through two layers: global `BLOCKED_FIELDS` (pattern matching on field names) and `COLLECTION_REDACTED_KEYS` (exact field names for payment collections). Blocked values appear as `"[REDACTED]"`.

### What if the LLM hallucinates a field name?

The `flexible_query` tool has a **field auto-correction** system. It samples the collection's actual fields and fuzzy-matches the LLM's requested field to the closest real field. There's also a static `FIELD_ALIASES` map for common mismatches (e.g., `total_price` → `billings.amount.grand_total`).

### What if the LLM tries to write to the database?

It can't. The tool layer only exposes read operations. There are no write tools registered. Even `flexible_query` only supports `count`, `find`, and `distinct` actions.

### What if Redis is down?

The app continues working. Only `dispatch_queue` uses Redis. If Redis is unavailable, the tool returns an error message immediately without hanging. The app never crashes due to Redis failures.

### Can I use this with MCP clients (Claude, Cursor, etc.)?

Yes. Run `npm run start` to launch the MCP stdio server. This exposes all 30 tools via the Model Context Protocol for use with any MCP-compatible client.

### How are tokens counted?

Each `/api/chat` request logs token usage to the terminal:
```
[llm] user query | input+output=total tokens | N tools | Xms
```

### What countries are supported?

DZ (Algeria), MA (Morocco), TN (Tunisia), FR (France), SN (Senegal), ZA (South Africa). Each has its own currency, timezone, and operational configuration.

### Can I add new tools?

1. Create a new `.tool.ts` file in the appropriate `src/tools/` subdirectory
2. Export a Zod schema and handler function
3. Add the tool to `src/tools/registry.ts`
4. Add routing hints to `system-prompt.txt`
5. Rebuild with `npm run build`

---

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@modelcontextprotocol/sdk` | ^1.27.0 | MCP server protocol |
| `express` | ^5.2.1 | HTTP server |
| `mongoose` | ^6.13.8 | MongoDB ODM |
| `openai` | ^6.27.0 | LLM API client (OpenAI-compatible) |
| `zod` | ^3.25.0 | Schema validation for tool inputs |
| `zod-to-json-schema` | ^3.25.1 | Convert Zod schemas to JSON Schema for function calling |
| `helmet` | ^8.1.0 | Security headers (CSP, etc.) |
| `cors` | ^2.8.6 | Cross-origin resource sharing |
| `express-rate-limit` | ^8.3.0 | Rate limiting |
| `ioredis` | ^5.10.0 | Redis client (optional) |
| `dotenv` | ^16.4.5 | Environment variable loading |
****