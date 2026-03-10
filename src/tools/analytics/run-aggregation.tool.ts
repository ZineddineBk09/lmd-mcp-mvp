import { z } from 'zod';
import mongoose from 'mongoose';
import { wrapToolResponse, formatAggregation } from '../../utils/fact-check.js';
import { logQuery } from '../../utils/query-logger.js';

const MAX_PIPELINE_STAGES = 12;
const MAX_RESULT_DOCS = 1000;
const MAX_TIME_MS = 30_000;

// ── Security: blocked stages, operators, collections ────────────────

const BLOCKED_STAGES = new Set(['$out', '$merge', '$currentOp', '$listSessions', '$listLocalSessions', '$collStats', '$indexStats', '$planCacheStats']);

const BLOCKED_OPERATORS = new Set(['$function', '$accumulator', '$where']);

const BLOCKED_COLLECTIONS = new Set(['system.views', 'system.profile', 'system.js']);

const DEPRECATED_COLLECTIONS = new Set([
  'cart',
  'restaurants',
  'blogpostxes',
  'blogpostxxes',
  'blogs',
  'categoriesX',
  'model1',
  'delete_me',
  'billing_comparison',
  'billing_cycle_copy',
  'billing_cycle_duplicates',
  'billing_cycle_duplicates_by_city',
  'billing_cycle_duplicates_by_city_dangling',
  'billing_cycle_fallback',
  'billing_cycle_fallback2',
  'driver_billings_fallback',
  'driver_billings_fallback2',
  'restaurant_billings_cleanup_v2',
  'restaurant_billing_cycle_cleanup_v2',
  'cartv2_archived',
  'deleted_restaurant_orders_backup',
  'tmp_deleted_restaurants',
  'rejectedOrdersTemp',
  'temp_cart',
  'temp_payment',
  'temp_popular_items_1755449372867',
  'cartlog',
  'count_yamaps_google',
  'cobrand',
  'cobrandproduct',
  'postfooter',
  'postheader',
  'newsletter_subscriber',
  'contact',
]);

const COLLECTION_REDIRECTS: Record<string, string> = {
  restaurants: 'restaurant',
  cart: 'cartv2',
  driver: 'drivers',
  cities: 'city',
  countries: 'countrycurrency',
};

const BLOCKED_FIELDS = [
  'password',
  'token',
  'secret',
  'credit_card',
  'card_number',
  'cvv',
  'pin',
  'otp',
  'refresh_token',
  'access_token',
  'api_key',
  'apikey',
  'client_secret',
  'auth_code',
  'approval_code',
  'transaction_id',
  'payment_order_id',
  'action_id',
  'device_token',
];

const COLLECTION_REDACTED_KEYS: Record<string, string[]> = {
  cart_payment_transactions: [
    'MICRO_SERVICE_TRANSACTION_ID',
    'YASSIR_ACTION_ID',
    'PAYMENT_ORDER_ID',
    'CLIENT_SECRET_KEY',
    'AUTH_CODE',
    'AUTH_CODE_DESC',
    'APPROVAL_CODE',
    'END_MESSAGES',
    'TRACKER',
    'INTERNAL_ERROR_MESSAGE',
    'REMOTE_ERROR_MESSAGE',
  ],
  courier_payments: ['MICRO_SERVICE_TRANSACTION_ID', 'YASSIR_ACTION_ID', 'PAYMENT_ORDER_ID', 'CLIENT_SECRET_KEY', 'AUTH_CODE', 'AUTH_CODE_DESC', 'APPROVAL_CODE'],
  payment_gateway: ['MICRO_SERVICE_TRANSACTION_ID', 'CLIENT_SECRET_KEY', 'AUTH_CODE', 'APPROVAL_CODE'],
  temp_payment: ['MICRO_SERVICE_TRANSACTION_ID', 'CLIENT_SECRET_KEY', 'AUTH_CODE', 'APPROVAL_CODE'],
};

// ── Schema ──────────────────────────────────────────────────────────

export const runAggregationSchema = z.object({
  collection: z
    .string()
    .describe('MongoDB collection to aggregate. Examples: orders, restaurant, drivers, city, users, food, dispatches, ratings, coupon, offer, billing_cycle, driver_billings, countrycurrency.'),
  pipeline: z
    .array(z.record(z.unknown()))
    .min(1)
    .describe(
      'MongoDB aggregation pipeline — array of stage objects. ' +
        'Allowed stages: $match, $group, $sort, $limit, $skip, $project, $unwind, $lookup, $addFields, $set, $unset, $count, $facet, $bucket, $bucketAuto, $replaceRoot, $replaceWith, $sortByCount, $sample, $redact, $graphLookup. ' +
        'BLOCKED stages (will be rejected): $out, $merge, $currentOp. ' +
        'Always start with a $match to narrow the dataset. Include $limit to cap results.',
    ),
  explain: z.boolean().optional().describe('If true, returns the query execution plan instead of results. Useful for checking if indexes are used.'),
  comment: z.string().optional().describe('Human-readable description of what this pipeline computes (for logging).'),
});

export type RunAggregationInput = z.infer<typeof runAggregationSchema>;

// ── Validation helpers ──────────────────────────────────────────────

function validatePipeline(pipeline: Record<string, unknown>[]): string | null {
  if (pipeline.length > MAX_PIPELINE_STAGES) {
    return `Pipeline too long: ${pipeline.length} stages (max ${MAX_PIPELINE_STAGES}).`;
  }

  for (let i = 0; i < pipeline.length; i++) {
    const stage = pipeline[i];
    const keys = Object.keys(stage);
    if (keys.length === 0) return `Stage ${i} is empty.`;

    const stageOp = keys[0];
    if (BLOCKED_STAGES.has(stageOp)) {
      return `Stage "${stageOp}" is blocked for security reasons (no write/admin operations).`;
    }

    const operatorViolation = scanForBlockedOperators(stage);
    if (operatorViolation) {
      return `Stage ${i} contains blocked operator "${operatorViolation}" — no arbitrary code execution.`;
    }
  }

  return null;
}

function scanForBlockedOperators(obj: unknown): string | null {
  if (obj == null || typeof obj !== 'object') return null;

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = scanForBlockedOperators(item);
      if (found) return found;
    }
    return null;
  }

  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (BLOCKED_OPERATORS.has(key)) return key;
    const found = scanForBlockedOperators(value);
    if (found) return found;
  }
  return null;
}

function pipelineHasLimit(pipeline: Record<string, unknown>[]): boolean {
  return pipeline.some((stage) => '$limit' in stage);
}

function pipelineHasFacet(pipeline: Record<string, unknown>[]): boolean {
  return pipeline.some((stage) => '$facet' in stage);
}

// ── Field redaction ─────────────────────────────────────────────────

function isObjectId(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const constructor = (value as Record<string, unknown>).constructor;
  if (constructor && constructor.name === 'ObjectId') return true;
  const str = String(value);
  return str.length === 24 && /^[a-f0-9]{24}$/.test(str);
}

function stripBlockedFields(doc: Record<string, unknown>, collection: string): Record<string, unknown> {
  const collectionKeys = COLLECTION_REDACTED_KEYS[collection] ?? [];

  function isBlocked(key: string): boolean {
    const lower = key.toLowerCase();
    if (BLOCKED_FIELDS.some((bf) => lower.includes(bf))) return true;
    if (collectionKeys.includes(key)) return true;
    return false;
  }

  function recurse(obj: unknown, depth: number): unknown {
    if (depth > 6 || obj == null) return obj;
    if (Array.isArray(obj)) return obj.map((item) => recurse(item, depth + 1));
    if (typeof obj === 'object' && !isObjectId(obj) && !(obj instanceof Date)) {
      const cleaned: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        if (isBlocked(key)) {
          cleaned[key] = '[REDACTED]';
        } else {
          cleaned[key] = recurse(val, depth + 1);
        }
      }
      return cleaned;
    }
    return obj;
  }

  return recurse(doc, 0) as Record<string, unknown>;
}

// ── Date expression preprocessor ────────────────────────────────────
// LLMs often generate $dateSubtract / $dateAdd / $$NOW inside $match
// as if they were plain values, but they're aggregation expressions
// that only work inside $expr. We pre-compute them to real Date objects.

const DURATION_MS: Record<string, number> = {
  millisecond: 1,
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000,
  year: 31_536_000_000,
};

function resolveStartDate(val: unknown): Date | null {
  if (val === '$$NOW' || val === 'now' || val === '$$NOW') return new Date();
  if (typeof val === 'string') {
    const d = new Date(val);
    if (!isNaN(d.getTime())) return d;
  }
  if (typeof val === 'number') return new Date(val);
  return null;
}

function tryResolveDateExpr(value: unknown): Date | null {
  if (value === '$$NOW') return new Date();

  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;

  if ('$dateSubtract' in obj) {
    const spec = obj['$dateSubtract'] as Record<string, unknown>;
    const start = resolveStartDate(spec?.startDate) ?? new Date();
    const unit = String(spec?.unit ?? 'day');
    const amount = Number(spec?.amount ?? 0);
    const ms = DURATION_MS[unit] ?? DURATION_MS.day;
    return new Date(start.getTime() - amount * ms);
  }

  if ('$dateAdd' in obj) {
    const spec = obj['$dateAdd'] as Record<string, unknown>;
    const start = resolveStartDate(spec?.startDate) ?? new Date();
    const unit = String(spec?.unit ?? 'day');
    const amount = Number(spec?.amount ?? 0);
    const ms = DURATION_MS[unit] ?? DURATION_MS.day;
    return new Date(start.getTime() + amount * ms);
  }

  return null;
}

function preprocessDateValues(obj: unknown): unknown {
  if (obj === '$$NOW') return new Date();
  if (obj == null || typeof obj !== 'object') {
    if (typeof obj === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(obj)) {
      const d = new Date(obj);
      if (!isNaN(d.getTime())) return d;
    }
    return obj;
  }

  if (Array.isArray(obj)) return obj.map(preprocessDateValues);

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const resolved = tryResolveDateExpr(val);
    if (resolved) {
      result[key] = resolved;
      continue;
    }
    result[key] = preprocessDateValues(val);
  }
  return result;
}

function preprocessPipeline(pipeline: Record<string, unknown>[]): Record<string, unknown>[] {
  return pipeline.map((stage) => {
    if ('$match' in stage) {
      return { $match: preprocessDateValues(stage['$match']) };
    }
    return stage;
  }) as Record<string, unknown>[];
}

// ── Smart display hint ──────────────────────────────────────────────

function inferDisplayHint(results: Record<string, unknown>[]): string {
  if (results.length === 0) return 'No results. Check your $match filter or try broader criteria.';

  const sample = results[0];
  const keys = Object.keys(sample);

  const hasTimeKey = keys.some((k) => /date|day|hour|week|month|period|time|bucket/i.test(k) || (k === '_id' && typeof sample._id === 'string' && /^\d{4}/.test(sample._id as string)));
  const hasCount = keys.some((k) => /count|total|sum|orders/i.test(k));
  const hasAvg = keys.some((k) => /avg|average|mean/i.test(k));

  if (hasTimeKey && (hasCount || hasAvg)) {
    return 'Time-series data detected. Present as a markdown table AND generate a ```chart block with type:"line" using the time field as labels and numeric fields as datasets.';
  }

  if (keys.includes('_id') && hasCount && results.length <= 20) {
    return 'Grouped data detected. Present as a markdown table AND generate a ```chart block with type:"bar" using _id as labels and the count/sum field as data.';
  }

  if (results.length <= 5 && hasCount) {
    return 'Small grouped dataset. Present as a markdown table AND generate a ```chart block with type:"doughnut" using _id as labels and the count field as data.';
  }

  if (results.length > 20) {
    return 'Large result set. Present a summary (totals, averages) and show the top rows in a markdown table. Mention the total count.';
  }

  return 'Present the results as a clean markdown table.';
}

// ── Main handler ────────────────────────────────────────────────────

export async function runAggregation(params: RunAggregationInput) {
  const start = Date.now();

  let collectionName = params.collection;
  if (COLLECTION_REDIRECTS[collectionName]) {
    collectionName = COLLECTION_REDIRECTS[collectionName];
  }

  if (BLOCKED_COLLECTIONS.has(collectionName)) {
    return wrapToolResponse({ error: `Collection '${collectionName}' is not accessible.` }, { query: 'BLOCKED', execution_time_ms: 0, result_count: 0 });
  }

  if (DEPRECATED_COLLECTIONS.has(collectionName)) {
    return wrapToolResponse({ error: `Collection '${collectionName}' is deprecated or empty.` }, { query: 'BLOCKED', execution_time_ms: 0, result_count: 0 });
  }

  const validationError = validatePipeline(params.pipeline);
  if (validationError) {
    return wrapToolResponse({ error: validationError }, { query: 'BLOCKED', execution_time_ms: 0, result_count: 0 });
  }

  let pipeline = [...params.pipeline];

  // Pre-process $match stages: resolve $dateSubtract, $dateAdd, $$NOW, and ISO strings to real Date objects
  pipeline = preprocessPipeline(pipeline);

  console.log(
    `[agg-debug] Preprocessed pipeline for "${collectionName}":`,
    JSON.stringify(pipeline, (_k, v) => (v instanceof Date ? `ISODate("${v.toISOString()}")` : v)),
  );

  if (!pipelineHasLimit(pipeline) && !pipelineHasFacet(pipeline)) {
    pipeline.push({ $limit: MAX_RESULT_DOCS });
  }

  const db = mongoose.connection.db;
  if (!db) {
    return wrapToolResponse({ error: 'Database not connected.' }, { query: 'FAILED', execution_time_ms: 0, result_count: 0 });
  }

  const col = db.collection(collectionName);
  const queryDesc = formatAggregation(collectionName, pipeline);

  try {
    if (params.explain) {
      const plan = await col.aggregate(pipeline, { maxTimeMS: MAX_TIME_MS }).explain('executionStats');

      logQuery({
        tool: 'run_aggregation',
        params: { collection: collectionName, comment: params.comment, explain: true },
        query: queryDesc,
        execution_time_ms: Date.now() - start,
        result_count: 0,
      });

      return wrapToolResponse(
        {
          summary: 'Execution plan returned (no data). Check stages, index usage, and docs examined.',
          explain: plan,
        },
        {
          query: queryDesc + ' [EXPLAIN]',
          collection: collectionName,
          execution_time_ms: Date.now() - start,
          result_count: 0,
        },
      );
    }

    const rawResults = await col.aggregate(pipeline, { maxTimeMS: MAX_TIME_MS }).toArray();

    const results = rawResults.map((doc) => stripBlockedFields(doc as Record<string, unknown>, collectionName));

    const executionTime = Date.now() - start;

    // Verbose logging for debugging: log each result row when set is small
    if (results.length > 0 && results.length <= 50) {
      console.log(`[agg-debug] ${collectionName} | ${params.comment ?? 'no comment'} | ${results.length} results:`);
      results.forEach((r, i) => {
        console.log(`[agg-debug]   [${i}] ${JSON.stringify(r)}`);
      });
    }

    logQuery({
      tool: 'run_aggregation',
      params: { collection: collectionName, comment: params.comment, stages: pipeline.length },
      query: queryDesc,
      execution_time_ms: executionTime,
      result_count: results.length,
    });

    return wrapToolResponse(
      {
        summary: `Aggregation on "${collectionName}" returned ${results.length} document(s) in ${executionTime}ms.`,
        count: results.length,
        results,
        display_hint: inferDisplayHint(results),
      },
      {
        query: queryDesc,
        collection: collectionName,
        execution_time_ms: executionTime,
        result_count: results.length,
      },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const executionTime = Date.now() - start;

    const isTimeout = message.includes('exceeded time limit') || message.includes('MaxTimeMSExpired');

    logQuery({
      tool: 'run_aggregation',
      params: { collection: collectionName, comment: params.comment, stages: pipeline.length },
      query: queryDesc,
      execution_time_ms: executionTime,
      result_count: 0,
    });

    return wrapToolResponse(
      {
        error: isTimeout
          ? `Aggregation timed out after ${MAX_TIME_MS / 1000}s. Simplify the pipeline: add a narrower $match at the start, reduce $lookup scope, or use $limit earlier.`
          : `Aggregation failed: ${message}`,
        hint: 'Check field names with describe_collection if unsure. Ensure $match date filters use ISODate strings or { $gte: "2025-01-01T00:00:00Z" } format.',
      },
      {
        query: queryDesc,
        collection: collectionName,
        execution_time_ms: executionTime,
        result_count: 0,
      },
    );
  }
}
