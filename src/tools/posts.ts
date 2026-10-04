import type { McpServer } from "@modelcontextprotocol/server";

import type { ToolContext } from "../context.js";

// TODO: posts (list/get merged), upsert_post, preview_post_send, publish_post (send gated by MICROPAGE_MCP_ALLOW_SEND), unpublish_post, delete_post.
export function registerPostTools(_server: McpServer, _ctx: ToolContext): void {}
