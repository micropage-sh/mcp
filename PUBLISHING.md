# Publishing

A release publishes two things from one GitHub release, through
`.github/workflows/publish.yml`:

- the npm package [`@micropage-sh/mcp`](https://www.npmjs.com/package/@micropage-sh/mcp), via npm trusted publishing (provenance is automatic);
- the MCP Registry entry `io.github.micropage-sh/mcp`, generated from `server.json`.

After the first version, nothing is published from a laptop: a local
`npm publish` skips provenance and the registry, so the two would drift apart.

## First publish (by hand, once)

npm trusted publishing can only be configured for a package that already
exists, so the first version goes out manually:

1. Deploy the docs and run `npm run check-content` (see Release order).
2. `npm login`, then `npm publish --access public` from a clean checkout of
   the release commit (`prepublishOnly` runs all the gates).
3. Publish the registry entry by hand: `mcp-publisher login github`, then
   `mcp-publisher publish` (see Recovery for the binary).
4. On npmjs.com, package settings for `@micropage-sh/mcp`, add a trusted
   publisher: GitHub Actions, organization `micropage-sh`, repository `mcp`,
   workflow `publish.yml`. Then set publishing access to require trusted
   publishing and disallow tokens.

## Prerequisites (one-time)

- **GitHub repo `micropage-sh/mcp`** with this repo pushed to `main`. The
  registry namespace `io.github.micropage-sh` is proven with the release
  workflow's GitHub OIDC token, so the repo must live under the
  `micropage-sh` org. No DNS record is needed.
- **npm trusted publisher** for `@micropage-sh/mcp` pointing at workflow
  `publish.yml` (see First publish). No `NPM_TOKEN` secret is used; the
  workflow upgrades npm to >= 11.5.1, which trusted publishing requires.
- **npm org access for `@micropage-sh`**: the account doing the first publish
  is a member of the `micropage-sh` npm org with publish rights. The first publish
  of a scoped package needs `--access public`, which the workflow passes and
  `publishConfig.access` repeats. Without it npm treats the package as private
  and rejects it with `E402 Payment Required`.
- **Actions permissions**: the workflow asks for `id-token: write` itself. If
  the org restricts workflow permissions, allow it for this repo.

## Versions

`package.json` is the only place a version is typed. `npm version` bumps it
and then runs the `version` script, which runs `scripts/sync-version.mjs` to
copy the version into `server.json` (top level and the npm package entry) and
regenerate `src/version.ts`, and stages both into the same commit.
`src/version.ts` is a generated constant (the hosted Worker has no
filesystem to read package.json from); do not edit it by hand.

`npm run check` (in CI, the publish job and `prepublishOnly`) fails when
`server.json` or `src/version.ts` disagrees with `package.json`, when its `name` differs from
`mcpName`, or when its description is over the registry's 100-character
limit. If you edited `package.json` by hand, `npm run sync-version` fixes it.

## Releasing

Order matters. `prepublishOnly` runs `check-content-drift.mjs --strict`, which
compares the bundled markup reference (`src/content/grammar*.md`) with what
`https://docs.micropage.sh/llms.txt` and `llms-full.txt` serve right now. A
release whose bundled text the live docs don't match fails at `npm publish`,
before anything is uploaded.

1. **Deploy the docs first** (`docs/`, `npm run deploy`, see that repo). This
   matters for the first release in particular: the bundled `llms.txt`
   already mentions the MCP server and the live one does not, and the MCP
   pages under `/docs/mcp/` (which `server.json` and `homepage` link to) are
   not live yet. Confirm with:

   ```bash
   npm run check-content   # every line must say "ok"
   ```

2. **Sync the content** if the docs changed since the last sync, from a full
   monorepo checkout:

   ```bash
   npm run sync-content
   npm run check-content
   git commit -am "Sync bundled content with docs"
   ```

3. **Bump the version** on a clean `main`:

   ```bash
   npm version patch   # or minor / major; commits and tags v<version>
   git push origin main --follow-tags
   ```

4. **Wait for CI to go green** on that commit.

5. **Publish a GitHub release** for the tag `v<version>` (Releases → Draft a
   new release → choose the tag → Publish), or:

   ```bash
   gh release create v0.1.1 --title v0.1.1 --generate-notes
   ```

   The release workflow then checks that the tag, `package.json` and
   `server.json` agree, runs typecheck, tests, build and `npm run check`,
   downloads a pinned `mcp-publisher` and verifies its checksum, validates
   `server.json`, runs `npm publish --provenance --access public`, waits until
   npm serves the new version, then runs `mcp-publisher login github-oidc`
   and `mcp-publisher publish`.

A failure before "Publish to npm" leaves nothing published. If the cause was
outside the repo (the docs were not deployed yet), fix it and re-run the
failed workflow from the Actions tab. If it needs a code change, fix it on
`main`, delete the GitHub release, and start again from step 3 with a new
patch version.

## Verification

```bash
# npm has the version, with provenance
npm view @micropage-sh/mcp version
npm view @micropage-sh/mcp --json | grep -A3 '"attestations"'

# the registry lists it as active, at the same version
curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=io.github.micropage-sh/mcp"

# a clean install starts and answers over stdio (Ctrl-C to stop)
MICROPAGE_CONFIG_DIR="$(mktemp -d)" npx -y @micropage-sh/mcp@<version>
```

The npm package page shows a "Provenance" section linking to the workflow run.
Finally, add the server to a client as in the docs
(`claude mcp add micropage -- npx -y @micropage-sh/mcp`) and call `whoami`.

## Recovery

- **npm published but the registry step failed** (for example npm took over
  10 minutes to serve the version): re-running the job fails at `npm publish`
  because the version exists. Publish the registry entry by hand from the
  release commit, with the same pinned binary:

  ```bash
  git checkout v<version>
  # download mcp-publisher v1.8.1 for your platform from
  # https://github.com/modelcontextprotocol/registry/releases/tag/v1.8.1
  # and check it against registry_1.8.1_checksums.txt
  ./mcp-publisher login github   # device flow, as a micropage-sh org member
  ./mcp-publisher publish
  ```

- **A broken version reached npm**: do not unpublish. Fix forward with a new
  patch release, and `npm deprecate @micropage-sh/mcp@<bad> "<reason>"`.

## Upgrading mcp-publisher

`publish.yml` pins `PUBLISHER_VERSION` and `PUBLISHER_SHA256` because that
step holds a token that can publish under our namespace. To upgrade, take the
new version from https://github.com/modelcontextprotocol/registry/releases
and the `mcp-publisher_linux_amd64.tar.gz` line from that release's
`registry_<version>_checksums.txt`, and update both together. `mcp-publisher`
is the registry's Go binary; the npm package of the same name is unrelated.

## Registry constraints worth knowing

- `description` is capped at 100 characters and is mirrored verbatim by
  downstream directories, so it is the one string worth writing carefully.
- The `name` must match the auth method: `io.github.micropage-sh/...` needs
  GitHub auth as the `micropage-sh` org. Moving to `sh.micropage/...` would
  need DNS auth on `micropage.sh` instead.
- The registry checks that the npm package's `mcpName` equals the
  `server.json` name, and that npm already serves the version.
