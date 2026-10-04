import { VERSION } from "../version.js";
import type { AuthProvider } from "./auth-provider.js";
import type { MicropageConfig } from "./config.js";
import { MicropageError, planRequiredError } from "./errors.js";
import type { FetchLike } from "./http.js";
import { isProjectUuid } from "./project-ref.js";

/** TTL requested from exchange-deploy-token (the function clamps to 60-3600 s). */
export const DEPLOY_TOKEN_TTL_SECONDS = 1800;
/** Re-exchange this long before the minted JWT expires. */
const REEXCHANGE_SKEW_MS = 60_000;

export interface DeployTokenEnv {
  token: string;
  projectUuid: string;
}

/**
 * MICROPAGE_DEPLOY_TOKEN + MICROPAGE_DEPLOY_PROJECT, or null when neither is
 * set. Exactly one set, or a project that is not a uuid, is a config mistake
 * the user must fix, so it throws rather than silently falling back to the
 * CLI session (which would act with broader access than they configured).
 */
export function readDeployTokenEnv(env: NodeJS.ProcessEnv = process.env): DeployTokenEnv | null {
  const token = env.MICROPAGE_DEPLOY_TOKEN?.trim() ?? "";
  const projectUuid = env.MICROPAGE_DEPLOY_PROJECT?.trim() ?? "";
  if (!token && !projectUuid) return null;
  if (!token || !projectUuid) {
    const missing = token ? "MICROPAGE_DEPLOY_PROJECT" : "MICROPAGE_DEPLOY_TOKEN";
    const present = token ? "MICROPAGE_DEPLOY_TOKEN" : "MICROPAGE_DEPLOY_PROJECT";
    throw new MicropageError(
      "DEPLOY_TOKEN_CONFIG",
      `${present} is set but ${missing} is not. Set both (the deploy token and the project's uuid) ` +
        `or neither (to use the \`micropage login\` session).`,
    );
  }
  if (!isProjectUuid(projectUuid)) {
    throw new MicropageError(
      "DEPLOY_TOKEN_CONFIG",
      `MICROPAGE_DEPLOY_PROJECT must be the project's uuid (e.g. 1b4e28ba-2fa1-11d2-883f-0016d3cca427), got "${projectUuid}".`,
    );
  }
  return { token, projectUuid: projectUuid.toLowerCase() };
}

export interface DeployTokenAuthOptions extends DeployTokenEnv {
  config: Pick<MicropageConfig, "supabaseUrl" | "supabaseAnonKey">;
  fetch?: FetchLike;
  now?: () => number;
  ttlSeconds?: number;
  timeoutMs?: number;
}

interface ExchangeResponse {
  access_token?: unknown;
  expires_at?: unknown;
  expires_in?: unknown;
  project_id?: unknown;
  error?: unknown;
  message?: unknown;
}

/**
 * Exchanges a project deploy token for a short-lived owner JWT
 * (supabase/functions/exchange-deploy-token), re-exchanging shortly before it
 * expires. The JWT is a full owner token server-side; the pin to one project
 * is enforced client-side (project-ref + guards).
 */
export class DeployTokenAuthProvider implements AuthProvider {
  readonly mode = "deploy_token" as const;
  readonly pinnedProjectUuid: string;
  /** Internal numeric id of the pinned project, known after the first exchange. */
  projectId: number | undefined;
  private readonly token: string;
  private readonly config: DeployTokenAuthOptions["config"];
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly ttlSeconds: number;
  private readonly timeoutMs: number;
  private cached: { accessToken: string; expiresAtMs: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(options: DeployTokenAuthOptions) {
    this.token = options.token;
    this.pinnedProjectUuid = options.projectUuid.toLowerCase();
    this.config = options.config;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.ttlSeconds = options.ttlSeconds ?? DEPLOY_TOKEN_TTL_SECONDS;
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const cached = this.cached;
    if (!options.forceRefresh && cached && cached.expiresAtMs - REEXCHANGE_SKEW_MS > this.now()) {
      return cached.accessToken;
    }
    this.inflight ??= this.exchange(options.forceRefresh ? cached?.accessToken : undefined).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async exchange(rejected: string | undefined): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.supabaseUrl}/functions/v1/exchange-deploy-token`, {
        method: "POST",
        headers: {
          apikey: this.config.supabaseAnonKey,
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
          "User-Agent": `micropage-mcp/${VERSION}`,
        },
        body: JSON.stringify({ projectUuid: this.pinnedProjectUuid, expiresInSeconds: this.ttlSeconds }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MicropageError(
        "NETWORK",
        `Exchanging the deploy token failed before a response arrived (${err instanceof Error ? err.message : String(err)}). Check the network and retry.`,
        { cause: err },
      );
    }

    const text = await res.text().catch(() => "");
    let data: ExchangeResponse | null = null;
    try {
      data = text ? (JSON.parse(text) as ExchangeResponse) : null;
    } catch {
      data = null;
    }
    const detail =
      (typeof data?.error === "string" && data.error) ||
      (typeof data?.message === "string" && data.message) ||
      `HTTP ${res.status}`;

    // Checked before the 401/403 branch: a token whose owner dropped below
    // Pro+ is valid but refused, and "token invalid" would send the user
    // off rotating a token that is fine.
    const planRequired = planRequiredError(data, { status: res.status });
    if (planRequired) throw planRequired;
    if (res.status === 401 || res.status === 403) {
      throw new MicropageError(
        "DEPLOY_TOKEN_INVALID",
        `The deploy token was rejected (${detail}). Ask the user to check MICROPAGE_DEPLOY_TOKEN, or to create a new ` +
          `token in the micropage editor under Settings > Deploy tokens.`,
        { status: res.status, data },
      );
    }
    if (res.status === 404) {
      throw new MicropageError(
        "DEPLOY_TOKEN_INVALID",
        `No project with uuid ${this.pinnedProjectUuid} exists (${detail}). Ask the user to check MICROPAGE_DEPLOY_PROJECT.`,
        { status: 404, data },
      );
    }
    if (!res.ok) {
      throw new MicropageError("HTTP", `Exchanging the deploy token failed (HTTP ${res.status}): ${detail}`, {
        status: res.status,
        data,
      });
    }
    if (typeof data?.access_token !== "string" || !data.access_token) {
      throw new MicropageError("HTTP", "exchange-deploy-token answered without an access_token.", { data });
    }
    if (rejected !== undefined && data.access_token === rejected) {
      // Minted twice in the same second with identical claims: the server
      // rejected a token it would mint again, so retrying cannot help.
      throw new MicropageError(
        "DEPLOY_TOKEN_INVALID",
        "micropage rejected a freshly exchanged deploy-token session. Ask the user to check the deploy token, then retry.",
      );
    }

    const expiresAtMs =
      typeof data.expires_at === "number"
        ? data.expires_at * 1000
        : this.now() + (typeof data.expires_in === "number" ? data.expires_in : this.ttlSeconds) * 1000;
    if (typeof data.project_id === "number" || typeof data.project_id === "string") {
      const id = Number(data.project_id);
      if (Number.isFinite(id)) this.projectId = id;
    }
    this.cached = { accessToken: data.access_token, expiresAtMs };
    return data.access_token;
  }
}
