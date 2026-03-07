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
  if (typeof value === "object" && value !== null && "result" in value) {
    const obj = value as Record<string, unknown>;
    const result = obj.result;
    if (result && typeof result === "object" && "summary" in result) {
      const summary = (result as Record<string, unknown>).summary;
      return JSON.stringify({ result: { summary }, _truncated: true });
    }
  }
  return text.slice(0, maxLen - 20) + ',"_truncated":true}';
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
