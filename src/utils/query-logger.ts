interface QueryLogEntry {
  tool: string;
  params: unknown;
  query: string;
  execution_time_ms: number;
  result_count: number;
  timestamp: string;
}

const queryLog: QueryLogEntry[] = [];
const MAX_LOG_SIZE = 500;

export function logQuery(entry: Omit<QueryLogEntry, 'timestamp'>): void {
  queryLog.push({
    ...entry,
    timestamp: new Date().toISOString(),
  });

  if (queryLog.length > MAX_LOG_SIZE) {
    queryLog.splice(0, queryLog.length - MAX_LOG_SIZE);
  }
}

export function getRecentQueries(limit = 20): QueryLogEntry[] {
  return queryLog.slice(-limit);
}

export function clearQueryLog(): void {
  queryLog.length = 0;
}
