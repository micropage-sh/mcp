# @micropage-sh/mcp

MCP server for [micropage.sh](https://micropage.sh). It lets an AI assistant (Claude Code, Claude Desktop, Cursor, VS Code) create, edit and publish micropages and posts from markup.

**Documentation: https://docs.micropage.sh/docs/mcp/overview/**

## Install

The server needs Node.js 20 or later and a Pro or Pro+ account. It uses the session from the [micropage CLI](https://www.npmjs.com/package/micropage):

```sh
npm install -g @micropage-sh/cli
micropage login
claude mcp add micropage -- npx -y @micropage-sh/mcp
```

For other clients, run `npx -y @micropage-sh/mcp` over stdio:

```json
{
  "mcpServers": {
    "micropage": {
      "command": "npx",
      "args": ["-y", "@micropage-sh/mcp"]
    }
  }
}
```

Emailing subscribers, deleting projects and reading form submissions are off by default. Turn them on with `MICROPAGE_MCP_ALLOW_SEND=1`, `MICROPAGE_MCP_ALLOW_DELETE=1` and `MICROPAGE_MCP_SUBMISSIONS=1`. For headless use, set `MICROPAGE_DEPLOY_TOKEN` and `MICROPAGE_DEPLOY_PROJECT` instead of logging in. See [Install](https://docs.micropage.sh/docs/mcp/install/) and [Safety](https://docs.micropage.sh/docs/mcp/safety/).

## Hosted server

micropage also hosts this server at `https://mcp.micropage.sh/mcp`. Clients connect over streamable HTTP and sign in with OAuth through the micropage account, so nothing is installed locally. Dynamic client registration is off, so each client uses a pre-registered client ID. Claude Code:

```sh
claude mcp add --transport http --client-id f1176948-266f-42af-9fe6-b285e023421c --callback-port 33418 \
  micropage https://mcp.micropage.sh/mcp
```

The setup for claude.ai and Claude Desktop, the per-connection permissions, and the deploy-token headers for headless use are in [Hosted server](https://docs.micropage.sh/docs/mcp/remote/).

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for working on the server and [PUBLISHING.md](PUBLISHING.md) for releases.

## License

MIT
