import type { ClientCapabilities, ProtocolEra, ServerContext } from "@modelcontextprotocol/server";

import type { HostDenylist, HostLookup, PathLoader } from "./client/assets.js";
import type { AuthProvider } from "./client/auth-provider.js";
import type { MicropageConfig } from "./client/config.js";
import type { FetchLike, Http } from "./client/http.js";
import type { PlanGate } from "./client/tier.js";
import type { ConfirmationTokens } from "./guards.js";
import type { ModeHints } from "./hints.js";

/**
 * What the user allowed this connection to do. Each defaults off. Stdio reads
 * them from env switches the user sets in their MCP config; the remote server
 * reads the per-connection row the user set on the consent page.
 */
export interface Permissions {
  /** MICROPAGE_MCP_ALLOW_SEND: publish_post may email the subscriber list. */
  allowSend: boolean;
  /** MICROPAGE_MCP_ALLOW_DELETE: delete_project is registered at all. */
  allowDelete: boolean;
  /** MICROPAGE_MCP_SUBMISSIONS: form submission (PII) tools are registered. */
  allowSubmissions: boolean;
}

/** Where upload_asset may read bytes from; differs between a local and a hosted server. */
export interface UploadDeps {
  /** Reads `{path}` sources. Absent on a hosted server, which then does not offer `{path}` at all. */
  pathLoader?: PathLoader;
  /**
   * Resolves `{url}` hostnames so private addresses are refused before the
   * fetch. Null only where the runtime's fetch cannot reach private networks
   * anyway; IP-literal hosts and the denylist are checked either way.
   */
  lookupHost: HostLookup | null;
  /** Hostnames `{url}` must never fetch (our own infrastructure on a hosted server). */
  deniedHosts?: HostDenylist;
  /** fetch for `{url}` sources; never the micropage-authenticated client. Defaults to global fetch. */
  fetchExternal?: FetchLike;
}

/**
 * Dependencies for serving one user. Stdio builds them once per process;
 * the remote server builds them per request (with long-lived pieces such as
 * the plan-tier cache and the token key passed in).
 */
export interface ServerDeps {
  config: MicropageConfig;
  auth: AuthProvider;
  http: Http;
  /** Paid-plan gate with its 5-minute per-user plan_tier cache; call through gateTool() in tools. */
  tier: PlanGate;
  permissions: Permissions;
  /** Signs preview_post_send tokens; its key decides which servers accept them. */
  confirmationTokens: ConfirmationTokens;
  uploads: UploadDeps;
  /** Wording that names how the user changes a setting or fixes a login. Defaults to the stdio wording. */
  hints?: ModeHints;
  /** Called with each error a tool handler throws, before the SDK turns it into an isError result (logging). */
  onToolError?: (tool: string, error: unknown) => void;
}

/** What every register* function receives: the deps plus per-instance protocol facts. */
export interface ToolContext extends ServerDeps {
  hints: ModeHints;
  /** Protocol era this server instance serves (fixed per instance by the factory). */
  era: ProtocolEra;
  /** The calling client's declared capabilities for this request, era-correct. */
  clientCapabilities(handlerCtx: ServerContext): ClientCapabilities | undefined;
}
