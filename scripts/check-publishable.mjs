/**
 * Publish guard. Two ways an npm-published MCP server ships broken (both
 * seen for real in the maproll server this one is modelled on):
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
console.log("publishable: no local-path deps, no stale dist files");
