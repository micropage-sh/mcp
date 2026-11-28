import { describe, expect, it } from "vitest";

import { parseBuildRef } from "../src/client/builds.js";
import { formatDeployEvent, pollDeployStatus, type Clock } from "../src/client/deploy-events.js";
import {
  MAX_SOURCE_BYTES,
  collectParseIssues,
  concatPages,
  concatPagesWithMap,
  injectLlmsTxt,
  mapDiagnostics,
  mapLine,
  normalizeLlmsTxt,
  parsePageSource,
  type PageFile,
} from "../src/client/pages.js";
import { createFakeFetch, makeHttp, type RecordedCall } from "./helpers/fake-fetch.js";

describe("concatPages", () => {
  it("puts landing.page first, sorts the rest by name, trims, skips empty extras, joins with a blank line", () => {
    expect(
      concatPages([
        { name: "zeta.page", content: "Z\n" },
        { name: "Beta.page", content: "B" },
        { name: "landing.page", content: "\n\nL\n\n" },
        { name: "alpha.page", content: "A" },
        { name: "blank.page", content: " \n " },
      ]),
    ).toBe("L\n\nB\n\nA\n\nZ");
  });

  it("works without a landing.page", () => {
    expect(concatPages([{ name: "b.page", content: "B" }, { name: "a.page", content: "A" }])).toBe("A\n\nB");
  });

  it("rejects bad names, duplicates, all-empty and oversized input", () => {
    expect(() => concatPages([])).toThrow(/at least one page/);
    expect(() => concatPages([{ name: "index.html", content: "x" }])).toThrow(/not valid/);
    expect(() => concatPages([{ name: "dir/a.page", content: "x" }])).toThrow(/not valid/);
    expect(() => concatPages([{ name: ".page", content: "x" }])).toThrow(/not valid/);
    expect(() => concatPages([{ name: "a.page", content: "x" }, { name: "a.page", content: "y" }])).toThrow(/twice/);
    expect(() => concatPages([{ name: "a.page", content: " " }])).toThrow(/empty/);
    expect(() => concatPages([{ name: "a.page", content: "x".repeat(MAX_SOURCE_BYTES + 1) }])).toThrow(/limit/);
  });
});

/** Every merged line maps back to the same text in its file; separators map to null. */
function expectRoundTrip(pages: PageFile[]): void {
  const { text, map } = concatPagesWithMap(pages);
  expect(text).toBe(concatPages(pages));
  const merged = text.split("\n");
  const byName = new Map(pages.map((p) => [p.name, p.content.split("\n")]));
  merged.forEach((line, i) => {
    const at = mapLine(map, i + 1);
    if (at === null) {
      expect(line, `merged line ${i + 1}`).toBe("");
      return;
    }
    const fileLines = byName.get(at.file)!;
    expect(fileLines[at.line - 1]!.trim(), `merged line ${i + 1} -> ${at.file}:${at.line}`).toBe(line.trim());
  });
  expect(mapLine(map, merged.length + 1)).toBeNull();
  expect(mapLine(map, 0)).toBeNull();
}

describe("concatPagesWithMap", () => {
  it("maps merged lines to file lines, mirroring the CLI's merge", () => {
    const pages = [
      { name: "zeta.page", content: "Z1\nZ2\n" },
      { name: "landing.page", content: "\n\nL1\nL2\n\n" },
      { name: "about.page", content: "\n\n\nA1\n\nA3" },
      { name: "blank.page", content: " \n " },
    ];
    const { text, map } = concatPagesWithMap(pages);
    expect(text).toBe("L1\nL2\n\nA1\n\nA3\n\nZ1\nZ2");
    expect(map.files).toEqual([
      { name: "landing.page", startLine: 1, lineCount: 2, leadingLines: 2 },
      { name: "about.page", startLine: 4, lineCount: 3, leadingLines: 3 },
      { name: "zeta.page", startLine: 8, lineCount: 2, leadingLines: 0 },
    ]);
    expect(mapLine(map, 1)).toEqual({ file: "landing.page", line: 3 });
    expect(mapLine(map, 3)).toBeNull();
    expect(mapLine(map, 4)).toEqual({ file: "about.page", line: 4 });
    expect(mapLine(map, 6)).toEqual({ file: "about.page", line: 6 });
    expect(mapLine(map, 9)).toEqual({ file: "zeta.page", line: 2 });
    expectRoundTrip(pages);
  });

  it("keeps an empty landing.page as one line and skips other empty files", () => {
    const pages = [
      { name: "landing.page", content: "  \n\n" },
      { name: "a.page", content: "\n" },
      { name: "b.page", content: "B" },
    ];
    const { text, map } = concatPagesWithMap(pages);
    expect(text).toBe("\n\nB");
    expect(map.files).toEqual([
      { name: "landing.page", startLine: 1, lineCount: 1, leadingLines: 0 },
      { name: "b.page", startLine: 3, lineCount: 1, leadingLines: 0 },
    ]);
    expect(mapLine(map, 2)).toBeNull();
    expect(mapLine(map, 3)).toEqual({ file: "b.page", line: 1 });
  });

  it("counts a BOM and CRLF leading lines like the trim does", () => {
    const pages = [
      { name: "landing.page", content: "\uFEFF\r\n\r\n[site]\r\ntitle: A\r\n" },
      { name: "x.page", content: "\r\n[X -> /x]\r\n/// section\r\np: x\r\n" },
    ];
    const { map } = concatPagesWithMap(pages);
    expect(mapLine(map, 1)).toEqual({ file: "landing.page", line: 3 });
    expect(mapLine(map, 2)).toEqual({ file: "landing.page", line: 4 });
    expect(mapLine(map, 3)).toBeNull();
    expect(mapLine(map, 4)).toEqual({ file: "x.page", line: 2 });
    expect(mapLine(map, 6)).toEqual({ file: "x.page", line: 4 });
    expectRoundTrip(pages);
  });

  it("validates exactly like concatPages", () => {
    expect(() => concatPagesWithMap([])).toThrow(/at least one page/);
    expect(() => concatPagesWithMap([{ name: "../a.page", content: "x" }])).toThrow(/not valid/);
    expect(() => concatPagesWithMap([{ name: "a.page", content: "\n " }])).toThrow(/empty/);
  });
});

describe("mapDiagnostics", () => {
  const { map } = concatPagesWithMap([
    { name: "landing.page", content: "\n[Home -> /]\n/// section\nimg: <- a.png" },
    { name: "b.page", content: "[B -> /b]\n/// section\nbuton: Go -> /x" },
  ]);

  it("maps lines and fixes to files, keeping column, code and message", () => {
    expect(
      mapDiagnostics(
        [
          { line: 3, column: 1, severity: "warning", code: "missing-alt", message: "Image has no alt text" },
          { line: 7, column: 1, severity: "hint", code: "unknown-tag", message: "Did you mean button:?", fix: { line: 7, replace: "button: Go -> /x" } },
          { severity: "hint", code: "too-many-diagnostics", message: "3 more not shown" },
        ],
        map,
      ),
    ).toEqual([
      { file: "landing.page", line: 4, column: 1, severity: "warning", code: "missing-alt", message: "Image has no alt text" },
      {
        file: "b.page",
        line: 3,
        column: 1,
        severity: "hint",
        code: "unknown-tag",
        message: "Did you mean button:?",
        fix: { file: "b.page", line: 3, replace: "button: Go -> /x" },
      },
      { severity: "hint", code: "too-many-diagnostics", message: "3 more not shown" },
    ]);
  });

  it("reads unknown severities as hints, keeps merged lines it cannot map, drops unmappable fixes and drops malformed entries", () => {
    expect(
      mapDiagnostics(
        [
          { line: 4, severity: "fatal", code: "x", message: "on the separator" },
          { line: 99, column: 2, severity: "error", code: "y", message: "past the end", fix: { line: 99, replace: "z" } },
          { line: 0, column: 3, severity: "error", code: "z", message: "bad line" },
          { severity: "error", code: "f", message: "bad fix", fix: { line: 1, replace: "a\nb" } },
          { severity: "error", message: "no code" },
          null,
          "text",
          [],
        ],
        map,
      ),
    ).toEqual([
      { line: 4, severity: "hint", code: "x", message: "on the separator" },
      { line: 99, column: 2, severity: "error", code: "y", message: "past the end" },
      { severity: "error", code: "z", message: "bad line" },
      { severity: "error", code: "f", message: "bad fix" },
    ]);
  });

  it("caps at 51 entries and clips long messages", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ severity: "warning", code: "c", message: `m${i}` }));
    expect(mapDiagnostics(many, map)).toHaveLength(51);
    expect(mapDiagnostics([{ severity: "warning", code: "c", message: "x".repeat(1000) }], map)[0]!.message).toHaveLength(300);
  });
});

describe("parsePageSource", () => {
  const config = { buildCompilerUrl: "https://bc.test/" };

  it("asks for diagnostics and detaches them from the build JSON", async () => {
    const fake = createFakeFetch();
    fake.push({ body: { site: {}, pages: [], manifest: {}, diagnostics: [{ severity: "hint", code: "c", message: "m" }] } });
    const res = await parsePageSource(makeHttp(fake), config, { text: "x", projectId: 7, buildId: 30 });
    expect(fake.calls[0]!.url).toBe("https://bc.test/parse");
    expect(fake.calls[0]!.body).toEqual({ text: "x", project_id: 7, build_id: 30, version: "2", diagnostics: true });
    expect(res).toEqual({ json: { site: {}, pages: [], manifest: {} }, diagnostics: [{ severity: "hint", code: "c", message: "m" }] });
  });

  it("returns null diagnostics when an older compiler sends none, or sends something else", async () => {
    const fake = createFakeFetch();
    fake.push({ body: { site: {}, pages: [] } });
    fake.push({ body: { site: {}, pages: [], diagnostics: "nope" } });
    const http = makeHttp(fake);
    expect(await parsePageSource(http, config, { text: "x", projectId: 7, buildId: null })).toEqual({ json: { site: {}, pages: [] }, diagnostics: null });
    expect(await parsePageSource(http, config, { text: "x", projectId: 7, buildId: null })).toEqual({ json: { site: {}, pages: [] }, diagnostics: null });
  });
});

describe("llms_txt and parse issues", () => {
  it("normalizes llms_txt like the CLI and injects it into site", () => {
    expect(normalizeLlmsTxt("  ")).toBeNull();
    expect(normalizeLlmsTxt("# A\n\n")).toBe("# A\n");
    expect(injectLlmsTxt({ pages: [] }, "x")).toEqual({ pages: [], site: { llms_txt: "x" } });
    expect(injectLlmsTxt({ site: { title: "T" } }, null)).toEqual({ site: { title: "T" } });
  });

  it("collects element errors and flags a site without pages", () => {
    expect(collectParseIssues({ site: { logo: { error: "File not found: logo.svg" } }, pages: [] })).toEqual([
      "No pages were produced. Add a page block such as `[Home -> /]` followed by `/// hero` or `/// section`.",
      "File not found: logo.svg",
    ]);
    expect(collectParseIssues({ site: {}, pages: [{ body: [] }] })).toEqual([]);
  });
});

describe("parseBuildRef", () => {
  it("reads numbers, vN and id:N", () => {
    expect(parseBuildRef(12)).toEqual({ kind: "number", value: 12, idFallback: true });
    expect(parseBuildRef(" v12 ")).toEqual({ kind: "number", value: 12, idFallback: false });
    expect(parseBuildRef("12")).toEqual({ kind: "number", value: 12, idFallback: true });
    expect(parseBuildRef("id:4567")).toEqual({ kind: "id", value: 4567 });
    expect(() => parseBuildRef("latest")).toThrow(/not a build reference/);
  });
});

describe("formatDeployEvent", () => {
  it("formats the active domain wiring step like the CLI and falls back to type + payload", () => {
    expect(formatDeployEvent({ event_type: "deployment.domain_wiring", payload: { step: "active", hostname: "a.micropage.sh" } })).toBe(
      "deployment.domain_wiring: live — https://a.micropage.sh",
    );
    expect(formatDeployEvent({ event_type: "deployment.domain_wiring", payload: { step: "dns_ok", hostname: "a.micropage.sh" } })).toBe(
      'deployment.domain_wiring {"step":"dns_ok","hostname":"a.micropage.sh"}',
    );
    expect(formatDeployEvent({ event_type: "build.failed", payload: { step: "x" } })).toBe('build.failed {"step":"x"}');
    expect(formatDeployEvent({ event_type: "deployment.started", payload: null })).toBe("deployment.started");
  });
});

describe("pollDeployStatus", () => {
  function clock(): Clock & { t: number; sleeps: number[] } {
    const c = {
      t: 1_000,
      sleeps: [] as number[],
      now: () => c.t,
      sleep: async (ms: number) => {
        c.sleeps.push(ms);
        c.t += ms;
      },
    };
    return c;
  }

  /** Scripted polls: each entry is [build status, events returned for that poll]. */
  function script(polls: Array<[string, Array<{ id: number; event_type: string }>]>) {
    const fake = createFakeFetch();
    for (const [status, events] of polls) {
      fake.push({ body: [{ id: 5, number: 2, status, failure_reason: null, updated_at: null }] });
      fake.push({ body: events.map((e) => ({ ...e, payload: null, created_at: "t" })) });
    }
    return fake;
  }

  it("stops at a terminal event even while the status still says publishing", async () => {
    const fake = script([
      ["publishing", [{ id: 11, event_type: "build.enqueued" }]],
      ["publishing", [{ id: 12, event_type: "deployment.completed" }]],
    ]);
    const c = clock();
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 10, waitMs: 60_000, clock: c });
    expect(r).toMatchObject({ done: true, timed_out: false, after_event_id: 12, terminal_event: { type: "deployment.completed" } });
    expect(c.sleeps).toEqual([2000]);
    const q = new URL(fake.calls[1]!.url).searchParams;
    expect(q.get("id")).toBe("gt.10");
    expect(q.get("order")).toBe("id.asc");
    expect(new URL(fake.calls[3]!.url).searchParams.get("id")).toBe("gt.11");
  });

  it("does not end a publish wait on archive events", async () => {
    const fake = script([
      ["publishing", [{ id: 11, event_type: "archive.failed" }]],
      ["publishing", [{ id: 12, event_type: "archive.completed" }]],
      ["publishing", [{ id: 13, event_type: "build.failed" }]],
    ]);
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 10, waitMs: 60_000, clock: clock() });
    expect(r).toMatchObject({ done: true, after_event_id: 13, terminal_event: { type: "build.failed" } });
    expect(r.events.map((e) => e.id)).toEqual([11, 12, 13]);
  });

  it("without a cursor, stops when the build is no longer publishing", async () => {
    const fake = script([["failed", []]]);
    const r = await pollDeployStatus({
      http: makeHttp(fake),
      projectId: 7,
      buildId: 5,
      afterId: 0,
      waitMs: 60_000,
      clock: clock(),
      trustEvents: false,
    });
    expect(r).toMatchObject({ done: true, terminal_event: null, after_event_id: 0, waiting_for_start: false });
  });

  it("with a cursor, a status that is already settled does not end the wait (queued post rebuild)", async () => {
    const fake = script([
      ["deployed", []],
      ["deployed", []],
      ["deployed", [{ id: 21, event_type: "build.enqueued" }]],
      ["deployed", [{ id: 22, event_type: "deployment.completed" }]],
    ]);
    const c = clock();
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 20, waitMs: 60_000, clock: c });
    expect(r).toMatchObject({ done: true, waiting_for_start: false, after_event_id: 22, terminal_event: { id: 22 } });
    expect(c.sleeps).toEqual([2000, 2000, 2000]);
  });

  it("with a cursor, reports waiting_for_start while a draft active build has no new events", async () => {
    const fake = script([
      ["draft", []],
      ["draft", []],
    ]);
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 20, waitMs: 3_000, clock: clock() });
    expect(r).toMatchObject({ done: false, timed_out: true, waiting_for_start: true, after_event_id: 20 });
  });

  it("with a cursor, a status that moves away from publishing during the wait ends it", async () => {
    const fake = script([
      ["publishing", []],
      ["failed", []],
    ]);
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 20, waitMs: 60_000, clock: clock() });
    expect(r).toMatchObject({ done: true, terminal_event: null, waiting_for_start: false });
  });

  it("returns done false within waitMs, never sleeping or polling past the deadline", async () => {
    const fake = script([
      ["publishing", []],
      ["publishing", []],
    ]);
    const c = clock();
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 3, waitMs: 3_000, clock: c });
    expect(r).toMatchObject({ done: false, timed_out: true, after_event_id: 3, waiting_for_start: false });
    expect(c.sleeps).toEqual([2000]);
    // The last poll leaves at least one interval for its own requests.
    expect(c.t - 1_000).toBeLessThan(3_000);
  });

  it("waitMs 0 polls exactly once", async () => {
    const fake = script([["publishing", []]]);
    const c = clock();
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 0, waitMs: 0, clock: c });
    expect(r.done).toBe(false);
    expect(c.sleeps).toEqual([]);
    expect(fake.calls).toHaveLength(2);
  });

  it("drains a full page of events before returning, while the budget lasts", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, event_type: "deployment.domain_wiring" }));
    const fake = script([
      ["publishing", page],
      ["deployed", [{ id: 101, event_type: "deployment.completed" }]],
    ]);
    const c = clock();
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 0, waitMs: 10_000, clock: c });
    expect(r.events).toHaveLength(101);
    expect(r).toMatchObject({ after_event_id: 101, done: true });
    expect(c.sleeps).toEqual([]);
  });

  it("does not drain past the deadline; the cursor resumes on the next call", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, event_type: "deployment.domain_wiring" }));
    const fake = script([["publishing", page]]);
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 0, waitMs: 0, clock: clock() });
    expect(r).toMatchObject({ after_event_id: 100, done: false });
    expect(fake.calls).toHaveLength(2);
  });

  it("swallows a throwing progress callback", async () => {
    const fake = script([["deployed", []]]);
    const calls: RecordedCall[] = fake.calls;
    const r = await pollDeployStatus({
      http: makeHttp(fake),
      projectId: 7,
      buildId: 5,
      afterId: 0,
      waitMs: 0,
      clock: clock(),
      trustEvents: false,
      onPoll: () => {
        throw new Error("boom");
      },
    });
    expect(r.done).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
