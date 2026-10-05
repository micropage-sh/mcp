import type { McpServer, McpServerOptions } from "@modelcontextprotocol/server";

import type { ToolContext } from "./context.js";
import { registerPrompts } from "./reference/prompts.js";
import { registerResources } from "./reference/resources.js";
import { registerReferenceTool } from "./reference/tool.js";
import { REFERENCE_CACHE_HINT } from "./reference/topics.js";

/**
 * Cache hints for the list results the SDK builds itself. tools/list is left
 * out on purpose: which tools exist depends on the user's env switches.
 */
export const LIST_CACHE_HINTS: NonNullable<McpServerOptions["cacheHints"]> = {
  "resources/list": REFERENCE_CACHE_HINT,
  "resources/templates/list": REFERENCE_CACHE_HINT,
  "prompts/list": REFERENCE_CACHE_HINT,
};

/** micropage:// resources, the four workflow prompts, and get_markup_reference. */
export function registerReference(server: McpServer, ctx: ToolContext): void {
  registerResources(server);
  registerPrompts(server, ctx.hints);
  registerReferenceTool(server);
}
