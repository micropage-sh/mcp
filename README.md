# @micropage-sh/mcp

MCP server for [micropage.sh](https://micropage.sh). It lets an AI assistant (Claude Code, Claude Desktop, Cursor, VS Code) create, edit and publish micropages and posts from markup.

**Documentation: https://docs.micropage.sh/docs/mcp/overview/**

## Install

The server needs Node.js 20 or later and a Pro or Pro+ account. It uses the session from the [micropage CLI](https://www.npmjs.com/package/micropage):

```sh
npm install -g micropage
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

## Development

See [DEVELOPMENT.md](DEVELOPMENT.md) for working on the server and [PUBLISHING.md](PUBLISHING.md) for releases.

## License

MIT
