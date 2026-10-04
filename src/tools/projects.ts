import type { McpServer } from "@modelcontextprotocol/server";

import type { ToolContext } from "../context.js";

// TODO: list_projects, get_project, get_page_source, create_project, save_page, delete_project (gated by MICROPAGE_MCP_ALLOW_DELETE).
export function registerProjectTools(_server: McpServer, _ctx: ToolContext): void {}
