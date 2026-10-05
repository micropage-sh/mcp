import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { PostRow } from "../src/client/posts.js";
import { DENIED_HOSTS, MAX_REQUEST_BODY_BYTES, REMOTE_MAX_ASSET_BYTES, deniedHostsFor, type Env, type RateLimiter } from "../src/remote/config.js";
import { REMOTE_DEPLOY_TOKEN_HINTS, REMOTE_OAUTH_HINTS } from "../src/hints.js";
import { createWorker, type RemoteWorker } from "../src/remote/app.js";
import { dohLookup } from "../src/remote/doh.js";
import { makeJwt } from "./helpers/session.js";

// The Worker's fetch handler run in Node with stubbed bindings and a routed
// fake for every outbound call (Supabase, exchange-deploy-token, `{url}`).

const SUPABASE = "https://sb.example.test";
const RESOURCE = "https://mcp.example.test/mcp";
const PRM_URL = "https://mcp.example.test/.well-known/oauth-protected-resource/mcp";
const UUID = "11111111-2222-3333-4444-555555555555";
const OTHER_UUID = "99999999-2222-3333-4444-555555555555";
const DEPLOY_TOKEN = "ab".repeat(32);
const CLIENT_ID = "c0ffee00-0000-4000-8000-000000000001";
const FORM_ID = "aaaaaaaa-0000-0000-0000-000000000001";
const PROJECT_ROW = { id: 7, uuid: UUID, name: "Acme", domain: "acme", custom_domain: null, active_build_id: 30, status: "active", created_at: null };

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

interface Backend {
  /** "mismatch": /auth/v1/user answers with another user's id. */
  users: Record<string, "ok" | "revoked" | "mismatch">;
  /** /auth/v1/user waits for this before answering. */
  userGate?: Promise<void>;
  /** The permissions read fails with HTTP 500. */
  permissionsFail?: boolean;
  /** Every PostgREST call answers 401 (the API rejects the access token). */
  restUnauthorized?: boolean;
  /** exchange-deploy-token: the token is revoked (403) / the project is gone (404). */
  deployRevoked?: boolean;
  deployProjectGone?: boolean;
  planTier: string;
  permissions: { allow_send: boolean; allow_delete: boolean; allow_submissions: boolean } | null;
  posts: PostRow[];
  /** Project the deploy token belongs to. */
  deployProject: string;
  /** exchange-deploy-token refuses with plan_required (owner below Pro+). */
  deployPlanRequired?: boolean;
}

let backend: Backend;
let calls: Call[];
let external: string[];
/** Scripted answers for `{url}` fetches, by full URL; anything else is 404. */
let externalRoutes: Record<string, () => Response>;
/** Addresses lookupHost returns, by hostname; anything else is public. */
let hostAddresses: Record<string, string>;
let exchanges: number;
let logs: string[];
let worker: RemoteWorker;
let client: Client | undefined;
let skewMs: number;

function oauthToken(sub: string, claims: Record<string, unknown> = {}): string {
  return makeJwt({ sub, email: `${sub}@example.com`, exp: Math.floor(Date.now() / 1000) + 3600, client_id: CLIENT_ID, ...claims });
}

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

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

async function route(input: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(input);
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  let body: unknown = init.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      // raw
    }
  }
  calls.push({ method: init.method ?? "GET", url: input, headers, body });

  if (url.origin !== SUPABASE) {
    external.push(input);
    return externalRoutes[input]?.() ?? new Response("nope", { status: 404 });
  }
  if (backend.restUnauthorized && url.pathname.startsWith("/rest/v1/")) return json({ message: "JWT expired" }, 401);
  const bearer = headers.authorization?.replace(/^Bearer /, "") ?? "";
  const sub = (() => {
    try {
      return (JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString()) as { sub?: string }).sub;
    } catch {
      return undefined;
    }
  })();
  switch (url.pathname) {
    case "/auth/v1/user": {
      const state = sub ? backend.users[sub] : undefined;
      if (backend.userGate) await backend.userGate;
      if (state === "ok") return json({ id: sub, email: `${sub}@example.com` });
      if (state === "mismatch") return json({ id: "someone-else", email: "someone-else@example.com" });
      return json({ code: 403, msg: "invalid claim: session not found" }, 403);
    }
    case "/functions/v1/exchange-deploy-token": {
      const req = body as { projectUuid?: string };
      if (backend.deployRevoked || bearer !== DEPLOY_TOKEN || req.projectUuid !== backend.deployProject) return json({ error: "Invalid deploy token" }, 403);
      if (backend.deployProjectGone) return json({ error: "Project not found" }, 404);
      if (backend.deployPlanRequired) return json({ error: "Deploy tokens need the Pro+ plan.", code: "plan_required", required_tier: "pro_plus" }, 403);
      return json({
        access_token: makeJwt({
          sub: "deploy-owner",
          exp: Math.floor(Date.now() / 1000) + 300,
          role: "authenticated",
          n: ++exchanges,
        }),
        expires_in: 300,
        project_id: 7,
      });
    }
    case "/rest/v1/mcp_connection_permissions":
      if (backend.permissionsFail) return json({ message: "boom" }, 500);
      return json(backend.permissions ? [backend.permissions] : []);
    case "/rest/v1/customers":
      return json([{ plan_tier: backend.planTier }]);
    case "/rest/v1/projects":
      return json([PROJECT_ROW]);
    case "/rest/v1/posts": {
      const slug = url.searchParams.get("slug")?.replace(/^eq\./, "");
      return json(slug ? backend.posts.filter((p) => p.slug === slug) : backend.posts);
    }
    case "/rest/v1/forms":
      return json([{ id: FORM_ID, form_name: "Newsletter", is_newsletter: true }]);
    case "/rest/v1/newsletter_subscribers":
      return json(null, 200, { "content-range": "*/3" });
    default:
      throw new Error(`unexpected ${init.method ?? "GET"} ${input}`);
  }
}

function env(overrides: Partial<Env> = {}): Env {
  return {
    RESOURCE_URL: RESOURCE,
    SUPABASE_URL: SUPABASE,
    SUPABASE_ANON_KEY: "anon-key",
    MCP_CONFIRM_KEY: "confirm-key-".repeat(4),
    ...overrides,
  };
}

const call = (path: string, init: RequestInit = {}, e: Env = env()) => worker.fetch(new Request(`https://mcp.example.test${path}`, init), e);

const rpc = (token: string | null, body: unknown, headers: Record<string, string> = {}, e: Env = env()) =>
  call(
    "/mcp",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    },
    e,
  );

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
};

async function connect(token: string, headers: Record<string, string> = {}, e: Env = env(), endpoint = RESOURCE): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
    fetch: (url, init) => worker.fetch(new Request(url, init), e),
    requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } },
  });
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

async function disconnect(): Promise<void> {
  await client?.close();
  client = undefined;
}

const text = (res: { content?: unknown }) => JSON.stringify(res.content);
const userChecks = () => calls.filter((c) => new URL(c.url).pathname === "/auth/v1/user");

beforeEach(() => {
  backend = { users: { "user-a": "ok", "user-b": "ok" }, planTier: "pro", permissions: null, posts: [post()], deployProject: UUID };
  calls = [];
  external = [];
  externalRoutes = {};
  hostAddresses = {};
  exchanges = 0;
  logs = [];
  skewMs = 0;
  worker = createWorker({
    fetch: route,
    now: () => Date.now() + skewMs,
    lookupHost: async (host) => [{ address: hostAddresses[host] ?? "93.184.216.34", family: 4 }],
    log: (line) => logs.push(line),
  });
});
afterEach(disconnect);

describe("routes", () => {
  it("serves protected-resource metadata at both the bare and the path-suffixed well-known URL", async () => {
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const res = await call(path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const doc = (await res.json()) as Record<string, unknown>;
      expect(doc.resource).toBe(RESOURCE);
      expect(doc.authorization_servers).toEqual([`${SUPABASE}/auth/v1`]);
    }
  });

  it("answers /healthz and 404s everything else", async () => {
    expect((await call("/healthz")).status).toBe(200);
    expect((await call("/")).status).toBe(404);
    expect((await call("/.well-known/oauth-authorization-server")).status).toBe(404);
    expect((await call("/mcp/extra")).status).toBe(404);
  });

  it("refuses to serve /mcp without a confirmation key of at least 32 characters", async () => {
    const res = await rpc(oauthToken("user-a"), INIT, {}, env({ MCP_CONFIRM_KEY: "short" }));
    expect(res.status).toBe(500);
  });
});

describe("authentication", () => {
  it("answers a request without a token with 401 and a resource_metadata challenge", async () => {
    const res = await rpc(null, INIT);
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${PRM_URL}"`);
  });

  it("refuses a session JWT without a client_id claim, without asking Supabase", async () => {
    const res = await rpc(oauthToken("user-a", { client_id: undefined }), INIT);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(userChecks()).toHaveLength(0);
  });

  it("refuses a revoked token (/auth/v1/user answers 403) even though the JWT is unexpired", async () => {
    backend.users["user-a"] = "revoked";
    const res = await rpc(oauthToken("user-a"), INIT);
    expect(res.status).toBe(401);
    expect(userChecks()).toHaveLength(1);
  });

  it("refuses an expired token without asking Supabase", async () => {
    const res = await rpc(oauthToken("user-a", { exp: Math.floor(Date.now() / 1000) - 10 }), INIT);
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/expired/);
    expect(userChecks()).toHaveLength(0);
  });

  it("caches a verification for 60 s, then checks again and notices a revocation", async () => {
    const token = oauthToken("user-a");
    expect((await rpc(token, INIT)).status).toBe(200);
    expect((await rpc(token, INIT)).status).toBe(200);
    expect(userChecks()).toHaveLength(1);

    backend.users["user-a"] = "revoked";
    skewMs = 30_000;
    expect((await rpc(token, INIT)).status).toBe(200);
    skewMs = 61_000;
    expect((await rpc(token, INIT)).status).toBe(401);
    expect(userChecks()).toHaveLength(2);
  });

  it("never caches past the token's exp", async () => {
    const token = oauthToken("user-a", { exp: Math.floor(Date.now() / 1000) + 30 });
    expect((await rpc(token, INIT)).status).toBe(200);
    skewMs = 31_000;
    expect((await rpc(token, INIT)).status).toBe(401);
  });

  it("answers 503 when Supabase auth is down, without caching anything", async () => {
    const down = createWorker({ fetch: async () => json({}, 502), log: () => undefined, lookupHost: async () => [] });
    const res = await down.fetch(
      new Request(`${RESOURCE}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${oauthToken("user-a")}` }, body: JSON.stringify(INIT) }),
      env(),
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("refuses a deploy token for another project, and one without the project header", async () => {
    const wrong = await rpc(DEPLOY_TOKEN, INIT, { "x-micropage-project": OTHER_UUID });
    expect(wrong.status).toBe(401);
    expect(wrong.headers.get("www-authenticate")).toContain("resource_metadata=");
    const missing = await rpc(DEPLOY_TOKEN, INIT);
    expect(missing.status).toBe(401);
    expect(await missing.text()).toMatch(/X-Micropage-Project/);
  });

  it("accepts a deploy token for its project, exchanging it once per isolate", async () => {
    const c = await connect(DEPLOY_TOKEN, { "x-micropage-project": UUID });
    const { tools } = await c.listTools();
    expect(tools.length).toBeGreaterThan(0);
    const res = await c.callTool({ name: "list_projects", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not available with a deploy token/);
    expect(text(res)).not.toMatch(/micropage login/);
    expect(calls.filter((x) => x.url.endsWith("/exchange-deploy-token"))).toHaveLength(1);
  });

  it("lets a deploy token whose owner is below Pro+ in, so each tool call reports the plan requirement", async () => {
    backend.deployPlanRequired = true;
    const c = await connect(DEPLOY_TOKEN, { "x-micropage-project": UUID });
    const res = await c.callTool({ name: "get_project", arguments: { project: UUID } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Pro\+ plan[\s\S]*Upgrade at https:\/\/micropage\.sh\/pricing/);
  });
});

describe("serving", () => {
  it("round-trips tools/list with a valid token: 20 tools, upload_asset without {path}", async () => {
    const c = await connect(oauthToken("user-a"));
    const { tools } = await c.listTools();
    expect(tools).toHaveLength(20);
    const upload = tools.find((t) => t.name === "upload_asset")!;
    expect(JSON.stringify(upload.inputSchema)).not.toContain('"path"');
    expect(tools.map((t) => t.name)).not.toContain("delete_project");
    expect(tools.map((t) => t.name)).not.toContain("list_submissions");
    const whoami = tools.find((t) => t.name === "whoami")!;
    expect(whoami.description).not.toMatch(/micropage login/);
    expect(whoami.description).toMatch(/reconnect/);
  });

  it("also serves the 2025 stateless handshake, and answers GET and DELETE with 405", async () => {
    const token = oauthToken("user-a");
    const init = await rpc(token, INIT);
    expect(init.status).toBe(200);
    expect(await init.text()).toContain('"serverInfo"');
    for (const method of ["GET", "DELETE"]) {
      const res = await call("/mcp", { method, headers: { authorization: `Bearer ${token}`, accept: "text/event-stream" } });
      expect(res.status, method).toBe(405);
    }
  });

  it("with no permissions row: publish_post refuses to email (pointing at Connected AI apps) and delete_project is absent", async () => {
    backend.posts = [post({ email_enabled: true, form_id: FORM_ID })];
    const c = await connect(oauthToken("user-a"));
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("delete_project");

    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token: "x.y" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Let it send newsletter emails/);
    expect(text(res)).toMatch(/app\.micropage\.sh\/account\/connected-apps/);
    expect(text(res)).not.toMatch(/MICROPAGE_MCP_ALLOW_SEND/);
    expect(calls.some((x) => x.url.includes("/functions/v1/publish-post"))).toBe(false);

    const preview = (await c.listTools()).tools.find((t) => t.name === "preview_post_send")!;
    expect(preview.description).not.toMatch(/MICROPAGE_MCP_ALLOW_SEND/);
  });

  it("with a permissions row allowing delete: delete_project is registered", async () => {
    backend.permissions = { allow_send: false, allow_delete: true, allow_submissions: false };
    const c = await connect(oauthToken("user-a"));
    const tools = (await c.listTools()).tools;
    const del = tools.find((t) => t.name === "delete_project");
    expect(del).toBeDefined();
    expect(del!.description).toMatch(/Let it delete projects/);
    expect(tools.map((t) => t.name)).not.toContain("list_submissions");
    const permissionReads = calls.filter((x) => x.url.includes("/rest/v1/mcp_connection_permissions"));
    expect(permissionReads[0]!.url).toContain(`oauth_client_id=eq.${CLIENT_ID}`);
    expect(permissionReads[0]!.url).toContain("user_id=eq.user-a");
  });

  it("rejects user A's confirmation token when user B presents it", async () => {
    const a = await connect(oauthToken("user-a"));
    const preview = await a.callTool({ name: "preview_post_send", arguments: { project: "acme", slug: "hello" } });
    expect(preview.isError, text(preview)).toBeFalsy();
    const token = (preview.structuredContent as { confirmation_token: string }).confirmation_token;
    await disconnect();

    const b = await connect(oauthToken("user-b"));
    const res = await b.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token: token } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/another session or account/);
    expect(calls.some((x) => x.url.includes("/functions/v1/publish-post"))).toBe(false);
  });

  it("refuses a {url} upload from our own infrastructure without fetching it", async () => {
    const c = await connect(oauthToken("user-a"));
    for (const url of ["https://build-compiler.micropage.sh/x.png", "https://fallback.micropage.sh/x.png", "https://sb.example.test/x.png"]) {
      const res = await c.callTool({ name: "upload_asset", arguments: { project: "acme", filename: "x.png", source: { url } } });
      expect(res.isError, url).toBe(true);
      expect(text(res)).toMatch(/not fetched by this server/);
    }
    expect(external).toEqual([]);
    expect(DENIED_HOSTS.exact).toContain("build-compiler.micropage.sh");
  });

  it("gives a free-plan user a plan error from the tool, not an HTTP refusal", async () => {
    backend.planTier = "free";
    const c = await connect(oauthToken("user-a"));
    const res = await c.callTool({ name: "list_projects", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/paid plans only/);
    expect(text(res)).toMatch(/micropage\.sh\/pricing/);
    expect(logs.some((l) => (JSON.parse(l) as { error_code?: string }).error_code === "PLAN_REQUIRED")).toBe(true);
  });

  it("refuses a body over 6 MiB with 413", async () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(6 * 1024 * 1024);
    const res = await call("/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${oauthToken("user-a")}` },
      body: JSON.stringify({ ...INIT, pad: "x".repeat(MAX_REQUEST_BODY_BYTES + 1) }),
    });
    expect(res.status).toBe(413);
  });
});

describe("origin and rate limits", () => {
  it("lets Origin-less clients through, refuses an unlisted browser Origin, and adds CORS for a listed one", async () => {
    const token = oauthToken("user-a");
    expect((await rpc(token, INIT, { origin: "https://evil.example" })).status).toBe(403);
    const allowed = await rpc(token, INIT, { origin: "https://claude.ai" }, env({ ALLOWED_ORIGINS: "claude.ai" }));
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    const preflight = await call("/mcp", { method: "OPTIONS", headers: { origin: "https://claude.ai" } }, env({ ALLOWED_ORIGINS: "claude.ai" }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-expose-headers")).toMatch(/WWW-Authenticate/);
  });

  it("answers 429 with Retry-After once the per-user limiter refuses, keyed by sub", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = { limit: async ({ key }) => (keys.push(key), { success: keys.length < 3 }) };
    const e = env({ USER_LIMITER: limiter });
    const token = oauthToken("user-a");
    expect((await rpc(token, INIT, {}, e)).status).toBe(200);
    expect((await rpc(token, INIT, {}, e)).status).toBe(200);
    const limited = await rpc(token, INIT, {}, e);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    expect(keys).toEqual(["sub:user-a", "sub:user-a", "sub:user-a"]);
  });

  it("counts presented-but-bad credentials per IP and answers 429 past the limit", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = { limit: async ({ key }) => (keys.push(key), { success: keys.length < 2 }) };
    const e = env({ IP_LIMITER: limiter });
    // Bare discovery requests (no Authorization) are never counted: hosted clients share egress IPs.
    for (let i = 0; i < 3; i++) {
      expect((await rpc(null, INIT, { "cf-connecting-ip": "203.0.113.9" }, e)).status).toBe(401);
    }
    expect(keys).toEqual([]);
    expect((await rpc("not-a-valid-token", INIT, { "cf-connecting-ip": "203.0.113.9" }, e)).status).toBe(401);
    expect((await rpc("not-a-valid-token", INIT, { "cf-connecting-ip": "203.0.113.9" }, e)).status).toBe(429);
    expect(keys).toEqual(["ip:203.0.113.9", "ip:203.0.113.9"]);
  });

  it("checks the per-IP limit before verification, so an over-limit IP never reaches Supabase", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = { limit: async ({ key }) => (keys.push(key), { success: false }) };
    const e = env({ IP_LIMITER: limiter });
    const ip = { "cf-connecting-ip": "203.0.113.9" };
    const presented: Array<[string, Record<string, string>]> = [
      [oauthToken("user-a"), {}],
      [DEPLOY_TOKEN, { "x-micropage-project": UUID }],
      ["not-a-valid-token", {}],
    ];
    for (const [token, headers] of presented) {
      const res = await rpc(token, INIT, { ...ip, ...headers }, e);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("60");
      await res.text();
    }
    expect(calls).toHaveLength(0);
    expect(keys).toEqual(["ip:203.0.113.9", "ip:203.0.113.9", "ip:203.0.113.9"]);
    // A bare request stays uncounted even from an over-limit IP.
    expect((await rpc(null, INIT, ip, e)).status).toBe(401);
    expect(keys).toHaveLength(3);
    expect(logs.filter((l) => (JSON.parse(l) as { error_code?: string }).error_code === "rate_limited")).toHaveLength(3);
  });

  it("does not count credentials this isolate has already verified", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = { limit: async ({ key }) => (keys.push(key), { success: true }) };
    const e = env({ IP_LIMITER: limiter });
    const token = oauthToken("user-a");
    for (let i = 0; i < 3; i++) expect((await rpc(token, INIT, {}, e)).status).toBe(200);
    expect(keys).toHaveLength(1);
    expect(userChecks()).toHaveLength(1);

    for (let i = 0; i < 3; i++) expect((await rpc(DEPLOY_TOKEN, INIT, { "x-micropage-project": UUID }, e)).status).toBe(200);
    expect(keys).toHaveLength(2);
    expect(calls.filter((x) => x.url.endsWith("/exchange-deploy-token"))).toHaveLength(1);

    // Once the verification has expired, the next check is an upstream call again and counts.
    skewMs = 61_000;
    expect((await rpc(token, INIT, {}, e)).status).toBe(200);
    expect(keys).toHaveLength(3);
    expect(userChecks()).toHaveLength(2);
  });

  it("does not limit when the bindings are absent or failing", async () => {
    const broken: RateLimiter = { limit: async () => Promise.reject(new Error("binding down")) };
    expect((await rpc(oauthToken("user-a"), INIT, {}, env({ USER_LIMITER: broken }))).status).toBe(200);
  });
});

describe("logging", () => {
  it("writes one structured line per request with hashed ids and no token, header or body", async () => {
    const token = oauthToken("user-a");
    const marker = "SECRET-BODY-MARKER-1234";
    const c = await connect(token);
    await c.callTool({ name: "upload_asset", arguments: { project: "acme", filename: "x.png", source: { base64: Buffer.from(marker).toString("base64") } } });
    await c.callTool({ name: "get_page_source", arguments: { project: marker } });
    await disconnect();
    // The line is written once the body has been sent, so read it as the runtime would.
    await (await rpc(DEPLOY_TOKEN, INIT, { "x-micropage-project": OTHER_UUID })).text();
    await (await rpc("not-a-jwt-" + marker, INIT)).text();

    const all = logs.join("\n");
    expect(logs.length).toBeGreaterThan(3);
    for (const secret of [token, token.split(".")[1]!, DEPLOY_TOKEN, marker, Buffer.from(marker).toString("base64"), "user-a", CLIENT_ID, "Bearer"]) {
      expect(all, secret).not.toContain(secret);
    }
    const entries = logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    const toolCall = entries.find((e) => e.tool === "upload_asset");
    expect(toolCall).toMatchObject({ event: "request", route: "mcp", method: "tools/call", status: 200, auth: "oauth" });
    expect(toolCall!.sub_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(toolCall!.client_hash).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof toolCall!.latency_ms).toBe("number");
    expect(entries.some((e) => e.status === 401 && e.error_code === "invalid_token")).toBe(true);
  });
});

describe("dohLookup", () => {
  it("returns A and AAAA answers, skipping CNAMEs, and treats NXDOMAIN as no addresses", async () => {
    const seen: string[] = [];
    const lookup = dohLookup(async (url) => {
      seen.push(url);
      const type = new URL(url).searchParams.get("type");
      if (new URL(url).searchParams.get("name") === "nope.example") return json({ Status: 3 });
      return json({
        Status: 0,
        Answer:
          type === "A"
            ? [{ type: 5, data: "cdn.example." }, { type: 1, data: "93.184.216.34" }]
            : [{ type: 28, data: "2606:2800:220:1::1" }],
      });
    });
    expect(await lookup("img.example")).toEqual([
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
    expect(seen.every((u) => u.startsWith("https://cloudflare-dns.com/dns-query?name=img.example"))).toBe(true);
    expect(await lookup("nope.example")).toEqual([]);
    await expect(dohLookup(async () => json({}, 500))("x.example")).rejects.toThrow(/HTTP 500/);
  });
});

describe("configuration", () => {
  it("refuses to serve /mcp or the metadata while RESOURCE_URL is the placeholder or not https", async () => {
    const cases: Array<[string, string]> = [
      ["https://micropage-mcp-remote.REPLACE-WITH-ACCOUNT-SUBDOMAIN.workers.dev/mcp", "RESOURCE_URL_PLACEHOLDER"],
      ["http://mcp.example.test/mcp", "RESOURCE_URL_NOT_HTTPS"],
      ["not a url", "RESOURCE_URL_INVALID"],
    ];
    for (const [resource, code] of cases) {
      logs = [];
      const e = env({ RESOURCE_URL: resource });
      const mcp = await rpc(oauthToken("user-a"), INIT, {}, e);
      expect(mcp.status, resource).toBe(500);
      await mcp.text();
      for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        const prm = await call(path, {}, e);
        expect(prm.status, `${resource} ${path}`).toBe(500);
        expect(await prm.text()).not.toContain("REPLACE");
      }
      const configErrors = logs.map((l) => JSON.parse(l) as Record<string, unknown>).filter((x) => x.event === "config_error");
      expect(configErrors, resource).toHaveLength(3);
      expect(configErrors.every((x) => x.error_code === code), resource).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("answers a non-GET on the metadata with 405 and an Allow header that includes HEAD", async () => {
    const res = await call("/.well-known/oauth-protected-resource", { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect((await call("/.well-known/oauth-protected-resource", { method: "HEAD" })).status).toBe(200);
  });

  it("logs a non-standard HTTP method as other", async () => {
    await (await call("/healthz", { method: "PROPFIND" })).text();
    await (await call("/healthz", { method: "HEAD" })).text();
    const methods = logs.map((l) => (JSON.parse(l) as { http_method?: string }).http_method);
    expect(methods).toEqual(["other", "HEAD"]);
    expect(logs.join("\n")).not.toContain("PROPFIND");
  });

  it("denies {url} uploads from the host the request arrived at, not only the RESOURCE_URL host", async () => {
    const workersDev = "micropage-mcp-remote.acct.workers.dev";
    const denied = deniedHostsFor(env({ RESOURCE_URL: "https://mcp.micropage.sh/mcp" }), workersDev);
    expect(denied.exact).toEqual(expect.arrayContaining([workersDev, "mcp.micropage.sh", "sb.example.test"]));

    const c = await connect(oauthToken("user-a"), {}, env(), `https://${workersDev}/mcp`);
    const res = await c.callTool({ name: "upload_asset", arguments: { project: "acme", filename: "x.png", source: { url: `https://${workersDev}/x.png` } } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/not fetched by this server/);
    expect(external).toEqual([]);
  });
});

describe("verification edges", () => {
  it("refuses a token whose /auth/v1/user id differs from its sub, and does not cache it", async () => {
    backend.users["user-a"] = "mismatch";
    const token = oauthToken("user-a");
    const first = await rpc(token, INIT);
    expect(first.status).toBe(401);
    expect(await first.text()).toMatch(/does not match its user/);
    expect((await rpc(token, INIT)).status).toBe(401);
    expect(userChecks()).toHaveLength(2);
  });

  it("makes one upstream check for concurrent requests with the same token", async () => {
    let release!: () => void;
    backend.userGate = new Promise<void>((resolve) => (release = resolve));
    const token = oauthToken("user-a");
    const pending = [rpc(token, INIT), rpc(token, INIT), rpc(token, INIT)];
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const responses = await Promise.all(pending);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(userChecks()).toHaveLength(1);
  });
});

describe("permissions", () => {
  it("treats a failed permissions read as everything off, logs it, and does not cache it", async () => {
    backend.permissionsFail = true;
    backend.posts = [post({ email_enabled: true, form_id: FORM_ID })];
    const c = await connect(oauthToken("user-a"));
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain("delete_project");
    expect(names).not.toContain("list_submissions");
    const res = await c.callTool({ name: "publish_post", arguments: { project: "acme", slug: "hello", confirmation_token: "x.y" } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Let it send newsletter emails/);
    expect(calls.filter((x) => x.url.includes("/rest/v1/mcp_connection_permissions")).length).toBeGreaterThan(1);
    expect(logs.some((l) => (JSON.parse(l) as { event?: string }).event === "permissions_error")).toBe(true);
  });

  it("registers list_submissions only when the row allows submissions", async () => {
    backend.permissions = { allow_send: true, allow_delete: true, allow_submissions: false };
    let c = await connect(oauthToken("user-a"));
    expect((await c.listTools()).tools.map((t) => t.name)).not.toContain("list_submissions");
    await disconnect();

    backend.permissions = { allow_send: false, allow_delete: false, allow_submissions: true };
    c = await connect(oauthToken("user-b"));
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("list_submissions");
  });
});

describe("uploads on the hosted server", () => {
  const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const pngOf = (size: number) => {
    const bytes = new Uint8Array(size);
    bytes.set(PNG_HEAD);
    return bytes;
  };

  it("advertises a 4 MB cap and prefers {url}", async () => {
    expect(REMOTE_MAX_ASSET_BYTES).toBe(4 * 1024 * 1024);
    const c = await connect(oauthToken("user-a"));
    const upload = (await c.listTools()).tools.find((t) => t.name === "upload_asset")!;
    expect(upload.description).toMatch(/max 4 MB/);
    expect(upload.description).not.toMatch(/10 MB/);
    expect(upload.description).toContain(REMOTE_OAUTH_HINTS.uploadSourceNote);
    const schema = JSON.stringify(upload.inputSchema);
    expect(schema).toContain("Max 4 MB");
    expect(schema).toContain('"maxLength":6000000');
  });

  it("refuses base64 over 4 MB before anything is uploaded", async () => {
    const c = await connect(oauthToken("user-a"));
    const base64 = Buffer.from(pngOf(REMOTE_MAX_ASSET_BYTES + 1)).toString("base64");
    const res = await c.callTool({ name: "upload_asset", arguments: { project: "acme", filename: "big.png", source: { base64 } } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/the limit is 4\.00 MB/);
    expect(calls.some((x) => x.url.includes("/functions/v1/"))).toBe(false);
  });

  it("refuses a {url} image over 4 MB while reading it", async () => {
    externalRoutes["https://img.example/big.png"] = () => new Response(pngOf(REMOTE_MAX_ASSET_BYTES + 1), { headers: { "content-type": "image/png" } });
    const c = await connect(oauthToken("user-a"));
    const res = await c.callTool({ name: "upload_asset", arguments: { project: "acme", filename: "big.png", source: { url: "https://img.example/big.png" } } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/4\.00 MB/);
    expect(calls.some((x) => x.url.includes("/functions/v1/"))).toBe(false);
  });

  it("refuses a {url} that redirects to a denied, private or privately resolving hop, without fetching it", async () => {
    const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } });
    externalRoutes["https://img.example/denied.png"] = redirect("https://fallback.micropage.sh/x.png");
    externalRoutes["https://img.example/self.png"] = redirect("https://mcp.example.test/x.png");
    externalRoutes["https://img.example/literal.png"] = redirect("https://10.0.0.1/x.png");
    externalRoutes["https://img.example/resolves.png"] = redirect("https://intranet.example/x.png");
    hostAddresses["intranet.example"] = "192.168.1.10";

    const c = await connect(oauthToken("user-a"));
    const cases: Array<[string, RegExp]> = [
      ["denied", /not fetched by this server/],
      ["self", /not fetched by this server/],
      ["literal", /private, local or reserved address \(10\.0\.0\.1\)/],
      ["resolves", /private, local or reserved address \(192\.168\.1\.10\)/],
    ];
    for (const [name, message] of cases) {
      const res = await c.callTool({
        name: "upload_asset",
        arguments: { project: "acme", filename: "x.png", source: { url: `https://img.example/${name}.png` } },
      });
      expect(res.isError, name).toBe(true);
      expect(text(res), name).toMatch(message);
    }
    expect(external).toEqual(cases.map(([name]) => `https://img.example/${name}.png`));
  });
});

describe("hosted wording for login and deploy-token failures", () => {
  const noStdio = (s: string) => {
    expect(s).not.toMatch(/micropage login/);
    expect(s).not.toMatch(/MICROPAGE_/);
  };

  it("deploy token revoked mid-session: the re-exchange failure points at the connector settings", async () => {
    const c = await connect(DEPLOY_TOKEN, { "x-micropage-project": UUID });
    backend.restUnauthorized = true;
    backend.deployRevoked = true;
    const res = await c.callTool({ name: "get_project", arguments: { project: UUID } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(REMOTE_DEPLOY_TOKEN_HINTS.deployTokenCheck);
    noStdio(text(res));
  });

  it("deploy token whose project is gone: the re-exchange failure points at the X-Micropage-Project header", async () => {
    const c = await connect(DEPLOY_TOKEN, { "x-micropage-project": UUID });
    backend.restUnauthorized = true;
    backend.deployProjectGone = true;
    const res = await c.callTool({ name: "get_project", arguments: { project: UUID } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(REMOTE_DEPLOY_TOKEN_HINTS.deployProjectCheck);
    noStdio(text(res));
  });

  it("deploy token: a 401 after a successful re-exchange names the connector settings", async () => {
    const c = await connect(DEPLOY_TOKEN, { "x-micropage-project": UUID });
    backend.restUnauthorized = true;
    const res = await c.callTool({ name: "get_project", arguments: { project: UUID } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain(REMOTE_DEPLOY_TOKEN_HINTS.sessionInvalid);
    noStdio(text(res));
    expect(exchanges).toBe(2);
  });

  it("OAuth: a token the API rejects asks for a reconnect", async () => {
    const c = await connect(oauthToken("user-a"));
    backend.restUnauthorized = true;
    const res = await c.callTool({ name: "list_projects", arguments: {} });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/reconnect/);
    noStdio(text(res));
  });
});
