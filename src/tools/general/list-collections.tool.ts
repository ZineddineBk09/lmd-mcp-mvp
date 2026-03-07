import { z } from "zod";
import mongoose from "mongoose";
import { wrapToolResponse } from "../../utils/fact-check.js";

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

const COLLECTION_HINTS: Record<string, string> = {
  orders: "Food delivery orders (statuses, users, drivers, restaurants)",
  restaurant: "Restaurant profiles, menus, settings",
  drivers: "Driver profiles, status, location, vehicle info",
  users: "Customer/user accounts",
  food: "Menu items / food catalog",
  city: "City-level configurations (dispatch, SLA, fees)",
  countrycurrency: "Country settings, currency, codes",
  cartv2: "Active shopping carts",
  offer: "Promotions, discounts, offers",
  coupon: "Coupon codes and usage",
  dispatch: "Dispatch logs and assignment history",
  billing_cycles: "Billing cycle records",
  billing: "Billing/invoicing records",
  picker_history: "Picker assignment and activity logs",
  ratings: "Customer ratings and reviews",
  notification: "Push notification records",
  admin: "Admin/backoffice user accounts",
};

export const listCollectionsSchema = z.object({
  include_empty: z
    .boolean()
    .default(false)
    .describe("OPTIONAL. If true, include collections with 0 documents (default: false)."),
});

export type ListCollectionsInput = z.infer<typeof listCollectionsSchema>;

export async function listCollections(params: ListCollectionsInput) {
  const start = Date.now();

  const db = mongoose.connection.db;
  if (!db) {
    return wrapToolResponse(
      { error: "Database not connected" },
      { query: "N/A", execution_time_ms: 0, result_count: 0 }
    );
  }

  try {
    const collections = await db.listCollections().toArray();

    const results: Array<{ name: string; documents: number; hint?: string }> = [];

    const countPromises = collections
      .filter((c) => !BLOCKED_COLLECTIONS.has(c.name) && !DEPRECATED_COLLECTIONS.has(c.name))
      .map(async (c) => {
        const count = await db.collection(c.name).estimatedDocumentCount();
        return { name: c.name, count };
      });

    const counts = await Promise.all(countPromises);

    for (const { name, count } of counts) {
      if (!params.include_empty && count === 0) continue;
      const entry: { name: string; documents: number; hint?: string } = {
        name,
        documents: count,
      };
      if (COLLECTION_HINTS[name]) {
        entry.hint = COLLECTION_HINTS[name];
      }
      results.push(entry);
    }

    results.sort((a, b) => b.documents - a.documents);

    const summary = results.map((r) => {
      const hint = r.hint ? ` — ${r.hint}` : "";
      return `${r.name} (${r.documents} docs)${hint}`;
    });

    return wrapToolResponse(
      {
        total_collections: results.length,
        collections: summary,
        usage_hint:
          "Pick a collection name, then call describe_collection to see its fields before querying with flexible_query.",
      },
      {
        query: "db.getCollectionNames()",
        execution_time_ms: Date.now() - start,
        result_count: results.length,
      }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return wrapToolResponse(
      { error: `Failed to list collections: ${message}` },
      {
        query: "db.getCollectionNames()",
        execution_time_ms: Date.now() - start,
        result_count: 0,
      }
    );
  }
}
