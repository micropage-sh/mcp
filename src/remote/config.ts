import type { HostDenylist } from "../client/assets.js";
import { loadConfig, type MicropageConfig } from "../client/config.js";

/** The Workers rate limiting binding (`[[ratelimits]]` in wrangler.toml). */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Bindings and vars from wrangler.toml, plus secrets set with `wrangler secret put`. */
export interface Env {
  /** Public URL of the MCP endpoint, e.g. https://mcp.micropage.sh/mcp; the PRM `resource`. */
  RESOURCE_URL: string;
  SUPABASE_URL: string;
  /** Public anon key (the same one the editor and CLI ship). */
  SUPABASE_ANON_KEY: string;
  /** Secret, at least 32 characters: signs preview_post_send confirmation tokens. */
  MCP_CONFIRM_KEY?: string;
  /** Comma-separated browser Origin hostnames allowed to call /mcp. Requests without an Origin always pass. */
  ALLOWED_ORIGINS?: string;
  /** OpenAI apps domain-verification token, served at /.well-known/openai-apps-challenge; unset or empty serves 404. */
  OPENAI_APPS_CHALLENGE?: string;
  APP_URL?: string;
  BUILD_COMPILER_URL?: string;
  BASE_DOMAIN?: string;
  /** 120 requests / 60 s per user (or per deploy token). */
  USER_LIMITER?: RateLimiter;
  /**
   * 30 requests / 60 s per client IP, counted on every presented credential
   * this isolate has not verified yet, before the upstream check.
   */
  IP_LIMITER?: RateLimiter;
}

export const MCP_PATH = "/mcp";

/**
 * Largest upload_asset accepts here (stdio keeps MAX_ASSET_BYTES). An isolate
 * has 128 MB, and a base64 upload is held as request text, parsed JSON, the
 * decoded bytes and the multipart body at once, so a few concurrent 10 MB
 * uploads would exhaust it. `{url}` sources share the cap.
 */
export const REMOTE_MAX_ASSET_BYTES = 4 * 1024 * 1024;

/**
 * Upper bound on a POST body: a REMOTE_MAX_ASSET_BYTES image as base64
 * (about 5.33 MiB of text) plus the JSON-RPC envelope.
 */
export const MAX_REQUEST_BODY_BYTES = 6 * 1024 * 1024;

/**
 * Our own infrastructure, which a `{url}` upload must never fetch: these
 * hosts are public, so the private-address check alone would let a
 * model-supplied URL reach them from inside our account. Customer sites under
 * *.micropage.sh stay fetchable on purpose (re-uploading an image from one's
 * own site is legitimate).
 */
export const DENIED_HOSTS = Object.freeze({
  exact: ["build-compiler.micropage.sh", "parser.micropage.sh", "micropage-publisher.blckshp.xyz"],
  suffixes: ["fallback.micropage.sh", "cname.micropage.sh", "mcp.micropage.sh", "blckshp.xyz"],
});

/**
 * DENIED_HOSTS plus the Supabase project, the RESOURCE_URL host, and the host
 * this request actually arrived at (the workers.dev name while RESOURCE_URL
 * already names the Custom Domain, or the other way round).
 */
export function deniedHostsFor(env: Env, requestHost?: string): HostDenylist {
  const exact = [...DENIED_HOSTS.exact];
  for (const url of [env.SUPABASE_URL, env.RESOURCE_URL]) {
    try {
      exact.push(new URL(url).hostname);
    } catch {
      // a malformed var is reported where it is used
    }
  }
  if (requestHost) exact.push(requestHost);
  return { exact, suffixes: [...DENIED_HOSTS.suffixes] };
}

/**
 * Why RESOURCE_URL cannot be served, or null when it can. The placeholder
 * from wrangler.toml would be published as the protected resource, so
 * clients would request tokens for a host that does not exist.
 */
export function resourceUrlProblem(env: Env): string | null {
  let url: URL;
  try {
    url = new URL(env.RESOURCE_URL);
  } catch {
    return "RESOURCE_URL_INVALID";
  }
  if (/REPLACE/i.test(env.RESOURCE_URL)) return "RESOURCE_URL_PLACEHOLDER";
  if (url.protocol !== "https:") return "RESOURCE_URL_NOT_HTTPS";
  return null;
}

export function remoteConfig(env: Env): MicropageConfig {
  const vars: Record<string, string | undefined> = {
    MICROPAGE_SUPABASE_URL: env.SUPABASE_URL,
    MICROPAGE_SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
    MICROPAGE_APP_URL: env.APP_URL,
    MICROPAGE_BUILD_COMPILER_URL: env.BUILD_COMPILER_URL,
    MICROPAGE_BASE_DOMAIN: env.BASE_DOMAIN,
  };
  return loadConfig(vars);
}

export function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}
