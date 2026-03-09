import { z } from 'zod';
import { getConnectedRedis, isRedisConfigured, getRedisStatus } from '../../connections/redis.js';
import { wrapToolResponse } from '../../utils/fact-check.js';
import { logQuery } from '../../utils/query-logger.js';

export const dispatchQueueSchema = z.object({
  country_code: z.string().optional().describe('OPTIONAL. Country code to filter queue data.'),
  action: z.enum(['status', 'stuck', 'stats']).default('status').describe("OPTIONAL. 'status' for queue overview, 'stuck' for orders waiting too long, 'stats' for queue depth history."),
});

export type DispatchQueueInput = z.infer<typeof dispatchQueueSchema>;

function redisUnavailableResponse(reason: string, startMs: number) {
  return wrapToolResponse(
    { error: reason, available: false },
    {
      query: 'redis connection check',
      execution_time_ms: Date.now() - startMs,
      result_count: 0,
    },
  );
}

export async function getDispatchQueue(params: DispatchQueueInput) {
  const start = Date.now();

  if (!isRedisConfigured()) {
    return redisUnavailableResponse('Redis is not configured. Set REDIS_HOST in .env to enable dispatch queue monitoring.', start);
  }

  const redis = await getConnectedRedis();

  if (!redis) {
    return redisUnavailableResponse(`Redis is unreachable (status: ${getRedisStatus()}). Dispatch queue monitoring is temporarily unavailable.`, start);
  }

  try {
    const queueKey = 'orderDispatchQueue';
    const processingKey = 'orderDispatchProcessing';

    if (params.action === 'status') {
      const [queueLen, processingLen, allQueued] = await Promise.all([redis.llen(queueKey), redis.llen(processingKey), redis.lrange(queueKey, 0, 20)]);

      const parsedOrders = allQueued
        .map((item: string) => {
          try {
            return JSON.parse(item);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .slice(0, 10);

      const executionTime = Date.now() - start;
      logQuery({
        tool: 'dispatch_queue',
        params,
        query: `LLEN ${queueKey}, LLEN ${processingKey}, LRANGE ${queueKey} 0 20`,
        execution_time_ms: executionTime,
        result_count: queueLen,
      });

      return wrapToolResponse(
        {
          available: true,
          queue_depth: queueLen,
          processing_count: processingLen,
          total_in_pipeline: queueLen + processingLen,
          sample_orders: parsedOrders,
          summary: `Dispatch queue: ${queueLen} orders waiting, ${processingLen} being processed. Total pipeline: ${queueLen + processingLen}.`,
        },
        {
          query: `LLEN ${queueKey} + LLEN ${processingKey}`,
          execution_time_ms: executionTime,
          result_count: queueLen,
        },
      );
    }

    if (params.action === 'stuck') {
      const allQueued = await redis.lrange(queueKey, 0, 100);
      const now = Date.now();
      const stuckThresholdMs = 300_000;

      const stuck = allQueued
        .map((item: string) => {
          try {
            return JSON.parse(item);
          } catch {
            return null;
          }
        })
        .filter((order: Record<string, unknown> | null): order is Record<string, unknown> => {
          if (!order) return false;
          const createdAt = order.createdAt || order.created_at || order.timestamp;
          if (!createdAt) return false;
          return now - new Date(createdAt as string).getTime() > stuckThresholdMs;
        })
        .map((order: Record<string, unknown>) => {
          const createdAt = order.createdAt || order.created_at || order.timestamp;
          const ageMinutes = Math.round((now - new Date(createdAt as string).getTime()) / 60000);
          return { ...order, stuck_minutes: ageMinutes };
        });

      const executionTime = Date.now() - start;
      logQuery({
        tool: 'dispatch_queue',
        params,
        query: `LRANGE ${queueKey} 0 100 (stuck filter)`,
        execution_time_ms: executionTime,
        result_count: stuck.length,
      });

      return wrapToolResponse(
        {
          available: true,
          stuck_count: stuck.length,
          stuck_orders: stuck.slice(0, 20),
          threshold_minutes: stuckThresholdMs / 60000,
          summary: `${stuck.length} orders stuck in dispatch queue for >5 minutes.`,
        },
        {
          query: `LRANGE ${queueKey} 0 100 (stuck filter)`,
          execution_time_ms: executionTime,
          result_count: stuck.length,
        },
      );
    }

    const [queueLen, processingLen] = await Promise.all([redis.llen(queueKey), redis.llen(processingKey)]);

    const executionTime = Date.now() - start;
    logQuery({
      tool: 'dispatch_queue',
      params,
      query: `LLEN ${queueKey}, LLEN ${processingKey}`,
      execution_time_ms: executionTime,
      result_count: queueLen,
    });

    return wrapToolResponse(
      {
        available: true,
        queue_depth: queueLen,
        processing_count: processingLen,
        summary: `Dispatch queue stats: ${queueLen} queued, ${processingLen} processing.`,
      },
      {
        query: `Redis queue depth stats`,
        execution_time_ms: executionTime,
        result_count: queueLen,
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return wrapToolResponse(
      { error: `Redis query failed: ${msg}`, available: false },
      {
        query: 'redis error',
        execution_time_ms: Date.now() - start,
        result_count: 0,
      },
    );
  }
}
