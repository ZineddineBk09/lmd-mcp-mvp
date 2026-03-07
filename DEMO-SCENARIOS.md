# LMD Ops Command Center — Demo Scenarios

Use these three scenarios to demonstrate the MCP server to stakeholders.
Each scenario shows the natural language question, which tools the agent calls,
the expected output structure, and how to fact-check the results.

---

## Scenario A: "Why are orders timing out?"

**Persona:** City Ops Manager during peak hours
**Question:** "Why are we having so many timeouts in Algiers right now?"

### Tools Called

1. `query_orders` — `{ country_code: "DZ", city: "Algiers", status: [11], since_minutes: 30 }`
2. `fleet_status` — `{ country_code: "DZ", city: "Algiers" }`
3. `dispatch_queue_status` — `{ country_code: "DZ" }`

### Expected Agent Response Pattern

> "In the last 30 minutes, **X orders** timed out in Algiers. Here's why:
> - **Driver shortage:** Only Y drivers online (Z available, W at capacity). Supply health: {status}.
> - **Queue backup:** N orders in dispatch queue, oldest waiting M minutes.
>
> **Recommended actions:**
> 1. Send push notification to offline drivers
> 2. Consider widening dispatch radius from 20 to 30"

### Fact-Check

```bash
# In mongosh
db.orders.countDocuments({
  country_code: "DZ",
  main_city: "Algiers",
  status: 11,
  updatedAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) }
})

# In redis-cli
ZCARD orderDispatchQueue
```

Compare the counts from the MCP `_debug` field with these manual queries.

---

## Scenario B: "Shift summary"

**Persona:** Operations lead at shift handover
**Question:** "Give me a shift summary for the last 8 hours in Tunisia"

### Tools Called

1. `shift_report` — `{ country_code: "TN", hours: 8 }`

### Expected Agent Response Pattern

> **Tunisia 8-Hour Shift Summary (HH:00 - HH:00)**
> - **Orders:** X total — Y delivered (Z%), W timed out (V%), U cancelled
> - **Dispatch:** N orders had driver rejections, M total rejections
> - **Fleet:** P drivers online now out of Q registered
> - **Restaurants:** R currently auto-busy. Worst: "Restaurant Name" (S% rejection rate)

### Fact-Check

```bash
# In mongosh — verify order totals
const sinceDate = new Date(Date.now() - 8 * 3600 * 1000);
db.orders.aggregate([
  { $match: { country_code: "TN", createdAt: { $gte: sinceDate } } },
  { $group: { _id: "$status", count: { $sum: 1 } } },
  { $sort: { _id: 1 } }
]).toArray()
```

The status breakdown should match the `orders.status_breakdown` field in the shift report.

---

## Scenario C: "Auto-busy risk"

**Persona:** Restaurant success manager
**Question:** "Which restaurants in Algeria are close to going auto-busy?"

### Tools Called

1. `auto_busy_predictions` — `{ country_code: "DZ" }`
2. `restaurant_health` — `{ country_code: "DZ", since_hours: 4 }`

### Expected Agent Response Pattern

> **Auto-busy predictions for Algeria (threshold: N consecutive rejections):**
> - **X restaurants at risk** — will trigger auto-busy on next rejection
> - **Y restaurants currently auto-busy**
>
> At-risk restaurants:
> 1. "Restaurant A" — 4/5 consecutive rejections (1 more triggers 30-min pause)
> 2. "Restaurant B" — 3/5 consecutive rejections
>
> **Currently auto-busy:**
> - "Restaurant C" — busy until HH:MM (post-rejection: true)

### Fact-Check

```bash
# In mongosh — verify auto-busy restaurants
db.restaurant.find(
  { "address.country_code": "DZ", "restaurantAvailability.isBusy": true },
  { name: 1, restaurantAvailability: 1 }
).toArray()

# Verify city config
db.cities.findOne(
  { country_code: "DZ" },
  { busySettings: 1, maxRejectedOrders: 1, busyTime: 1 }
)
```

---

## Presentation Flow

1. **Problem** (2 min): Show the current admin dashboard. Highlight the manual effort
   to correlate orders, drivers, restaurants, and dispatch queues across multiple screens.

2. **Solution Demo** (8 min): Run the three scenarios live against staging data.
   Show natural language in → structured insights out.

3. **Fact-Check** (3 min): For one scenario, show the `_debug` query output,
   paste it into mongosh, and show the numbers match.

4. **Architecture** (2 min): Show the diagram — MCP server connects to existing
   MongoDB/Redis, no new infrastructure needed.

5. **Cost** (1 min): Development cost = $0 (Ollama local).
   Production cost = $0 with Cursor, or minimal API cost with Claude/GPT.

6. **Roadmap** (2 min): Phase 5+ — write operations (reassign driver, cancel orders),
   real-time Socket.IO anomaly detection, Slack/Teams integration.

7. **Impact Metrics** (2 min):
   - MTTD (mean time to detect): 15-30 min → <2 min
   - MTTR (mean time to resolve): 30-60 min → <10 min
   - Shift reports: manual → automated
   - Context switching: multiple dashboards → single conversation
