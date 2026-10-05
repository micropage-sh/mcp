/**
 * Structured request logs for the hosted server. Only these fields are ever
 * written: identifiers are hashed, and nothing from the Authorization header,
 * the request body or the response body reaches a log line. Error details are
 * reduced to a name and a code, because error messages can quote input.
 */
export interface RequestLogEntry {
  event: "request" | "sdk_error" | "permissions_error" | "config_error";
  route?: string | undefined;
  http_method?: string | undefined;
  status?: number | undefined;
  latency_ms?: number | undefined;
  auth?: "oauth" | "deploy_token" | "none" | undefined;
  sub_hash?: string | undefined;
  client_hash?: string | undefined;
  /** JSON-RPC method, e.g. tools/call; "batch" for an array. */
  method?: string | undefined;
  tool?: string | undefined;
  /** Why the request failed: an OAuth error code, a MicropageError code, rate_limited, ... */
  error_code?: string | undefined;
  error_name?: string | undefined;
}

export type LogSink = (line: string) => void;

export interface Logger {
  log(entry: RequestLogEntry): void;
}

export function createLogger(sink: LogSink = (line) => console.log(line)): Logger {
  return {
    log(entry) {
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entry)) if (v !== undefined) clean[k] = v;
      try {
        sink(JSON.stringify(clean));
      } catch {
        // logging must never fail a request
      }
    },
  };
}

/** First 16 hex chars of SHA-256: stable enough to correlate a user's requests, not their id. */
export async function shortHash(value: string): Promise<string> {
  return (await sha256Hex(value)).slice(0, 16);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Name and code of an error, never its message. */
export function errorFacts(err: unknown): { error_name?: string; error_code?: string } {
  if (!(err instanceof Error)) return { error_name: typeof err };
  const code = (err as { code?: unknown }).code;
  return {
    error_name: err.name,
    ...(typeof code === "string" || typeof code === "number" ? { error_code: String(code) } : {}),
  };
}
