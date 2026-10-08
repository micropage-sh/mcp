import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DESTRUCTIVE, OUT, RO } from "../src/annotations.js";
import { postContentFingerprint, postMatchesPayload, type PostRow, type UpsertPostPayload } from "../src/client/posts.js";
import { createDeps } from "../src/node/deps.js";
import { createServer } from "../src/server.js";
import { createFakeFetch, type FakeFetch, type RecordedCall } from "./helpers/fake-fetch.js";
import { tempConfig, tokenFor, type TempConfig } from "./helpers/session.js";

const UUID = "11111111-2222-3333-4444-555555555555";
const FORM_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const POST_TOOLS = ["list_posts", "upsert_post", "preview_post_send", "publish_post", "unpublish_post", "delete_post"];
const MUTATING = ["upsert-post", "publish-post", "unpublish-post", "delete-post"];

let cfg: TempConfig;
let client: Client | undefined;

/** Messages the server put in front of the user through elicitation. */
let elicited: string[] = [];

beforeEach(async () => {
  elicited = [];
  cfg = await tempConfig();
  await cfg.write({ access_token: tokenFor("user-1", 3600), refresh_token: "r1", user: { id: "user-1" } });
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  await cfg.cleanup();
});

// ---------------------------------------------------------------------------
// A tiny stateful stand-in for PostgREST + the edge functions, routed by path.
// ---------------------------------------------------------------------------

function post(overrides: Partial<PostRow> = {}): PostRow {
  return {
    id: "post-1",
    slug: "hello",
    title: "Hello",
    description: null,
    body_markdown: "Body",
    web_visibility: "listed",
    email_enabled: false,
    form_id: null,
    hero_image: null,
    subject: "Hello",
    preheader: null,
    status: "queued",
    published_at: null,
    created_at: "2026-10-01T00:00:00Z",
    recipient_count: 0,
    sent_count: 0,
    ...overrides,
  };
}

interface Backend {
  posts: PostRow[];
  forms: Array<{ id: string; form_name: string; is_newsletter: boolean }>;
  subscribers: number;
  activeBuildId: number | null;
  activeBuildStatus: string;
  /** rebuild_build_id the post functions answer with; undefined leaves it out, like servers before it existed. */
  rebuildBuildId?: number | null;
  files: Array<{ id: string; filename: string }>;
  upsert: (call: RecordedCall) => { status?: number; body: unknown };
}

function backend(overrides: Partial<Backend> = {}): Backend {
  return {
    posts: [],
    forms: [{ id: FORM_ID, form_name: "Newsletter", is_newsletter: true }],
    subscribers: 0,
    activeBuildId: 30,
    activeBuildStatus: "deployed",
    files: [],
    upsert: () => ({ body: { post_id: "post-new", action: "created", published: false } }),
    ...overrides,
  };
}

function rebuildField(b: Backend): { rebuild_build_id?: number | null } {
  return b.rebuildBuildId === undefined ? {} : { rebuild_build_id: b.rebuildBuildId };
}

function serve(b: Backend): FakeFetch {
  const fake = createFakeFetch();
  const responder = (call: RecordedCall) => {
    const url = new URL(call.url);
    const q = url.searchParams;
    switch (url.pathname) {
      case "/rest/v1/customers":
        return { body: [{ plan_tier: "pro" }] };
      case "/rest/v1/projects":
        return {
          body: [
            { id: 7, uuid: UUID, name: "Acme", domain: "acme", custom_domain: null, active_build_id: b.activeBuildId, status: "active", created_at: null },
          ],
        };
      case "/rest/v1/posts": {
        const slug = q.get("slug")?.replace(/^eq\./, "");
        const rows = slug ? b.posts.filter((p) => p.slug === slug) : b.posts;
        return { body: rows.slice(0, Number(q.get("limit") ?? 1000)) };
      }
      case "/rest/v1/forms": {
        const ids = q.get("id")?.match(/^in\.\((.*)\)$/)?.[1]?.split(",");
        return { body: ids ? b.forms.filter((f) => ids.includes(f.id)) : b.forms.filter((f) => f.is_newsletter) };
      }
      case "/rest/v1/newsletter_subscribers":
        // An exact count: HEAD with Prefer: count=exact, read from Content-Range.
        return { headers: { "content-range": `*/${b.subscribers}` } };
      case "/rest/v1/builds":
        return { body: [{ number: 6, status: b.activeBuildStatus }] };
      case "/rest/v1/build_deploy_events":
        return { body: [{ id: 77 }] };
      case "/functions/v1/list-files":
        return { body: { files: b.files } };
      case "/functions/v1/get-file-url":
        return { body: { url: `https://files.micropage.sh/projects/7/${q.get("file_id")}.png` } };
      case "/functions/v1/upsert-post":
        return b.upsert(call);
      case "/functions/v1/publish-post": {
        const p = b.posts.find((x) => x.slug === (call.body as { slug: string }).slug)!;
        const emailed = p.email_enabled === true && p.form_id !== null;
        p.published_at ??= "2026-10-04T12:00:00Z";
        return { body: { post_id: p.id, published_at: p.published_at, emailed, recipient_count: emailed ? b.subscribers : 0, ...rebuildField(b) } };
      }
      case "/functions/v1/unpublish-post":
        return { body: { post_id: "post-1", unpublished: true, ...rebuildField(b) } };
      case "/functions/v1/delete-post":
        return { body: { deleted: true, slug: (call.body as { slug: string }).slug, ...rebuildField(b) } };
      default:
        throw new Error(`unexpected ${call.method} ${call.url}`);
    }
  };
  for (let i = 0; i < 200; i++) fake.push(responder);
  return fake;
}

const fnName = (c: RecordedCall) => new URL(c.url).pathname.replace(/^\/functions\/v1\//, "");
const mutatingCalls = (fake: FakeFetch) => fake.calls.filter((c) => MUTATING.includes(fnName(c)));
const callsTo = (fake: FakeFetch, name: string) => fake.calls.filter((c) => fnName(c) === name);

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

// ---------------------------------------------------------------------------

describe("registration", () => {
  it("registers every post tool with strict, described inputs, an output schema and the right hints", async () => {
    const c = await connect(serve(backend()));
    const { tools } = await c.listTools();
    const ours = tools.filter((t) => POST_TOOLS.includes(t.name));
    expect(ours.map((t) => t.name).sort()).toEqual([...POST_TOOLS].sort());

    const expected: Record<string, object> = {
      list_posts: RO,
      preview_post_send: RO,
      upsert_post: DESTRUCTIVE,
      publish_post: OUT,
      unpublish_post: OUT,
      delete_post: { ...OUT, idempotentHint: true },
    };
    for (const tool of ours) {
      expect(tool.annotations, tool.name).toEqual(expected[tool.name]);
      expect((tool.description ?? "").length).toBeGreaterThan(120);
      expect(tool.outputSchema).toBeDefined();
      const schema = tool.inputSchema as { additionalProperties?: unknown; properties?: Record<string, { description?: string }> };
      expect(schema.additionalProperties).toBe(false);
      for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        expect(prop.description, `${tool.name}.${name}`).toBeTruthy();
      }
    }
  });
});

describe("list_posts", () => {
  it("lists posts with list names and hides the send status of web-only posts", async () => {
    const b = backend({
      posts: [
        post({ id: "p2", slug: "news", email_enabled: true, form_id: FORM_ID, status: "sent", published_at: "2026-10-02T00:00:00Z" }),
        post(),
      ],
    });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({ name: "list_posts", arguments: { project: "acme" } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      count: 2,
      posts: [
        { slug: "news", email: true, list: "Newsletter", published: true, send_status: "sent" },
        { slug: "hello", email: false, list: null, published: false, send_status: null },
      ],
    });
  });

  it("returns one post in full under upsert_post's field names", async () => {
    const b = backend({ posts: [post({ description: "D", hero_image: "https://x/h.png", preheader: "P" })] });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "list_posts", arguments: { project: "acme", slug: "Hello" } });
    expect(res.structuredContent).toMatchObject({
      post: { slug: "hello", title: "Hello", body_markdown: "Body", description: "D", hero: "https://x/h.png", preview: "P", visibility: "listed" },
    });
  });
});

describe("upsert_post", () => {
  it("sends the CLI's posts push payload, resolving list -> form_id and a hero filename -> URL", async () => {
    const b = backend({ files: [{ id: "file-9", filename: "launch.png" }] });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({
      name: "upsert_post",
      arguments: {
        project: "acme",
        title: "Launching our new dashboard",
        body_markdown: "Hi ![shot](https://cdn.example/s.png)",
        description: "What's new",
        hero: "launch.png",
        email: true,
        list: "newsletter",
        preview: "See it",
      },
    });
    expect(res.isError, text(res)).toBeFalsy();

    const [call] = callsTo(fake, "upsert-post");
    expect(call!.method).toBe("POST");
    expect(call!.body).toEqual({
      project_id: 7,
      title: "Launching our new dashboard",
      slug: "launching-our-new-dashboard",
      body_markdown: "Hi ![shot](https://cdn.example/s.png)",
      description: "What's new",
      web_visibility: "listed",
      hero_image: "https://files.micropage.sh/projects/7/file-9.png",
      form_id: FORM_ID,
      subject: null,
      preheader: "See it",
    });
    expect(new URL(callsTo(fake, "list-files")[0]!.url).searchParams.get("project_id")).toBe("7");
    expect(res.structuredContent).toMatchObject({ action: "created", published: false, email: true, list: "newsletter", warnings: [expect.stringMatching(/draft/)] });
  });

  it("passes an https hero through and warns about unhosted body images", async () => {
    const fake = serve(backend());
    const c = await connect(fake);
    const res = await c.callTool({
      name: "upsert_post",
      arguments: { project: "acme", title: "T", slug: "My Post", body_markdown: "![a](local.png)", hero: "https://img.example/h.jpg" },
    });
    expect(callsTo(fake, "list-files")).toHaveLength(0);
    expect(callsTo(fake, "upsert-post")[0]!.body).toMatchObject({ slug: "my-post", hero_image: "https://img.example/h.jpg", form_id: null });
    expect(JSON.stringify(res.structuredContent)).toMatch(/local\.png/);
  });

  it("refuses an unknown hero filename and an unknown list without saving", async () => {
    const fake = serve(backend());
    const c = await connect(fake);
    const hero = await c.callTool({ name: "upsert_post", arguments: { project: "acme", title: "T", body_markdown: "b", hero: "nope.png" } });
    expect(hero.isError).toBe(true);
    expect(text(hero)).toMatch(/upload_asset/);
    const list = await c.callTool({ name: "upsert_post", arguments: { project: "acme", title: "T", body_markdown: "b", email: true, list: "Other" } });
    expect(list.isError).toBe(true);
    expect(text(list)).toMatch(/No newsletter form named \\"Other\\"[\s\S]*Newsletter/);
    expect(mutatingCalls(fake)).toHaveLength(0);
  });

  it("requires list with email: true before any network call", async () => {
    const fake = serve(backend());
    const c = await connect(fake);
    const res = await c.callTool({ name: "upsert_post", arguments: { project: "acme", title: "T", body_markdown: "b", email: true } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/needs `list`/);
    expect(mutatingCalls(fake)).toHaveLength(0);
  });

  it("refuses to change a published post without confirm_live_update, then saves with it", async () => {
    const b = backend({
      posts: [post({ published_at: "2026-10-01T00:00:00Z" })],
      upsert: () => ({ body: { post_id: "post-1", action: "updated", published: true } }),
    });
    const fake = serve(b);
    const c = await connect(fake);
    const args = { project: "acme", title: "Hello", body_markdown: "New body" };

    const refused = await c.callTool({ name: "upsert_post", arguments: args });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/confirm_live_update: true/);
    expect(mutatingCalls(fake)).toHaveLength(0);

    const ok = await c.callTool({ name: "upsert_post", arguments: { ...args, confirm_live_update: true } });
    expect(ok.isError, text(ok)).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ action: "updated", published: true, rebuild_queued: true });
    expect(mutatingCalls(fake)).toHaveLength(1);
  });

  it("explains a 409 slug conflict", async () => {
    const b = backend({ upsert: () => ({ status: 409, body: { error: "A post with this slug already exists" } }) });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "upsert_post", arguments: { project: "acme", title: "T", slug: "taken", body_markdown: "b" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/slug \\"taken\\" is already used by another post[\s\S]*list_posts/);
  });

  it("passes date through only when given", async () => {
    const fake = serve(backend());
    const c = await connect(fake);
    for (const date of ["2026-09-01", "2026-09-01T09:30:00Z", "2026-09-01T09:30:00.123+02:00", "2026-09-01T09:30:00"]) {
      const res = await c.callTool({ name: "upsert_post", arguments: { project: "acme", title: "T", body_markdown: "b", date } });
      expect(res.isError, text(res)).toBeFalsy();
    }
    await c.callTool({ name: "upsert_post", arguments: { project: "acme", title: "T", body_markdown: "b" } });
    const bodies = callsTo(fake, "upsert-post").map((call) => call.body as Record<string, unknown>);
    expect(bodies.map((body) => body.date)).toEqual(["2026-09-01", "2026-09-01T09:30:00Z", "2026-09-01T09:30:00.123+02:00", "2026-09-01T09:30:00", undefined]);
    expect(bodies[4]).not.toHaveProperty("date");
  });

  it("rejects a malformed date before any network call", async () => {
    const fake = serve(backend());
    const c = await connect(fake);
    for (const date of ["2026-9-1", "01/09/2026", "2026-02-30", "2026-09-01T25:30:00Z", "2026-13-01", "yesterday", ""]) {
      const res = await c.callTool({ name: "upsert_post", arguments: { project: "acme", title: "T", body_markdown: "b", date } });
      expect(res.isError, date).toBe(true);
      expect(text(res), date).toMatch(/YYYY-MM-DD/);
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("surfaces the server's future-date refusal as a tool error", async () => {
    const b = backend({
      upsert: () => ({ status: 400, body: { error: "date is in the future; scheduling posts is not supported" } }),
    });
    const c = await connect(serve(b));
    const res = await c.callTool({ name: "upsert_post", arguments: { project: "acme", title: "T", body_markdown: "b", date: "2099-01-01" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/date is in the future; scheduling posts is not supported/);
  });
});

describe("upsert_post unchanged short-circuit", () => {
  const base = { project: "acme", title: "Hello", body_markdown: "Body" };

  it("skips a save of a published post that changes nothing, with no confirm, write or cursor", async () => {
    const fake = serve(backend({ posts: [post({ published_at: "2026-10-01T09:15:00Z" })] }));
    const c = await connect(fake);
    const res = await c.callTool({ name: "upsert_post", arguments: base });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      post_id: "post-1",
      slug: "hello",
      action: "unchanged",
      published: true,
      rebuild_queued: false,
      build_id: null,
      after_event_id: null,
      warnings: [expect.stringMatching(/Nothing changed[\s\S]*not rebuilt/)],
    });
    expect(mutatingCalls(fake)).toHaveLength(0);
    expect(fake.calls.filter((call) => new URL(call.url).pathname === "/rest/v1/build_deploy_events")).toHaveLength(0);
    expect(text(res)).toMatch(/unchanged \(nothing saved\)/);
  });

  it("treats trailing newlines, CRLF and a defaulted subject as unchanged", async () => {
    const cases: Array<[Partial<PostRow>, Record<string, unknown>]> = [
      [{}, { body_markdown: "Body\n" }],
      [{ body_markdown: "Line 1\r\nLine 2\n\n" }, { body_markdown: "Line 1\nLine 2" }],
      [{ body_markdown: "Line 1\nLine 2" }, { body_markdown: "Line 1\r\nLine 2  \n" }],
      [{}, { body_markdown: "\n  \t\nBody" }],
      [{ body_markdown: "\r\nBody\r" }, { body_markdown: "Body" }],
      [{ body_markdown: "Line 1\rLine 2" }, { body_markdown: "Line 1\nLine 2" }],
      [{ subject: null }, {}],
      [{ subject: "" }, { subject: "" }],
      [{}, { subject: "Hello" }],
      [{ subject: null }, { subject: "Hello" }],
      [{ description: "", preheader: "", hero_image: "" }, { description: "" }],
      [{ title: "Hello " }, { title: " Hello" }],
    ];
    for (const [row, args] of cases) {
      const fake = serve(backend({ posts: [post(row)] }));
      const c = await connect(fake);
      const res = await c.callTool({ name: "upsert_post", arguments: { ...base, ...args } });
      expect(res.isError, text(res)).toBeFalsy();
      expect(res.structuredContent, JSON.stringify([row, args])).toMatchObject({ action: "unchanged", published: false });
      expect(mutatingCalls(fake), JSON.stringify([row, args])).toHaveLength(0);
      await client?.close();
      client = undefined;
    }
  });

  it("still saves when any single field differs", async () => {
    const changes: Array<[string, Partial<PostRow>, Record<string, unknown>]> = [
      ["title", {}, { title: "Hello there", slug: "hello" }],
      ["body", {}, { body_markdown: "Body!" }],
      ["leading indentation", {}, { body_markdown: "  Body" }],
      ["description", {}, { description: "Summary" }],
      ["description cleared", { description: "Summary" }, {}],
      ["hero", {}, { hero: "https://img.example/h.jpg" }],
      ["visibility", {}, { visibility: "unlisted" }],
      ["email", {}, { email: true, list: "Newsletter" }],
      ["email off", { email_enabled: true, form_id: FORM_ID }, {}],
      ["email flag out of step with the list", { email_enabled: false, form_id: FORM_ID }, { email: true, list: "Newsletter" }],
      ["subject", {}, { subject: "Read me" }],
      ["subject reset to title", { subject: "Custom" }, {}],
      ["preview", {}, { preview: "Inbox text" }],
      ["date on a draft", {}, { date: "2026-09-01" }],
      ["different held date", { date_override: "2026-09-01T00:00:00.000Z" }, { date: "2026-09-02" }],
    ];
    for (const [name, row, args] of changes) {
      const fake = serve(backend({ posts: [post(row)], upsert: () => ({ body: { post_id: "post-1", action: "updated", published: false } }) }));
      const c = await connect(fake);
      const res = await c.callTool({ name: "upsert_post", arguments: { ...base, ...args } });
      expect(res.isError, `${name}: ${text(res)}`).toBeFalsy();
      expect(res.structuredContent, name).toMatchObject({ action: "updated" });
      expect(callsTo(fake, "upsert-post"), name).toHaveLength(1);
      await client?.close();
      client = undefined;
    }
  });

  it("still requires confirm_live_update when a published post changes", async () => {
    const fake = serve(backend({ posts: [post({ published_at: "2026-10-01T09:15:00Z" })] }));
    const c = await connect(fake);
    const res = await c.callTool({ name: "upsert_post", arguments: { ...base, description: "New" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/CONFIRM_REQUIRED|confirm_live_update: true/);
    expect(mutatingCalls(fake)).toHaveLength(0);
  });

  it("compares date only when given, with upsert-post's no-op rules", async () => {
    const published = post({ published_at: "2026-10-01T09:15:00Z" });
    const draftHeld = post({ date_override: "2026-09-01T00:00:00.000Z" });
    const run = async (row: PostRow, date: string) => {
      const fake = serve(backend({ posts: [row] }));
      const c = await connect(fake);
      const res = await c.callTool({ name: "upsert_post", arguments: { ...base, date } });
      await client?.close();
      client = undefined;
      return { res, writes: mutatingCalls(fake).length };
    };

    // Same UTC day keeps published_at; an exact timestamp must match to the millisecond.
    for (const date of ["2026-10-01", "2026-10-01T09:15:00Z", "2026-10-01T11:15:00+02:00", "2026-10-01T09:15:00"]) {
      const { res, writes } = await run(published, date);
      expect(res.structuredContent, date).toMatchObject({ action: "unchanged" });
      expect(writes, date).toBe(0);
    }
    for (const date of ["2026-09-30", "2026-10-01T09:16:00Z"]) {
      const { res, writes } = await run(published, date);
      expect(text(res), date).toMatch(/confirm_live_update: true/);
      expect(writes, date).toBe(0);
    }
    // A draft holds the date in date_override, compared as an instant.
    for (const date of ["2026-09-01", "2026-09-01T00:00:00Z", "2026-09-01T02:00:00+02:00"]) {
      expect((await run(draftHeld, date)).writes, date).toBe(0);
    }
    expect((await run(draftHeld, "2026-09-01T00:00:01Z")).writes).toBe(1);
  });
});

describe("postMatchesPayload", () => {
  const payload = (overrides: Partial<UpsertPostPayload> = {}): UpsertPostPayload => ({
    project_id: 7,
    title: "Hello",
    slug: "hello",
    body_markdown: "Body",
    description: null,
    web_visibility: "listed",
    hero_image: null,
    form_id: null,
    subject: null,
    preheader: null,
    ...overrides,
  });

  it("matches a row saved from the same fields and ignores send bookkeeping", () => {
    expect(postMatchesPayload(post(), payload())).toBe(true);
    expect(postMatchesPayload(post({ status: "sent", sent_count: 9, recipient_count: 9, published_at: "2026-10-01T00:00:00Z" }), payload())).toBe(true);
  });

  it("does not compare the date when the payload has none", () => {
    expect(postMatchesPayload(post({ date_override: "2026-09-01T00:00:00Z" }), payload())).toBe(true);
  });

  it("counts an unparseable stored date or a stored null as changed when a date is given", () => {
    expect(postMatchesPayload(post({ published_at: "garbage" }), payload({ date: "2026-10-01" }))).toBe(false);
    expect(postMatchesPayload(post({ date_override: null }), payload({ date: "2026-10-01" }))).toBe(false);
  });
});

describe("preview_post_send + publish_post", () => {
  const emailing = () => post({ email_enabled: true, form_id: FORM_ID });

  async function preview(c: Client, slug = "hello") {
    const res = await c.callTool({ name: "preview_post_send", arguments: { project: "acme", slug } });
    expect(res.isError, text(res)).toBeFalsy();
    return res.structuredContent as Record<string, unknown> & { confirmation_token: string };
  }

  it("reports recipients, the list and the send flag, counting only active subscribers", async () => {
    const b = backend({ posts: [emailing()], subscribers: 42 });
    const fake = serve(b);
    const c = await connect(fake);
    const p = await preview(c);
    expect(p).toMatchObject({
      will_email: true,
      list: "Newsletter",
      recipient_count: 42,
      already_published: false,
      resend_warning: null,
      send_allowed: false,
      publish_allowed: false,
      blocked_reason: expect.stringMatching(/MICROPAGE_MCP_ALLOW_SEND=1/),
    });
    const subs = fake.calls.filter((call) => call.url.includes("/rest/v1/newsletter_subscribers"));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.method).toBe("HEAD");
    expect(subs[0]!.headers.prefer).toBe("count=exact");
    const q = new URL(subs[0]!.url).searchParams;
    expect(q.get("form_id")).toBe(`eq.${FORM_ID}`);
    expect(q.get("unsubscribed_at")).toBe("is.null");
    expect(mutatingCalls(fake)).toHaveLength(0);
  });

  it("warns about a re-send", async () => {
    const b = backend({ posts: [post({ email_enabled: true, form_id: FORM_ID, published_at: "2026-10-01T00:00:00Z" })] });
    const c = await connect(serve(b), { MICROPAGE_MCP_ALLOW_SEND: "1" });
    const p = await preview(c);
    expect(p).toMatchObject({ already_published: true, resend_warning: expect.stringMatching(/RE-SENDS/), publish_allowed: true });
    expect(p).not.toHaveProperty("site_warning");
  });

  it("publishes a web-only post with a fresh token and returns the deploy cursor", async () => {
    const b = backend({ posts: [post()] });
    const fake = serve(b);
    const c = await connect(fake);
    const { confirmation_token } = await preview(c);
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(callsTo(fake, "publish-post").map((call) => call.body)).toEqual([{ project_id: 7, slug: "hello" }]);
    expect(res.structuredContent).toMatchObject({ emailed: false, rebuild_queued: true, build_id: 30, after_event_id: 77, published_at: "2026-10-04T12:00:00Z" });
  });

  it("refuses a missing or made-up token with zero publish calls", async () => {
    const fake = serve(backend({ posts: [post()] }));
    const c = await connect(fake);
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token: "abc.def" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Call preview_post_send again/);
    expect(mutatingCalls(fake)).toHaveLength(0);
  });

  it("refuses a token gone stale after the post changed, with zero publish calls", async () => {
    const b = backend({ posts: [post()] });
    const fake = serve(b);
    const c = await connect(fake);
    const { confirmation_token } = await preview(c);
    b.posts[0]!.body_markdown = "Edited after the preview";
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/does not match the current state/);
    expect(mutatingCalls(fake)).toHaveLength(0);
  });

  it("refuses a token previewed under another account, with zero publish calls", async () => {
    const fake = serve(backend({ posts: [post()] }));
    const c = await connect(fake);
    const { confirmation_token } = await preview(c);
    // `micropage login` as someone else between the preview and the publish.
    await cfg.write({ access_token: tokenFor("user-2", 3600), refresh_token: "r2", user: { id: "user-2" } });
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/another session or account/);
    expect(mutatingCalls(fake)).toHaveLength(0);
  });

  it("refuses a token once the list changed", async () => {
    const b = backend({ posts: [emailing()], subscribers: 3 });
    const fake = serve(b);
    const c = await connect(fake, { MICROPAGE_MCP_ALLOW_SEND: "1" });
    const { confirmation_token } = await preview(c);
    b.posts[0]!.form_id = "aaaaaaaa-0000-0000-0000-000000000002";
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError).toBe(true);
    expect(mutatingCalls(fake)).toHaveLength(0);
  });

  it("refuses an emailing post when MICROPAGE_MCP_ALLOW_SEND is off, with zero publish calls", async () => {
    const fake = serve(backend({ posts: [emailing()], subscribers: 5 }));
    const c = await connect(fake);
    const { confirmation_token } = await preview(c);
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/MICROPAGE_MCP_ALLOW_SEND=1[\s\S]*email: false/);
    expect(mutatingCalls(fake)).toHaveLength(0);
  });

  it("publishes and emails when MICROPAGE_MCP_ALLOW_SEND is on (client without elicitation)", async () => {
    const fake = serve(backend({ posts: [emailing()], subscribers: 5 }));
    const c = await connect(fake, { MICROPAGE_MCP_ALLOW_SEND: "1" });
    const { confirmation_token } = await preview(c);
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ emailed: true, recipient_count: 5 });
    expect(elicited).toHaveLength(0);
    expect(callsTo(fake, "publish-post")).toHaveLength(1);
  });

  it("asks the user through elicitation and publishes on accept", async () => {
    const fake = serve(backend({ posts: [emailing()], subscribers: 5 }));
    const c = await connect(fake, { MICROPAGE_MCP_ALLOW_SEND: "1" }, { elicit: "accept" });
    const { confirmation_token } = await preview(c);
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(elicited).toEqual([expect.stringMatching(/email it to 5 subscriber\(s\) on the "Newsletter" list/)]);
    expect(callsTo(fake, "publish-post")).toHaveLength(1);
  });

  it("aborts with zero publish calls when the user declines the elicitation", async () => {
    const fake = serve(backend({ posts: [emailing()], subscribers: 5 }));
    const c = await connect(fake, { MICROPAGE_MCP_ALLOW_SEND: "1" }, { elicit: "decline" });
    const { confirmation_token } = await preview(c);
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/declined/);
    expect(elicited).toHaveLength(1);
    expect(mutatingCalls(fake)).toHaveLength(0);
  });

  it("explains a 402 from publish-post", async () => {
    const b = backend({ posts: [emailing()], subscribers: 5 });
    const fake = serve(b);
    // Override the publish-post route for this test only.
    const original = fake.fetch;
    fake.fetch = async (input, init) =>
      String(input).endsWith("/functions/v1/publish-post")
        ? new Response(JSON.stringify({ error: "Monthly newsletter send limit of 1000 reached for your plan." }), { status: 402 })
        : original(input, init);
    const c = await connect(fake, { MICROPAGE_MCP_ALLOW_SEND: "1" });
    const { confirmation_token } = await preview(c);
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Monthly newsletter send limit[\s\S]*pricing/);
  });
});

describe("unpublish_post / delete_post", () => {
  for (const [tool, fn] of [
    ["unpublish_post", "unpublish-post"],
    ["delete_post", "delete-post"],
  ] as const) {
    it(`${tool} needs confirm: true and makes zero network calls without it`, async () => {
      const fake = serve(backend({ posts: [post()] }));
      const c = await connect(fake);
      for (const confirm of [undefined, false]) {
        const res = await c.callTool({ name: tool, arguments: { project: "acme", slug: "hello", ...(confirm === undefined ? {} : { confirm }) } });
        expect(res.isError).toBe(true);
        expect(text(res)).toMatch(/confirm: true/);
      }
      expect(fake.calls).toHaveLength(0);
    });

    it(`${tool} calls ${fn} with the CLI's body when confirmed`, async () => {
      const fake = serve(backend({ posts: [post()] }));
      const c = await connect(fake);
      const res = await c.callTool({ name: tool, arguments: { project: "acme", slug: "Hello", confirm: true } });
      expect(res.isError, text(res)).toBeFalsy();
      expect(callsTo(fake, fn).map((call) => call.body)).toEqual([{ project_id: 7, slug: "hello" }]);
      expect(res.structuredContent).toMatchObject({ slug: "hello", rebuild_queued: true });
    });
  }
});

describe("site rebuild target (server rebuild_build_id)", () => {
  const cursorCalls = (fake: FakeFetch) => fake.calls.filter((call) => call.url.includes("/rest/v1/build_deploy_events"));

  it("publish_post takes the project-scoped cursor before publishing and follows the server's rebuild_build_id", async () => {
    // Active build 30 is a page draft; the server rebuilds live build 25 instead.
    const b = backend({ activeBuildStatus: "draft", rebuildBuildId: 25, posts: [post()] });
    const fake = serve(b);
    const c = await connect(fake);
    const preview = await c.callTool({ name: "preview_post_send", arguments: { project: "acme", slug: "hello" } });
    const { confirmation_token } = preview.structuredContent as { confirmation_token: string };
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      rebuild_queued: true,
      build_id: 25,
      after_event_id: 77,
      note: expect.stringMatching(/build "id:25", after_event_id 77/),
    });

    const cursors = cursorCalls(fake);
    expect(cursors).toHaveLength(1);
    const q = new URL(cursors[0]!.url).searchParams;
    expect(q.get("project_id")).toBe("eq.7");
    expect(q.get("build_id")).toBeNull();
    expect(q.get("order")).toBe("id.desc");
    expect(fake.calls.indexOf(cursors[0]!)).toBeLessThan(fake.calls.indexOf(callsTo(fake, "publish-post")[0]!));
    expect(fake.calls.some((call) => call.url.includes("/rest/v1/builds"))).toBe(false);
  });

  it("publish_post reports no rebuild when the server queued none (rebuild_build_id null)", async () => {
    const b = backend({ rebuildBuildId: null, posts: [post()] });
    const c = await connect(serve(b));
    const preview = await c.callTool({ name: "preview_post_send", arguments: { project: "acme", slug: "hello" } });
    const { confirmation_token } = preview.structuredContent as { confirmation_token: string };
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      rebuild_queued: false,
      build_id: null,
      after_event_id: null,
      note: expect.stringMatching(/no published build yet[\s\S]*publish_build/),
    });
  });

  it("publish_post falls back to the active build when the server leaves rebuild_build_id out", async () => {
    const b = backend({ posts: [post()] });
    const fake = serve(b);
    const c = await connect(fake);
    const preview = await c.callTool({ name: "preview_post_send", arguments: { project: "acme", slug: "hello" } });
    const { confirmation_token } = preview.structuredContent as { confirmation_token: string };
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ rebuild_queued: true, build_id: 30, after_event_id: 77 });
    expect(cursorCalls(fake)).toHaveLength(1);
  });

  it("publish_post of a visibility none post takes no cursor and queues no rebuild", async () => {
    const b = backend({ posts: [post({ web_visibility: "none" })] });
    const fake = serve(b);
    const c = await connect(fake);
    const preview = await c.callTool({ name: "preview_post_send", arguments: { project: "acme", slug: "hello" } });
    const { confirmation_token } = preview.structuredContent as { confirmation_token: string };
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ rebuild_queued: false, build_id: null, note: expect.stringMatching(/visibility none/) });
    expect(cursorCalls(fake)).toHaveLength(0);
  });

  it("publish_post no longer accepts allow_draft_deploy", async () => {
    const fake = serve(backend({ posts: [post()] }));
    const c = await connect(fake);
    const res = await c.callTool({
      name: "publish_post",
      arguments: { project: "acme", slug: "hello", confirmation_token: "abc.def", allow_draft_deploy: true },
    });
    expect(res.isError).toBe(true);
    expect(mutatingCalls(fake)).toHaveLength(0);
  });

  it("upsert_post on a published post reports the server's rebuild build and cursor", async () => {
    const b = backend({
      activeBuildStatus: "draft",
      posts: [post({ published_at: "2026-10-01T00:00:00Z" })],
      upsert: () => ({ body: { post_id: "post-1", action: "updated", published: true, rebuild_build_id: 25 } }),
    });
    const fake = serve(b);
    const c = await connect(fake);
    const res = await c.callTool({
      name: "upsert_post",
      arguments: { project: "acme", title: "Hello", body_markdown: "New", confirm_live_update: true },
    });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ rebuild_queued: true, build_id: 25, after_event_id: 77, warnings: [] });
  });

  it("upsert_post on a draft post takes no cursor", async () => {
    const fake = serve(backend());
    const c = await connect(fake);
    const res = await c.callTool({ name: "upsert_post", arguments: { project: "acme", title: "T", body_markdown: "b" } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ rebuild_queued: false, build_id: null, after_event_id: null });
    expect(cursorCalls(fake)).toHaveLength(0);
  });

  for (const [tool, fn] of [
    ["unpublish_post", "unpublish-post"],
    ["delete_post", "delete-post"],
  ] as const) {
    it(`${tool} takes the project cursor first and returns the server's rebuild_build_id`, async () => {
      const fake = serve(backend({ activeBuildStatus: "draft", rebuildBuildId: 25, posts: [post({ published_at: "2026-10-01T00:00:00Z" })] }));
      const c = await connect(fake);
      const res = await c.callTool({ name: tool, arguments: { project: "acme", slug: "hello", confirm: true } });
      expect(res.isError, text(res)).toBeFalsy();
      expect(res.structuredContent).toMatchObject({ rebuild_queued: true, build_id: 25, after_event_id: 77 });
      const cursors = cursorCalls(fake);
      expect(cursors).toHaveLength(1);
      expect(new URL(cursors[0]!.url).searchParams.get("project_id")).toBe("eq.7");
      expect(fake.calls.indexOf(cursors[0]!)).toBeLessThan(fake.calls.indexOf(callsTo(fake, fn)[0]!));
    });

    it(`${tool} reports no rebuild when rebuild_build_id is null`, async () => {
      const fake = serve(backend({ rebuildBuildId: null, posts: [post()] }));
      const c = await connect(fake);
      const res = await c.callTool({ name: tool, arguments: { project: "acme", slug: "hello", confirm: true } });
      expect(res.isError, text(res)).toBeFalsy();
      expect(res.structuredContent).toMatchObject({ rebuild_queued: false, build_id: null, after_event_id: null });
    });

    it(`${tool} falls back to the active build when rebuild_build_id is absent`, async () => {
      const fake = serve(backend({ posts: [post()] }));
      const c = await connect(fake);
      const res = await c.callTool({ name: tool, arguments: { project: "acme", slug: "hello", confirm: true } });
      expect(res.isError, text(res)).toBeFalsy();
      expect(res.structuredContent).toMatchObject({ rebuild_queued: true, build_id: 30, after_event_id: 77 });
      expect(res.structuredContent).not.toHaveProperty("site_warning");
    });
  }
});

describe("publish_post note", () => {
  it("tells the model the rebuild is queued and how get_deploy_status will report it", async () => {
    const fake = serve(backend({ posts: [post()] }));
    const c = await connect(fake);
    const preview = await c.callTool({ name: "preview_post_send", arguments: { project: "acme", slug: "hello" } });
    const { confirmation_token } = preview.structuredContent as { confirmation_token: string };
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect((res.structuredContent as { note: string }).note).toMatch(
      /3 minutes[\s\S]*Pro\+[\s\S]*build "id:30", after_event_id 77[\s\S]*waiting_for_start[\s\S]*done only once/,
    );
  });
});

describe("fingerprint", () => {
  it("changes with any saved field and not with send bookkeeping", () => {
    const base = post();
    const fp = postContentFingerprint(base);
    expect(postContentFingerprint({ ...base, status: "sent", sent_count: 9 })).toBe(fp);
    for (const change of [{ title: "x" }, { subject: "x" }, { preheader: "x" }, { body_markdown: "x" }, { hero_image: "x" }, { web_visibility: "unlisted" as const }]) {
      expect(postContentFingerprint({ ...base, ...change })).not.toBe(fp);
    }
  });
});
