import { zodToJsonSchema } from "zod-to-json-schema";
import type { ChatCompletionTool } from "openai/resources/chat/completions.js";
import { TOOL_DEFINITIONS } from "../tools/registry.js";

const handlerMap = new Map<string, (params: unknown) => Promise<unknown>>();
for (const tool of TOOL_DEFINITIONS) {
  handlerMap.set(tool.name, tool.handler);
}

export function getOpenAITools(): ChatCompletionTool[] {
  return TOOL_DEFINITIONS.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.schema, { target: "openApi3" }) as Record<
        string,
        unknown
      >,
    },
  }));
}

const MAX_RESULT_CHARS = 6000;

function safeStringify(value: unknown, maxLen: number): string {
  const text = JSON.stringify(value);
  if (text.length <= maxLen) return text;

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const result = ("result" in obj ? obj.result : obj) as Record<
      string,
      unknown
    > | null;
    if (result && typeof result === "object") {
      if ("summary" in result) {
        const compact: Record<string, unknown> = {
          summary: result.summary,
          _truncated: true,
        };
        if ("totals" in result) compact.totals = result.totals;
        if ("count" in result) compact.count = result.count;
        if ("order_count" in result) compact.order_count = result.order_count;
        return JSON.stringify("result" in obj ? { result: compact } : compact);
      }
      if ("breakdown" in result && Array.isArray(result.breakdown)) {
        const trimmed = {
          ...result,
          breakdown: result.breakdown.slice(0, 10),
          _truncated: true,
        };
        const attempt = JSON.stringify(
          "result" in obj ? { result: trimmed } : trimmed,
        );
        if (attempt.length <= maxLen) return attempt;
      }
    }
  }

  return JSON.stringify({
    _truncated: true,
    _note:
      "Response too large. Ask a more specific question or add filters to narrow results.",
  });
}

export interface ToolExecResult {
  text: string;
  debugQuery?: string;
}

export async function executeTool(
  name: string,
  args: unknown,
): Promise<ToolExecResult> {
  const handler = handlerMap.get(name);
  if (!handler)
    return { text: JSON.stringify({ error: `Unknown tool: ${name}` }) };
  try {
    const response = await handler(args);
    let debugQuery: string | undefined;
    let dataForLLM: unknown = response;

    if (response && typeof response === "object") {
      const obj = response as Record<string, unknown>;
      if ("_debug" in obj) {
        const debug = obj._debug as Record<string, unknown> | undefined;
        debugQuery = debug?.query as string | undefined;
        dataForLLM = obj.result ?? response;
      }
    }

    const text = safeStringify(dataForLLM, MAX_RESULT_CHARS);
    return { text, debugQuery };
  } catch (err) {
    return {
      text: JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

export function getToolCount(): number {
  return TOOL_DEFINITIONS.length;
}
