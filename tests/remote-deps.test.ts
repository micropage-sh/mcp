import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { BearerAuthProvider } from "../src/client/bearer-auth.js";
import { PlanGate, PlanTierCache } from "../src/client/tier.js";
import type { Permissions, ServerDeps, UploadDeps } from "../src/context.js";
import { ConfirmationTokens, NO_PERMISSIONS } from "../src/guards.js";
import { createDeps } from "../src/node/deps.js";
import { nodeHostLookup } from "../src/node/host-lookup.js";
import { nodePathLoader } from "../src/node/path-source.js";
import { createServer } from "../src/server.js";
import { TEST_CONFIG, createFakeFetch, makeHttp, type FakeFetch, type RecordedCall } from "./helpers/fake-fetch.js";
import { tokenFor } from "./helpers/session.js";

// Deps shaped the way a hosted entry builds them per request: a verified
// bearer, no filesystem, no resolver, permissions from the connection, and
// long-lived pieces (token key, tier cache) passed in.

const KEY = "remote-secret-".repeat(4);
const TIER_CACHE = new PlanTierCache();
const UUID = "11111111-2222-3333-4444-555555555555";
const PROJECT_ROW = { id: 7, uuid: UUID, name: "Acme", domain: "acme", custom_domain: null, active_build_id: 30, status: "active", created_at: null };

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  TIER_CACHE.clear();
});

function remoteDeps(fake: FakeFetch, options: { permissions?: Permissions; uploads?: Partial<UploadDeps>; sub?: string } = {}): ServerDeps {
  const auth = new BearerAuthProvider(tokenFor(options.sub ?? "user-1", 3600));
  const http = makeHttp(fake, auth);
  return {
    config: TEST_CONFIG,
    auth,
    http,
    tier: new PlanGate({ http, auth, cache: TIER_CACHE }),
    permissions: options.permissions ?? NO_PERMISSIONS,
    confirmationTokens: new ConfirmationTokens({ key: KEY }),
    uploads: { lookupHost: null, ...options.uploads },
  };
}

async function connect(deps: ServerDeps): Promise<Client> {
  const server = createServer({ era: "legacy" }, deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);
  return client;
}

function routed(fake: FakeFetch, routes: Record<string, (call: RecordedCall) => unknown>): void {
  for (let i = 0; i < 50; i++) {
    fake.push((call) => {
      const path = new URL(call.url).pathname;
      const route = routes[path];
      if (!route) throw new Error(`unexpected ${call.method} ${call.url}`);
      const out = route(call);
      return out && typeof out === "object" && "status" in out ? (out as { status: number }) : { body: out };
    });
  }
}

const text = (res: { content?: unknown }) => JSON.stringify(res.content);

describe("server on remote-shaped deps", () => {
  it("serves the stdio tool set, with upload_asset offering only {url} and {base64}", async () => {
    const c = await connect(remoteDeps(createFakeFetch()));
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(20);
    const upload = tools.find((t) => t.name === "upload_asset")!;
    const schema = JSON.stringify(upload.inputSchema);
    expect(schema).toContain('"url"');
    expect(schema).toContain('"base64"');
    expect(schema).not.toContain('"path"');
    expect(upload.description).toMatch(/from a public https URL or base64 bytes/);
    expect(upload.description).not.toMatch(/local file path/);
  });

  it("stdio deps keep {path} in the schema and wire the node loader and resolver", async () => {
    const deps = createDeps({ HOME: "/nonexistent", MICROPAGE_CONFIG_DIR: "/nonexistent" });
    expect(deps.uploads.pathLoader).toBe(nodePathLoader);
    expect(deps.uploads.lookupHost).toBe(nodeHostLookup);
    const c = await connect(deps);
    const upload = (await c.listTools()).tools.find((t) => t.name === "upload_asset")!;
    expect(JSON.stringify(upload.inputSchema)).toContain('"path"');
    expect(upload.description).toMatch(/from a local file path/);
  });

  it("registers delete_project and list_submissions only when the connection's permissions allow them", async () => {
    const names = async (permissions: Permissions) => {
      const c = await connect(remoteDeps(createFakeFetch(), { permissions }));
      const list = (await c.listTools()).tools.map((t) => t.name);
      await c.close();
      client = undefined;
      return list;
    };
    const none = await names(NO_PERMISSIONS);
    expect(none).not.toContain("delete_project");
    expect(none).not.toContain("list_submissions");
    const all = await names({ allowSend: true, allowDelete: true, allowSubmissions: true });
    expect(all).toContain("delete_project");
    expect(all).toContain("list_submissions");
  });

  it("refuses a {path} source by schema, before any network call", async () => {
    const fake = createFakeFetch();
    const c = await connect(remoteDeps(fake));
    const res = await c.callTool({ name: "upload_asset", arguments: { project: "acme", filename: "a.png", source: { path: "/etc/passwd" } } });
    expect(res.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  it("refuses a {url} on a denied host (exact or suffix), on the first hop and after a redirect, without fetching it", async () => {
    const fake = createFakeFetch();
    routed(fake, {
      "/rest/v1/customers": () => [{ plan_tier: "pro" }],
      "/rest/v1/projects": () => [PROJECT_ROW],
    });
    const external: string[] = [];
    const fetchExternal = async (input: string) => {
      external.push(input);
      return new Response(null, { status: 302, headers: { location: "https://publisher.internal.example/x.png" } });
    };
    const c = await connect(
      remoteDeps(fake, {
        uploads: { fetchExternal, deniedHosts: { exact: ["mcp.example.com"], suffixes: [".internal.example"] } },
      }),
    );
    const call = (url: string) => c.callTool({ name: "upload_asset", arguments: { project: "acme", filename: "a.png", source: { url } } });

    for (const url of ["https://MCP.example.com./a.png", "https://internal.example/a.png", "https://a.b.internal.example/a.png"]) {
      const res = await call(url);
      expect(res.isError, url).toBe(true);
      expect(text(res)).toMatch(/not fetched by this server/);
      expect(text(res)).toMatch(/source\.base64/);
      expect(text(res)).not.toMatch(/source\.path/);
    }
    expect(external).toEqual([]);

    const redirected = await call("https://cdn.example.org/a.png");
    expect(redirected.isError).toBe(true);
    expect(text(redirected)).toMatch(/publisher\.internal\.example is not fetched/);
    expect(external).toEqual(["https://cdn.example.org/a.png"]);
    expect(fake.calls.some((c) => c.url.includes("/functions/v1/"))).toBe(false);
  });

  it("does not treat a lookalike domain as a suffix match", async () => {
    const fake = createFakeFetch();
    routed(fake, {
      "/rest/v1/customers": () => [{ plan_tier: "pro" }],
      "/rest/v1/projects": () => [PROJECT_ROW],
    });
    const fetched: string[] = [];
    const fetchExternal = async (input: string) => {
      fetched.push(input);
      return new Response("nope", { status: 404 });
    };
    const c = await connect(remoteDeps(fake, { uploads: { fetchExternal, deniedHosts: { suffixes: ["internal.example"] } } }));
    const res = await c.callTool({
      name: "upload_asset",
      arguments: { project: "acme", filename: "a.png", source: { url: "https://notinternal.example/a.png" } },
    });
    expect(text(res)).toMatch(/HTTP 404/);
    expect(fetched).toEqual(["https://notinternal.example/a.png"]);
  });

  it("whoami reports an expired bearer as not logged in, telling the client to re-authenticate", async () => {
    const fake = createFakeFetch({ status: 401, body: { message: "invalid JWT" } });
    const c = await connect(remoteDeps(fake));
    const res = await c.callTool({ name: "whoami", arguments: {} });
    expect(res.isError, text(res)).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ logged_in: false, auth_mode: "oauth", config_path: null });
    expect((res.structuredContent as { note: string }).note).toMatch(/re-authenticate/);
  });
});
