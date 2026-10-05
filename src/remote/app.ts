import {
  OAuthError,
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  isJsonContentType,
  readRequestBody,
  validateOriginHeader,
  verifyBearerToken,
  type AuthInfo,
  type OAuthProtectedResourceMetadata,
} from "@modelcontextprotocol/server";

import type { HostLookup } from "../client/assets.js";
import type { FetchLike } from "../client/http.js";
import { PlanTierCache } from "../client/tier.js";
import type { ServerDeps } from "../context.js";
import { createServer, SERVER_NAME } from "../server.js";
import { VERSION } from "../version.js";
import { MAX_REQUEST_BODY_BYTES, MCP_PATH, allowedOrigins, remoteConfig, type Env } from "./config.js";
import { depsFor, type RemoteShared } from "./deps.js";
import { dohLookup } from "./doh.js";
import { createLogger, errorFacts, shortHash, type LogSink, type RequestLogEntry } from "./log.js";
import { PermissionStore } from "./permissions.js";
import { overLimit, tooManyRequests } from "./rate-limit.js";
import { DeployTokenVerifier, OAuthAccessTokenVerifier, UpstreamUnavailable, requestVerifier, type VerifiedAuth } from "./verifier.js";

export interface WorkerOptions {
  /** Every outbound call: Supabase, the build compiler, DNS-over-HTTPS and `{url}` uploads (tests). */
  fetch?: FetchLike;
  now?: () => number;
  /** Replaces the DNS-over-HTTPS resolver for `{url}` uploads (tests). */
  lookupHost?: HostLookup;
  log?: LogSink;
}

export interface RemoteWorker {
  fetch(request: Request, env: Env, ctx?: unknown): Promise<Response>;
  /** Drops every per-isolate cache (tests). */
  reset(): void;
}

const PRM_PATH = "/.well-known/oauth-protected-resource";
const CONFIRM_KEY_MIN_LENGTH = 32;

/**
 * The hosted MCP server: OAuth protected-resource metadata, a health check,
 * and /mcp, which validates the Origin, verifies the bearer, rate-limits, and
 * serves one stateless request from a per-request server instance.
 */
export function createWorker(options: WorkerOptions = {}): RemoteWorker {
  // A bare `fetch` stored on an object and called as a method throws
  // "Illegal invocation" on Workers, so always go through a closure.
  const fetchImpl: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? Date.now;
  const logger = createLogger(options.log);
  const shared: RemoteShared = {
    fetch: fetchImpl,
    now,
    lookupHost: options.lookupHost ?? dohLookup(fetchImpl),
    tierCache: new PlanTierCache(),
    permissions: new PermissionStore(now),
  };
  let verifiers: { key: string; oauth: OAuthAccessTokenVerifier; deploy: DeployTokenVerifier } | null = null;
  const verifiersFor = (env: Env) => {
    const config = remoteConfig(env);
    const key = `${config.supabaseUrl}\n${config.supabaseAnonKey}`;
    if (verifiers?.key !== key) {
      const base = { config, fetch: fetchImpl, now };
      verifiers = { key, oauth: new OAuthAccessTokenVerifier(base), deploy: new DeployTokenVerifier(base) };
    }
    return verifiers;
  };

  const handler = createMcpHandler(
    (ctx) => {
      const deps = ctx.authInfo?.extra?.deps as ServerDeps | undefined;
      if (!deps) throw new Error("An unauthenticated request reached the MCP handler.");
      return createServer(ctx, deps);
    },
    {
      legacy: "stateless",
      maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
      onerror: (err) => logger.log({ event: "sdk_error", ...errorFacts(err) }),
    },
  );

  async function serveMcp(request: Request, env: Env, entry: RequestLogEntry): Promise<Response> {
    const origin = request.headers.get("origin");
    const originCheck = validateOriginHeader(origin, allowedOrigins(env));
    if (!originCheck.ok) {
      entry.error_code = originCheck.errorCode;
      return Response.json(
        { jsonrpc: "2.0", error: { code: -32000, message: "Forbidden: this Origin may not call the micropage MCP server." }, id: null },
        { status: 403 },
      );
    }
    const cors = origin ? corsHeaders(origin, request) : null;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors ?? {} });

    const resourceMetadataUrl = prmUrl(env);
    if (!resourceMetadataUrl || !env.MCP_CONFIRM_KEY || env.MCP_CONFIRM_KEY.length < CONFIRM_KEY_MIN_LENGTH) {
      logger.log({ event: "config_error", error_code: !resourceMetadataUrl ? "RESOURCE_URL" : "MCP_CONFIRM_KEY" });
      entry.error_code = "misconfigured";
      return withCors(Response.json({ error: "server_error", error_description: "The server is misconfigured." }, { status: 500 }), cors);
    }

    let authInfo: AuthInfo;
    const { oauth, deploy } = verifiersFor(env);
    try {
      authInfo = await verifyBearerToken(request.headers.get("authorization"), {
        verifier: requestVerifier(request, oauth, deploy),
        resourceMetadataUrl,
      });
    } catch (err) {
      if (err instanceof UpstreamUnavailable) {
        entry.error_code = "upstream_unavailable";
        return withCors(
          Response.json({ error: "temporarily_unavailable", error_description: "micropage could not check the token. Retry shortly." }, { status: 503, headers: { "Retry-After": "5" } }),
          cors,
        );
      }
      entry.error_code = err instanceof OAuthError ? String(err.code) : "auth_failed";
      if (await overLimit(env.IP_LIMITER, `ip:${request.headers.get("cf-connecting-ip") ?? "unknown"}`)) {
        entry.error_code = "rate_limited";
        return withCors(tooManyRequests(), cors);
      }
      return withCors(bearerAuthChallengeResponse(err, { resourceMetadataUrl }), cors);
    }

    const verified = authInfo.extra?.verified as VerifiedAuth;
    entry.auth = verified.kind;
    if (verified.kind === "oauth") {
      entry.sub_hash = await shortHash(verified.sub);
      entry.client_hash = await shortHash(verified.clientId);
    } else if (verified.sub) {
      entry.sub_hash = await shortHash(verified.sub);
    }

    const userKey = verified.kind === "oauth" ? `sub:${verified.sub}` : `deploy:${verified.tokenHash}`;
    if (await overLimit(env.USER_LIMITER, userKey)) {
      entry.error_code = "rate_limited";
      return withCors(tooManyRequests(), cors);
    }

    let forward = request;
    let parsedBody: unknown;
    if (request.method === "POST" && isJsonContentType(request.headers.get("content-type"))) {
      let text: string;
      try {
        const read = await readRequestBody(request, MAX_REQUEST_BODY_BYTES);
        if (read.tooLarge) {
          entry.error_code = "body_too_large";
          return withCors(
            Response.json(
              { jsonrpc: "2.0", error: { code: -32000, message: `Request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes.` }, id: null },
              { status: 413 },
            ),
            cors,
          );
        }
        text = read.text;
      } catch {
        entry.error_code = "unreadable_body";
        return withCors(Response.json({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error: the request body could not be read" }, id: null }, { status: 400 }), cors);
      }
      try {
        parsedBody = text ? JSON.parse(text) : undefined;
      } catch {
        parsedBody = undefined;
      }
      Object.assign(entry, describeRpc(parsedBody));
      // The body stream is spent; an unparsed body goes on as text so the SDK can answer it.
      if (parsedBody === undefined) forward = new Request(request.url, { method: request.method, headers: request.headers, body: text });
    }

    const deps = await depsFor(verified, env, shared, {
      onPermissionsError: (err) => logger.log({ event: "permissions_error", sub_hash: entry.sub_hash, ...errorFacts(err) }),
      onToolError: (_tool, err) => {
        entry.error_code = errorFacts(err).error_code ?? "tool_error";
      },
    });
    const response = await handler.fetch(forward, {
      authInfo: { ...authInfo, extra: { ...authInfo.extra, deps } },
      ...(parsedBody !== undefined ? { parsedBody } : {}),
    });
    return withCors(response, cors);
  }

  return {
    async fetch(request, env) {
      const started = now();
      const url = new URL(request.url);
      const entry: RequestLogEntry = { event: "request", route: routeName(url.pathname), http_method: request.method };
      let response: Response;
      try {
        if (url.pathname === MCP_PATH) {
          response = await serveMcp(request, env, entry);
        } else if (url.pathname === PRM_PATH || url.pathname === `${PRM_PATH}${MCP_PATH}`) {
          response = protectedResourceMetadata(request, env);
        } else if (url.pathname === "/healthz" && (request.method === "GET" || request.method === "HEAD")) {
          response = Response.json({ ok: true, name: SERVER_NAME, version: VERSION });
        } else {
          response = Response.json({ error: "not_found" }, { status: 404 });
        }
      } catch (err) {
        Object.assign(entry, errorFacts(err));
        response = Response.json({ error: "server_error" }, { status: 500 });
      }
      entry.status = response.status;
      // A stateless 2025-era call answers with an SSE stream before the tool
      // has run, so the line is written once the body is done, when a tool
      // error code (set through onToolError) is known.
      return afterBody(response, () => {
        entry.latency_ms = Math.max(0, now() - started);
        logger.log(entry);
      });
    },
    reset() {
      shared.tierCache.clear();
      shared.permissions.clear();
      verifiers = null;
    },
  };
}

/** Calls `done` once the response body has been fully sent, failed or been cancelled. */
function afterBody(response: Response, done: () => void): Response {
  if (!response.body) {
    done();
    return response;
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    done();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) {
          controller.close();
          finish();
        } else {
          controller.enqueue(chunk.value);
        }
      } catch (err) {
        controller.error(err);
        finish();
      }
    },
    cancel(reason) {
      finish();
      return reader.cancel(reason);
    },
  });
  return new Response(body, response);
}

/** A fixed label, never the raw path, which is caller-controlled. */
function routeName(path: string): string {
  if (path === MCP_PATH) return "mcp";
  if (path === PRM_PATH || path === `${PRM_PATH}${MCP_PATH}`) return "prm";
  if (path === "/healthz") return "healthz";
  return "other";
}

function prmUrl(env: Env): string | null {
  try {
    return getOAuthProtectedResourceMetadataUrl(new URL(env.RESOURCE_URL));
  } catch {
    return null;
  }
}

export function buildMetadata(env: Env): OAuthProtectedResourceMetadata {
  const issuer = `${remoteConfig(env).supabaseUrl}/auth/v1`;
  return buildOAuthProtectedResourceMetadata({
    // Only the issuer is read; Supabase serves the full AS metadata itself.
    oauthMetadata: {
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      response_types_supported: ["code"],
    },
    resourceServerUrl: new URL(env.RESOURCE_URL),
    resourceName: "micropage",
    serviceDocumentationUrl: new URL("https://docs.micropage.sh/docs/mcp/overview/"),
  });
}

/** RFC 9728 metadata. Public and cacheable, so any origin may read it. */
function protectedResourceMetadata(request: Request, env: Env): Response {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return Response.json({ error: "method_not_allowed" }, { status: 405, headers: { ...cors, Allow: "GET, OPTIONS" } });
  }
  return Response.json(buildMetadata(env), { headers: { ...cors, "Cache-Control": "public, max-age=3600" } });
}

function corsHeaders(origin: string, request: Request): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      request.headers.get("access-control-request-headers") ??
      "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID, X-Micropage-Project",
    "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Retry-After",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

function withCors(response: Response, cors: Record<string, string> | null): Response {
  if (!cors) return response;
  // Responses from fetch (and some from the SDK) have immutable headers.
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
  return out;
}

const SAFE_METHOD = /^[a-zA-Z][a-zA-Z0-9_/]{0,63}$/;
const SAFE_TOOL = /^[a-z][a-z0-9_]{0,63}$/;

/** JSON-RPC method and tool name, for the log; nothing else is read from the body. */
function describeRpc(body: unknown): Pick<RequestLogEntry, "method" | "tool"> {
  if (Array.isArray(body)) return { method: "batch" };
  if (!body || typeof body !== "object") return {};
  const msg = body as { method?: unknown; params?: { name?: unknown } };
  if (typeof msg.method !== "string") return {};
  // Only identifier-shaped names are logged, so a crafted method or tool name cannot carry content into the logs.
  const method = SAFE_METHOD.test(msg.method) ? msg.method : "other";
  if (msg.method !== "tools/call") return { method };
  const name = msg.params?.name;
  return { method, tool: typeof name === "string" && SAFE_TOOL.test(name) ? name : "other" };
}
