# Development

```bash
npm install
npm run typecheck   # src + tests + scripts
npm test            # offline vitest, fetch is faked (Node 22.12+)
npm run build       # dist/
npm run check       # publish guard: deps, server.json version, stale dist
npm run smoke       # real MCP over stdio, checks tool invariants
npm run inspect     # MCP Inspector against src/
```

The runtime supports Node 20 (`engines`); the test runner (vitest 5) needs
Node 22.12 or later, so develop on 22. CI runs both, without vitest on 20.

## Layout

```
src/
  index.ts          stdio entry (serveStdio over the factory)
  server.ts         createServer(ctx, deps) / createServerFactory(deps);
                    transport-agnostic, all long-lived state lives in deps
  version.ts        name and version, read from package.json at runtime
  context.ts        ToolContext and the env flags
  guards.ts         env switches, confirm checks, confirmation tokens,
                    elicitation, the deploy-token allowlist
  annotations.ts    RO / WRITE / DESTRUCTIVE / OUT hint presets
  progress.ts       progress notifications
  tools/            one register* per area
  reference.ts      resources, prompts and get_markup_reference
  reference/        their definitions
  content/          GENERATED markup reference and examples (see below)
  client/           the micropage API client; must not import the MCP SDK
scripts/
  smoke.ts              end-to-end over real stdio
  sync-content.mjs      regenerates src/content from the monorepo
  check-content-drift.mjs  bundled content vs docs.micropage.sh
  check-publishable.mjs publish guard
  sync-version.mjs      package.json version -> server.json
tests/              vitest, offline (tests/helpers/fake-fetch.ts)
server.json         MCP Registry entry; version is generated
```

## Auth modes

The server picks its credentials at startup (`createAuthProvider` in
`src/server.ts`):

- **CLI session** (default): reads `config.json` from `MICROPAGE_CONFIG_DIR`,
  or `~/.micropage` like the CLI. Run `micropage login` (Pro or Pro+) first.
  The file is re-read on each call, so logging in after the server started
  works without a restart; until then calls fail with `NOT_LOGGED_IN`.
- **Deploy token**: set both `MICROPAGE_DEPLOY_TOKEN` and
  `MICROPAGE_DEPLOY_PROJECT` (the project's uuid). Setting only one is a
  startup error. The server is then pinned to that project and only the tools
  a deploy token can serve are allowed.

To keep a development session apart from your normal CLI login, log the CLI
in under another `HOME` (the CLI has no config-dir override of its own) and
point the server at it:

```bash
HOME=~/micropage-dev micropage login
export MICROPAGE_CONFIG_DIR=~/micropage-dev/.micropage
```

## Running against production, read-only

There is no staging stack: the default endpoints are production, and a
logged-in server acts on the real account. To look without touching
anything:

- leave `MICROPAGE_MCP_ALLOW_SEND`, `MICROPAGE_MCP_ALLOW_DELETE` and
  `MICROPAGE_MCP_SUBMISSIONS` unset, so no email, delete or PII tools exist;
- call only read-only tools (`readOnlyHint: true`), for example `whoami`,
  `list_projects`, `get_page_source`, `list_builds`, `get_markup_reference`;
- use your own account, never a customer's session.

```bash
MICROPAGE_SMOKE_LIVE=1 npm run smoke   # also calls whoami and list_projects
```

Write tools (`save_page`, `publish_build`, uploads, posts) change real sites.
If you need them, use a throwaway project, ideally through a deploy token
scoped to it.

## Smoke and inspector

`npm run smoke` spawns `src/index.ts` over stdio with a real MCP client,
lists tools, resources and prompts, and checks that every tool has a long
description, sets all four annotation hints, and is marked destructive when
it takes a confirm input. Offline by default; CI runs it with no network
dependency:

```bash
MICROPAGE_SUPABASE_URL=http://127.0.0.1:9 MICROPAGE_CONFIG_DIR="$(mktemp -d)" npm run smoke
```

`npm run inspect` opens the MCP Inspector in a browser against `src/`. Pass
env switches in front of it, for example
`MICROPAGE_MCP_SUBMISSIONS=1 npm run inspect`.

## Content sync

`src/content/` (grammar, posts format, agent guide, examples) is generated
and committed, so the server never reads the filesystem at runtime. Do not
edit it. The sources of truth are in the monorepo:

- `docs/static/llms.txt`, `docs/static/llms-full.txt`
- `cli/templates/PROJECT_AGENT.template.md`, `cli/templates/examples/*.page`
- `docs/docs/cli/posts.md`, `docs/docs/concepts/posts.md`

```bash
npm run sync-content    # regenerate from ../docs and ../cli
npm run check-content   # compare with ../docs/static and docs.micropage.sh
```

`check-content` warns on network failure; `prepublishOnly` runs it with
`--strict`, which fails on drift or network failure. The docs site is the
source of truth, so a release needs the docs deployed first (see
[PUBLISHING.md](PUBLISHING.md)).

## Env switches

| Variable | Default | Effect |
| --- | --- | --- |
| `MICROPAGE_MCP_ALLOW_SEND` | off | `publish_post` may email the subscriber list |
| `MICROPAGE_MCP_ALLOW_DELETE` | off | registers `delete_project` |
| `MICROPAGE_MCP_SUBMISSIONS` | off | registers the form submission (PII) tools |
| `MICROPAGE_DEPLOY_TOKEN` / `MICROPAGE_DEPLOY_PROJECT` | unset | deploy-token auth, pinned to one project |
| `MICROPAGE_CONFIG_DIR` | `~/.micropage` | where the CLI session is read |
| `MICROPAGE_SMOKE_LIVE` | unset | `1` makes the smoke call whoami and list_projects |

The switches accept `1`, `true`, `yes` or `on`. Endpoint overrides use the
CLI's variables (`src/client/config.ts`): `MICROPAGE_SUPABASE_URL`,
`MICROPAGE_SUPABASE_ANON_KEY`, `MICROPAGE_APP_URL`,
`MICROPAGE_BUILD_COMPILER_URL` (or `MICROPAGE_PARSER_URL`) and
`MICROPAGE_BASE_DOMAIN`.

When you add a switch, add it to `server.json`'s `environmentVariables` too,
so registry clients can offer it.
