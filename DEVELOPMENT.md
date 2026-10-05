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
  version.ts        GENERATED name and version constants (sync-version.mjs)
  hints.ts          model-facing wording per mode (stdio / remote OAuth /
                    remote deploy token)
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
  node/             stdio-only deps: createDeps / createAuthProvider,
                    filesystem path source, system DNS lookup
  remote/           hosted Worker entry; not part of the npm package
                    (see Remote server)
scripts/
  smoke.ts              end-to-end over real stdio
  sync-content.mjs      regenerates src/content from the monorepo
  check-content-drift.mjs  bundled content vs docs.micropage.sh
  check-publishable.mjs publish guard
  sync-version.mjs      package.json version -> server.json, src/version.ts
tests/              vitest, offline (tests/helpers/fake-fetch.ts)
server.json         MCP Registry entry; version is generated
```

## Auth modes

The stdio server picks its credentials at startup (`createAuthProvider` in
`src/node/deps.ts`):

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
so registry clients can offer it. On the hosted server a switch is a column
in `mcp_connection_permissions` instead (see Remote server).

## Remote server

The hosted server is a Cloudflare Worker, `micropage-mcp-remote`, built from
the same `createServer(ctx, deps)` as stdio. It is live at
`https://micropage-mcp-remote.cosmin-stefaniga.workers.dev/mcp` and will move
to `https://mcp.micropage.sh/mcp` as a Custom Domain. User docs:
`docs/docs/mcp/remote.md` in the monorepo.

```
src/remote/
  worker.ts       wrangler `main`; createWorker() with real fetch
  app.ts          routing (/mcp, /.well-known/oauth-protected-resource,
                  /healthz), Origin check, bearer verification, rate limits,
                  body cap, stateless createMcpHandler
  config.ts       Env bindings, RESOURCE_URL checks, upload/body caps,
                  host denylist for {url} uploads
  verifier.ts     OAuth access tokens (client_id claim required, checked
                  against /auth/v1/user, 60 s cache) and deploy tokens
                  (Bearer + X-Micropage-Project, exchanged every 5 min)
  deps.ts         per-request ServerDeps: auth, plan gate, permissions, hints
  permissions.ts  mcp_connection_permissions row per (user, OAuth client),
                  read under RLS with the user's token, 60 s cache
  rate-limit.ts   USER_LIMITER / IP_LIMITER helpers; 429 + Retry-After
  doh.ts          DNS-over-HTTPS lookup for the private-address check
  cache.ts        bounded per-isolate TTL cache
  log.ts          structured, redacted request logs (hashed ids only)
```

`tsconfig.json` excludes `src/remote`, so none of it ships in the npm
package. Shared code must not reach for `node:fs`, `node:dns` or
`node:net`; those live in `src/node/`. Mode-specific model-facing text goes
in `src/hints.ts`.

```bash
npm run dev:remote      # wrangler dev, local
npm run deploy:remote   # wrangler deploy: production, coordinate first
```

For `wrangler dev`, put `MCP_CONFIRM_KEY` (32+ characters) in `.dev.vars`
(gitignored); without it `/mcp` answers 500. The rate-limit bindings are
absent locally, which disables limiting rather than refusing requests.
`wrangler dev` still talks to the production Supabase from `wrangler.toml`.

**Secrets.** One, set with `wrangler secret put MCP_CONFIRM_KEY`: at least 32
random characters (`openssl rand -base64 48`), signs `preview_post_send`
confirmation tokens. Rotating it invalidates outstanding previews (15 min).
Everything else in `[vars]` is public (the anon key is the one the editor and
CLI ship).

**`RESOURCE_URL`** is the public URL of `/mcp` and the `resource` in the
protected-resource metadata, so it must be exactly the URL clients connect
to. The Worker answers `/mcp` and the metadata with 500 (`config_error`
`RESOURCE_URL_*` in the logs) when it is not a valid URL, is not `https`, or
still contains `REPLACE`. When the Custom Domain is attached, set it to
`https://mcp.micropage.sh/mcp` and `workers_dev = false` in the same deploy,
so the Worker answers on one host only. Do not add `routes`: the
`micropage.sh` zone's `*/*` route belongs to the custom-hostnames fallback
Worker.

**Plan.** The Worker needs the Workers Paid plan on its Cloudflare account.
Do not move it to an account on the Free plan.

**Rate limits.** `[[ratelimits]]` bindings with `namespace_id` `5001`
(`USER_LIMITER`, 120 per 60 s, keyed by OAuth `sub` or deploy-token hash)
and `5002` (`IP_LIMITER`, 30 per 60 s per `cf-connecting-ip`, counted only
for credentials this isolate has not verified yet). Namespace ids are
account-wide: another Worker using the same id shares the counters.

**Logs.** Observability is on, but `invocation_logs = false`: Cloudflare does
not document that the platform's per-request logs redact `Authorization`.
The only log lines are the ones `src/remote/log.ts` writes, which never
include headers or bodies. Keep it that way when adding logging.

**OAuth.** The authorization server is Supabase's OAuth 2.1 server (enabled
on production, dynamic registration off, consent at
`app.micropage.sh/oauth/consent`). Clients are pre-registered as public
clients; redirect URIs are exact-match, which is why Claude Code needs
`--callback-port 33418`. Revoking a grant makes `/auth/v1/user` refuse the
token at once, so the Worker stops within its 60 s verify cache; PostgREST
and the build compiler keep accepting the JWT until it expires (up to 1 h).
