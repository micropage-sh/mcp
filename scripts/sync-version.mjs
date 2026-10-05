#!/usr/bin/env node
/**
 * Writes package.json's version into server.json (top level and every npm
 * package entry) and src/version.ts, so package.json is the only place a
 * version is ever typed. Runs from the npm `version` lifecycle, which stages
 * both into the version commit.
 *
 *   npm version patch        # bumps package.json, then runs this
 *   node scripts/sync-version.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MCP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(MCP_DIR, "package.json"), "utf8"));
const serverPath = join(MCP_DIR, "server.json");
const server = JSON.parse(readFileSync(serverPath, "utf8"));

server.version = pkg.version;
for (const p of server.packages ?? []) {
  if (p.registryType === "npm" && p.identifier === pkg.name) p.version = pkg.version;
}

writeFileSync(serverPath, JSON.stringify(server, null, 2) + "\n");
console.log(`server.json -> ${pkg.version}`);

const versionPath = join(MCP_DIR, "src", "version.ts");
writeFileSync(versionPath, versionModule(pkg.name, pkg.version));
console.log(`src/version.ts -> ${pkg.version}`);

function versionModule(name, version) {
  return [
    "// Generated from package.json by scripts/sync-version.mjs; do not edit.",
    "// A constant rather than a runtime read so the server needs no filesystem",
    "// (the remote entry runs where there is none); `npm run check` and a test",
    "// fail if it drifts from package.json.",
    `export const PACKAGE_NAME = ${JSON.stringify(name)};`,
    `export const VERSION = ${JSON.stringify(version)};`,
    "",
  ].join("\n");
}
