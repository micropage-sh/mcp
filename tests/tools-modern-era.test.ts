import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { serveStdio, type StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PostRow } from "../src/client/posts.js";
import { createDeps } from "../src/node/deps.js";
import { createServerFactory } from "../src/server.js";
import { createFakeFetch, type FakeFetch, type RecordedCall } from "./helpers/fake-fetch.js";
import { tempConfig, tokenFor, type TempConfig } from "./helpers/session.js";

// The same factory the stdio entry serves, over the 2026-07-28 protocol: the
// client negotiates the modern era, sends its capabilities in each request's
// _meta envelope, and answers elicitation through the input_required round
// trip instead of a server-to-client request.

const UUID = "11111111-2222-3333-4444-555555555555";
const FORM_ID = "aaaaaaaa-0000-0000-0000-000000000001";

let cfg: TempConfig;
let client: Client | undefined;
let handle: StdioServerHandle | undefined;
let elicited: string[] = [];
let eras: string[] = [];

beforeEach(async () => {
  elicited = [];
  eras = [];
  cfg = await tempConfig();
  await cfg.write({ access_token: tokenFor("user-1", 3600), refresh_token: "r1", user: { id: "user-1" } });
});
afterEach(async () => {
  await client?.close();
  await handle?.close();
  client = undefined;
  handle = undefined;
  await cfg.cleanup();
});

const emailingPost: PostRow = {
  id: "post-1",
  slug: "hello",
  title: "Hello",
  description: null,
  body_markdown: "Body",
  web_visibility: "listed",
  email_enabled: true,
  form_id: FORM_ID,
  hero_image: null,
  subject: "Hello",
  preheader: null,
  status: "queued",
  published_at: null,
  created_at: "2026-10-01T00:00:00Z",
  recipient_count: 0,
  sent_count: 0,
};

function serve(): FakeFetch {
  const fake = createFakeFetch();
  const post = { ...emailingPost };
  const responder = (call: RecordedCall) => {
    switch (new URL(call.url).pathname) {
      case "/rest/v1/customers":
        return { body: [{ plan_tier: "pro" }] };
      case "/rest/v1/projects":
        return { body: [{ id: 7, uuid: UUID, name: "Acme", domain: "acme", custom_domain: null, active_build_id: 30, status: "active", created_at: null }] };
      case "/rest/v1/posts":
        return { body: [post] };
      case "/rest/v1/forms":
        return { body: [{ id: FORM_ID, form_name: "Newsletter" }] };
      case "/rest/v1/newsletter_subscribers":
        return { headers: { "content-range": "*/5" } };
      case "/rest/v1/builds":
        return { body: [{ number: 6, status: "deployed" }] };
      case "/rest/v1/build_deploy_events":
        return { body: [{ id: 77 }] };
      case "/functions/v1/publish-post":
        post.published_at = "2026-10-04T12:00:00Z";
        return { body: { post_id: post.id, published_at: post.published_at, emailed: true, recipient_count: 5 } };
      default:
        throw new Error(`unexpected ${call.method} ${call.url}`);
    }
  };
  for (let i = 0; i < 200; i++) fake.push(responder);
  return fake;
}

async function connectModern(fake: FakeFetch, elicit?: "accept" | "decline"): Promise<Client> {
  const deps = createDeps(
    {
      HOME: cfg.dir,
      MICROPAGE_CONFIG_DIR: cfg.dir,
      MICROPAGE_SUPABASE_URL: "https://supabase.test",
      MICROPAGE_SUPABASE_ANON_KEY: "anon-key",
      MICROPAGE_MCP_ALLOW_SEND: "1",
    },
    { fetch: fake.fetch },
  );
  const factory = createServerFactory(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  handle = serveStdio(
    (ctx) => {
      eras.push(ctx.era);
      return factory(ctx);
    },
    { transport: serverTransport },
  );
  client = new Client(
    { name: "test", version: "0.0.0" },
    {
      ...(elicit ? { capabilities: { elicitation: { form: {} } } } : {}),
      versionNegotiation: { mode: { pin: "2026-07-28" } },
    },
  );
  if (elicit) {
    client.setRequestHandler("elicitation/create", async (request) => {
      elicited.push(request.params.message);
      return elicit === "accept" ? { action: "accept", content: { confirm: true } } : { action: "decline" };
    });
  }
  await client.connect(clientTransport);
  return client;
}

const publishCalls = (fake: FakeFetch) => fake.calls.filter((c) => c.url.endsWith("/functions/v1/publish-post"));

async function previewToken(c: Client): Promise<string> {
  const res = await c.callTool({ name: "preview_post_send", arguments: { project: "acme", slug: "hello" } });
  expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
  return (res.structuredContent as { confirmation_token: string }).confirmation_token;
}

describe("publish_post on the 2026-07-28 protocol", () => {
  it("reads elicitation support from the request envelope and confirms through the inputRequired round trip", async () => {
    const fake = serve();
    const c = await connectModern(fake, "accept");
    const confirmation_token = await previewToken(c);
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });

    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(eras).toContain("modern");
    expect(eras).not.toContain("legacy");
    expect(elicited).toEqual([expect.stringMatching(/email it to 5 subscriber\(s\) on the "Newsletter" list/)]);
    expect(publishCalls(fake)).toHaveLength(1);
    expect(res.structuredContent).toMatchObject({ emailed: true, recipient_count: 5 });
  });

  it("publishes nothing when the user declines in the round trip", async () => {
    const fake = serve();
    const c = await connectModern(fake, "decline");
    const confirmation_token = await previewToken(c);
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/declined/);
    expect(elicited).toHaveLength(1);
    expect(publishCalls(fake)).toHaveLength(0);
  });

  it("does not ask when the envelope declares no elicitation capability", async () => {
    const fake = serve();
    const c = await connectModern(fake);
    const confirmation_token = await previewToken(c);
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token } });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(eras).toContain("modern");
    expect(elicited).toHaveLength(0);
    expect(publishCalls(fake)).toHaveLength(1);
  });
});
