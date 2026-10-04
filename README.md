# @micropage-sh/mcp

MCP server for [micropage.sh](https://micropage.sh). It lets an AI assistant (Claude Code, Claude Desktop, Cursor, VS Code) create, edit and publish micropages. Work in progress; user docs will live at docs.micropage.sh.

## Development

```sh
npm install
npm run typecheck   # src + tests + scripts
npm test            # offline vitest, fetch is faked
npm run build       # dist/
npm run smoke       # spawns the stdio server over real MCP and checks tool invariants
npm run inspect     # MCP Inspector against src/
```

Layout:

- `src/index.ts`: the stdio entry (`serveStdio` over the factory).
- `src/server.ts`: `createServer(ctx, deps)` / `createServerFactory(deps)`. The server is transport-agnostic, and all long-lived state lives in `deps`.
- `src/tools/*.ts`, `src/reference.ts`: one `register*` per area.
- `src/client/`: the micropage API client. It must not import from the MCP SDK.
- `src/guards.ts`: env switches, confirm checks, confirmation tokens, elicitation, and the deploy-token allowlist.
- `src/annotations.ts`: the `RO` / `WRITE` / `DESTRUCTIVE` / `OUT` hint presets.

Env switches (all default off): `MICROPAGE_MCP_ALLOW_SEND`, `MICROPAGE_MCP_ALLOW_DELETE`, `MICROPAGE_MCP_SUBMISSIONS`. Endpoint overrides use the CLI's `MICROPAGE_*` variables.
