import { STDIO_HINTS, type ModeHints } from "../hints.js";
import { VERSION } from "../version.js";
import type { AuthProvider } from "./auth-provider.js";
import type { MicropageConfig } from "./config.js";
import { MicropageError, planRequiredError } from "./errors.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  config: MicropageConfig;
  auth: AuthProvider;
  fetch?: FetchLike;
  timeoutMs?: number;
  userAgent?: string;
  /** Wording of the 401 and plan errors. Defaults to the stdio wording. */
  hints?: Pick<ModeHints, "sessionInvalid" | "upgradeLinks">;
}

export interface RequestOptions {
  /** JSON-serialised into the request body. */
  body?: unknown;
  /** Sent as-is (uploads). Takes precedence over `body`. */
  rawBody?: NonNullable<RequestInit["body"]>;
  headers?: Record<string, string>;
  /**
   * When false the anon key is sent as the bearer instead of a user token —
   * for endpoints that run before the user is known (deploy-token exchange).
   */
  auth?: boolean;
}

/** PostgREST filter expressions keyed by column, e.g. `{ id: eq(42) }`. */
export type Filters = Record<string, string>;

export const eq = (v: string | number | boolean): string => `eq.${v}`;
export const neq = (v: string | number | boolean): string => `neq.${v}`;
export const is = (v: "null" | "true" | "false"): string => `is.${v}`;
export const inList = (vs: ReadonlyArray<string | number>): string => `in.(${vs.join(",")})`;
export const gt = (v: string | number): string => `gt.${v}`;
export const lt = (v: string | number): string => `lt.${v}`;

export interface SelectOptions {
  select?: string;
  filters?: Filters;
  order?: string;
  limit?: number;
}

export const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * fetch wrapper for Supabase (PostgREST + edge functions) and the build
 * compiler. Mirrors the CLI's request() (cli/src/supabase.js): apikey header
 * plus a user bearer, and one forced refresh + retry on 401 to cover tokens
 * that expired server-side before the local expiry check caught them.
 */
export class Http {
  readonly config: MicropageConfig;
  readonly auth: AuthProvider;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly hints: Pick<ModeHints, "sessionInvalid" | "upgradeLinks">;

  constructor(options: HttpOptions) {
    this.config = options.config;
    this.auth = options.auth;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? `micropage-mcp/${VERSION}`;
    this.hints = options.hints ?? STDIO_HINTS;
  }

  async request<T = unknown>(method: string, url: string, options: RequestOptions = {}): Promise<T> {
    const res = await this.exchange(method, url, options);
    const data = await readBody(res);
    if (!res.ok) throw httpError(method, url, res, data, this.hints);
    return data as T;
  }

  /** The response after auth and the one 401 retry; the caller reads (or cancels) the body. */
  private async exchange(method: string, url: string, options: RequestOptions): Promise<Response> {
    const useAuth = options.auth !== false;
    let token = useAuth ? await this.auth.getAccessToken() : this.config.supabaseAnonKey;
    let res = await this.send(method, url, token, options);

    if (res.status === 401 && useAuth) {
      const refreshed = await this.auth.getAccessToken({ forceRefresh: true });
      if (refreshed !== token) {
        await res.body?.cancel().catch(() => undefined);
        token = refreshed;
        res = await this.send(method, url, token, options);
      }
    }
    return res;
  }

  /**
   * Exact row count from PostgREST's Content-Range (a HEAD with
   * Prefer: count=exact). Selecting rows to count them would stop at the
   * server's max_rows cap and undercount silently.
   */
  async count(table: string, filters: Filters = {}): Promise<number> {
    const params = new URLSearchParams();
    params.set("select", "*");
    appendFilters(params, filters);
    const url = this.restUrl(table, params);
    const res = await this.exchange("HEAD", url, { headers: { Prefer: "count=exact" } });
    const data = await readBody(res);
    if (!res.ok) throw httpError("HEAD", url, res, data, this.hints);
    const total = /\/(\d+)\s*$/.exec(res.headers.get("content-range") ?? "")?.[1];
    if (total === undefined) {
      throw new MicropageError("HTTP", `HEAD ${new URL(url).pathname} returned no row count (Content-Range). Retry shortly.`, {
        status: res.status,
      });
    }
    return Number(total);
  }

  async select<T = unknown>(table: string, options: SelectOptions = {}): Promise<T[]> {
    const params = new URLSearchParams();
    params.set("select", options.select ?? "*");
    appendFilters(params, options.filters);
    if (options.order) params.set("order", options.order);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const rows = await this.request<T[] | null>("GET", this.restUrl(table, params));
    return rows ?? [];
  }

  async selectOne<T = unknown>(table: string, options: SelectOptions = {}): Promise<T | null> {
    const rows = await this.select<T>(table, { ...options, limit: 1 });
    return rows[0] ?? null;
  }

  async insert<T = unknown>(table: string, rows: object | object[]): Promise<T[]> {
    const out = await this.request<T[] | null>("POST", this.restUrl(table), {
      body: rows,
      headers: { Prefer: "return=representation" },
    });
    return out ?? [];
  }

  async patch<T = unknown>(table: string, filters: Filters, values: object): Promise<T[]> {
    if (Object.keys(filters).length === 0) {
      // An unfiltered PATCH updates every row RLS lets the user see.
      throw new MicropageError("HTTP", `Refusing to PATCH ${table} without a filter.`);
    }
    const params = new URLSearchParams();
    appendFilters(params, filters);
    const out = await this.request<T[] | null>("PATCH", this.restUrl(table, params), {
      body: values,
      headers: { Prefer: "return=representation" },
    });
    return out ?? [];
  }

  async invoke<T = unknown>(name: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", this.functionUrl(name), body === undefined ? {} : { body });
  }

  async invokeGet<T = unknown>(name: string, params: Record<string, string> = {}): Promise<T> {
    const qs = new URLSearchParams(params).toString();
    return this.request<T>("GET", `${this.functionUrl(name)}${qs ? `?${qs}` : ""}`);
  }

  restUrl(table: string, params?: URLSearchParams): string {
    const qs = params?.toString();
    return `${this.config.supabaseUrl}/rest/v1/${table}${qs ? `?${qs}` : ""}`;
  }

  functionUrl(name: string): string {
    return `${this.config.supabaseUrl}/functions/v1/${name}`;
  }

  private async send(method: string, url: string, token: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = {
      apikey: this.config.supabaseAnonKey,
      Authorization: `Bearer ${token}`,
      "User-Agent": this.userAgent,
      ...options.headers,
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (options.rawBody !== undefined) {
      init.body = options.rawBody;
    } else if (options.body !== undefined) {
      headers["Content-Type"] ??= "application/json";
      init.body = JSON.stringify(options.body);
    }

    try {
      return await this.fetchImpl(url, init);
    } catch (err) {
      const where = describe(method, url);
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new MicropageError(
          "TIMEOUT",
          `${where} timed out after ${Math.round(this.timeoutMs / 1000)}s. micropage may be slow right now; retry shortly.`,
          { cause: err },
        );
      }
      throw new MicropageError(
        "NETWORK",
        `${where} failed before a response arrived (${err instanceof Error ? err.message : String(err)}). Check the network and retry.`,
        { cause: err },
      );
    }
  }
}

function appendFilters(params: URLSearchParams, filters: Filters | undefined): void {
  for (const [column, expr] of Object.entries(filters ?? {})) params.append(column, expr);
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function describe(method: string, url: string): string {
  // Path only: query strings can carry filter values that read as noise to the model.
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    // keep the raw url
  }
  return `${method} ${path}`;
}

function httpError(
  method: string,
  url: string,
  res: Response,
  data: unknown,
  hints: Pick<ModeHints, "sessionInvalid" | "upgradeLinks">,
): MicropageError {
  const planRequired = planRequiredError(data, { status: res.status }, hints);
  if (planRequired) return planRequired;
  if (res.status === 401) {
    return new MicropageError("SESSION_EXPIRED", hints.sessionInvalid, { status: 401, data });
  }
  const detail =
    (data && typeof data === "object" && (pick(data, "message") ?? pick(data, "error"))) ||
    (typeof data === "string" && data.length < 500 ? data : null) ||
    res.statusText ||
    `HTTP ${res.status}`;
  return new MicropageError("HTTP", `${describe(method, url)} failed (HTTP ${res.status}): ${detail}`, {
    status: res.status,
    data,
  });
}

function pick(obj: object, key: string): string | undefined {
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : undefined;
}
