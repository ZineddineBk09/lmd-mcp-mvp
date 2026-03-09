import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from '../tools/registry.js';
import type { AuthContext, UserPrivilege } from '../auth/types.js';
import { filterToolsByPermissions } from '../auth/tool-filter.js';
import { getMissingPermission } from '../auth/tool-filter.js';
import { isWriteTool, requiresConfirmation } from '../auth/safety-tiers.js';
import { logTool } from '../utils/tool-logger.js';

const handlerMap = new Map<string, (params: unknown, ctx?: AuthContext) => Promise<unknown>>();
for (const tool of TOOL_DEFINITIONS) {
  handlerMap.set(tool.name, tool.handler);
}

/**
 * Get OpenAI function-calling tool definitions.
 * If privileges are provided, only tools the user has permission for are returned.
 */
export function getOpenAITools(privileges?: UserPrivilege[]): ChatCompletionTool[] {
  let tools: ToolDefinition[] = TOOL_DEFINITIONS;

  if (privileges) {
    tools = filterToolsByPermissions(TOOL_DEFINITIONS, privileges);
  }

  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: zodToJsonSchema(t.schema, { target: 'openApi3' }) as Record<string, unknown>,
    },
  }));
}

const MAX_RESULT_CHARS = 16_000;

function safeStringify(value: unknown, maxLen: number): string {
  const text = JSON.stringify(value);
  if (text.length <= maxLen) return text;

  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    const result = ('result' in obj ? obj.result : obj) as Record<string, unknown> | null;
    if (result && typeof result === 'object') {
      // For order detail results — keep the full order but trim items if too large
      if ('order' in result && 'summary' in result) {
        const order = result.order as Record<string, unknown>;
        const items = order?.items;
        if (Array.isArray(items) && items.length > 10) {
          const trimmedOrder = {
            ...order,
            items: items.slice(0, 10),
            _items_truncated: `Showing 10 of ${items.length} items`,
          };
          const attempt = JSON.stringify({
            summary: result.summary,
            order: trimmedOrder,
          });
          if (attempt.length <= maxLen) return attempt;
        }
        // Still too big — drop items entirely but keep everything else
        const compactOrder = { ...order };
        delete compactOrder.items;
        (compactOrder as Record<string, unknown>)._items_omitted = `${Array.isArray(items) ? items.length : 0} items (omitted for size)`;
        const attempt2 = JSON.stringify({
          summary: result.summary,
          order: compactOrder,
        });
        if (attempt2.length <= maxLen) return attempt2;
      }

      if ('summary' in result) {
        const compact: Record<string, unknown> = {
          summary: result.summary,
          _truncated: true,
        };
        // Preserve key fields from different tool types
        for (const key of ['totals', 'count', 'order_count', 'total_count', 'preview', 'requires_confirmation', 'instruction', 'order', 'action', 'success', 'error', 'message', 'available_reasons']) {
          if (key in result) compact[key] = result[key];
        }
        const attempt = JSON.stringify('result' in obj ? { result: compact } : compact);
        if (attempt.length <= maxLen) return attempt;
        // If still too big with all fields, drop the large ones
        delete compact.order;
        delete compact.available_reasons;
        return JSON.stringify('result' in obj ? { result: compact } : compact);
      }
      if ('breakdown' in result && Array.isArray(result.breakdown)) {
        const trimmed = {
          ...result,
          breakdown: result.breakdown.slice(0, 10),
          _truncated: true,
        };
        const attempt = JSON.stringify('result' in obj ? { result: trimmed } : trimmed);
        if (attempt.length <= maxLen) return attempt;
      }
    }
  }

  return JSON.stringify({
    _truncated: true,
    _note: 'Response too large. Ask a more specific question or add filters to narrow results.',
  });
}

export interface ToolExecResult {
  text: string;
  debugQuery?: string;
  isWriteAction?: boolean;
  requiresConfirmation?: boolean;
}

/**
 * Execute a tool by name with auth context.
 * Performs permission checks and passes context to API-backed tools.
 */
export async function executeTool(name: string, args: unknown, ctx?: AuthContext): Promise<ToolExecResult> {
  const handler = handlerMap.get(name);
  if (!handler) return { text: JSON.stringify({ error: `Unknown tool: ${name}` }) };

  if (ctx) {
    const missing = getMissingPermission(name, ctx.privileges);
    if (missing) {
      return {
        text: JSON.stringify({
          error: missing.message,
          permission_denied: true,
        }),
      };
    }
  }

  const toolStart = Date.now();
  logTool({ phase: 'tool_start', tool: name, args });

  try {
    const response = await handler(args, ctx);
    const elapsed = Date.now() - toolStart;
    let debugQuery: string | undefined;
    let dataForLLM: unknown = response;

    if (response && typeof response === 'object') {
      const obj = response as Record<string, unknown>;
      if ('_debug' in obj) {
        const debug = obj._debug as Record<string, unknown> | undefined;
        debugQuery = debug?.query as string | undefined;
        dataForLLM = obj.result ?? response;
      }
    }

    const text = safeStringify(dataForLLM, MAX_RESULT_CHARS);
    const isWrite = isWriteTool(name);
    const needsConfirm = isWrite && requiresConfirmation(name);

    logTool({
      phase: 'tool_result',
      tool: name,
      result: dataForLLM,
      duration_ms: elapsed,
      meta: { debugQuery, isWrite, needsConfirm, text_length: text.length },
    });

    return {
      text,
      debugQuery,
      isWriteAction: isWrite,
      requiresConfirmation: needsConfirm,
    };
  } catch (err) {
    const elapsed = Date.now() - toolStart;
    const errMsg = err instanceof Error ? err.message : String(err);
    logTool({
      phase: 'tool_error',
      tool: name,
      error: errMsg,
      duration_ms: elapsed,
    });
    return {
      text: JSON.stringify({ error: errMsg }),
    };
  }
}

export function getToolCount(): number {
  return TOOL_DEFINITIONS.length;
}

export function getFilteredToolCount(privileges?: UserPrivilege[]): number {
  if (!privileges) return TOOL_DEFINITIONS.length;
  return filterToolsByPermissions(TOOL_DEFINITIONS, privileges).length;
}
