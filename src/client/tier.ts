import { STDIO_HINTS, type ModeHints } from "../hints.js";
import { currentUserId, type AuthProvider } from "./auth-provider.js";
import { MicropageError, PRICING_URL } from "./errors.js";
import { eq, type Http } from "./http.js";

export { PRICING_URL };

export type PlanTier = "free" | "pro" | "pro_plus";

/** The stdio refusal; same wording as the CLI (cli/src/plan.js), addressed to the model. */
export const UPGRADE_MESSAGE = STDIO_HINTS.planRequired;

export const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;

export function isPaidTier(tier: string | null | undefined): tier is "pro" | "pro_plus" {
  return tier === "pro" || tier === "pro_plus";
}

/** Bound on cached users; past it, expired entries are dropped before adding one. */
export const PLAN_CACHE_MAX_USERS = 1000;

/**
 * Tier lookups keyed by user id. A PlanGate owns one by default; the remote
 * server builds a gate per request and passes one long-lived cache to all of
 * them, so the cache outlives the request without sharing anything else.
 */
export class PlanTierCache {
  private readonly entries = new Map<string, { tier: PlanTier; at: number }>();
  readonly inflight = new Map<string, Promise<PlanTier>>();

  get(userId: string, now: number, ttlMs: number): PlanTier | null {
    const hit = this.entries.get(userId);
    return hit && now - hit.at < ttlMs ? hit.tier : null;
  }

  set(userId: string, tier: PlanTier, now: number, ttlMs: number): void {
    if (this.entries.size >= PLAN_CACHE_MAX_USERS && !this.entries.has(userId)) {
      for (const [id, entry] of this.entries) {
        if (now - entry.at >= ttlMs) this.entries.delete(id);
      }
      // Still full of live entries: drop the oldest insertion.
      if (this.entries.size >= PLAN_CACHE_MAX_USERS) {
        const oldest = this.entries.keys().next();
        if (!oldest.done) this.entries.delete(oldest.value);
      }
    }
    this.entries.delete(userId);
    this.entries.set(userId, { tier, at: now });
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

export interface PlanGateOptions {
  http: Http;
  auth: AuthProvider;
  now?: () => number;
  ttlMs?: number;
  /** Shared across gates (one per request on the remote server). */
  cache?: PlanTierCache;
  /** Wording of the no-user-id and plan errors. Defaults to the stdio wording. */
  hints?: Pick<ModeHints, "tokenNoUser" | "planRequired">;
}

/**
 * The CLI's client-side Pro gate: reads customers.plan_tier under RLS and
 * caches it for 5 minutes per user. A product gate, not a security boundary;
 * the server enforces its own per-feature limits.
 */
export class PlanGate {
  private readonly http: Http;
  private readonly auth: AuthProvider;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly cache: PlanTierCache;
  private readonly hints: Pick<ModeHints, "tokenNoUser" | "planRequired"> | undefined;

  constructor(options: PlanGateOptions) {
    this.http = options.http;
    this.auth = options.auth;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PLAN_CACHE_TTL_MS;
    this.cache = options.cache ?? new PlanTierCache();
    this.hints = options.hints;
  }

  /** The signed-in user's id, read from the access token's `sub`. */
  currentUserId(): Promise<string> {
    return currentUserId(this.auth, this.hints);
  }

  /**
   * Missing customer row means free, as in the CLI. A failed lookup is not
   * cached and propagates, so a network blip does not read as "free plan".
   */
  async getPlanTier(): Promise<PlanTier> {
    const userId = await this.currentUserId();
    const hit = this.cache.get(userId, this.now(), this.ttlMs);
    if (hit) return hit;

    const pending = this.cache.inflight.get(userId);
    if (pending) return pending;
    const lookup = (async () => {
      const row = await this.http.selectOne<{ plan_tier: string | null }>("customers", {
        select: "plan_tier",
        filters: { user_id: eq(userId) },
      });
      const tier: PlanTier = isPaidTier(row?.plan_tier) ? row.plan_tier : "free";
      this.cache.set(userId, tier, this.now(), this.ttlMs);
      return tier;
    })().finally(() => {
      this.cache.inflight.delete(userId);
    });
    this.cache.inflight.set(userId, lookup);
    return lookup;
  }

  /**
   * Throws PLAN_REQUIRED unless the account is pro or pro_plus. Deploy-token
   * mode skips the lookup: exchange-deploy-token refuses the exchange with
   * `plan_required` unless the token owner is Pro+ at that moment, so a
   * working deploy-token session already implies a paid plan (and a downgrade
   * takes effect at the next exchange).
   */
  async requirePaidPlan(): Promise<void> {
    if (this.auth.mode === "deploy_token") return;
    const tier = await this.getPlanTier();
    if (!isPaidTier(tier)) throw new MicropageError("PLAN_REQUIRED", (this.hints ?? STDIO_HINTS).planRequired);
  }

  clearCache(): void {
    this.cache.clear();
  }
}
