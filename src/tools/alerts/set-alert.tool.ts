import { z } from "zod";
import { wrapToolResponse } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";

export const setAlertSchema = z.object({
  action: z
    .enum(["list", "add", "remove"])
    .describe("REQUIRED. Action to perform."),
  metric: z
    .enum([
      "cancellations",
      "timeouts",
      "ghost_drivers",
      "sla_breach_rate",
      "unassigned_orders",
    ])
    .optional()
    .describe("Metric to alert on (required for add)."),
  threshold: z
    .number()
    .optional()
    .describe(
      "Threshold value (required for add). Alert fires when metric exceeds this.",
    ),
  country_code: z.string().optional().describe("OPTIONAL. Country code scope."),
  alert_id: z
    .string()
    .optional()
    .describe("Alert ID to remove (required for remove action)."),
});

export type SetAlertInput = z.infer<typeof setAlertSchema>;

export interface Alert {
  id: string;
  metric: string;
  threshold: number;
  country_code?: string;
  created_at: string;
}

const alertStore = new Map<string, Alert>();

export async function setAlert(params: SetAlertInput) {
  const start = Date.now();

  if (params.action === "list") {
    const alerts = Array.from(alertStore.values());
    const executionTime = Date.now() - start;
    logQuery({
      tool: "set_alert",
      params,
      query: "list alerts",
      execution_time_ms: executionTime,
      result_count: alerts.length,
    });
    return wrapToolResponse(
      { alerts, count: alerts.length },
      {
        query: "list alerts",
        execution_time_ms: executionTime,
        result_count: alerts.length,
      },
    );
  }

  if (params.action === "add") {
    if (!params.metric || params.threshold === undefined) {
      return wrapToolResponse(
        { error: "metric and threshold are required for add action" },
        {
          query: "add alert (validation failed)",
          execution_time_ms: Date.now() - start,
          result_count: 0,
        },
      );
    }
    const id = `alert_${Date.now()}`;
    const alert: Alert = {
      id,
      metric: params.metric,
      threshold: params.threshold,
      country_code: params.country_code,
      created_at: new Date().toISOString(),
    };
    alertStore.set(id, alert);
    const executionTime = Date.now() - start;
    logQuery({
      tool: "set_alert",
      params,
      query: `add alert ${id}`,
      execution_time_ms: executionTime,
      result_count: 1,
    });
    return wrapToolResponse(
      {
        alert,
        message: `Alert ${id} added. Will fire when ${params.metric} exceeds ${params.threshold}.`,
      },
      {
        query: `add alert ${id}`,
        execution_time_ms: executionTime,
        result_count: 1,
      },
    );
  }

  if (params.action === "remove") {
    if (!params.alert_id) {
      return wrapToolResponse(
        { error: "alert_id is required for remove action" },
        {
          query: "remove alert (validation failed)",
          execution_time_ms: Date.now() - start,
          result_count: 0,
        },
      );
    }
    const deleted = alertStore.delete(params.alert_id);
    const executionTime = Date.now() - start;
    logQuery({
      tool: "set_alert",
      params,
      query: `remove alert ${params.alert_id}`,
      execution_time_ms: executionTime,
      result_count: deleted ? 1 : 0,
    });
    return wrapToolResponse(
      {
        removed: deleted,
        message: deleted
          ? `Alert ${params.alert_id} removed.`
          : `Alert ${params.alert_id} not found.`,
      },
      {
        query: `remove alert ${params.alert_id}`,
        execution_time_ms: executionTime,
        result_count: deleted ? 1 : 0,
      },
    );
  }

  return wrapToolResponse(
    { error: "Unknown action" },
    {
      query: "set_alert",
      execution_time_ms: Date.now() - start,
      result_count: 0,
    },
  );
}
