import { z } from "zod";
import mongoose from "mongoose";
import { wrapToolResponse } from "../../utils/fact-check.js";

export const describeCollectionSchema = z.object({
  collection: z
    .string()
    .describe(
      "REQUIRED. MongoDB collection name. Examples: orders, restaurant, drivers, city, countrycurrency, cartv2, food, users, billing_cycles, offer, etc."
    ),
  sample_size: z
    .number()
    .default(3)
    .describe("OPTIONAL. Documents to sample (default 3, max 5)."),
});

export type DescribeCollectionInput = z.infer<typeof describeCollectionSchema>;

const COLLECTION_REDIRECTS: Record<string, string> = {
  restaurants: "restaurant",
  cart: "cartv2",
  driver: "drivers",
  cities: "city",
  countries: "countrycurrency",
};

const SENSITIVE_PATTERN = /password|token|secret|credit_card|card_number|cvv|pin|otp|api_key|apikey/i;

const MAX_DEPTH = 3;
const MAX_FIELDS = 80;

function isObjectId(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const ctor = (value as Record<string, unknown>).constructor;
  if (ctor && ctor.name === "ObjectId") return true;
  const str = String(value);
  return str.length === 24 && /^[a-f0-9]{24}$/.test(str);
}

function isBsonLeaf(value: unknown): boolean {
  if (value instanceof Date) return true;
  if (isObjectId(value)) return true;
  if (value instanceof Buffer) return true;
  if (value && typeof value === "object") {
    const ctor = (value as Record<string, unknown>).constructor;
    if (
      ctor &&
      ["Binary", "Decimal128", "Long", "Timestamp", "Double", "Int32"].includes(ctor.name)
    )
      return true;
  }
  return false;
}

function truncateSample(value: unknown): string {
  if (value === null || value === undefined) return "null";
  const str = String(value);
  return str.length > 60 ? str.slice(0, 57) + "..." : str;
}

function extractFieldPaths(
  obj: Record<string, unknown>,
  prefix = "",
  depth = 0,
  collected: Array<{ path: string; type: string; sample: string }> = []
): Array<{ path: string; type: string; sample: string }> {
  if (depth > MAX_DEPTH || collected.length >= MAX_FIELDS) return collected;

  for (const [key, value] of Object.entries(obj)) {
    if (collected.length >= MAX_FIELDS) break;
    const fullPath = prefix ? `${prefix}.${key}` : key;

    if (SENSITIVE_PATTERN.test(key)) {
      collected.push({ path: fullPath, type: "REDACTED", sample: "***" });
      continue;
    }

    if (value === null || value === undefined) {
      collected.push({ path: fullPath, type: "null", sample: "null" });
    } else if (Array.isArray(value)) {
      const itemType = value.length > 0 ? typeof value[0] : "unknown";
      collected.push({
        path: fullPath,
        type: `Array<${itemType}>`,
        sample: `[${value.length} items]`,
      });
      if (value.length > 0 && typeof value[0] === "object" && value[0] !== null && !isBsonLeaf(value[0])) {
        extractFieldPaths(value[0] as Record<string, unknown>, `${fullPath}.0`, depth + 1, collected);
      }
    } else if (isBsonLeaf(value)) {
      collected.push({
        path: fullPath,
        type: isObjectId(value) ? "ObjectId" : ((value as Record<string, unknown>).constructor?.name ?? "Date"),
        sample: truncateSample(value),
      });
    } else if (typeof value === "object") {
      collected.push({ path: fullPath, type: "Object", sample: "{...}" });
      extractFieldPaths(value as Record<string, unknown>, fullPath, depth + 1, collected);
    } else {
      collected.push({ path: fullPath, type: typeof value, sample: truncateSample(value) });
    }
  }

  return collected;
}

export async function describeCollection(params: DescribeCollectionInput) {
  const start = Date.now();

  let collectionName = params.collection;
  const redirect = COLLECTION_REDIRECTS[collectionName];
  if (redirect) {
    collectionName = redirect;
  }

  const db = mongoose.connection.db;
  if (!db) {
    return wrapToolResponse(
      { error: "Database not connected" },
      { query: "N/A", execution_time_ms: 0, result_count: 0 }
    );
  }

  try {
    const col = db.collection(collectionName);
    const sampleSize = Math.min(params.sample_size, 5);
    const estimatedCount = await col.estimatedDocumentCount();

    const samples = await col
      .find({})
      .sort({ _id: -1 })
      .limit(sampleSize)
      .toArray();

    if (samples.length === 0) {
      return wrapToolResponse(
        {
          collection: collectionName,
          estimated_count: estimatedCount,
          fields: [],
          message: "Collection is empty.",
        },
        {
          query: `db.${collectionName}.find().limit(${sampleSize})`,
          execution_time_ms: Date.now() - start,
          result_count: 0,
        }
      );
    }

    const fieldMap = new Map<string, { type: string; sample: string }>();

    for (const doc of samples) {
      const fields = extractFieldPaths(doc as Record<string, unknown>);
      for (const f of fields) {
        if (!fieldMap.has(f.path)) {
          fieldMap.set(f.path, { type: f.type, sample: f.sample });
        }
      }
    }

    const compactFields: string[] = [];
    for (const [path, info] of fieldMap) {
      compactFields.push(`${path} (${info.type}) = ${info.sample}`);
    }

    const topLevelFields = Array.from(fieldMap.keys()).filter((f) => !f.includes("."));
    const truncated = fieldMap.size >= MAX_FIELDS;

    return wrapToolResponse(
      {
        collection: collectionName,
        estimated_count: estimatedCount,
        top_level_fields: topLevelFields,
        fields: compactFields,
        truncated,
        hint: `Use field paths above in flexible_query filter. Example: {collection:"${collectionName}", action:"find", filter:{"${topLevelFields[1] || "_id"}": <value>}, limit:5}`,
      },
      {
        query: `db.${collectionName}.find().sort({_id:-1}).limit(${sampleSize})`,
        collection: collectionName,
        execution_time_ms: Date.now() - start,
        result_count: samples.length,
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapToolResponse(
      { error: `Failed to describe collection: ${message}` },
      {
        query: `db.${collectionName}.find().limit(${params.sample_size})`,
        execution_time_ms: Date.now() - start,
        result_count: 0,
      }
    );
  }
}
