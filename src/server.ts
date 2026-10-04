import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  type ClientCapabilities,
  type McpRequestContext,
  type McpServerFactory,
  type ServerContext,
} from "@modelcontextprotocol/server";

import type { AuthProvider } from "./client/auth-provider.js";
import { loadConfig, type MicropageConfig } from "./client/config.js";
import { DeployTokenAuthProvider, readDeployTokenEnv } from "./client/deploy-token.js";
import { Http, type FetchLike } from "./client/http.js";
import { SessionAuthProvider, sessionFilePath } from "./client/session-store.js";
import { PlanGate } from "./client/tier.js";
import type { ServerDeps, ToolContext } from "./context.js";
import { readEnvFlags } from "./guards.js";
import { LIST_CACHE_HINTS, registerReference } from "./reference.js";
import { registerAccountTools } from "./tools/account.js";
import { registerBuildTools } from "./tools/builds.js";
import { registerFileTools } from "./tools/files.js";
import { registerFormTools } from "./tools/forms.js";
import { registerPostTools } from "./tools/posts.js";
import { registerProjectTools } from "./tools/projects.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "micropage";

export interface CreateDepsOptions {
  /** Replaces global fetch for every outbound call (tests). */
  fetch?: FetchLike;
  now?: () => number;
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

/** Builds the process-wide deps from the environment. */
export function createDeps(env: NodeJS.ProcessEnv = process.env, options: CreateDepsOptions = {}): ServerDeps {
  const config = loadConfig(env);
  const auth = createAuthProvider(env, config, options);
  const http = new Http({ config, auth, ...(options.fetch ? { fetch: options.fetch } : {}) });
  const tier = new PlanGate({ http, auth, ...(options.now ? { now: options.now } : {}) });
  return { config, auth, http, tier, flags: readEnvFlags(env) };
}

/**
 * Builds one server instance. Transport-agnostic and factory-shaped on
 * purpose: serveStdio calls it once per connection (plus a discarded
 * discovery probe) and a future HTTP entry would call it per request, so all
 * long-lived state (token refresh, caches) lives in `deps`, never here.
 */
export function createServer(ctx: McpRequestContext, deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { cacheHints: LIST_CACHE_HINTS });

  const toolCtx: ToolContext = {
    ...deps,
    era: ctx.era,
    clientCapabilities: (handlerCtx: ServerContext): ClientCapabilities | undefined => {
      if (ctx.era === "modern") {
        const envelope = handlerCtx.mcpReq.envelope as Record<string, unknown> | undefined;
        return envelope?.[CLIENT_CAPABILITIES_META_KEY] as ClientCapabilities | undefined;
      }
      // 2025-era connections declare capabilities once, at initialize.
      return server.server.getClientCapabilities();
    },
  };

  registerAccountTools(server, toolCtx);
  registerProjectTools(server, toolCtx);
  registerBuildTools(server, toolCtx);
  registerFileTools(server, toolCtx);
  registerFormTools(server, toolCtx);
  registerPostTools(server, toolCtx);
  registerReference(server, toolCtx);

  return server;
}

export function createServerFactory(deps: ServerDeps): McpServerFactory {
  return (ctx) => createServer(ctx, deps);
}
