import type { AuthProvider } from "../../src/client/auth-provider.js";
import { loadConfig, type MicropageConfig } from "../../src/client/config.js";
import { Http, type FetchLike } from "../../src/client/http.js";

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Parsed JSON when the body was JSON, the raw string otherwise. */
  body: unknown;
}

export interface ScriptedResponse {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Either a fixed response or a function of the call (route-style scripting). */
export type Responder = ScriptedResponse | ((call: RecordedCall) => ScriptedResponse | Promise<ScriptedResponse>);

export interface FakeFetch {
  fetch: FetchLike;
  calls: RecordedCall[];
  /** Append more scripted responses, consumed in order. */
  push(...responders: Responder[]): void;
}

/**
 * A fetch stand-in that records every call and answers from a queue of
 * scripted responses. Running out of script fails the test loudly instead of
 * reaching the network.
 */
export function createFakeFetch(...responders: Responder[]): FakeFetch {
  const queue: Responder[] = [...responders];
  const calls: RecordedCall[] = [];

  const fakeFetch: FetchLike = async (input, init = {}) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    let body: unknown = init.body ?? undefined;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        // keep the raw string
      }
    }
    const call: RecordedCall = { method: init.method ?? "GET", url: String(input), headers, body };
    calls.push(call);

    const next = queue.shift();
    if (!next) throw new Error(`fake fetch: no scripted response for ${call.method} ${call.url}`);
    const scripted = typeof next === "function" ? await next(call) : next;
    const payload =
      scripted.body === undefined
        ? null
        : typeof scripted.body === "string"
          ? scripted.body
          : JSON.stringify(scripted.body);
    return new Response(payload, {
      status: scripted.status ?? 200,
      headers: { "content-type": "application/json", ...scripted.headers },
    });
  };

  return { fetch: fakeFetch, calls, push: (...more) => queue.push(...more) };
}

/** Scripted AuthProvider: hands out tokens in order; forceRefresh advances to the next one. */
export class FakeAuth implements AuthProvider {
  readonly mode: AuthProvider["mode"];
  readonly pinnedProjectUuid?: string;
  refreshCount = 0;
  private index = 0;

  constructor(
    private readonly tokens: string[] = ["token-1"],
    options: { mode?: AuthProvider["mode"]; pinnedProjectUuid?: string } = {},
  ) {
    this.mode = options.mode ?? "session";
    if (options.pinnedProjectUuid !== undefined) this.pinnedProjectUuid = options.pinnedProjectUuid;
  }

  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    if (options.forceRefresh) {
      this.refreshCount++;
      this.index = Math.min(this.index + 1, this.tokens.length - 1);
    }
    return this.tokens[this.index]!;
  }
}

export const TEST_CONFIG: MicropageConfig = {
  ...loadConfig({}),
  supabaseUrl: "https://supabase.test",
  supabaseAnonKey: "anon-key",
};

export function makeHttp(fake: FakeFetch, auth: AuthProvider = new FakeAuth()): Http {
  return new Http({ config: TEST_CONFIG, auth, fetch: fake.fetch, userAgent: "micropage-mcp/test" });
}
