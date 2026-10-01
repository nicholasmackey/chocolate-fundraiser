import { hmacSha256Hex } from './crypto';

export interface RateLimitRule {
  name: string;
  limit: number;
  windowSeconds: number;
}

export const ORDER_RATE_LIMIT: RateLimitRule = { name: 'order', limit: 5, windowSeconds: 600 };
export const LOGIN_RATE_LIMIT: RateLimitRule = { name: 'login', limit: 10, windowSeconds: 900 };

/**
 * Fixed-window rate limiter backed by D1. The client identifier (an IP
 * address) is stored only as a keyed hash. Returns true when allowed.
 */
export async function consumeRateLimit(
  db: D1Database,
  rule: RateLimitRule,
  clientId: string,
  secret: string,
  now = Date.now(),
): Promise<boolean> {
  const windowStart = Math.floor(now / 1000 / rule.windowSeconds) * rule.windowSeconds;
  const bucket = await hmacSha256Hex(secret, `rate:${rule.name}:${clientId}`);
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (bucket, window_start, request_count) VALUES (?1, ?2, 1)
       ON CONFLICT (bucket) DO UPDATE SET
         request_count = CASE WHEN window_start = ?2 THEN request_count + 1 ELSE 1 END,
         window_start = ?2
       RETURNING request_count`,
    )
    .bind(bucket, windowStart)
    .first<{ request_count: number }>();
  return (row?.request_count ?? 1) <= rule.limit;
}

export async function pruneRateLimits(db: D1Database, now = Date.now()): Promise<void> {
  const cutoff = Math.floor(now / 1000) - 24 * 60 * 60;
  await db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(cutoff).run();
}
