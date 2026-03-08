import { z } from "zod";
import { wrapToolResponse } from "../../utils/fact-check.js";
import { logQuery } from "../../utils/query-logger.js";

export const scheduledReportSchema = z.object({
  action: z
    .enum(["list", "add", "remove"])
    .describe("REQUIRED. Action to perform."),
  report_type: z
    .enum(["shift_report", "anomaly_check", "fleet_status", "revenue_summary"])
    .optional()
    .describe("Report type (required for add)."),
  interval_hours: z
    .number()
    .optional()
    .describe(
      "Interval in hours between reports (required for add). E.g. 8 for every shift.",
    ),
  webhook_url: z
    .string()
    .optional()
    .describe(
      "Webhook URL to POST the report to (required for add). Slack, Teams, or custom endpoint.",
    ),
  country_code: z
    .string()
    .optional()
    .describe("OPTIONAL. Country code scope for the report."),
  report_id: z
    .string()
    .optional()
    .describe("Report ID to remove (required for remove action)."),
});

export type ScheduledReportInput = z.infer<typeof scheduledReportSchema>;

interface ScheduledReport {
  id: string;
  report_type: string;
  interval_hours: number;
  webhook_url: string;
  country_code?: string;
  created_at: string;
  last_run?: string;
  next_run: string;
}

const reportStore = new Map<string, ScheduledReport>();
const timers = new Map<string, ReturnType<typeof setInterval>>();

function computeNextRun(intervalHours: number): string {
  return new Date(Date.now() + intervalHours * 3600000).toISOString();
}

export async function manageScheduledReports(params: ScheduledReportInput) {
  const start = Date.now();

  if (params.action === "list") {
    const reports = Array.from(reportStore.values());
    logQuery({
      tool: "scheduled_reports",
      params,
      query: "list reports",
      execution_time_ms: Date.now() - start,
      result_count: reports.length,
    });
    return wrapToolResponse(
      {
        reports,
        count: reports.length,
        summary: `${reports.length} scheduled report(s) configured.`,
      },
      {
        query: "list scheduled reports",
        execution_time_ms: Date.now() - start,
        result_count: reports.length,
      },
    );
  }

  if (params.action === "add") {
    if (!params.report_type || !params.interval_hours || !params.webhook_url) {
      return wrapToolResponse(
        {
          error:
            "report_type, interval_hours, and webhook_url are required for add action.",
        },
        {
          query: "add report (validation failed)",
          execution_time_ms: Date.now() - start,
          result_count: 0,
        },
      );
    }

    try {
      const url = new URL(params.webhook_url);
      if (!["https:", "http:"].includes(url.protocol)) {
        throw new Error("Invalid protocol");
      }
      const host = url.hostname.toLowerCase();
      if (
        host === "localhost" ||
        host === "127.0.0.1" ||
        host === "0.0.0.0" ||
        host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        host.startsWith("172.") ||
        host === "[::1]"
      ) {
        return wrapToolResponse(
          {
            error: "Webhook URL must not point to internal/private addresses.",
          },
          {
            query: "add report (blocked URL)",
            execution_time_ms: Date.now() - start,
            result_count: 0,
          },
        );
      }
    } catch {
      return wrapToolResponse(
        {
          error:
            "Invalid webhook URL format. Must be a valid https:// or http:// URL.",
        },
        {
          query: "add report (invalid URL)",
          execution_time_ms: Date.now() - start,
          result_count: 0,
        },
      );
    }

    const id = `report_${Date.now()}`;
    const report: ScheduledReport = {
      id,
      report_type: params.report_type,
      interval_hours: params.interval_hours,
      webhook_url: params.webhook_url,
      country_code: params.country_code,
      created_at: new Date().toISOString(),
      next_run: computeNextRun(params.interval_hours),
    };
    reportStore.set(id, report);

    const timer = setInterval(async () => {
      try {
        const entry = reportStore.get(id);
        if (!entry) {
          clearInterval(timer);
          timers.delete(id);
          return;
        }
        entry.last_run = new Date().toISOString();
        entry.next_run = computeNextRun(entry.interval_hours);

        const payload = {
          report_id: id,
          report_type: entry.report_type,
          country_code: entry.country_code,
          timestamp: entry.last_run,
          message: `Scheduled ${entry.report_type} report triggered. Use the MCP tools to generate the full report.`,
        };

        await fetch(entry.webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }).catch(() => {});
      } catch {}
    }, params.interval_hours * 3600000);
    timers.set(id, timer);

    const executionTime = Date.now() - start;
    logQuery({
      tool: "scheduled_reports",
      params,
      query: `add report ${id}`,
      execution_time_ms: executionTime,
      result_count: 1,
    });
    return wrapToolResponse(
      {
        report,
        message: `Scheduled report ${id}: ${params.report_type} every ${params.interval_hours}h to ${params.webhook_url}.`,
      },
      {
        query: `add scheduled report ${id}`,
        execution_time_ms: executionTime,
        result_count: 1,
      },
    );
  }

  if (params.action === "remove") {
    if (!params.report_id) {
      return wrapToolResponse(
        { error: "report_id is required for remove action." },
        {
          query: "remove report (validation failed)",
          execution_time_ms: Date.now() - start,
          result_count: 0,
        },
      );
    }
    const deleted = reportStore.delete(params.report_id);
    const timer = timers.get(params.report_id);
    if (timer) {
      clearInterval(timer);
      timers.delete(params.report_id);
    }

    const executionTime = Date.now() - start;
    logQuery({
      tool: "scheduled_reports",
      params,
      query: `remove report ${params.report_id}`,
      execution_time_ms: executionTime,
      result_count: deleted ? 1 : 0,
    });
    return wrapToolResponse(
      {
        removed: deleted,
        message: deleted
          ? `Report ${params.report_id} removed.`
          : `Report ${params.report_id} not found.`,
      },
      {
        query: `remove scheduled report ${params.report_id}`,
        execution_time_ms: executionTime,
        result_count: deleted ? 1 : 0,
      },
    );
  }

  return wrapToolResponse(
    { error: "Unknown action" },
    {
      query: "scheduled_reports",
      execution_time_ms: Date.now() - start,
      result_count: 0,
    },
  );
}
