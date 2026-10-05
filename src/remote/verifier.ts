import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthTokenVerifier } from "@modelcontextprotocol/server";

import type { MicropageConfig } from "../client/config.js";
import { DeployTokenAuthProvider } from "../client/deploy-token.js";
import { isMicropageError } from "../client/errors.js";
import type { FetchLike } from "../client/http.js";
import { decodeJwtClaims } from "../client/jwt.js";
import { isProjectUuid } from "../client/project-ref.js";
import { REMOTE_DEPLOY_TOKEN_HINTS } from "../hints.js";
import { VERSION } from "../version.js";
import { BoundedCache } from "./cache.js";
import { sha256Hex } from "./log.js";

/** How long a successful /auth/v1/user check is trusted (never past the token's exp). */
export const VERIFY_CACHE_TTL_MS = 60_000;
export const VERIFY_CACHE_MAX = 5_000;
/** Deploy tokens are re-exchanged this often, so a revoked token stops working within it. */
export const REMOTE_DEPLOY_TOKEN_TTL_SECONDS = 300;
const DEPLOY_PROVIDER_IDLE_MS = 30 * 60_000;
const DEPLOY_PROVIDER_MAX = 1_000;

export const PROJECT_HEADER = "x-micropage-project";

const DEPLOY_TOKEN_RE = /^[0-9a-f]{64}$/i;

export function isDeployToken(token: string): boolean {
  return DEPLOY_TOKEN_RE.test(token);
}

/** micropage itself (Supabase auth, the deploy-token exchange) could not answer; not the caller's fault. */
export class UpstreamUnavailable extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UpstreamUnavailable";
  }
}

export type VerifiedAuth =
  | { kind: "oauth"; token: string; sub: string; clientId: string; expiresAt: number }
  | {
      kind: "deploy_token";
      provider: DeployTokenAuthProvider;
      /** SHA-256 of the deploy token and project: the rate-limit key and cache key. */
      tokenHash: string;
      /** From the exchanged JWT; null when the exchange was refused for the owner's plan. */
      sub: string | null;
      expiresAt: number;
    };

export interface VerifierOptions {
  config: Pick<MicropageConfig, "supabaseUrl" | "supabaseAnonKey">;
  fetch: FetchLike;
  now: () => number;
  timeoutMs?: number;
}

const invalid = (message: string): OAuthError => new OAuthError(OAuthErrorCode.InvalidToken, message);

interface OAuthIdentity {
  sub: string;
  clientId: string;
  expiresAt: number;
}

/**
 * Accepts only access tokens the Supabase OAuth server issued to a connected
 * app (they carry a `client_id` claim), so an editor or CLI session token
 * pasted into an MCP client is refused. Each token is checked against
 * /auth/v1/user, which honours a revoked grant immediately, whereas
 * PostgREST and the build compiler keep accepting the JWT until it expires.
 */
export class OAuthAccessTokenVerifier {
  private readonly cache: BoundedCache<OAuthIdentity>;
  private readonly inflight = new Map<string, Promise<OAuthIdentity>>();

  constructor(private readonly options: VerifierOptions & { ttlMs?: number; maxEntries?: number }) {
    this.cache = new BoundedCache(options.maxEntries ?? VERIFY_CACHE_MAX, options.now);
  }

  async verify(token: string): Promise<OAuthIdentity> {
    const claims = decodeJwtClaims(token);
    if (!claims) throw invalid("The bearer token is not a micropage access token.");
    const clientId = claims.client_id;
    if (typeof clientId !== "string" || !clientId) {
      throw invalid("The bearer token was not issued to a connected app. Connect through OAuth instead of reusing a session token.");
    }
    if (typeof claims.sub !== "string" || !claims.sub) throw invalid("The bearer token has no subject.");
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw invalid("The bearer token has no expiry.");
    const expMs = claims.exp * 1000;
    if (expMs <= this.options.now()) throw invalid("The bearer token has expired.");

    const key = await sha256Hex(token);
    const hit = this.cache.get(key);
    if (hit) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const identity: OAuthIdentity = { sub: claims.sub, clientId, expiresAt: claims.exp };
    const check = this.checkUpstream(token, identity.sub)
      .then(() => {
        const until = Math.min(this.options.now() + (this.options.ttlMs ?? VERIFY_CACHE_TTL_MS), expMs);
        this.cache.set(key, identity, until);
        return identity;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, check);
    return check;
  }

  /** True when verify() would answer this token from the cache, without asking Supabase. */
  async isCached(token: string): Promise<boolean> {
    return this.cache.get(await sha256Hex(token)) !== undefined;
  }

  clear(): void {
    this.cache.clear();
  }

  private async checkUpstream(token: string, sub: string): Promise<void> {
    let res: Response;
    try {
      res = await this.options.fetch(`${this.options.config.supabaseUrl}/auth/v1/user`, {
        method: "GET",
        headers: {
          apikey: this.options.config.supabaseAnonKey,
          Authorization: `Bearer ${token}`,
          "User-Agent": `micropage-mcp/${VERSION}`,
        },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 10_000),
      });
    } catch (err) {
      throw new UpstreamUnavailable("micropage auth did not answer", { cause: err });
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => undefined);
      throw invalid("The bearer token was revoked or is no longer valid. Reconnect the app.");
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => undefined);
      throw new UpstreamUnavailable(`micropage auth answered HTTP ${res.status}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw invalid("The bearer token was not accepted.");
    }
    const user = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (user?.id !== sub) throw invalid("The bearer token does not match its user.");
  }
}

/**
 * A project deploy token (64 hex chars) plus the project's uuid in
 * X-Micropage-Project. The exchange through exchange-deploy-token is the
 * check: it refuses a wrong project, a revoked token and a non-Pro+ owner.
 * Providers are kept per isolate so the minted JWT is reused until it nears
 * expiry.
 */
export class DeployTokenVerifier {
  private readonly providers: BoundedCache<DeployTokenAuthProvider>;

  constructor(private readonly options: VerifierOptions) {
    this.providers = new BoundedCache(DEPLOY_PROVIDER_MAX, options.now);
  }

  async verify(token: string, projectHeader: string | null): Promise<Extract<VerifiedAuth, { kind: "deploy_token" }>> {
    const projectUuid = normaliseProject(projectHeader);
    if (!isProjectUuid(projectUuid)) {
      throw invalid("A deploy token needs the X-Micropage-Project header set to the project's uuid.");
    }
    const tokenHash = await deployKey(token, projectUuid);
    let provider = this.providers.get(tokenHash);
    if (!provider) {
      provider = new DeployTokenAuthProvider({
        token,
        projectUuid,
        config: this.options.config,
        fetch: this.options.fetch,
        now: this.options.now,
        ttlSeconds: REMOTE_DEPLOY_TOKEN_TTL_SECONDS,
        hints: REMOTE_DEPLOY_TOKEN_HINTS,
        ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
      });
    }

    let jwt: string;
    try {
      jwt = await provider.getAccessToken();
    } catch (err) {
      this.providers.delete(tokenHash);
      if (isMicropageError(err) && err.code === "PLAN_REQUIRED") {
        // The token is real but its owner is below Pro+. Let the request in
        // so every tool call reports PLAN_REQUIRED (the provider re-tries
        // the exchange and throws it) instead of an opaque HTTP refusal.
        return { kind: "deploy_token", provider, tokenHash, sub: null, expiresAt: Math.floor(this.options.now() / 1000) + 60 };
      }
      if (isMicropageError(err) && err.code === "DEPLOY_TOKEN_INVALID") {
        throw invalid("The deploy token was rejected for this project.");
      }
      throw new UpstreamUnavailable("the deploy-token exchange did not answer", { cause: err });
    }
    this.providers.set(tokenHash, provider, this.options.now() + DEPLOY_PROVIDER_IDLE_MS);
    const claims = decodeJwtClaims(jwt);
    return {
      kind: "deploy_token",
      provider,
      tokenHash,
      sub: typeof claims?.sub === "string" ? claims.sub : null,
      expiresAt: typeof claims?.exp === "number" ? claims.exp : Math.floor(this.options.now() / 1000) + REMOTE_DEPLOY_TOKEN_TTL_SECONDS,
    };
  }

  /** True when verify() would answer from a kept provider's JWT, without an exchange. */
  async isCached(token: string, projectHeader: string | null): Promise<boolean> {
    const projectUuid = normaliseProject(projectHeader);
    if (!isProjectUuid(projectUuid)) return false;
    return this.providers.get(await deployKey(token, projectUuid))?.hasFreshToken() ?? false;
  }

  clear(): void {
    this.providers.clear();
  }
}

const normaliseProject = (header: string | null): string => header?.trim().toLowerCase() ?? "";
const deployKey = (token: string, projectUuid: string): Promise<string> => sha256Hex(`${token}\n${projectUuid}`);

/**
 * True when the request's credential is already verified in this isolate, so
 * checking it again costs no upstream call. Parses the header as the SDK's
 * verifyBearerToken does; anything it would refuse counts as not cached.
 */
export async function isCachedCredential(
  request: Request,
  oauth: OAuthAccessTokenVerifier,
  deploy: DeployTokenVerifier,
): Promise<boolean> {
  const [type, token] = (request.headers.get("authorization") ?? "").split(" ");
  if (type?.toLowerCase() !== "bearer" || !token) return false;
  return isDeployToken(token) ? deploy.isCached(token, request.headers.get(PROJECT_HEADER)) : oauth.isCached(token);
}

/**
 * The SDK-facing verifier for one request: picks the bearer kind by shape.
 * The verified identity rides on AuthInfo.extra.verified.
 */
export function requestVerifier(
  request: Request,
  oauth: OAuthAccessTokenVerifier,
  deploy: DeployTokenVerifier,
): OAuthTokenVerifier {
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      if (isDeployToken(token)) {
        const verified = await deploy.verify(token, request.headers.get(PROJECT_HEADER));
        return { token, clientId: "deploy_token", scopes: [], expiresAt: verified.expiresAt, extra: { verified } };
      }
      const id = await oauth.verify(token);
      const verified: VerifiedAuth = { kind: "oauth", token, ...id };
      return { token, clientId: id.clientId, scopes: [], expiresAt: id.expiresAt, extra: { verified } };
    },
  };
}
