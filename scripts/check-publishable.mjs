/**
 * Publish guard. Runs in CI, on release and on prepublishOnly. Besides the
 * server.json checks below, two ways an npm-published MCP server ships broken
 * (both seen for real in the maproll server this one is modelled on):
 *
 *  - a `file:` dependency, which resolves to a path that exists only on the
 *    machine that published it, so `npx -y @micropage-sh/mcp` fails for everyone;
 *  - stale files in dist/, because tsc does not clean up after deleted
 *    sources (a deleted source leaves its .js behind).
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const problems = [];

for (const [name, range] of Object.entries(pkg.dependencies ?? {})) {
  if (/^(file:|link:|portal:)/.test(range)) {
    problems.push(
      `dependency "${name}" is "${range}" — a local path. Publish ${name} first, ` +
        `then set a version range (e.g. "^0.1.0") here.`
    );
  }
}

// package.json can say "^0.1.0" while the lockfile still pins the local path
// it was first installed from — npm keeps the old resolution until the tree is
// rebuilt, and `npm ci` would then quietly use the sibling directory.
if (existsSync("package-lock.json")) {
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    const resolved = entry?.resolved ?? "";
    if (path.startsWith("node_modules/") && /^(file:|\.\.?\/)/.test(resolved)) {
      problems.push(
        `package-lock.json resolves "${path}" to "${resolved}" — a local path. ` +
          `Delete node_modules and package-lock.json, then reinstall.`
      );
    }
  }
}

// The MCP registry rejects a server.json whose version disagrees with the npm
// package, and one whose name differs from package.json's mcpName (that is
// how it proves the npm package belongs to the listing). package.json is the
// source; scripts/sync-version.mjs fixes a version mismatch.
if (!existsSync("server.json")) {
  problems.push(`server.json is missing — the MCP registry listing is generated from it.`);
} else {
  const srv = JSON.parse(readFileSync("server.json", "utf8"));
  if (srv.name !== pkg.mcpName) {
    problems.push(`server.json name "${srv.name}" differs from package.json mcpName "${pkg.mcpName}".`);
  }
  if (typeof srv.description !== "string" || srv.description.length > 100) {
    problems.push(`server.json description must be a string of at most 100 characters (registry limit).`);
  }
  const versions = { "server.json version": srv.version };
  const npmEntries = (srv.packages ?? []).filter((p) => p.registryType === "npm" && p.identifier === pkg.name);
  if (npmEntries.length === 0) {
    problems.push(`server.json has no npm package entry for "${pkg.name}".`);
  }
  npmEntries.forEach((p, i) => (versions[`server.json npm package [${i}] version`] = p.version));
  for (const [where, v] of Object.entries(versions)) {
    if (v !== pkg.version) {
      problems.push(
        `${where} is "${v}" but package.json is "${pkg.version}". ` +
          `Run node scripts/sync-version.mjs (npm version does this for you).`
      );
    }
  }
}

// src/version.ts is generated (the server reads no package.json at runtime),
// so a hand edit of package.json leaves it behind.
if (!existsSync("src/version.ts")) {
  problems.push(`src/version.ts is missing. Run node scripts/sync-version.mjs.`);
} else {
  const versionTs = readFileSync("src/version.ts", "utf8");
  const found = Object.fromEntries(
    [...versionTs.matchAll(/export const (\w+) = ("[^"]*");/g)].map((m) => [m[1], JSON.parse(m[2])])
  );
  if (found.VERSION !== pkg.version || found.PACKAGE_NAME !== pkg.name) {
    problems.push(
      `src/version.ts says ${found.PACKAGE_NAME}@${found.VERSION} but package.json is ${pkg.name}@${pkg.version}. ` +
        `Run node scripts/sync-version.mjs (npm version does this for you).`
    );
  }
}

// Every emitted .js must trace back to a source file of the same name.
if (existsSync("dist")) {
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
    );
  for (const file of walk("dist")) {
    if (!file.endsWith(".js")) continue;
    const src = file.replace(/^dist[\\/]/, "src/").replace(/\.js$/, ".ts");
    if (!existsSync(src)) {
      problems.push(`dist file "${file}" has no source at "${src}" — stale build. Run a clean build.`);
    }
  }
}

if (problems.length > 0) {
  console.error("Not publishable:\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log("publishable: no local-path deps, server.json and src/version.ts agree with package.json, no stale dist files");
