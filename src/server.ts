import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  type ClientCapabilities,
  type McpRequestContext,
  type McpServerFactory,
  type ServerContext,
} from "@modelcontextprotocol/server";

import { NoAuthProvider } from "./client/auth-provider.js";
import { loadConfig } from "./client/config.js";
import { Http } from "./client/http.js";
import type { ServerDeps, ToolContext } from "./context.js";
import { readEnvFlags } from "./guards.js";
import { registerReference } from "./reference.js";
import { registerAccountTools } from "./tools/account.js";
import { registerBuildTools } from "./tools/builds.js";
import { registerFileTools } from "./tools/files.js";
import { registerFormTools } from "./tools/forms.js";
import { registerPostTools } from "./tools/posts.js";
import { registerProjectTools } from "./tools/projects.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "micropage";

/** Builds the process-wide deps from the environment. */
export function createDeps(env: NodeJS.ProcessEnv = process.env): ServerDeps {
  const config = loadConfig(env);
  const auth = new NoAuthProvider();
  return { config, auth, http: new Http({ config, auth }), flags: readEnvFlags(env) };
}

/**
 * Builds one server instance. Transport-agnostic and factory-shaped on
 * purpose: serveStdio calls it once per connection (plus a discarded
 * discovery probe) and a future HTTP entry would call it per request, so all
 * long-lived state (token refresh, caches) lives in `deps`, never here.
 */
export function createServer(ctx: McpRequestContext, deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION });

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
