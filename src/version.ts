import { readFileSync } from "node:fs";

// Read at runtime rather than hardcoded so the advertised server version and
// User-Agent can never drift from what npm published. Resolves from both
// src/ (tsx, vitest) and dist/ because each sits one level below the root.
const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

export const PACKAGE_NAME: string = pkg.name;
export const VERSION: string = pkg.version;
