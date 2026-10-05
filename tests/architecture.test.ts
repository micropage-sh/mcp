import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// The remote entry bundles createServer and the tools for a Worker, which has
// node:crypto and Buffer (nodejs_compat) but no filesystem, resolver or
// sockets. Anything Node-only belongs in src/node/ and reaches the server
// through ServerDeps.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");
const FORBIDDEN = /^(node:)?(fs|fs\/promises|os|dns|dns\/promises|net|path|path\/posix|path\/win32|child_process)$/;

/** Runtime imports of one file: type-only imports and exports are erased, so they do not count. */
function runtimeImports(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt)) {
      if (stmt.importClause?.isTypeOnly) continue;
      specs.push((stmt.moduleSpecifier as ts.StringLiteral).text);
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && !stmt.isTypeOnly) {
      specs.push((stmt.moduleSpecifier as ts.StringLiteral).text);
    }
  }
  return specs;
}

/** Every Node-only module reachable from the entries, with the chain that reaches it. */
function forbiddenReachable(entries: string[]): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of runtimeImports(file)) {
      const here = [...chain, relative(ROOT, file)];
      if (FORBIDDEN.test(spec)) {
        found.push(`${here.join(" -> ")} -> ${spec}`);
      } else if (spec.startsWith(".")) {
        walk(resolve(dirname(file), spec.replace(/\.js$/, ".ts")), here);
      }
    }
  };
  for (const entry of entries) walk(entry, []);
  return found;
}

const TOOL_FILES = readdirSync(join(SRC, "tools"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => join(SRC, "tools", f));

describe("architecture: the server core stays free of Node-only modules", () => {
  it("nothing reachable from src/server.ts or src/tools/* imports node:fs, os, dns, net or path", () => {
    expect(TOOL_FILES.length).toBeGreaterThan(0);
    expect(forbiddenReachable([join(SRC, "server.ts"), ...TOOL_FILES])).toEqual([]);
  });

  it("nothing reachable from the Worker entry (src/remote/worker.ts) imports them either", () => {
    expect(forbiddenReachable([join(SRC, "remote", "worker.ts")])).toEqual([]);
  });

  it("the walker does see Node-only imports (src/node/deps.ts has them)", () => {
    const found = forbiddenReachable([join(SRC, "node", "deps.ts")]);
    expect(found.some((f) => f.endsWith("node:fs/promises"))).toBe(true);
    expect(found.some((f) => f.endsWith("node:dns/promises"))).toBe(true);
  });

  it("follows chains through intermediate modules", () => {
    // session-store reaches node:fs both directly and through lock.ts.
    const found = forbiddenReachable([join(SRC, "client", "session-store.ts")]);
    expect(found).toContain("src/client/session-store.ts -> src/client/lock.ts -> node:fs/promises");
  });
});
