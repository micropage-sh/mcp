#!/usr/bin/env node
/**
 * Writes package.json's version into server.json (top level and every npm
 * package entry), so package.json is the only place a version is ever typed.
 * Runs from the npm `version` lifecycle, which stages server.json into the
 * version commit.
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
