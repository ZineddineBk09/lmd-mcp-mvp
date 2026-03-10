import type { PermissionRequirement } from './types.js';

/**
 * Maps each tool to the privilege alias + action required to use it.
 * `null` means the tool is available to any authenticated user.
 * Missing tools are default-deny (blocked).
 */
export const TOOL_PERMISSION_MAP: Record<string, PermissionRequirement | null> = {
  // ── API-backed order read tools ──────────────────────────────────
  list_orders: { alias: 'orders', action: 'view' },
  get_order_details: { alias: 'orders', action: 'view' },

  // ── API-backed order write tools ─────────────────────────────────
  accept_order: { alias: 'orders', action: 'edit' },
  reject_order: { alias: 'orders', action: 'edit' },
  cancel_order: { alias: 'orders', action: 'edit' },

  // ── Direct DB order tools (kept) ─────────────────────────────────
  query_orders: { alias: 'orders', action: 'view' },
  lookup_order: { alias: 'orders', action: 'view' },
  investigate_order: { alias: 'orders', action: 'view' },
  get_needs_attention: { alias: 'orders', action: 'view' },
  get_order_sla_status: { alias: 'orders', action: 'view' },

  // ── User tools ───────────────────────────────────────────────────
  lookup_user: { alias: 'users', action: 'view' },

  // ── Fleet / Driver tools ─────────────────────────────────────────
  fleet_status: { alias: 'driver', action: 'view' },
  supply_demand_balance: { alias: 'driver', action: 'view' },
  ghost_drivers: { alias: 'driver', action: 'view' },
  lookup_driver: { alias: 'driver', action: 'view' },

  // ── Restaurant tools ─────────────────────────────────────────────
  restaurant_health: { alias: 'restaurant', action: 'view' },
  auto_busy_predictions: { alias: 'restaurant', action: 'view' },
  lookup_restaurant: { alias: 'restaurant', action: 'view' },

  // ── Dispatch tools ───────────────────────────────────────────────
  rejection_analysis: { alias: 'orders', action: 'view' },
  dispatch_queue: { alias: 'orders', action: 'view' },

  // ── Analytics tools ──────────────────────────────────────────────
  compare_periods: { alias: 'dashboard', action: 'view' },
  top_bottom_performers: { alias: 'dashboard', action: 'view' },
  detect_anomalies: { alias: 'dashboard', action: 'view' },
  revenue_metrics: { alias: 'dashboard', action: 'view' },
  eta_accuracy: { alias: 'dashboard', action: 'view' },
  geo_analysis: { alias: 'dashboard', action: 'view' },
  ratings_analysis: { alias: 'dashboard', action: 'view' },
  promo_performance: { alias: 'dashboard', action: 'view' },
  run_aggregation: { alias: 'dashboard', action: 'view' },

  // ── Config / Infra / Alerts ──────────────────────────────────────
  city_config_lookup: { alias: 'dashboard', action: 'view' },
  shift_report: { alias: 'dashboard', action: 'view' },
  scheduled_reports: { alias: 'dashboard', action: 'view' },
  set_alert: { alias: 'dashboard', action: 'view' },

  // ── Finance / Earnings tools ────────────────────────────────────
  get_admin_earnings: { alias: 'siteearnings', action: 'view' },
  list_billing_cycles: { alias: 'siteearnings', action: 'view' },
  get_driver_payouts: { alias: 'siteearnings', action: 'view' },
  get_driver_payout_details: { alias: 'siteearnings', action: 'view' },
  list_restaurant_cycles: { alias: 'siteearnings', action: 'view' },
  get_restaurant_cycle_orders: { alias: 'siteearnings', action: 'view' },

  // ── General exploration tools (available to all authenticated) ───
  flexible_query: null,
  describe_collection: null,
  list_collections: null,
};
