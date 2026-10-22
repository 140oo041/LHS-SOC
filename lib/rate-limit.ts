import { hasDatabase, query } from "@/lib/db";

type Bucket = { count: number; resetsAt: number };

declare global {
  var __atlasRateLimits: Map<string, Bucket> | undefined;
}

/**
 * Fixed-window rate limiting.
 *
 * With a database, the count lives in Postgres and is incremented in one
 * atomic statement, so the limit holds across every serverless instance.
 * Without one, it falls back to this process's memory, which is only a real
 * limit while exactly one long-lived process serves Atlas (a developer's
 * machine, or a single container).
 */
export async function takeRateLimit(key: string, limit: number, windowMs: number) {
  const timestamp = Date.now();
  const windowStart = Math.floor(timestamp / windowMs) * windowMs;
  const resetsAt = windowStart + windowMs;

  if (hasDatabase()) {
    const result = await query<{ count: number }>(
      `INSERT INTO rate_limit_buckets (key, window_start, count) VALUES ($1, to_timestamp($2 / 1000.0), 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_buckets.count + 1
       RETURNING count`,
      [key, windowStart],
    );
    const count = Number(result.rows[0].count);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetsAt };
  }

  globalThis.__atlasRateLimits ??= new Map();
  const buckets = globalThis.__atlasRateLimits;
  const current = buckets.get(key);
  if (!current || current.resetsAt <= timestamp) {
    buckets.set(key, { count: 1, resetsAt });
    return { allowed: true, remaining: limit - 1, resetsAt };
  }
  if (current.count >= limit) return { allowed: false, remaining: 0, resetsAt: current.resetsAt };
  current.count += 1;
  return { allowed: true, remaining: limit - current.count, resetsAt: current.resetsAt };
}

/** Windows used here are at most an hour; older buckets are dead weight. */
export async function pruneRateLimitBuckets() {
  if (!hasDatabase()) return 0;
  const result = await query("DELETE FROM rate_limit_buckets WHERE window_start < now() - interval '2 days'");
  return result.rowCount ?? 0;
}
