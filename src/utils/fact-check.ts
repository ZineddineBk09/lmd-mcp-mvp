const DEBUG_ENABLED = process.env.ENABLE_DEBUG_OUTPUT !== 'false';
const COMPACT_MODE = process.env.COMPACT_RESPONSES === 'true';

export interface DebugInfo {
  query: string;
  collection?: string;
  execution_time_ms: number;
  result_count?: number;
  timestamp: string;
}

export interface ToolResponse<T> {
  result: T;
  _debug?: DebugInfo;
}

export function wrapToolResponse<T>(result: T, debug: Omit<DebugInfo, 'timestamp'>): ToolResponse<T> {
  let finalResult = result;

  if (COMPACT_MODE && result && typeof result === 'object') {
    finalResult = compactResult(result as Record<string, unknown>) as T;
  }

  if (!DEBUG_ENABLED) {
    return { result: finalResult };
  }

  return {
    result: finalResult,
    _debug: {
      ...debug,
      timestamp: new Date().toISOString(),
    },
  };
}

function compactResult(obj: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'summary' || key === 'error') {
      compact[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.length > 10) {
      compact[key] = value.slice(0, 10);
      compact[`${key}_truncated`] = `Showing 10 of ${value.length}`;
    } else {
      compact[key] = value;
    }
  }
  return compact;
}

export function formatMongoQuery(collection: string, method: string, args: unknown[]): string {
  const serialized = args.map((a) => JSON.stringify(a, replacer)).join(', ');
  return `db.${collection}.${method}(${serialized})`;
}

export function formatAggregation(collection: string, pipeline: unknown[]): string {
  return `db.${collection}.aggregate(${JSON.stringify(pipeline, replacer)})`;
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Date) {
    return `ISODate("${value.toISOString()}")`;
  }
  if (typeof value === 'object' && value !== null && '$gte' in value) {
    return value;
  }
  return value;
}
