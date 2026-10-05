import type { RateLimiter } from "./config.js";

/** The binding's window; a refused caller can retry after it. */
export const RATE_LIMIT_PERIOD_SECONDS = 60;

/**
 * True when `limiter` refuses `key`. An absent binding (tests, `wrangler dev`
 * without it) or a failing one does not limit: the limits protect upstream
 * capacity, and refusing every request because the limiter broke would be
 * worse than briefly not limiting.
 */
export async function overLimit(limiter: RateLimiter | undefined, key: string): Promise<boolean> {
  if (!limiter) return false;
  try {
    const { success } = await limiter.limit({ key });
    return !success;
  } catch {
    return false;
  }
}

export function tooManyRequests(): Response {
  return Response.json(
    { error: "rate_limited", error_description: `Too many requests. Retry after ${RATE_LIMIT_PERIOD_SECONDS} seconds.` },
    { status: 429, headers: { "Retry-After": String(RATE_LIMIT_PERIOD_SECONDS) } },
  );
}
