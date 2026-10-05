import { randomBytes } from "node:crypto";

import type { HostLookup } from "../client/assets.js";
import type { AuthProvider } from "../client/auth-provider.js";
import { loadConfig, type MicropageConfig } from "../client/config.js";
import { DeployTokenAuthProvider, readDeployTokenEnv } from "../client/deploy-token.js";
import { Http, type FetchLike } from "../client/http.js";
import { SessionAuthProvider, sessionFilePath } from "../client/session-store.js";
import { PlanGate } from "../client/tier.js";
import type { ServerDeps } from "../context.js";
import { ConfirmationTokens, envPermissions } from "../guards.js";
import { nodeHostLookup } from "./host-lookup.js";
import { nodePathLoader } from "./path-source.js";

export interface CreateDepsOptions {
  /** Replaces global fetch for every outbound call (tests). */
  fetch?: FetchLike;
  now?: () => number;
  /** Replaces the system resolver for `{url}` uploads (tests). */
  lookupHost?: HostLookup;
}

/**
 * Picks where tokens come from: a deploy token when MICROPAGE_DEPLOY_TOKEN and
 * MICROPAGE_DEPLOY_PROJECT are both set (only one set throws), else the CLI
 * session file. The session provider is used even when the file does not
 * exist yet, so a `micropage login` after the server started takes effect
 * without a restart; until then every call fails with NOT_LOGGED_IN.
 */
export function createAuthProvider(env: NodeJS.ProcessEnv, config: MicropageConfig, options: CreateDepsOptions = {}): AuthProvider {
  const shared = {
    config,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  };
  const deploy = readDeployTokenEnv(env);
  if (deploy) return new DeployTokenAuthProvider({ ...shared, ...deploy });
  return new SessionAuthProvider({ ...shared, path: sessionFilePath(env) });
}

/**
 * The stdio server's deps, built once per process from the environment. The
 * confirmation-token key is random per process, so restarting the server
 * invalidates every outstanding preview token.
 */
export function createDeps(env: NodeJS.ProcessEnv = process.env, options: CreateDepsOptions = {}): ServerDeps {
  const config = loadConfig(env);
  const auth = createAuthProvider(env, config, options);
  const http = new Http({ config, auth, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const tier = new PlanGate({ http, auth, ...(options.now ? { now: options.now } : {}) });
  return {
    config,
    auth,
    http,
    tier,
    permissions: envPermissions(env),
    confirmationTokens: new ConfirmationTokens({ key: randomBytes(32), ...(options.now ? { now: options.now } : {}) }),
    uploads: {
      pathLoader: nodePathLoader,
      lookupHost: options.lookupHost ?? nodeHostLookup,
    },
  };
}
