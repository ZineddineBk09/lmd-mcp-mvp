import { Redis } from "ioredis";

let client: Redis | null = null;
let connectionStatus: "untested" | "connected" | "failed" = "untested";
let lastFailTime = 0;

const RETRY_COOLDOWN_MS = 60_000;

async function tryConnect(): Promise<boolean> {
  if (connectionStatus === "connected" && client) return true;

  if (
    connectionStatus === "failed" &&
    Date.now() - lastFailTime < RETRY_COOLDOWN_MS
  ) {
    return false;
  }

  const host = process.env.AUTO_DISPATCH_REDIS_HOST || process.env.REDIS_HOST;
  if (!host) {
    connectionStatus = "failed";
    return false;
  }

  const port = parseInt(
    process.env.AUTO_DISPATCH_REDIS_PORT || process.env.REDIS_PORT || "6379",
    10,
  );
  const password =
    process.env.AUTO_DISPATCH_REDIS_PASSWORD ||
    process.env.REDIS_PASSWORD ||
    undefined;

  if (!client) {
    try {
      client = new Redis({
        host,
        port,
        password: password || undefined,
        maxRetriesPerRequest: 1,
        connectTimeout: 3000,
        lazyConnect: true,
        retryStrategy: () => null,
      });

      client.on("error", () => {});
    } catch {
      connectionStatus = "failed";
      lastFailTime = Date.now();
      return false;
    }
  }

  try {
    if (client.status === "ready") {
      connectionStatus = "connected";
      return true;
    }
    if (client.status === "wait") {
      await client.connect();
    }
    await client.ping();
    connectionStatus = "connected";
    return true;
  } catch {
    connectionStatus = "failed";
    lastFailTime = Date.now();
    try {
      client.disconnect();
    } catch {}
    client = null;
    return false;
  }
}

export async function getConnectedRedis(): Promise<Redis | null> {
  const ok = await tryConnect();
  return ok ? client : null;
}

export function isRedisConfigured(): boolean {
  return !!(process.env.AUTO_DISPATCH_REDIS_HOST || process.env.REDIS_HOST);
}

export function getRedisStatus(): string {
  if (!isRedisConfigured()) return "not_configured";
  return connectionStatus;
}
