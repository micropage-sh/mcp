import {
  CLIENT_CAPABILITIES_META_KEY,
  McpServer,
  type ClientCapabilities,
  type McpRequestContext,
  type McpServerFactory,
  type ServerContext,
} from "@modelcontextprotocol/server";

import type { ServerDeps, ToolContext } from "./context.js";
import { STDIO_HINTS } from "./hints.js";
import { LIST_CACHE_HINTS, registerReference } from "./reference.js";
import { registerAccountTools } from "./tools/account.js";
import { registerBuildTools } from "./tools/builds.js";
import { registerFileTools } from "./tools/files.js";
import { registerFormTools } from "./tools/forms.js";
import { registerPostTools } from "./tools/posts.js";
import { registerProjectTools } from "./tools/projects.js";
import { VERSION } from "./version.js";

export const SERVER_NAME = "micropage";

/**
 * Builds one server instance. Transport-agnostic and factory-shaped on
 * purpose: serveStdio calls it once per connection (plus a discarded
 * discovery probe) and a remote HTTP entry would call it per request, so all
 * long-lived state (token refresh, caches) lives in `deps`, never here.
 * Nothing reachable from here may import a Node-only module (node:fs,
 * node:os, node:dns, node:net, node:path); tests/architecture.test.ts
 * enforces it. Node-only deps are built in src/node/.
 */
export function createServer(ctx: McpRequestContext, deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { cacheHints: LIST_CACHE_HINTS });
  if (deps.onToolError) observeToolErrors(server, deps.onToolError);

  const toolCtx: ToolContext = {
    ...deps,
    hints: deps.hints ?? STDIO_HINTS,
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

/**
 * Wraps every tool handler registered after this call so `observe` sees the
 * error it throws; the error still propagates, so the SDK's isError result
 * is unchanged. The SDK reduces a thrown error to its message, and the
 * remote server wants the error code for its logs.
 */
function observeToolErrors(server: McpServer, observe: (tool: string, error: unknown) => void): void {
  const register = server.registerTool.bind(server) as (name: string, config: unknown, cb: (...args: unknown[]) => unknown) => unknown;
  const wrapped = (name: string, config: unknown, cb: (...args: unknown[]) => unknown): unknown =>
    register(name, config, async (...args: unknown[]) => {
      try {
        return await cb(...args);
      } catch (err) {
        observe(name, err);
        throw err;
      }
    });
  server.registerTool = wrapped as unknown as typeof server.registerTool;
}

export function createServerFactory(deps: ServerDeps): McpServerFactory {
  return (ctx) => createServer(ctx, deps);
}
