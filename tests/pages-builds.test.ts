import { describe, expect, it } from "vitest";

import { parseBuildRef } from "../src/client/builds.js";
import { formatDeployEvent, pollDeployStatus, type Clock } from "../src/client/deploy-events.js";
import { MAX_SOURCE_BYTES, collectParseIssues, concatPages, injectLlmsTxt, normalizeLlmsTxt } from "../src/client/pages.js";
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
  it("formats domain wiring steps like the CLI and falls back to type + payload", () => {
    expect(formatDeployEvent({ event_type: "deployment.domain_wiring", payload: { step: "dns_ok", hostname: "a.micropage.sh" } })).toBe(
      "deployment.domain_wiring: DNS CNAME ready (a.micropage.sh)",
    );
    expect(formatDeployEvent({ event_type: "deployment.domain_wiring", payload: { step: "timeout", hostname: "a.micropage.sh" } })).toBe(
      "deployment.domain_wiring: still pending after wait (try https://a.micropage.sh shortly)",
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
      ["publishing", [{ id: 12, event_type: "archive.failed" }]],
    ]);
    const c = clock();
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 10, waitMs: 60_000, clock: c });
    expect(r).toMatchObject({ done: true, timed_out: false, after_event_id: 12, terminal_event: { type: "archive.failed" } });
    expect(c.sleeps).toEqual([2000]);
    const q = new URL(fake.calls[1]!.url).searchParams;
    expect(q.get("id")).toBe("gt.10");
    expect(q.get("order")).toBe("id.asc");
    expect(new URL(fake.calls[3]!.url).searchParams.get("id")).toBe("gt.11");
  });

  it("stops when the build is no longer publishing", async () => {
    const fake = script([["failed", []]]);
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 0, waitMs: 60_000, clock: clock() });
    expect(r).toMatchObject({ done: true, terminal_event: null, after_event_id: 0 });
  });

  it("returns done false after waitMs, never sleeping past the deadline", async () => {
    const fake = script([
      ["publishing", []],
      ["publishing", []],
      ["publishing", []],
    ]);
    const c = clock();
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 3, waitMs: 3_000, clock: c });
    expect(r).toMatchObject({ done: false, timed_out: true, after_event_id: 3 });
    expect(c.sleeps).toEqual([2000, 1000]);
  });

  it("waitMs 0 polls exactly once", async () => {
    const fake = script([["publishing", []]]);
    const c = clock();
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 0, waitMs: 0, clock: c });
    expect(r.done).toBe(false);
    expect(c.sleeps).toEqual([]);
    expect(fake.calls).toHaveLength(2);
  });

  it("drains a full page of events before returning", async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, event_type: "deployment.domain_wiring" }));
    const fake = script([
      ["deployed", page],
      ["deployed", [{ id: 101, event_type: "deployment.completed" }]],
    ]);
    const r = await pollDeployStatus({ http: makeHttp(fake), projectId: 7, buildId: 5, afterId: 0, waitMs: 0, clock: clock() });
    expect(r.events).toHaveLength(101);
    expect(r.after_event_id).toBe(101);
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
      onPoll: () => {
        throw new Error("boom");
      },
    });
    expect(r.done).toBe(true);
    expect(calls).toHaveLength(2);
  });
});
