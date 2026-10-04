import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DESTRUCTIVE, OUT, RO } from "../src/annotations.js";
import { postContentFingerprint, type PostRow } from "../src/client/posts.js";
import { createDeps, createServer } from "../src/server.js";
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
        return { body: { post_id: p.id, published_at: p.published_at, emailed, recipient_count: emailed ? b.subscribers : 0 } };
      }
      case "/functions/v1/unpublish-post":
        return { body: { post_id: "post-1", unpublished: true } };
      case "/functions/v1/delete-post":
        return { body: { deleted: true, slug: (call.body as { slug: string }).slug } };
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

  it("warns about a re-send and about a page draft that the rebuild would put live", async () => {
    const b = backend({ posts: [post({ email_enabled: true, form_id: FORM_ID, published_at: "2026-10-01T00:00:00Z" })], activeBuildStatus: "draft" });
    const c = await connect(serve(b), { MICROPAGE_MCP_ALLOW_SEND: "1" });
    const p = await preview(c);
    expect(p).toMatchObject({ already_published: true, resend_warning: expect.stringMatching(/RE-SENDS/), publish_allowed: true, site_warning: expect.stringMatching(/draft/) });
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

describe("site rebuild with an unpublished page draft as the active build (TASK-54)", () => {
  for (const status of ["draft", "failed"]) {
    it(`upsert_post on a published post is refused while the active build is ${status}, then saves with allow_draft_deploy`, async () => {
      const b = backend({
        activeBuildStatus: status,
        posts: [post({ published_at: "2026-10-01T00:00:00Z" })],
        upsert: () => ({ body: { post_id: "post-1", action: "updated", published: true } }),
      });
      const fake = serve(b);
      const c = await connect(fake);
      const args = { project: "acme", title: "Hello", body_markdown: "New", confirm_live_update: true };

      const refused = await c.callTool({ name: "upsert_post", arguments: args });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(new RegExp(`unpublished page draft \\(build v6, status ${status}\\)[\\s\\S]*publish_build[\\s\\S]*allow_draft_deploy: true[\\s\\S]*Nothing was changed`));
      expect(mutatingCalls(fake)).toHaveLength(0);

      const ok = await c.callTool({ name: "upsert_post", arguments: { ...args, allow_draft_deploy: true } });
      expect(ok.isError, text(ok)).toBeFalsy();
      expect(ok.structuredContent).toMatchObject({ warnings: [expect.stringMatching(/build v6[\s\S]*goes live with this site rebuild/)] });
      expect(mutatingCalls(fake)).toHaveLength(1);
    });
  }

  it("upsert_post on a draft post is not affected (no rebuild)", async () => {
    const fake = serve(backend({ activeBuildStatus: "draft" }));
    const c = await connect(fake);
    const res = await c.callTool({ name: "upsert_post", arguments: { project: "acme", title: "T", body_markdown: "b" } });
    expect(res.isError, text(res)).toBeFalsy();
    expect(fake.calls.some((call) => call.url.includes("/rest/v1/builds"))).toBe(false);
  });

  it("publish_post is refused before any publish call, then goes ahead with allow_draft_deploy", async () => {
    const b = backend({ activeBuildStatus: "draft", posts: [post()] });
    const fake = serve(b);
    const c = await connect(fake);
    const preview = await c.callTool({ name: "preview_post_send", arguments: { project: "acme", slug: "hello" } });
    const { confirmation_token, site_warning } = preview.structuredContent as { confirmation_token: string; site_warning: string };
    expect(site_warning).toMatch(/build v6, status draft[\s\S]*allow_draft_deploy/);

    const refused = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/Publishing \\"hello\\" rebuilds the site[\s\S]*build v6/);
    expect(mutatingCalls(fake)).toHaveLength(0);

    const ok = await c.callTool({
      name: "publish_post",
      arguments: { project: "acme", slug: "hello", confirmation_token, allow_draft_deploy: true },
    });
    expect(ok.isError, text(ok)).toBeFalsy();
    expect(ok.structuredContent).toMatchObject({ rebuild_queued: true, note: expect.stringMatching(/goes live with this site rebuild/) });
    expect(callsTo(fake, "publish-post")).toHaveLength(1);
  });

  it("publish_post of a visibility none post needs no acknowledgement", async () => {
    const b = backend({ activeBuildStatus: "draft", posts: [post({ web_visibility: "none" })] });
    const fake = serve(b);
    const c = await connect(fake);
    const preview = await c.callTool({ name: "preview_post_send", arguments: { project: "acme", slug: "hello" } });
    const { confirmation_token } = preview.structuredContent as { confirmation_token: string };
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError, text(res)).toBeFalsy();
  });

  for (const [tool, fn, verb] of [
    ["unpublish_post", "unpublish-post", "Unpublishing"],
    ["delete_post", "delete-post", "Deleting"],
  ] as const) {
    it(`${tool} is refused while the active build is a draft, then goes ahead with allow_draft_deploy`, async () => {
      const b = backend({ activeBuildStatus: "draft", posts: [post({ published_at: "2026-10-01T00:00:00Z" })] });
      const fake = serve(b);
      const c = await connect(fake);
      const refused = await c.callTool({ name: tool, arguments: { project: "acme", slug: "hello", confirm: true } });
      expect(refused.isError).toBe(true);
      expect(text(refused)).toMatch(new RegExp(`${verb} \\\\"hello\\\\" rebuilds the site[\\s\\S]*build v6`));
      expect(callsTo(fake, fn)).toHaveLength(0);

      const ok = await c.callTool({ name: tool, arguments: { project: "acme", slug: "hello", confirm: true, allow_draft_deploy: true } });
      expect(ok.isError, text(ok)).toBeFalsy();
      expect(ok.structuredContent).toMatchObject({ rebuild_queued: true, site_warning: expect.stringMatching(/build v6/) });
      expect(callsTo(fake, fn)).toHaveLength(1);
    });

    it(`${tool} needs no acknowledgement when the active build is deployed`, async () => {
      const fake = serve(backend({ posts: [post()] }));
      const c = await connect(fake);
      const res = await c.callTool({ name: tool, arguments: { project: "acme", slug: "hello", confirm: true } });
      expect(res.isError, text(res)).toBeFalsy();
      expect(res.structuredContent).toMatchObject({ site_warning: null });
    });
  }

  it("delete_post of a slug that does not exist is not blocked (nothing is rebuilt)", async () => {
    const fake = serve(backend({ activeBuildStatus: "draft" }));
    const c = await connect(fake);
    const res = await c.callTool({ name: "delete_post", arguments: { project: "acme", slug: "ghost", confirm: true } });
    expect(res.isError, text(res)).toBeFalsy();
  });
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
