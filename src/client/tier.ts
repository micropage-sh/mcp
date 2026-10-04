import type { AuthProvider } from "./auth-provider.js";
import { MicropageError, PRICING_URL } from "./errors.js";
import { eq, type Http } from "./http.js";
import { decodeJwtClaims } from "./jwt.js";

export { PRICING_URL };

export type PlanTier = "free" | "pro" | "pro_plus";

/** Same wording as the CLI (cli/src/plan.js), addressed to the model. */
export const UPGRADE_MESSAGE =
  "The micropage MCP server, like the micropage CLI, is available on paid plans only. " +
  `This account is on the free plan. Tell the user they can upgrade at ${PRICING_URL}, then retry.`;

export const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;

export function isPaidTier(tier: string | null | undefined): tier is "pro" | "pro_plus" {
  return tier === "pro" || tier === "pro_plus";
}

export interface PlanGateOptions {
  http: Http;
  auth: AuthProvider;
  now?: () => number;
  ttlMs?: number;
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
  private cache: { userId: string; tier: PlanTier; at: number } | null = null;
  private inflight: Promise<PlanTier> | null = null;

  constructor(options: PlanGateOptions) {
    this.http = options.http;
    this.auth = options.auth;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? PLAN_CACHE_TTL_MS;
  }

  /** The signed-in user's id, read from the access token's `sub`. */
  async currentUserId(): Promise<string> {
    const sub = decodeJwtClaims(await this.auth.getAccessToken())?.sub;
    if (typeof sub !== "string" || !sub) {
      throw new MicropageError("SESSION_EXPIRED", "The micropage access token has no user id. Run `micropage login` in a terminal, then retry.");
    }
    return sub;
  }

  /**
   * Missing customer row means free, as in the CLI. A failed lookup is not
   * cached and propagates, so a network blip does not read as "free plan".
   */
  async getPlanTier(): Promise<PlanTier> {
    const userId = await this.currentUserId();
    const hit = this.cache;
    if (hit && hit.userId === userId && this.now() - hit.at < this.ttlMs) return hit.tier;

    this.inflight ??= (async () => {
      const row = await this.http.selectOne<{ plan_tier: string | null }>("customers", {
        select: "plan_tier",
        filters: { user_id: eq(userId) },
      });
      const tier: PlanTier = isPaidTier(row?.plan_tier) ? row.plan_tier : "free";
      this.cache = { userId, tier, at: this.now() };
      return tier;
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
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
    if (!isPaidTier(tier)) throw new MicropageError("PLAN_REQUIRED", UPGRADE_MESSAGE);
  }

  clearCache(): void {
    this.cache = null;
  }
}
