import type { ClientCapabilities, ProtocolEra, ServerContext } from "@modelcontextprotocol/server";

import type { AuthProvider } from "./client/auth-provider.js";
import type { MicropageConfig } from "./client/config.js";
import type { Http } from "./client/http.js";

/** User-set switches. Each defaults off; only the user's MCP config can turn them on. */
export interface EnvFlags {
  /** MICROPAGE_MCP_ALLOW_SEND: publish_post may email the subscriber list. */
  allowSend: boolean;
  /** MICROPAGE_MCP_ALLOW_DELETE: delete_project is registered at all. */
  allowDelete: boolean;
  /** MICROPAGE_MCP_SUBMISSIONS: form submission (PII) tools are registered. */
  submissions: boolean;
}

/** Process-wide dependencies, built once and shared by every server instance. */
export interface ServerDeps {
  config: MicropageConfig;
  auth: AuthProvider;
  http: Http;
  flags: EnvFlags;
}

/** What every register* function receives: the deps plus per-instance protocol facts. */
export interface ToolContext extends ServerDeps {
  /** Protocol era this server instance serves (fixed per instance by the factory). */
  era: ProtocolEra;
  /** The calling client's declared capabilities for this request, era-correct. */
  clientCapabilities(handlerCtx: ServerContext): ClientCapabilities | undefined;
}
