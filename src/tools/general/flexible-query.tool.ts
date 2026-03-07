import { z } from "zod";
import mongoose from "mongoose";
import { wrapToolResponse } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";

const MAX_RESULTS = 50;
const MAX_FILTER_DEPTH = 3;

const BLOCKED_COLLECTIONS = new Set([
  "system.views",
  "system.profile",
  "system.js",
]);

const DEPRECATED_COLLECTIONS = new Set([
  "cart",
  "restaurants",
  "blogpostxes",
  "blogpostxxes",
  "blogs",
  "categoriesX",
  "model1",
  "delete_me",
  "billing_comparison",
  "billing_cycle_copy",
  "billing_cycle_duplicates",
  "billing_cycle_duplicates_by_city",
  "billing_cycle_duplicates_by_city_dangling",
  "billing_cycle_fallback",
  "billing_cycle_fallback2",
  "driver_billings_fallback",
  "driver_billings_fallback2",
  "restaurant_billings_cleanup_v2",
  "restaurant_billing_cycle_cleanup_v2",
  "cartv2_archived",
  "deleted_restaurant_orders_backup",
  "tmp_deleted_restaurants",
  "rejectedOrdersTemp",
  "temp_cart",
  "temp_payment",
  "temp_popular_items_1755449372867",
  "cartlog",
  "count_yamaps_google",
  "cobrand",
  "cobrandproduct",
  "postfooter",
  "postheader",
  "newsletter_subscriber",
  "contact",
]);

const COLLECTION_REDIRECTS: Record<string, string> = {
  restaurants: "restaurant",
  cart: "cartv2",
  driver: "drivers",
  cities: "city",
  countries: "countrycurrency",
};

const BLOCKED_FIELDS = [
  "password",
  "token",
  "secret",
  "credit_card",
  "card_number",
  "cvv",
  "pin",
  "otp",
  "refresh_token",
  "access_token",
  "api_key",
  "apikey",
  "client_secret",
  "auth_code",
  "approval_code",
  "transaction_id",
  "payment_order_id",
  "action_id",
  "device_token",
];

const COLLECTION_REDACTED_KEYS: Record<string, string[]> = {
  cart_payment_transactions: [
    "MICRO_SERVICE_TRANSACTION_ID",
    "YASSIR_ACTION_ID",
    "PAYMENT_ORDER_ID",
    "CLIENT_SECRET_KEY",
    "AUTH_CODE",
    "AUTH_CODE_DESC",
    "APPROVAL_CODE",
    "END_MESSAGES",
    "TRACKER",
    "INTERNAL_ERROR_MESSAGE",
    "REMOTE_ERROR_MESSAGE",
  ],
  courier_payments: [
    "MICRO_SERVICE_TRANSACTION_ID",
    "YASSIR_ACTION_ID",
    "PAYMENT_ORDER_ID",
    "CLIENT_SECRET_KEY",
    "AUTH_CODE",
    "AUTH_CODE_DESC",
    "APPROVAL_CODE",
  ],
  payment_gateway: [
    "MICRO_SERVICE_TRANSACTION_ID",
    "CLIENT_SECRET_KEY",
    "AUTH_CODE",
    "APPROVAL_CODE",
  ],
  temp_payment: [
    "MICRO_SERVICE_TRANSACTION_ID",
    "CLIENT_SECRET_KEY",
    "AUTH_CODE",
    "APPROVAL_CODE",
  ],
};

function stripBlockedFields(
  doc: Record<string, unknown>,
  collection: string,
): Record<string, unknown> {
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
    if (typeof obj === "object" && !isObjectId(obj) && !(obj instanceof Date)) {
      const cleaned: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(
        obj as Record<string, unknown>,
      )) {
        if (isBlocked(key)) {
          cleaned[key] = "[REDACTED]";
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

export const flexibleQuerySchema = z.object({
  collection: z
    .string()
    .describe(
      "REQUIRED. MongoDB collection name. Examples: orders, restaurant, drivers, city, countrycurrency, cartv2, food, users, offer, etc.",
    ),
  action: z
    .enum(["count", "find", "distinct"])
    .describe(
      "REQUIRED. 'count' returns document count, 'find' returns documents, 'distinct' returns unique values.",
    ),
  filter: z
    .record(z.unknown())
    .describe(
      "REQUIRED. MongoDB filter. Must have at least one condition. Field names are AUTO-CORRECTED if they don't match the actual document structure. Use describe_collection first to discover correct field names.",
    ),
  distinct_field: z
    .string()
    .optional()
    .describe("OPTIONAL. Field for 'distinct' action."),
  projection: z
    .record(z.number())
    .optional()
    .describe("OPTIONAL. Fields to include (1) or exclude (0)."),
  sort: z
    .record(z.number())
    .optional()
    .describe("OPTIONAL. Sort order. Example: {createdAt:-1}"),
  limit: z
    .number()
    .default(25)
    .describe("OPTIONAL. Max documents, capped at 50 (default 25)."),
});

export type FlexibleQueryInput = z.infer<typeof flexibleQuerySchema>;

function validateFilter(
  filter: Record<string, unknown>,
  depth = 0,
): string | null {
  if (depth > MAX_FILTER_DEPTH)
    return "Filter too deeply nested (max 3 levels).";
  if (Object.keys(filter).length === 0)
    return "Filter cannot be empty — include at least one condition.";

  for (const [key, value] of Object.entries(filter)) {
    if (BLOCKED_FIELDS.some((bf) => key.toLowerCase().includes(bf))) {
      return `Filtering on '${key}' is not allowed for security reasons.`;
    }
    if (key === "$where" || key === "$function" || key === "$accumulator") {
      return `Operator '${key}' is blocked — no arbitrary code execution.`;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = validateFilter(
        value as Record<string, unknown>,
        depth + 1,
      );
      if (nested) return nested;
    }
  }
  return null;
}

function sanitizeProjection(
  projection?: Record<string, number>,
): Record<string, number> | undefined {
  if (!projection) return undefined;
  const safe: Record<string, number> = {};
  for (const [key, val] of Object.entries(projection)) {
    if (BLOCKED_FIELDS.some((bf) => key.toLowerCase().includes(bf))) continue;
    const resolved = FIELD_ALIASES[key.toLowerCase()] ?? key;
    safe[resolved] = val;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}

function getCollection(name: string) {
  const db = mongoose.connection.db;
  if (!db) throw new Error("Database not connected");
  return db.collection(name);
}

function isObjectId(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const constructor = (value as Record<string, unknown>).constructor;
  if (constructor && constructor.name === "ObjectId") return true;
  const str = String(value);
  return str.length === 24 && /^[a-f0-9]{24}$/.test(str);
}

function isBsonLeaf(value: unknown): boolean {
  if (value instanceof Date) return true;
  if (isObjectId(value)) return true;
  if (value instanceof Buffer) return true;
  if (value && typeof value === "object") {
    const constructor = (value as Record<string, unknown>).constructor;
    if (
      constructor &&
      ["Binary", "Decimal128", "Long", "Timestamp", "Double", "Int32"].includes(
        constructor.name,
      )
    )
      return true;
  }
  return false;
}

const MAX_RECURSION_DEPTH = 4;

function extractFieldPaths(
  obj: Record<string, unknown>,
  prefix = "",
  depth = 0,
): string[] {
  if (depth > MAX_RECURSION_DEPTH) return [];
  const paths: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (key === "_id" && depth === 0) continue;
    if (key.startsWith("$")) continue;

    const fullPath = prefix ? `${prefix}.${key}` : key;
    paths.push(fullPath);

    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !isBsonLeaf(value) &&
      Object.keys(value).length > 0
    ) {
      paths.push(
        ...extractFieldPaths(
          value as Record<string, unknown>,
          fullPath,
          depth + 1,
        ),
      );
    }
  }
  return paths;
}

const FIELD_ALIASES: Record<string, string> = {
  total_price: "billings.amount.grand_total",
  price: "billings.amount.grand_total",
  total: "billings.amount.grand_total",
  grand_total: "billings.amount.grand_total",
  delivery_fee: "billings.amount.delivery_amount",
  delivery_amount: "billings.amount.delivery_amount",
  service_charge: "billings.amount.service_charge",
  payment_method: "billings.epay.method",
  coupon_discount: "billings.amount.coupon_discount",
  offer_discount: "billings.amount.offer_discount",
  restaurant_name: "restaurant.restaurantname",
  driver_name: "driver.username",
  user_name: "user.username",
  customer_name: "user.username",
  customer_phone: "user.phone.number",
  user_phone: "user.phone.number",
  driver_phone: "driver.phone.number",
  name: "restaurantname",
};

function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[._-]/g, "");
}

function findBestFieldMatch(
  filterKey: string,
  actualPaths: string[],
): string | null {
  if (filterKey.startsWith("$")) return null;
  if (actualPaths.includes(filterKey)) return filterKey;

  const alias = FIELD_ALIASES[filterKey.toLowerCase()];
  if (alias && actualPaths.includes(alias)) return alias;

  const normalized = normalizeForMatch(filterKey);

  for (const path of actualPaths) {
    if (normalizeForMatch(path) === normalized) return path;
  }

  const filterParts = filterKey
    .toLowerCase()
    .replace(/[._-]/g, " ")
    .split(/\s+/);
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const path of actualPaths) {
    const pathParts = path.toLowerCase().replace(/[._-]/g, " ").split(/\s+/);
    let matchCount = 0;
    for (const fp of filterParts) {
      if (pathParts.some((pp) => pp.includes(fp) || fp.includes(pp))) {
        matchCount++;
      }
    }
    const score = matchCount / Math.max(filterParts.length, pathParts.length);
    if (score > bestScore && score >= 0.5) {
      bestScore = score;
      bestMatch = path;
    }
  }

  return bestMatch;
}

function autoCorrectFilter(
  filter: Record<string, unknown>,
  actualPaths: string[],
): { corrected: Record<string, unknown>; corrections: string[] } {
  const corrected: Record<string, unknown> = {};
  const corrections: string[] = [];

  for (const [key, value] of Object.entries(filter)) {
    if (key.startsWith("$")) {
      corrected[key] = value;
      continue;
    }

    const match = findBestFieldMatch(key, actualPaths);
    if (match && match !== key) {
      corrected[match] = value;
      corrections.push(`"${key}" → "${match}"`);
    } else {
      corrected[key] = value;
    }
  }

  return { corrected, corrections };
}

const schemaCache = new Map<string, string[]>();

async function discoverFields(collectionName: string): Promise<string[]> {
  if (schemaCache.has(collectionName)) {
    return schemaCache.get(collectionName)!;
  }

  const col = getCollection(collectionName);
  const samples = await col.find({}).sort({ _id: -1 }).limit(3).toArray();

  if (samples.length === 0) return [];

  const allPaths = new Set<string>();
  for (const doc of samples) {
    for (const path of extractFieldPaths(doc as Record<string, unknown>)) {
      allPaths.add(path);
    }
  }

  const paths = Array.from(allPaths);
  schemaCache.set(collectionName, paths);
  return paths;
}

export async function flexibleQuery(params: FlexibleQueryInput) {
  const start = Date.now();

  if (COLLECTION_REDIRECTS[params.collection]) {
    params = {
      ...params,
      collection: COLLECTION_REDIRECTS[params.collection],
    };
  }

  if (BLOCKED_COLLECTIONS.has(params.collection)) {
    return wrapToolResponse(
      { error: `Collection '${params.collection}' is not accessible.` },
      { query: "BLOCKED", execution_time_ms: 0, result_count: 0 },
    );
  }

  if (DEPRECATED_COLLECTIONS.has(params.collection)) {
    const redirect = COLLECTION_REDIRECTS[params.collection];
    const hint = redirect
      ? `Use '${redirect}' instead.`
      : `This collection is empty or deprecated.`;
    return wrapToolResponse(
      {
        error: `Collection '${params.collection}' is deprecated/empty. ${hint}`,
      },
      { query: "BLOCKED", execution_time_ms: 0, result_count: 0 },
    );
  }

  const filterError = validateFilter(params.filter);
  if (filterError) {
    return wrapToolResponse(
      { error: filterError },
      { query: "BLOCKED", execution_time_ms: 0, result_count: 0 },
    );
  }

  const actualFields = await discoverFields(params.collection);
  let usedFilter = params.filter;
  let corrections: string[] = [];

  if (actualFields.length > 0) {
    const result = autoCorrectFilter(params.filter, actualFields);
    usedFilter = result.corrected;
    corrections = result.corrections;
  }

  const cappedLimit = Math.min(params.limit, MAX_RESULTS);
  const projection = sanitizeProjection(params.projection);
  let result: unknown;
  let queryDesc: string;
  let resultCount = 0;

  try {
    const col = getCollection(params.collection);

    switch (params.action) {
      case "count": {
        const count = await col.countDocuments(usedFilter);
        resultCount = count;
        result = {
          summary: `Found ${count} documents in ${params.collection} matching the filter.`,
          count,
          ...(corrections.length > 0
            ? {
                auto_corrected_fields: corrections,
                corrected_filter: usedFilter,
              }
            : {}),
        };
        queryDesc = `db.${params.collection}.countDocuments(${JSON.stringify(usedFilter)})`;
        break;
      }
      case "find": {
        const cursor = col.find(usedFilter);
        if (projection) cursor.project(projection);
        cursor.sort((params.sort || { _id: -1 }) as Record<string, 1 | -1>);
        cursor.limit(cappedLimit);
        const rawDocs = await cursor.toArray();
        const total = await col.countDocuments(usedFilter);
        resultCount = total;
        const docs = rawDocs.map((d) =>
          stripBlockedFields(
            d as Record<string, unknown>,
            params.collection,
          ),
        );

        result = {
          summary: `Found ${total} documents in ${params.collection}. Returned ${docs.length}.`,
          returned: docs.length,
          total_matching: total,
          documents: docs,
          ...(corrections.length > 0
            ? {
                auto_corrected_fields: corrections,
                corrected_filter: usedFilter,
              }
            : {}),
          ...(docs.length === 0 && actualFields.length > 0
            ? {
                hint: "0 results. Available fields in this collection:",
                available_fields: actualFields.slice(0, 40),
              }
            : {}),
        };
        queryDesc = `db.${params.collection}.find(${JSON.stringify(usedFilter)}).limit(${cappedLimit})`;
        break;
      }
      case "distinct": {
        if (!params.distinct_field) {
          return wrapToolResponse(
            { error: "distinct_field is required when action is 'distinct'." },
            { query: "BLOCKED", execution_time_ms: 0, result_count: 0 },
          );
        }
        const dfLower = params.distinct_field!.toLowerCase();
        const collKeys = COLLECTION_REDACTED_KEYS[params.collection] ?? [];
        if (
          BLOCKED_FIELDS.some((bf) => dfLower.includes(bf)) ||
          collKeys.includes(params.distinct_field!)
        ) {
          return wrapToolResponse(
            { error: `Field '${params.distinct_field}' is blocked.` },
            { query: "BLOCKED", execution_time_ms: 0, result_count: 0 },
          );
        }

        let distinctField = params.distinct_field;
        if (actualFields.length > 0) {
          const match = findBestFieldMatch(distinctField, actualFields);
          if (match && match !== distinctField) {
            corrections.push(`distinct "${distinctField}" → "${match}"`);
            distinctField = match;
          }
        }

        const values = await col.distinct(distinctField, usedFilter);
        resultCount = values.length;
        result = {
          summary: `Found ${values.length} unique values for "${distinctField}" in ${params.collection}.`,
          field: distinctField,
          unique_values: values.slice(0, MAX_RESULTS),
          total_unique: values.length,
          ...(corrections.length > 0
            ? {
                auto_corrected_fields: corrections,
                corrected_filter: usedFilter,
              }
            : {}),
        };
        queryDesc = `db.${params.collection}.distinct('${distinctField}', ${JSON.stringify(usedFilter)})`;
        break;
      }
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapToolResponse(
      {
        error: `Query failed: ${message}`,
        ...(actualFields.length > 0
          ? { available_fields: actualFields.slice(0, 40) }
          : {}),
      },
      {
        query: `db.${params.collection}.${params.action}(${JSON.stringify(usedFilter)})`,
        execution_time_ms: Date.now() - start,
        result_count: 0,
      },
    );
  }

  const executionTime = Date.now() - start;

  logQuery({
    tool: "flexible_query",
    params: { ...params, filter: usedFilter },
    query: queryDesc!,
    execution_time_ms: executionTime,
    result_count: resultCount,
  });

  return wrapToolResponse(result, {
    query: queryDesc!,
    collection: params.collection,
    execution_time_ms: executionTime,
    result_count: resultCount,
    ...(corrections.length > 0 ? { field_corrections: corrections } : {}),
  });
}
