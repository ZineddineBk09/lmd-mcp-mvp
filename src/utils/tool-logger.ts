import { writeFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_DIR = resolve(__dirname, '..', '..', 'logs');
const MAX_VALUE_LEN = 2000;

if (!existsSync(LOG_DIR)) {
  mkdirSync(LOG_DIR, { recursive: true });
}

function getLogFilePath(): string {
  const date = new Date().toISOString().slice(0, 10);
  return resolve(LOG_DIR, `tool-calls-${date}.jsonl`);
}

function truncate(value: unknown): unknown {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (!str || str.length <= MAX_VALUE_LEN) return value;
  if (typeof value === 'string') return value.slice(0, MAX_VALUE_LEN) + '…[truncated]';
  return JSON.parse(str.slice(0, MAX_VALUE_LEN - 20) + '"…[truncated]"}') ?? str.slice(0, MAX_VALUE_LEN) + '…';
}

function safeTruncate(value: unknown): unknown {
  try {
    return truncate(value);
  } catch {
    const s = String(value);
    return s.length > MAX_VALUE_LEN ? s.slice(0, MAX_VALUE_LEN) + '…' : s;
  }
}

export type ToolLogPhase =
  | 'llm_request' // LLM asked to call a tool
  | 'tool_start' // Tool execution begins
  | 'api_call' // Outgoing API call from within a tool
  | 'api_response' // Response from an API call
  | 'tool_result' // Tool finished, result ready
  | 'tool_error' // Tool threw an error
  | 'llm_response'; // Final LLM text response

export interface ToolLogEntry {
  phase: ToolLogPhase;
  timestamp: string;
  tool?: string;
  args?: unknown;
  result?: unknown;
  error?: string;
  duration_ms?: number;
  meta?: Record<string, unknown>;
}

const inMemoryLog: ToolLogEntry[] = [];
const MAX_MEMORY_LOG = 200;

export function logTool(entry: Omit<ToolLogEntry, 'timestamp'>): void {
  const full: ToolLogEntry = {
    ...entry,
    timestamp: new Date().toISOString(),
    args: entry.args ? safeTruncate(entry.args) : undefined,
    result: entry.result ? safeTruncate(entry.result) : undefined,
  };

  inMemoryLog.push(full);
  if (inMemoryLog.length > MAX_MEMORY_LOG) {
    inMemoryLog.splice(0, inMemoryLog.length - MAX_MEMORY_LOG);
  }

  const prefix = phaseIcon(entry.phase);
  const toolLabel = entry.tool ? ` [${entry.tool}]` : '';
  const duration = entry.duration_ms != null ? ` (${entry.duration_ms}ms)` : '';

  if (entry.phase === 'llm_request') {
    console.log(`${prefix}${toolLabel} LLM requested tool call | args: ${JSON.stringify(safeTruncate(entry.args))}`);
  } else if (entry.phase === 'tool_result') {
    const snippet = typeof entry.result === 'string' ? entry.result.slice(0, 200) : JSON.stringify(safeTruncate(entry.result))?.slice(0, 200);
    console.log(`${prefix}${toolLabel} Tool completed${duration} | result preview: ${snippet}`);
  } else if (entry.phase === 'tool_error') {
    console.error(`${prefix}${toolLabel} Tool FAILED${duration} | error: ${entry.error}`);
  } else if (entry.phase === 'api_call') {
    console.log(`${prefix}${toolLabel} API call | ${JSON.stringify(safeTruncate(entry.meta))}`);
  } else if (entry.phase === 'api_response') {
    console.log(`${prefix}${toolLabel} API response${duration} | ${JSON.stringify(safeTruncate(entry.result))?.slice(0, 200)}`);
  } else {
    console.log(`${prefix}${toolLabel} ${entry.phase}${duration}`);
  }

  try {
    appendFileSync(getLogFilePath(), JSON.stringify(full) + '\n');
  } catch {
    // File write is best-effort
  }
}

function phaseIcon(phase: ToolLogPhase): string {
  switch (phase) {
    case 'llm_request':
      return '[>tool]';
    case 'tool_start':
      return '[tool>]';
    case 'api_call':
      return '[->api]';
    case 'api_response':
      return '[<-api]';
    case 'tool_result':
      return '[<tool]';
    case 'tool_error':
      return '[!tool]';
    case 'llm_response':
      return '[<llm ]';
  }
}

export function getRecentToolLogs(limit = 50): ToolLogEntry[] {
  return inMemoryLog.slice(-limit);
}

export function clearToolLogs(): void {
  inMemoryLog.length = 0;
}
