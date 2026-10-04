import { describe, expect, it } from "vitest";

import { DESTRUCTIVE, OUT, RO, WRITE, hints } from "../src/annotations.js";

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

describe("annotation presets", () => {
  it.each([
    ["RO", RO],
    ["WRITE", WRITE],
    ["DESTRUCTIVE", DESTRUCTIVE],
    ["OUT", OUT],
  ])("%s sets all four hints explicitly", (_name, preset) => {
    for (const hint of HINTS) expect(typeof preset[hint]).toBe("boolean");
  });

  it("RO is read-only and not destructive", () => {
    expect(RO).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true });
  });

  it("WRITE writes without being destructive", () => {
    expect(WRITE).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });

  it("DESTRUCTIVE and OUT are destructive and not read-only", () => {
    for (const preset of [DESTRUCTIVE, OUT]) {
      expect(preset).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    }
  });

  it("presets are frozen and hints() copies rather than mutates", () => {
    expect(Object.isFrozen(RO)).toBe(true);
    const idem = hints(OUT, { idempotentHint: true });
    expect(idem.idempotentHint).toBe(true);
    expect(OUT.idempotentHint).toBe(false);
  });
});
