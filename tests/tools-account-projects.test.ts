import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RO } from "../src/annotations.js";
import { createDeps, createServer } from "../src/server.js";
import { createFakeFetch, type FakeFetch, type RecordedCall } from "./helpers/fake-fetch.js";
import { tempConfig, tokenFor, type TempConfig } from "./helpers/session.js";

const UUID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";
const OURS = ["whoami", "list_projects", "get_project"];

let cfg: TempConfig;
let client: Client | undefined;

beforeEach(async () => {
  cfg = await tempConfig();
});
afterEach(async () => {
  await client?.close();
  client = undefined;
  await cfg.cleanup();
});

async function connect(fake: FakeFetch, extraEnv: Record<string, string> = {}): Promise<Client> {
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
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

/** Route-style responder: answers by path so the order of parallel requests does not matter. */
function route(handlers: Record<string, (call: RecordedCall) => unknown>) {
  return (call: RecordedCall) => {
    const url = new URL(call.url);
    const handler = handlers[url.pathname];
    if (!handler) throw new Error(`unexpected ${call.method} ${call.url}`);
    return { body: handler(call) };
  };
}

async function loginAs(tier: string | null) {
  await cfg.write({ access_token: tokenFor("user-1", 3600), refresh_token: "r1", user: { id: "user-1" } });
  return tier;
}

describe("tool registration", () => {
  it("advertises whoami, list_projects and get_project as read-only with strict, described inputs", async () => {
    const c = await connect(createFakeFetch());
    const { tools } = await c.listTools();
    const ours = tools.filter((t) => OURS.includes(t.name));
    expect(ours.map((t) => t.name).sort()).toEqual([...OURS].sort());

    for (const tool of ours) {
      expect(tool.annotations).toMatchObject(RO);
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

describe("whoami", () => {
  it("reports a missing login without failing and without a network call", async () => {
    const fake = createFakeFetch();
    const c = await connect(fake);
    const res = await c.callTool({ name: "whoami", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      logged_in: false,
      auth_mode: "session",
      config_path: cfg.path,
      note: expect.stringMatching(/micropage login/),
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("reports email, plan and subscription for a session, and does not gate on plan", async () => {
    await loginAs("free");
    const fake = createFakeFetch();
    const responder = route({
      "/auth/v1/user": () => ({ id: "user-1", email: "a@b.c", user_metadata: { full_name: "Ann" } }),
      "/rest/v1/customers": () => [{ plan_tier: "free" }],
      "/rest/v1/subscriptions": () => [],
    });
    fake.push(responder, responder, responder);
    const c = await connect(fake);

    const res = await c.callTool({ name: "whoami", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      logged_in: true,
      email: "a@b.c",
      name: "Ann",
      plan_tier: "free",
      paid_plan: false,
      note: expect.stringMatching(/micropage\.sh\/pricing/),
    });
  });

  it("reports the pinned project in deploy-token mode, reading identity from the JWT", async () => {
    const jwt = tokenFor("owner-1", 1800);
    const fake = createFakeFetch();
    const responder = route({
      "/functions/v1/exchange-deploy-token": () => ({ access_token: jwt, expires_at: Math.floor(Date.now() / 1000) + 1800, project_id: 7 }),
      "/rest/v1/customers": () => [{ plan_tier: "pro_plus" }],
      "/rest/v1/subscriptions": () => [],
    });
    fake.push(responder, responder, responder);
    const c = await connect(fake, { MICROPAGE_DEPLOY_TOKEN: "mpd_x", MICROPAGE_DEPLOY_PROJECT: UUID });

    const res = await c.callTool({ name: "whoami", arguments: {} });
    expect(res.structuredContent).toMatchObject({
      logged_in: true,
      auth_mode: "deploy_token",
      pinned_project_uuid: UUID,
      email: "owner-1@example.com",
      plan_tier: "pro_plus",
      config_path: null,
    });
    expect(fake.calls.some((c) => c.url.includes("/auth/v1/user"))).toBe(false);
  });
});

describe("list_projects", () => {
  it("lists projects with live URL and active build", async () => {
    await loginAs("pro");
    const fake = createFakeFetch(
      { body: [{ plan_tier: "pro" }] },
      {
        body: [
          { id: 8, uuid: OTHER, name: "Shop", domain: "shop", custom_domain: "www.shop.com", active_build_id: null, status: "active", created_at: null },
          { id: 7, uuid: UUID, name: "Acme", domain: "acme", custom_domain: null, active_build_id: 30, status: "active", created_at: null },
        ],
      },
      { body: [{ id: 30, number: 4, status: "deployed", updated_at: "2026-10-01T00:00:00Z", failure_reason: null }] },
    );
    const c = await connect(fake);

    const res = await c.callTool({ name: "list_projects", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      count: 2,
      projects: [
        { uuid: OTHER, live_url: "https://www.shop.com", active_build: null },
        {
          uuid: UUID,
          live_url: "https://acme.micropage.sh",
          editor_url: "https://app.micropage.sh/editor/7",
          active_build: { id: 30, number: 4, status: "deployed" },
        },
      ],
    });
    expect(new URL(fake.calls[2]!.url).searchParams.get("id")).toBe("in.(30)");
  });

  it("refuses a free account with the upgrade message before listing anything", async () => {
    await loginAs("free");
    const fake = createFakeFetch({ body: [{ plan_tier: "free" }] });
    const c = await connect(fake);
    const res = await c.callTool({ name: "list_projects", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/micropage\.sh\/pricing/);
    expect(fake.calls).toHaveLength(1);
  });

  it("is not available under a deploy token", async () => {
    const fake = createFakeFetch();
    const c = await connect(fake, { MICROPAGE_DEPLOY_TOKEN: "mpd_x", MICROPAGE_DEPLOY_PROJECT: UUID });
    const res = await c.callTool({ name: "list_projects", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/not available with a deploy token/);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("get_project", () => {
  it("returns active, latest and deployed builds, the failure reason and custom-domain status", async () => {
    await loginAs("pro");
    const fake = createFakeFetch({ body: [{ plan_tier: "pro" }] }, {
      body: [{ id: 7, uuid: UUID, name: "Acme", domain: "acme", custom_domain: "www.acme.com", active_build_id: 31, status: "active", created_at: null }],
    });
    const builds = (call: RecordedCall) => {
      const q = new URL(call.url).searchParams;
      if (q.get("id") === "eq.31") return [{ id: 31, number: 5, status: "failed", updated_at: null, failure_reason: "parse error line 3" }];
      if (q.get("status") === "eq.deployed") return [{ id: 30, number: 4, status: "deployed", updated_at: null, failure_reason: null }];
      return [{ id: 31, number: 5, status: "failed", updated_at: null, failure_reason: "parse error line 3" }];
    };
    const responder = route({
      "/rest/v1/builds": builds,
      "/rest/v1/projects": () => [
        {
          domain_active: false,
          custom_hostname_status: "pending",
          custom_hostname_ssl_status: "pending_validation",
          custom_hostname_verification_errors: null,
          custom_hostname_last_checked_at: null,
        },
      ],
    });
    fake.push(responder, responder, responder, responder);
    const c = await connect(fake);

    const res = await c.callTool({ name: "get_project", arguments: { project: "www.acme.com" } });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({
      project: { id: 7, live_url: "https://www.acme.com" },
      active_build: { id: 31, status: "failed" },
      latest_build: { number: 5 },
      last_deployed_build: { id: 30, number: 4 },
      failure_reason: "parse error line 3",
      custom_domain: { hostname: "www.acme.com", attached: false, status: "pending", ssl_status: "pending_validation", cname_target: "cname.micropage.sh" },
    });
  });

  it("rejects unknown arguments (strict input)", async () => {
    const c = await connect(createFakeFetch());
    const res = await c.callTool({ name: "get_project", arguments: { project: "acme", extra: 1 } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/Input validation error[\s\S]*extra/);
  });

  it("refuses a foreign project under a deploy token without exchanging or querying", async () => {
    const fake = createFakeFetch();
    const c = await connect(fake, { MICROPAGE_DEPLOY_TOKEN: "mpd_x", MICROPAGE_DEPLOY_PROJECT: UUID });
    const res = await c.callTool({ name: "get_project", arguments: { project: OTHER } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/pinned to project/);
    expect(fake.calls).toHaveLength(0);
  });

  it("tells the model about the plan when the deploy-token owner is below Pro+", async () => {
    const fake = createFakeFetch({
      status: 403,
      body: {
        error: "Deploy tokens require the Pro+ plan.",
        code: "plan_required",
        required_tier: "pro_plus",
        upgrade_url: "https://micropage.sh/pricing",
      },
    });
    const c = await connect(fake, { MICROPAGE_DEPLOY_TOKEN: "mpd_x", MICROPAGE_DEPLOY_PROJECT: UUID });
    const res = await c.callTool({ name: "get_project", arguments: { project: UUID } });
    expect(res.isError).toBe(true);
    const out = JSON.stringify(res.content);
    expect(out).toMatch(/Deploy tokens require the Pro\+ plan\. Upgrade at https:\/\/micropage\.sh\/pricing\./);
    expect(out).not.toMatch(/deploy token was rejected/);
    expect(fake.calls.map((call) => new URL(call.url).pathname)).toEqual(["/functions/v1/exchange-deploy-token"]);
  });
});
