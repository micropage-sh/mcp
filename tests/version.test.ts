import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { PACKAGE_NAME, VERSION } from "../src/version.js";

describe("version", () => {
  it("matches package.json (run node scripts/sync-version.mjs after a hand edit)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { name: string; version: string };
    expect({ PACKAGE_NAME, VERSION }).toEqual({ PACKAGE_NAME: pkg.name, VERSION: pkg.version });
  });
});
