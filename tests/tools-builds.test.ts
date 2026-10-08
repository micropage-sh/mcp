import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DESTRUCTIVE, OUT, RO, WRITE } from "../src/annotations.js";
import type { Clock } from "../src/client/deploy-events.js";
import { createDeps } from "../src/node/deps.js";
import { createServer } from "../src/server.js";
import { LEFTOVER_MIN_AGE_MS, resetOwnLeftovers } from "../src/client/builds.js";
import { buildToolsClock } from "../src/tools/builds.js";
import { createFakeFetch, type FakeFetch, type RecordedCall } from "./helpers/fake-fetch.js";
import { tempConfig, tokenFor, type TempConfig } from "./helpers/session.js";

const UUID = "11111111-2222-3333-4444-555555555555";
const PARSE_URL = "https://build-compiler.micropage.sh/parse";
const UNIT_B_TOOLS = ["get_page_source", "create_project", "save_page", "publish_build", "get_deploy_status", "list_builds"];

let cfg: TempConfig;
let client: Client | undefined;
let elicited: string[] = [];
const realClockRef = buildToolsClock.current;

beforeEach(async () => {
  elicited = [];
  resetOwnLeftovers();
  cfg = await tempConfig();
  await cfg.write({ access_token: tokenFor("user-1", 3600), refresh_token: "r1", user: { id: "user-1" } });
});
afterEach(async () => {
  buildToolsClock.current = realClockRef;
  await client?.close();
  client = undefined;
  await cfg.cleanup();
});

// ---------------------------------------------------------------------------
// Stateful stand-in for PostgREST, the edge functions and the build compiler.
// ---------------------------------------------------------------------------

interface BuildState {
  id: number;
  number: number;
  status: string;
  updated_at: string;
  created_at: string;
  failure_reason: string | null;
  raw_content: string | null;
  llms_txt: string | null;
  /** Stands in for json_content; only whether it is null matters here. */
  json_content: unknown;
}

interface EventState {
  id: number;
  build_id: number;
  event_type: string;
  payload: unknown;
  created_at: string;
}

interface Backend {
  tier: string;
  activeBuildId: number | null;
  domain: string;
  builds: BuildState[];
  events: EventState[];
  /** Status the "id,status" re-read reports, to simulate a publish starting mid-save. */
  rereadStatus?: string;
  /** Called on each builds status poll (select of the poll columns), to advance a deploy. */
  onStatusPoll?: (b: Backend, pollIndex: number) => void;
  statusPolls: number;
  parse: (call: RecordedCall) => { status?: number; body: unknown };
  deleteStatus?: number;
  /** Runs before each PATCH of builds is applied, to simulate another writer. */
  beforeBuildPatch?: (b: Backend) => void;
  /** HTTP status a PATCH of builds answers with instead of success. */
  buildPatchStatus?: number;
  /** HTTP status publish-build answers with instead of success. */
  publishStatus?: number;
  /** Body publish-build answers with alongside publishStatus. */
  publishBody?: unknown;
  /** HTTP status a PATCH of projects answers with after the first one. */
  restoreStatus?: number;
  projectPatches: number;
}

function build(overrides: Partial<BuildState> & { id: number; number: number }): BuildState {
  return {
    status: "deployed",
    updated_at: "2026-10-04T10:00:00Z",
    created_at: "2026-10-04T09:00:00Z",
    failure_reason: null,
    raw_content: "[site]\ntitle: Old",
    llms_txt: null,
    json_content: { site: { title: "Old" } },
    ...overrides,
  };
}

function backend(overrides: Partial<Backend> = {}): Backend {
  return {
    tier: "pro",
    activeBuildId: 30,
    domain: "acme",
    builds: [build({ id: 30, number: 4 })],
    events: [],
    statusPolls: 0,
    projectPatches: 0,
    parse: () => ({ body: { site: { title: "New" }, pages: [{ meta: {}, body: [] }] } }),
    ...overrides,
  };
}

const unq = (v: string | null | undefined) => v?.replace(/^(eq|gt)\./, "");

const BUILD_PARAMS = new Set(["select", "order", "limit", "id", "number", "status", "project_id", "json_content", "created_at"]);

function filterBuilds(b: Backend, q: URLSearchParams): BuildState[] {
  for (const key of q.keys()) if (!BUILD_PARAMS.has(key)) throw new Error(`fake builds: unsupported filter ${key}=${q.get(key)}`);
  const projectId = q.get("project_id");
  if (projectId && projectId !== "eq.7") throw new Error(`fake builds: unsupported project filter ${projectId}`);
  const json = q.get("json_content");
  if (json && json !== "is.null") throw new Error(`fake builds: unsupported json_content filter ${json}`);
  const createdAt = q.get("created_at");
  if (createdAt && !createdAt.startsWith("lt.")) throw new Error(`fake builds: unsupported created_at filter ${createdAt}`);
  let rows = [...b.builds];
  if (createdAt) rows = rows.filter((r) => Date.parse(r.created_at) < Date.parse(createdAt.slice(3)));
  const id = q.get("id");
  if (id?.startsWith("gt.")) rows = rows.filter((r) => r.id > Number(id.slice(3)));
  else if (id) rows = rows.filter((r) => r.id === Number(unq(id)));
  if (q.get("json_content") === "is.null") rows = rows.filter((r) => r.json_content === null);
  const number = unq(q.get("number"));
  if (number) rows = rows.filter((r) => r.number === Number(number));
  const status = q.get("status");
  const inList = status?.match(/^in\.\((.*)\)$/)?.[1]?.split(",");
  if (inList) rows = rows.filter((r) => inList.includes(r.status));
  else if (status) rows = rows.filter((r) => r.status === unq(status));
  if (q.get("order") === "number.desc") rows.sort((x, y) => y.number - x.number);
  if (q.get("order") === "id.desc") rows.sort((x, y) => y.id - x.id);
  const limit = q.get("limit");
  return limit ? rows.slice(0, Number(limit)) : rows;
}

function serve(b: Backend): FakeFetch {
  const fake = createFakeFetch();
  const responder = (call: RecordedCall) => {
    if (call.url === PARSE_URL) return b.parse(call);
    const url = new URL(call.url);
    const q = url.searchParams;
    const key = `${call.method} ${url.pathname}`;
    switch (key) {
      case "GET /rest/v1/customers":
        return { body: [{ plan_tier: b.tier }] };
      case "GET /rest/v1/projects":
        return {
          body: [
            { id: 7, uuid: UUID, name: "Acme", domain: b.domain, custom_domain: null, active_build_id: b.activeBuildId, status: "active", created_at: null },
          ],
        };
      case "PATCH /rest/v1/projects": {
        b.projectPatches++;
        if (b.projectPatches > 1 && b.restoreStatus) return { status: b.restoreStatus, body: { message: "nope" } };
        b.activeBuildId = (call.body as { active_build_id: number }).active_build_id;
        return { body: [{ id: 7, active_build_id: b.activeBuildId }] };
      }
      case "POST /rest/v1/projects": {
        const body = call.body as { name: string; domain?: string };
        return {
          body: [
            { id: 9, uuid: "22222222-3333-4444-5555-666666666666", name: body.name, domain: body.domain ?? "new-site-a1b2c3", custom_domain: null, active_build_id: null, status: null, created_at: "2026-10-04T00:00:00Z", user_id: "user-1" },
          ],
        };
      }
      case "GET /rest/v1/builds": {
        const select = q.get("select") ?? "";
        if (select === "id,status" && b.rereadStatus) {
          return { body: filterBuilds(b, q).map((r) => ({ id: r.id, status: b.rereadStatus })) };
        }
        if (select === "id,number,status,failure_reason,updated_at") {
          b.onStatusPoll?.(b, b.statusPolls);
          b.statusPolls++;
        }
        return { body: filterBuilds(b, q) };
      }
      case "PATCH /rest/v1/builds": {
        if (b.buildPatchStatus) return { status: b.buildPatchStatus, body: { message: "upstream down" } };
        b.beforeBuildPatch?.(b);
        const rows = filterBuilds(b, q);
        const body = call.body as { raw_content?: string; json_content?: unknown };
        if (body.raw_content !== undefined) for (const r of rows) r.raw_content = body.raw_content;
        if (body.json_content !== undefined) for (const r of rows) r.json_content = body.json_content;
        return { body: rows };
      }
      case "POST /rest/v1/builds": {
        const next = build({
          id: Math.max(99, ...b.builds.map((x) => x.id)) + 1,
          number: Math.max(0, ...b.builds.map((x) => x.number)) + 1,
          status: "draft",
          json_content: null,
          created_at: new Date().toISOString(),
        });
        b.builds.push(next);
        return { status: 201, body: [next] };
      }
      case "GET /rest/v1/build_deploy_events": {
        const buildId = Number(unq(q.get("build_id")));
        let rows = b.events.filter((e) => e.build_id === buildId);
        if (q.get("select") === "created_at") {
          rows.sort((x, y) => y.id - x.id);
          return { body: rows.slice(0, 1).map((e) => ({ created_at: e.created_at })) };
        }
        const after = q.get("id");
        if (after) rows = rows.filter((e) => e.id > Number(unq(after)));
        rows.sort((x, y) => (q.get("order") === "id.desc" ? y.id - x.id : x.id - y.id));
        return { body: rows.slice(0, Number(q.get("limit") ?? 1000)) };
      }
      case "POST /functions/v1/publish-build": {
        if (b.publishStatus) return { status: b.publishStatus, body: b.publishBody ?? { error: "publisher webhook failed" } };
        const { buildId } = call.body as { buildId: number };
        const target = b.builds.find((x) => x.id === buildId);
        if (target) target.status = "publishing";
        return { body: { success: true } };
      }
      case "GET /functions/v1/list-files":
        return { body: { files: [{ id: "f1", filename: "logo.svg" }, { id: "f2", filename: "hero.png" }] } };
      case "POST /functions/v1/delete-project":
        return b.deleteStatus ? { status: b.deleteStatus, body: { error: "gone" } } : { body: { success: true } };
      default:
        throw new Error(`unexpected ${call.method} ${call.url}`);
    }
  };
  for (let i = 0; i < 300; i++) fake.push(responder);
  return fake;
}

async function connect(
  fake: FakeFetch,
  extraEnv: Record<string, string> = {},
  options: { elicit?: "accept" | "decline" } = {},
): Promise<Client> {
  const deps = createDeps(
    {
      HOME: cfg.dir,
      MICROPAGE_CONFIG_DIR: cfg.dir,
      MICROPAGE_SUPABASE_URL: "https://supabase.test",
      MICROPAGE_SUPABASE_ANON_KEY: "anon-key",
      ...extraEnv,
    },
    { fetch: fake.fetch },
  );
  const server = createServer({ era: "legacy" }, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client(
    { name: "test", version: "0.0.0" },
    options.elicit ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  if (options.elicit) {
    const action = options.elicit;
    client.setRequestHandler("elicitation/create", async (request) => {
      elicited.push(request.params.message);
      return action === "accept" ? { action: "accept", content: { confirm: true } } : { action: "decline" };
    });
  }
  await client.connect(clientTransport);
  return client;
}

const text = (res: { content?: unknown }) => JSON.stringify(res.content);
const path = (c: RecordedCall) => (c.url === PARSE_URL ? "parse" : new URL(c.url).pathname);
const writes = (fake: FakeFetch) => fake.calls.filter((c) => c.method !== "GET" && path(c) !== "parse");
const callsTo = (fake: FakeFetch, method: string, p: string) =>
  fake.calls.filter((c) => c.method === method && path(c) === p);

function fakeClock(): Clock & { t: number; sleeps: number[] } {
  const clock = {
    t: 0,
    sleeps: [] as number[],
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.t += ms;
    },
  };
  return clock;
}

// ---------------------------------------------------------------------------

describe("registration", () => {
  it("registers the project and build tools with strict, described inputs and the right hints", async () => {
    const c = await connect(serve(backend()));
    const { tools } = await c.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of UNIT_B_TOOLS) expect(byName.has(name), name).toBe(true);
    expect(byName.has("delete_project")).toBe(false);

    expect(byName.get("get_page_source")!.annotations).toMatchObject(RO);
    expect(byName.get("list_builds")!.annotations).toMatchObject(RO);
    expect(byName.get("get_deploy_status")!.annotations).toMatchObject(RO);
    expect(byName.get("create_project")!.annotations).toMatchObject(WRITE);
    expect(byName.get("save_page")!.annotations).toEqual(DESTRUCTIVE);
    expect(byName.get("publish_build")!.annotations).toMatchObject(OUT);

    for (const name of UNIT_B_TOOLS) {
      const tool = byName.get(name)!;
      expect((tool.description ?? "").length, name).toBeGreaterThan(120);
      expect(tool.outputSchema, name).toBeDefined();
      const schema = tool.inputSchema as { additionalProperties?: unknown; properties?: Record<string, { description?: string }> };
      expect(schema.additionalProperties, name).toBe(false);
      for (const [prop, def] of Object.entries(schema.properties ?? {})) {
        expect(def.description, `${name}.${prop}`).toBeTruthy();
      }
    }
  });

  it("registers delete_project, marked outward-facing, only when MICROPAGE_MCP_ALLOW_DELETE is set", async () => {
    const c = await connect(serve(backend()), { MICROPAGE_MCP_ALLOW_DELETE: "1" });
    const { tools } = await c.listTools();
    const del = tools.find((t) => t.name === "delete_project");
    expect(del).toBeDefined();
    expect(del!.annotations).toMatchObject(OUT);
    expect((del!.inputSchema as { additionalProperties?: unknown }).additionalProperties).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("save_page", () => {
  const pages = [
    { name: "pricing.page", content: "[Pricing -> /pricing]\n/// section\np: b\n" },
    { name: "landing.page", content: "\n[site]\ntitle: Acme\n\n[Home -> /]\n/// hero\nh1: Hi\n" },
    { name: "about.page", content: "[About -> /about]\n/// section\np: a" },
    { name: "empty.page", content: "   " },
  ];

  it("merges landing.page first, then the rest by name, and overwrites an active draft in place", async () => {
    const b = backend({ builds: [build({ id: 30, number: 4, status: "draft" })] });
    const fake = serve(b);
    const c = await connect(fake);

    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages } });
    expect(res.isError, text(res)).toBeFalsy();

    const parse = callsTo(fake, "POST", "parse");
    expect(parse).toHaveLength(1);
    expect(parse[0]!.headers.authorization).toMatch(/^Bearer /);
    expect(parse[0]!.body).toEqual({
      text:
        "[site]\ntitle: Acme\n\n[Home -> /]\n/// hero\nh1: Hi\n\n" +
        "[About -> /about]\n/// section\np: a\n\n" +
        "[Pricing -> /pricing]\n/// section\np: b",
      project_id: 7,
      build_id: 30,
      version: "2",
    });

    const patch = callsTo(fake, "PATCH", "/rest/v1/builds");
    expect(patch).toHaveLength(1);
    const pq = new URL(patch[0]!.url).searchParams;
    expect(pq.get("id")).toBe("eq.30");
    expect(pq.get("status")).toBe("in.(draft,failed)");
    expect(Object.keys(patch[0]!.body as object).sort()).toEqual(["json_content", "raw_content"]);
    expect(callsTo(fake, "POST", "/rest/v1/builds")).toHaveLength(0);
    expect(callsTo(fake, "PATCH", "/rest/v1/projects")).toHaveLength(0);

    expect(res.structuredContent).toMatchObject({
      build: { id: 30, number: 4 },
      action: "updated_draft",
      live: false,
      preview_url: "https://app.micropage.sh/editor/7",
      next: expect.stringMatching(/never goes live until publish_build/),
    });
  });

  it("re-reads the status right before the PATCH", async () => {
    const b = backend({ builds: [build({ id: 30, number: 4, status: "draft" })] });
    const fake = serve(b);
    const c = await connect(fake);
    await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    const order = fake.calls.map((call) => `${call.method} ${path(call)} ${new URL(call.url).searchParams.get("select") ?? ""}`);
    const reread = order.indexOf("GET /rest/v1/builds id,status");
    const patch = order.findIndex((o) => o.startsWith("PATCH /rest/v1/builds"));
    expect(reread).toBeGreaterThan(order.findIndex((o) => o.startsWith("POST parse")));
    expect(patch).toBe(reread + 1);
  });

  it("overwrites a failed active build too", async () => {
    const b = backend({ builds: [build({ id: 30, number: 4, status: "failed", failure_reason: "boom" })] });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ action: "updated_draft", build: { id: 30 } });
    expect(callsTo(fake, "PATCH", "/rest/v1/builds")).toHaveLength(1);
    expect(callsTo(fake, "POST", "/rest/v1/builds")).toHaveLength(0);
  });

  it("creates a new draft with the CLI payload and makes it active when the active build is published", async () => {
    const b = backend();
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: "acme", pages: [{ name: "landing.page", content: "[site]\ntitle: A" }] } });
    expect(res.isError, text(res)).toBeFalsy();

    const insert = callsTo(fake, "POST", "/rest/v1/builds");
    expect(insert).toHaveLength(1);
    expect(insert[0]!.body).toEqual({
      project_id: 7,
      raw_content: "[site]\ntitle: A",
      status: "draft",
      parser_version: "2",
    });
    expect((callsTo(fake, "POST", "parse")[0]!.body as { build_id: unknown }).build_id).toBe(100);
    const fill = callsTo(fake, "PATCH", "/rest/v1/builds");
    expect(fill).toHaveLength(1);
    const fq = new URL(fill[0]!.url).searchParams;
    expect(fq.get("id")).toBe("eq.100");
    expect(fq.get("status")).toBe("in.(draft,failed)");
    expect(fill[0]!.body).toEqual({ json_content: { site: { title: "New" }, pages: [{ meta: {}, body: [] }] } });
    const setActive = callsTo(fake, "PATCH", "/rest/v1/projects");
    expect(setActive).toHaveLength(1);
    expect(new URL(setActive[0]!.url).searchParams.get("id")).toBe("eq.7");
    expect(setActive[0]!.body).toEqual({ active_build_id: 100 });
    expect(res.structuredContent).toMatchObject({
      action: "created_draft",
      build: { id: 100, number: 5, status: "draft" },
      previous_active_build_id: 30,
    });
  });

  it("creates the new draft before parsing, and makes it active only after its compiled content is stored", async () => {
    const fake = serve(backend());
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError, text(res)).toBeFalsy();
    const order = fake.calls.map((call) => `${call.method} ${path(call)}`);
    const insert = order.indexOf("POST /rest/v1/builds");
    const parse = order.indexOf("POST parse");
    const fill = order.indexOf("PATCH /rest/v1/builds");
    const setActive = order.indexOf("PATCH /rest/v1/projects");
    expect(insert).toBeGreaterThanOrEqual(0);
    expect(parse).toBeGreaterThan(insert);
    expect(fill).toBeGreaterThan(parse);
    expect(setActive).toBeGreaterThan(fill);
  });

  it("parses a new project's first draft with that draft's id", async () => {
    const fake = serve(backend({ activeBuildId: null, builds: [] }));
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError, text(res)).toBeFalsy();
    expect((callsTo(fake, "POST", "parse")[0]!.body as { build_id: unknown }).build_id).toBe(100);
    expect(res.structuredContent).toMatchObject({ action: "created_draft", build: { id: 100, number: 1 }, previous_active_build_id: null });
  });

  it("leaves the active build alone and names the empty draft when parsing a new draft fails", async () => {
    const b = backend({ parse: () => ({ status: 502, body: { error: "bad gateway" } }) });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/could not parse/);
    expect(text(res)).toMatch(/Draft v5 \(id:100\).*not made active/);
    expect(text(res)).not.toMatch(/Nothing was saved/);
    expect(callsTo(fake, "POST", "/rest/v1/builds")).toHaveLength(1);
    expect(callsTo(fake, "PATCH", "/rest/v1/builds")).toHaveLength(0);
    expect(callsTo(fake, "PATCH", "/rest/v1/projects")).toHaveLength(0);
    expect(b.activeBuildId).toBe(30);
  });

  it("names the empty draft, keeping the HTTP error, when storing a new draft's compiled content fails", async () => {
    const b = backend({ buildPatchStatus: 500 });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/HTTP 500\): upstream down\. Draft v5 \(id:100\).*not made active/);
    expect((callsTo(fake, "POST", "parse")[0]!.body as { build_id: unknown }).build_id).toBe(100);
    expect(callsTo(fake, "PATCH", "/rest/v1/projects")).toHaveLength(0);
    expect(b.activeBuildId).toBe(30);
  });

  it("reuses at once the empty draft its own failed save left behind, and makes it active", async () => {
    let parses = 0;
    const b = backend({
      parse: () => (++parses === 1 ? { status: 502, body: { error: "bad gateway" } } : { body: { site: { title: "New" }, pages: [] } }),
    });
    const fake = serve(b);
    const c = await connect(fake);
    const failed = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(failed.isError).toBe(true);
    expect(text(failed)).toMatch(/Draft v5 \(id:100\).*may reuse that empty draft; you can ignore it/);
    expect(b.builds.find((x) => x.id === 100)!.created_at > new Date(Date.now() - 60_000).toISOString()).toBe(true);
    expect(b.activeBuildId).toBe(30);

    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "y" }] } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(callsTo(fake, "POST", "/rest/v1/builds")).toHaveLength(1);
    expect(callsTo(fake, "POST", "parse").map((p) => (p.body as { build_id: unknown }).build_id)).toEqual([100, 100]);

    const [claim, fill] = callsTo(fake, "PATCH", "/rest/v1/builds");
    const cq = new URL(claim!.url).searchParams;
    expect(cq.get("id")).toBe("eq.100");
    expect(cq.get("project_id")).toBe("eq.7");
    expect(cq.get("status")).toBe("eq.draft");
    expect(cq.get("json_content")).toBe("is.null");
    expect(claim!.body).toEqual({ raw_content: "y", parser_version: "2" });
    const fq = new URL(fill!.url).searchParams;
    expect(fq.get("id")).toBe("eq.100");
    expect(fq.get("status")).toBe("in.(draft,failed)");
    expect(fill!.body).toEqual({ json_content: { site: { title: "New" }, pages: [] } });

    expect(b.activeBuildId).toBe(100);
    expect(b.builds.filter((x) => x.id === 100)).toMatchObject([{ raw_content: "y", json_content: { site: { title: "New" } } }]);
    expect(res.structuredContent).toMatchObject({ action: "created_draft", build: { id: 100, number: 5 }, previous_active_build_id: 30 });
  });

  it("names the reused draft when it fails again, leaving the active build alone", async () => {
    const b = backend({
      builds: [build({ id: 30, number: 4 }), build({ id: 31, number: 5, status: "draft", json_content: null })],
      parse: () => ({ status: 502, body: { error: "bad gateway" } }),
    });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Draft v5 \(id:31\).*not made active/);
    expect(callsTo(fake, "POST", "/rest/v1/builds")).toHaveLength(0);
    expect(callsTo(fake, "PATCH", "/rest/v1/projects")).toHaveLength(0);
    expect(b.activeBuildId).toBe(30);
  });

  it("looks only for uncompiled drafts newer than the active build, newest first, and inserts when there is none", async () => {
    const fake = serve(backend());
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError, text(res)).toBeFalsy();
    const lookup = fake.calls.find((call) => call.method === "GET" && path(call) === "/rest/v1/builds" && new URL(call.url).searchParams.has("json_content"));
    const lq = new URL(lookup!.url).searchParams;
    expect(lq.get("project_id")).toBe("eq.7");
    expect(lq.get("status")).toBe("eq.draft");
    expect(lq.get("json_content")).toBe("is.null");
    expect(lq.get("id")).toBe("gt.30");
    const cutoff = Date.parse(lq.get("created_at")!.replace(/^lt\./, ""));
    expect(lq.get("created_at")).toMatch(/^lt\./);
    expect(Date.now() - cutoff).toBeGreaterThanOrEqual(LEFTOVER_MIN_AGE_MS - 1000);
    expect(Date.now() - cutoff).toBeLessThan(LEFTOVER_MIN_AGE_MS + 60_000);
    expect(lq.get("order")).toBe("id.desc");
    expect(lq.get("limit")).toBe("1");
    expect(callsTo(fake, "POST", "/rest/v1/builds")).toHaveLength(1);
    expect(res.structuredContent).toMatchObject({ action: "created_draft", build: { id: 100 } });
  });

  it("does not reuse an empty draft older than the active build", async () => {
    const b = backend({ builds: [build({ id: 20, number: 3, status: "draft", json_content: null }), build({ id: 30, number: 4 })] });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(callsTo(fake, "POST", "/rest/v1/builds")).toHaveLength(1);
    expect(callsTo(fake, "PATCH", "/rest/v1/builds").map((p) => new URL(p.url).searchParams.get("id"))).toEqual(["eq.100"]);
    expect(b.builds.find((x) => x.id === 20)).toMatchObject({ raw_content: "[site]\ntitle: Old", json_content: null });
    expect(res.structuredContent).toMatchObject({ build: { id: 100 }, previous_active_build_id: 30 });
  });

  it("never takes the active build as the leftover, even an uncompiled one", async () => {
    const b = backend({ builds: [build({ id: 30, number: 4, status: "deployed", json_content: null })] });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(callsTo(fake, "PATCH", "/rest/v1/builds").map((p) => new URL(p.url).searchParams.get("id"))).toEqual(["eq.100"]);
    expect(b.builds.find((x) => x.id === 30)).toMatchObject({ raw_content: "[site]\ntitle: Old", json_content: null });
    expect(b.activeBuildId).toBe(100);
  });

  it("inserts a new draft when the leftover is filled by someone else between lookup and claim", async () => {
    const b = backend({
      builds: [build({ id: 30, number: 4 }), build({ id: 31, number: 5, status: "draft", json_content: null })],
      beforeBuildPatch: (s) => {
        const leftover = s.builds.find((x) => x.id === 31)!;
        if (leftover.json_content === null) leftover.json_content = { site: { title: "Theirs" } };
      },
    });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(callsTo(fake, "POST", "/rest/v1/builds")).toHaveLength(1);
    expect(b.builds.find((x) => x.id === 31)).toMatchObject({ raw_content: "[site]\ntitle: Old", json_content: { site: { title: "Theirs" } } });
    expect(res.structuredContent).toMatchObject({ build: { id: 100, number: 6 } });
    expect(b.activeBuildId).toBe(100);
  });

  it("skips another client's uncompiled draft younger than the age threshold, since it may still be mid-save", async () => {
    const fresh = new Date(Date.now() - 10_000).toISOString();
    const b = backend({ builds: [build({ id: 30, number: 4 }), build({ id: 31, number: 5, status: "draft", json_content: null, created_at: fresh })] });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(callsTo(fake, "POST", "/rest/v1/builds")).toHaveLength(1);
    expect(callsTo(fake, "PATCH", "/rest/v1/builds").map((p) => new URL(p.url).searchParams.get("id"))).toEqual(["eq.100"]);
    expect(b.builds.find((x) => x.id === 31)).toMatchObject({ raw_content: "[site]\ntitle: Old", json_content: null });
    expect(b.activeBuildId).toBe(100);
  });

  it("inserts a new draft when the leftover stops being a draft between lookup and claim", async () => {
    const b = backend({
      builds: [build({ id: 30, number: 4 }), build({ id: 31, number: 5, status: "draft", json_content: null })],
      beforeBuildPatch: (s) => {
        const leftover = s.builds.find((x) => x.id === 31)!;
        if (leftover.status === "draft") leftover.status = "publishing";
      },
    });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError, text(res)).toBeFalsy();
    const claim = callsTo(fake, "PATCH", "/rest/v1/builds")[0]!;
    expect(new URL(claim.url).searchParams.get("id")).toBe("eq.31");
    expect(callsTo(fake, "POST", "/rest/v1/builds")).toHaveLength(1);
    expect(b.builds.find((x) => x.id === 31)).toMatchObject({ raw_content: "[site]\ntitle: Old", status: "publishing" });
    expect(res.structuredContent).toMatchObject({ build: { id: 100 } });
    expect(b.activeBuildId).toBe(100);
  });

  it("with no active build, reuses an old enough uncompiled draft without an id bound", async () => {
    const b = backend({ activeBuildId: null, builds: [build({ id: 31, number: 1, status: "draft", json_content: null })] });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError, text(res)).toBeFalsy();
    const lookup = fake.calls.find((call) => call.method === "GET" && path(call) === "/rest/v1/builds" && new URL(call.url).searchParams.has("json_content"));
    const lq = new URL(lookup!.url).searchParams;
    expect(lq.has("id")).toBe(false);
    expect(lq.get("created_at")).toMatch(/^lt\./);
    const claim = callsTo(fake, "PATCH", "/rest/v1/builds")[0]!;
    expect(new URL(claim.url).searchParams.get("id")).toBe("eq.31");
    expect(callsTo(fake, "POST", "/rest/v1/builds")).toHaveLength(0);
    expect(b.activeBuildId).toBe(31);
    expect(res.structuredContent).toMatchObject({ action: "created_draft", build: { id: 31 }, previous_active_build_id: null });
  });

  it("writes nothing when parsing fails while overwriting the active draft", async () => {
    const fake = serve(backend({ builds: [build({ id: 30, number: 4, status: "draft" })], parse: () => ({ status: 502, body: { error: "bad gateway" } }) }));
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Nothing was saved/);
    expect(writes(fake)).toHaveLength(0);
  });

  it("refuses, without writing the build, when the draft started publishing between read and PATCH", async () => {
    const b = backend({ builds: [build({ id: 30, number: 4, status: "draft" })], rereadStatus: "publishing" });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/publishing.*Nothing was saved/);
    expect(callsTo(fake, "PATCH", "/rest/v1/builds")).toHaveLength(0);
    expect(callsTo(fake, "POST", "/rest/v1/builds")).toHaveLength(0);
    expect(callsTo(fake, "PATCH", "/rest/v1/projects")).toHaveLength(0);
  });

  it("injects llms_txt into site, and keeps the current one when omitted", async () => {
    const b = backend({ builds: [build({ id: 30, number: 4, status: "draft", llms_txt: "old llms" })] });
    const fake = serve(b);
    const c = await connect(fake);

    await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }], llms_txt: "# Acme\n" } });
    let body = callsTo(fake, "PATCH", "/rest/v1/builds").at(-1)!.body as { json_content: { site: Record<string, unknown> } };
    expect(body.json_content.site).toEqual({ title: "New", llms_txt: "# Acme" });

    await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "x" }] } });
    body = callsTo(fake, "PATCH", "/rest/v1/builds").at(-1)!.body as { json_content: { site: Record<string, unknown> } };
    expect(body.json_content.site.llms_txt).toBe("old llms");
  });

  it("reports compiler issues", async () => {
    const b = backend({
      builds: [build({ id: 30, number: 4, status: "draft" })],
      parse: () => ({ body: { site: {}, pages: [{ body: [{ elements: [{ type: "img", error: "File not found: hero.png" }] }] }] } }),
    });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: [{ name: "landing.page", content: "img: <- hero.png" }] } });
    expect(res.structuredContent).toMatchObject({ issues: ["File not found: hero.png"] });
  });

  it("rejects bad page names and duplicates before any network call", async () => {
    const fake = serve(backend());
    const c = await connect(fake);
    for (const bad of [
      [{ name: "landing.txt", content: "x" }],
      [{ name: "../x.page", content: "x" }],
      [{ name: "a.page", content: "x" }, { name: "a.page", content: "y" }],
      [{ name: "landing.page", content: "  " }],
    ]) {
      const res = await c.callTool({ name: "save_page", arguments: { project: UUID, pages: bad } });
      expect(res.isError, JSON.stringify(bad)).toBe(true);
    }
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("publish_build", () => {
  it("does nothing at all without confirm: true", async () => {
    const fake = serve(backend());
    const c = await connect(fake);
    for (const args of [{ project: UUID }, { project: UUID, confirm: false }]) {
      const res = await c.callTool({ name: "publish_build", arguments: args });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/confirm: true/);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses while another build of the project is publishing", async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 30, number: 4, status: "publishing", updated_at: recent }), build({ id: 31, number: 5, status: "draft" })],
    });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "publish_build", arguments: { project: UUID, confirm: true } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/v4.*still publishing/);
    expect(writes(fake)).toHaveLength(0);
  });

  it("ignores a publishing build stuck for over half an hour", async () => {
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 30, number: 4, status: "publishing", updated_at: "2026-01-01T00:00:00Z" }), build({ id: 31, number: 5, status: "draft" })],
    });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "publish_build", arguments: { project: UUID, confirm: true } });
    expect(res.isError, text(res)).toBeFalsy();
  });

  it("publishes the active build, capturing the event cursor before invoking publish-build", async () => {
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 30, number: 4 }), build({ id: 31, number: 5, status: "draft" })],
      events: [
        { id: 40, build_id: 31, event_type: "build.enqueued", payload: null, created_at: "" },
        { id: 41, build_id: 31, event_type: "deployment.completed", payload: null, created_at: "" },
        { id: 99, build_id: 30, event_type: "deployment.completed", payload: null, created_at: "" },
      ],
    });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "publish_build", arguments: { project: UUID, confirm: true } });
    expect(res.isError, text(res)).toBeFalsy();

    const cursorCall = fake.calls.findIndex((x) => path(x) === "/rest/v1/build_deploy_events");
    const publishCall = fake.calls.findIndex((x) => path(x) === "/functions/v1/publish-build");
    expect(cursorCall).toBeGreaterThan(-1);
    expect(cursorCall).toBeLessThan(publishCall);
    const cq = new URL(fake.calls[cursorCall]!.url).searchParams;
    expect(cq.get("build_id")).toBe("eq.31");
    expect(cq.get("order")).toBe("id.desc");
    expect(fake.calls[publishCall]!.body).toEqual({ buildId: 31, projectId: 7 });
    expect(callsTo(fake, "PATCH", "/rest/v1/projects")).toHaveLength(0);

    expect(res.structuredContent).toMatchObject({
      build: { id: 31, number: 5, previous_status: "draft" },
      status: "publishing",
      active_build_changed: false,
      after_event_id: 41,
      plan_tier: "pro",
      eta_seconds: 195,
      eta: expect.stringMatching(/3 minutes[\s\S]*live within seconds/),
      live_url: "https://acme.micropage.sh",
      next: expect.stringMatching(/get_deploy_status/),
    });
  });

  it("redeploys an older build by number, setting it active first", async () => {
    const b = backend({
      tier: "pro_plus",
      activeBuildId: 31,
      builds: [build({ id: 30, number: 4 }), build({ id: 31, number: 5 })],
    });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "publish_build", arguments: { project: UUID, build: "v4", confirm: true } });
    expect(res.isError, text(res)).toBeFalsy();

    const setActive = fake.calls.findIndex((x) => x.method === "PATCH" && path(x) === "/rest/v1/projects");
    const publish = fake.calls.findIndex((x) => path(x) === "/functions/v1/publish-build");
    expect(setActive).toBeGreaterThan(-1);
    expect(setActive).toBeLessThan(publish);
    expect(fake.calls[setActive]!.body).toEqual({ active_build_id: 30 });
    expect(fake.calls[publish]!.body).toEqual({ buildId: 30, projectId: 7 });
    expect(res.structuredContent).toMatchObject({
      build: { id: 30, number: 4 },
      active_build_changed: true,
      previous_active_build_id: 31,
      after_event_id: 0,
      eta_seconds: 15,
      eta: expect.stringMatching(/Pro\+[\s\S]*about 10 seconds/),
    });
  });

  it("accepts a build id from save_page", async () => {
    const b = backend({ activeBuildId: 30, builds: [build({ id: 30, number: 4 }), build({ id: 31, number: 5, status: "draft" })] });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "publish_build", arguments: { project: UUID, build: "id:31", confirm: true } });
    expect(res.structuredContent).toMatchObject({ build: { id: 31 }, active_build_changed: true });
  });
});

// ---------------------------------------------------------------------------

describe("get_deploy_status", () => {
  it("polls until deployment.completed and reports the new events and cursor", async () => {
    const clock = fakeClock();
    buildToolsClock.current = clock;
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 31, number: 5, status: "publishing" })],
      events: [{ id: 41, build_id: 31, event_type: "deployment.completed", payload: null, created_at: "old" }],
      onStatusPoll: (state, i) => {
        if (i === 0) {
          state.events.push({ id: 42, build_id: 31, event_type: "build.enqueued", payload: null, created_at: "t0" });
        }
        if (i === 2) {
          state.builds[0]!.status = "deployed";
          state.events.push(
            { id: 43, build_id: 31, event_type: "deployment.domain_wiring", payload: { step: "active", hostname: "acme.micropage.sh" }, created_at: "t1" },
            { id: 44, build_id: 31, event_type: "deployment.completed", payload: null, created_at: "t2" },
          );
        }
      },
    });
    const c = await connect(serve(b));
    const res = await c.callTool({
      name: "get_deploy_status",
      arguments: { project: UUID, build: "id:31", after_event_id: 41, wait_seconds: 30 },
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      build: { id: 31, status: "deployed" },
      done: true,
      succeeded: true,
      after_event_id: 44,
      events: [
        { id: 42, type: "build.enqueued" },
        { id: 43, message: "deployment.domain_wiring: live — https://acme.micropage.sh" },
        { id: 44, type: "deployment.completed" },
      ],
      live_url: "https://acme.micropage.sh",
      next: expect.stringMatching(/edge caches refresh.*308.*curl -L/),
    });
    expect(clock.sleeps).toEqual([2000, 2000]);
  });

  it("stops on build.failed and reports the failure reason", async () => {
    buildToolsClock.current = fakeClock();
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 31, number: 5, status: "publishing" })],
      onStatusPoll: (state) => {
        state.events.push({ id: 50, build_id: 31, event_type: "build.failed", payload: { step: "wrangler_deploy" }, created_at: "t" });
      },
    });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID, after_event_id: 0 } });
    expect(res.structuredContent).toMatchObject({ done: true, succeeded: false, events: [{ type: "build.failed" }] });
  });

  it("times out with done false and a cursor to resume from", async () => {
    const clock = fakeClock();
    buildToolsClock.current = clock;
    const now = new Date().toISOString();
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 31, number: 5, status: "publishing", updated_at: now })],
      events: [{ id: 42, build_id: 31, event_type: "build.enqueued", payload: null, created_at: now }],
    });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID, after_event_id: 41, wait_seconds: 5 } });
    expect(res.structuredContent).toMatchObject({
      done: false,
      succeeded: null,
      after_event_id: 42,
      events: [{ id: 42 }],
      next: expect.stringMatching(/after_event_id 42/),
    });
    expect(clock.sleeps).toEqual([2000, 2000]);
    expect(b.statusPolls).toBe(3);
    expect(res.structuredContent).toMatchObject({ waiting_for_start: false, possibly_stuck: false });
  });

  it("without a cursor, an old deployment.completed does not end a running publish", async () => {
    buildToolsClock.current = fakeClock();
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 31, number: 5, status: "publishing" })],
      events: [{ id: 41, build_id: 31, event_type: "deployment.completed", payload: null, created_at: "old" }],
    });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID, wait_seconds: 0 } });
    expect(res.structuredContent).toMatchObject({ done: false, after_event_id: 41 });
  });

  it("is done at once for a build that is not publishing", async () => {
    const b = backend({ activeBuildId: 31, builds: [build({ id: 31, number: 5, status: "draft" })] });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID } });
    expect(res.structuredContent).toMatchObject({ done: true, succeeded: null, next: expect.stringMatching(/publish_build/) });
    expect(b.statusPolls).toBe(1);
  });
});

describe("get_deploy_status after a post change (publish_post's build_id + after_event_id)", () => {
  // A post rebuild never sets the build to publishing: it stays as it was until
  // the queued job writes deployed/failed and the deploy events.
  it("follows a rebuild of a deployed build: waiting first, done only on the new deployment.completed", async () => {
    const clock = fakeClock();
    buildToolsClock.current = clock;
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 31, number: 5, status: "deployed" })],
      events: [{ id: 41, build_id: 31, event_type: "deployment.completed", payload: null, created_at: "old" }],
    });
    const c = await connect(serve(b));

    const first = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID, build: "id:31", after_event_id: 41, wait_seconds: 4 } });
    expect(first.isError, text(first)).toBeFalsy();
    expect(first.structuredContent).toMatchObject({
      done: false,
      succeeded: null,
      waiting_for_start: true,
      after_event_id: 41,
      next: expect.stringMatching(/Waiting for the rebuild to start[\s\S]*3 minutes[\s\S]*Pro\+[\s\S]*after_event_id 41/),
    });
    expect((first.structuredContent as { next: string }).next).not.toMatch(/publish_build/);

    // Polls 0-1 were the first call; the rebuild starts during the second.
    b.onStatusPoll = (state, i) => {
      if (i === 3) state.events.push({ id: 42, build_id: 31, event_type: "build.enqueued", payload: null, created_at: "t1" });
      if (i === 5) state.events.push({ id: 43, build_id: 31, event_type: "deployment.completed", payload: null, created_at: "t2" });
    };
    const second = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID, build: "id:31", after_event_id: 41, wait_seconds: 20 } });
    expect(second.structuredContent).toMatchObject({
      done: true,
      succeeded: true,
      waiting_for_start: false,
      after_event_id: 43,
      events: [{ id: 42 }, { id: 43, type: "deployment.completed" }],
    });
  });

  it("never reports a draft active build as done, nor tells the model to call publish_build", async () => {
    buildToolsClock.current = fakeClock();
    const b = backend({ activeBuildId: 31, builds: [build({ id: 31, number: 5, status: "draft" })] });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID, after_event_id: 0, wait_seconds: 6 } });
    expect(res.structuredContent).toMatchObject({ done: false, succeeded: null, waiting_for_start: true });
    expect((res.structuredContent as { next: string }).next).not.toMatch(/publish_build/);
    expect(text(res)).toMatch(/waiting for the rebuild to start/);
  });

  it("ignores archive events while waiting for a publish", async () => {
    buildToolsClock.current = fakeClock();
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 31, number: 5, status: "deployed" })],
      onStatusPoll: (state, i) => {
        if (i === 0) state.events.push({ id: 50, build_id: 31, event_type: "archive.completed", payload: null, created_at: "t" });
      },
    });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID, after_event_id: 49, wait_seconds: 4 } });
    expect(res.structuredContent).toMatchObject({ done: false, succeeded: null, waiting_for_start: true, events: [{ id: 50, type: "archive.completed" }] });
  });

  it("without a cursor still reports a settled build at once and offers publish_build", async () => {
    const b = backend({ activeBuildId: 31, builds: [build({ id: 31, number: 5, status: "deployed" })] });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID } });
    expect(res.structuredContent).toMatchObject({ done: true, succeeded: true, waiting_for_start: false });
  });
});

describe("get_deploy_status: stuck publishes and the wait cap", () => {
  it("flags a build publishing with no events for longer than the queue delay plus 5 minutes", async () => {
    buildToolsClock.current = fakeClock();
    const old = new Date(Date.now() - 9 * 60_000).toISOString();
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 31, number: 5, status: "publishing", updated_at: old })],
      events: [{ id: 41, build_id: 31, event_type: "deployment.completed", payload: null, created_at: old }],
    });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID, after_event_id: 41, wait_seconds: 0 } });
    expect(res.structuredContent).toMatchObject({
      done: false,
      possibly_stuck: true,
      next: expect.stringMatching(/possibly stuck[\s\S]*webhook may have failed[\s\S]*publish_build[\s\S]*30 minutes/),
    });
  });

  it("does not flag a free/pro publish still inside the queue delay plus grace", async () => {
    buildToolsClock.current = fakeClock();
    const recent = new Date(Date.now() - 6 * 60_000).toISOString();
    const b = backend({ activeBuildId: 31, builds: [build({ id: 31, number: 5, status: "publishing", updated_at: recent })] });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID, after_event_id: 0, wait_seconds: 0 } });
    expect(res.structuredContent).toMatchObject({ done: false, possibly_stuck: false, next: expect.stringMatching(/Still publishing/) });
  });

  it("uses a shorter threshold on Pro+, which has no queue delay", async () => {
    buildToolsClock.current = fakeClock();
    const recent = new Date(Date.now() - 6 * 60_000).toISOString();
    const b = backend({ tier: "pro_plus", activeBuildId: 31, builds: [build({ id: 31, number: 5, status: "publishing", updated_at: recent })] });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID, after_event_id: 0, wait_seconds: 0 } });
    expect(res.structuredContent).toMatchObject({ possibly_stuck: true });
  });

  it("caps wait_seconds at 45 and stays inside it", async () => {
    const clock = fakeClock();
    buildToolsClock.current = clock;
    const b = backend({ activeBuildId: 31, builds: [build({ id: 31, number: 5, status: "publishing", updated_at: new Date().toISOString() })] });
    const c = await connect(serve(b));
    const over = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID, after_event_id: 0, wait_seconds: 46 } });
    expect(over.isError).toBe(true);
    const res = await c.callTool({ name: "get_deploy_status", arguments: { project: UUID, after_event_id: 0, wait_seconds: 45 } });
    expect(res.structuredContent).toMatchObject({ done: false });
    expect(clock.t).toBeLessThan(45_000);
    // Polls every 2 s and skips a sleep that would leave no time for the poll after it.
    expect(clock.sleeps.reduce((a, x) => a + x, 0)).toBe(44_000);
  });
});

describe("publish_build rollback", () => {
  it("restores the previous active build when publish-build fails after switching it", async () => {
    const b = backend({ activeBuildId: 31, builds: [build({ id: 30, number: 4 }), build({ id: 31, number: 5 })], publishStatus: 500 });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "publish_build", arguments: { project: UUID, build: "v4", confirm: true } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/publisher webhook failed[\s\S]*restored to id 31/);
    expect(callsTo(fake, "PATCH", "/rest/v1/projects").map((x) => x.body)).toEqual([{ active_build_id: 30 }, { active_build_id: 31 }]);
    expect(b.activeBuildId).toBe(31);
  });

  it("says so when the restore fails too", async () => {
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 30, number: 4 }), build({ id: 31, number: 5 })],
      publishStatus: 500,
      restoreStatus: 500,
    });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "publish_build", arguments: { project: UUID, build: "v4", confirm: true } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Restoring the previous active build \(id 31\) also failed[\s\S]*list_builds/);
  });

  it("reports a reverted 502 as rejected, with the build's status, and restores the active build", async () => {
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 30, number: 4 }), build({ id: 31, number: 5 })],
      publishStatus: 502,
      publishBody: { error: "Publisher webhook failed", reverted: true, status_unknown: false },
    });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "publish_build", arguments: { project: UUID, build: "v4", confirm: true } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(
      /"text":"The publisher rejected the publish; build v4 is back to deployed\. Nothing went live\. Retry with publish_build\.[\s\S]*restored to id 31/,
    );
    expect(text(res)).not.toMatch(/get_deploy_status/);
    expect(callsTo(fake, "PATCH", "/rest/v1/projects").map((x) => x.body)).toEqual([{ active_build_id: 30 }, { active_build_id: 31 }]);
    expect(b.activeBuildId).toBe(31);
  });

  it("reports a reverted 502 even when the active build was not changed", async () => {
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 31, number: 5, status: "draft" })],
      publishStatus: 502,
      publishBody: { error: "Publisher webhook failed", reverted: true, status_unknown: false },
    });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "publish_build", arguments: { project: UUID, confirm: true } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/build v5 is back to draft\. Nothing went live\. Retry with publish_build/);
    expect(callsTo(fake, "PATCH", "/rest/v1/projects")).toHaveLength(0);
  });

  it("on a status_unknown 502 points at get_deploy_status and leaves the active build on the published one", async () => {
    const b = backend({
      activeBuildId: 31,
      builds: [build({ id: 30, number: 4 }), build({ id: 31, number: 5 })],
      publishStatus: 502,
      publishBody: { error: "Publisher webhook timed out", reverted: false, status_unknown: true },
    });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "publish_build", arguments: { project: UUID, build: "v4", confirm: true } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(
      /"text":"The publish may have been queued\. Call get_deploy_status with build \W+id:30\W+ before retrying, to avoid a double publish\./,
    );
    expect(text(res)).toMatch(/left at id 30 rather than restored to id 31, because the publish may be running for that build/);
    expect(text(res)).not.toMatch(/Nothing was published|Nothing went live/);
    expect(callsTo(fake, "PATCH", "/rest/v1/projects").map((x) => x.body)).toEqual([{ active_build_id: 30 }]);
    expect(b.activeBuildId).toBe(30);
  });

  it("treats a plain 500 as before: restores the active build and says nothing was published", async () => {
    const b = backend({ activeBuildId: 31, builds: [build({ id: 30, number: 4 }), build({ id: 31, number: 5 })], publishStatus: 500 });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "publish_build", arguments: { project: UUID, build: "v4", confirm: true } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Starting the publish failed: .*HTTP 500.*publisher webhook failed[\s\S]*restored to id 31, as before\. Nothing was published\./);
    expect(text(res)).not.toMatch(/rejected|get_deploy_status/);
    expect(b.activeBuildId).toBe(31);
  });

  it("does not touch the active build when it was not changed", async () => {
    const b = backend({ activeBuildId: 31, builds: [build({ id: 31, number: 5, status: "draft" })], publishStatus: 500 });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "publish_build", arguments: { project: UUID, confirm: true } });
    expect(res.isError).toBe(true);
    expect(callsTo(fake, "PATCH", "/rest/v1/projects")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("list_builds, get_page_source, create_project", () => {
  it("lists builds newest first with the active marker", async () => {
    const b = backend({ activeBuildId: 30, builds: [build({ id: 30, number: 4 }), build({ id: 31, number: 5, status: "failed", failure_reason: "x" })] });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "list_builds", arguments: { project: UUID, limit: 5 } });
    expect(res.structuredContent).toMatchObject({
      active_build_id: 30,
      count: 2,
      builds: [
        { id: 31, number: 5, status: "failed", failure_reason: "x", active: false },
        { id: 30, number: 4, active: true },
      ],
    });
    expect(new URL(callsTo(fake, "GET", "/rest/v1/builds")[0]!.url).searchParams.get("limit")).toBe("5");
  });

  it("returns the active build's source, llms.txt and asset names", async () => {
    const b = backend({ builds: [build({ id: 30, number: 4, raw_content: "[site]\ntitle: Acme", llms_txt: "# Acme" })] });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "get_page_source", arguments: { project: UUID } });
    expect(res.structuredContent).toMatchObject({
      build: { id: 30, number: 4, is_active: true },
      source: "[site]\ntitle: Acme",
      llms_txt: "# Acme",
      assets: ["hero.png", "logo.svg"],
    });
  });

  it("reads a given build number", async () => {
    const b = backend({ builds: [build({ id: 30, number: 4 }), build({ id: 29, number: 3, raw_content: "old" })] });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "get_page_source", arguments: { project: UUID, version: "v3" } });
    expect(res.structuredContent).toMatchObject({ build: { id: 29, number: 3, is_active: false }, source: "old" });
  });

  it("creates a project as the CLI does and returns a starter page", async () => {
    const fake = serve(backend());
    const c = await connect(fake);
    const res = await c.callTool({ name: "create_project", arguments: { name: "New site", domain: "New-Site.micropage.sh" } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(callsTo(fake, "POST", "/rest/v1/projects")[0]!.body).toEqual({ name: "New site", domain: "new-site" });
    expect(res.structuredContent).toMatchObject({
      project: { id: 9, domain: "new-site", live_url: "https://new-site.micropage.sh" },
      starter: { example: "startup-landing", source: expect.stringContaining("[site]"), referenced_files: ["favicon.svg", "logo.svg"] },
    });
  });

  it("rejects an invalid domain before any network call", async () => {
    const fake = serve(backend());
    const c = await connect(fake);
    const res = await c.callTool({ name: "create_project", arguments: { name: "x", domain: "-bad_" } });
    expect(res.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe("delete_project", () => {
  const ENV = { MICROPAGE_MCP_ALLOW_DELETE: "1" };

  it("is not callable without the env flag", async () => {
    const fake = serve(backend());
    const c = await connect(fake);
    await expect(
      c.callTool({ name: "delete_project", arguments: { project: UUID, confirm_domain: "acme" } }),
    ).rejects.toThrow(/delete_project not found/);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a wrong or missing confirm_domain without deleting", async () => {
    const fake = serve(backend());
    const c = await connect(fake, ENV);
    for (const confirm_domain of ["acme2", undefined]) {
      const res = await c.callTool({ name: "delete_project", arguments: { project: UUID, ...(confirm_domain ? { confirm_domain } : {}) } });
      expect(res.isError).toBe(true);
      expect(text(res)).toMatch(/confirm_domain.*acme/);
    }
    expect(writes(fake)).toHaveLength(0);
  });

  it("aborts when the user declines the elicitation", async () => {
    const fake = serve(backend());
    const c = await connect(fake, ENV, { elicit: "decline" });
    const res = await c.callTool({ name: "delete_project", arguments: { project: UUID, confirm_domain: "acme.micropage.sh" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/declined/);
    expect(elicited).toHaveLength(1);
    expect(elicited[0]).toMatch(/Permanently delete.*Acme/);
    expect(writes(fake)).toHaveLength(0);
  });

  it("deletes through the delete-project function after the user accepts", async () => {
    const fake = serve(backend());
    const c = await connect(fake, ENV, { elicit: "accept" });
    const res = await c.callTool({ name: "delete_project", arguments: { project: UUID, confirm_domain: "ACME" } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(callsTo(fake, "POST", "/functions/v1/delete-project").map((x) => x.body)).toEqual([{ projectId: 7 }]);
    expect(res.structuredContent).toMatchObject({ deleted: true, already_removed: false, project_id: 7 });
  });

  it("proceeds on confirm_domain alone when the client cannot elicit, and treats 404 as already removed", async () => {
    const fake = serve(backend({ deleteStatus: 404 }));
    const c = await connect(fake, ENV);
    const res = await c.callTool({ name: "delete_project", arguments: { project: UUID, confirm_domain: "acme" } });
    expect(res.structuredContent).toMatchObject({ deleted: true, already_removed: true });
  });

  it("reports delete-project's 403 (missing or not yours) as an error, not as already removed", async () => {
    const fake = serve(backend({ deleteStatus: 403 }));
    const c = await connect(fake, ENV);
    const res = await c.callTool({ name: "delete_project", arguments: { project: UUID, confirm_domain: "acme" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/refused to delete[\s\S]*403[\s\S]*get_project/);
  });
});
