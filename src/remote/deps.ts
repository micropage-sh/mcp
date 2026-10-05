import type { HostLookup } from "../client/assets.js";
import type { AuthProvider } from "../client/auth-provider.js";
import { BearerAuthProvider } from "../client/bearer-auth.js";
import { Http, type FetchLike } from "../client/http.js";
import { PlanGate, PlanTierCache } from "../client/tier.js";
import type { ServerDeps } from "../context.js";
import { ConfirmationTokens, NO_PERMISSIONS } from "../guards.js";
import { REMOTE_DEPLOY_TOKEN_HINTS, REMOTE_OAUTH_HINTS } from "../hints.js";
import { deniedHostsFor, remoteConfig, type Env } from "./config.js";
import type { PermissionStore } from "./permissions.js";
import type { VerifiedAuth } from "./verifier.js";

/** Long-lived pieces shared by every request an isolate serves. */
export interface RemoteShared {
  fetch: FetchLike;
  now: () => number;
  lookupHost: HostLookup;
  tierCache: PlanTierCache;
  permissions: PermissionStore;
}

export interface DepsForOptions {
  onPermissionsError?: (err: unknown) => void;
  onToolError?: (tool: string, err: unknown) => void;
}

/**
 * ServerDeps for one verified request. Everything user-specific is built
 * here, per request; only caches keyed by user (plan tier, permissions) and
 * the confirmation-token key outlive it. The key is a Worker secret shared by
 * every isolate, and tokens are bound to the user's sub, so a token minted for
 * one user never verifies for another.
 */
export async function depsFor(verified: VerifiedAuth, env: Env, shared: RemoteShared, options: DepsForOptions = {}): Promise<ServerDeps> {
  const config = remoteConfig(env);
  const auth: AuthProvider = verified.kind === "oauth" ? new BearerAuthProvider(verified.token) : verified.provider;
  const http = new Http({ config, auth, fetch: shared.fetch });
  const permissions =
    verified.kind === "oauth"
      ? await shared.permissions.get(http, verified.sub, verified.clientId, options.onPermissionsError)
      : NO_PERMISSIONS;
  return {
    config,
    auth,
    http,
    tier: new PlanGate({ http, auth, cache: shared.tierCache, now: shared.now }),
    permissions,
    confirmationTokens: new ConfirmationTokens({ key: env.MCP_CONFIRM_KEY ?? "", now: shared.now }),
    uploads: {
      lookupHost: shared.lookupHost,
      deniedHosts: deniedHostsFor(env),
      fetchExternal: shared.fetch,
    },
    hints: verified.kind === "oauth" ? REMOTE_OAUTH_HINTS : REMOTE_DEPLOY_TOKEN_HINTS,
    ...(options.onToolError ? { onToolError: options.onToolError } : {}),
  };
}
