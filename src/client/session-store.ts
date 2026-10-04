import { randomBytes } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { VERSION } from "../version.js";
import type { AuthProvider } from "./auth-provider.js";
import type { MicropageConfig } from "./config.js";
import { MicropageError } from "./errors.js";
import type { FetchLike } from "./http.js";
import { isJwtExpiring } from "./jwt.js";
import { withFileLock, type LockOptions } from "./lock.js";

export const LOGIN_HINT = "Run `micropage login` in a terminal, then retry.";

/** Same location as the CLI (cli/src/auth.js), plus a MICROPAGE_CONFIG_DIR override. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.MICROPAGE_CONFIG_DIR?.trim();
  if (override) return override;
  return join(env.HOME || env.USERPROFILE || homedir(), ".micropage");
}

export function sessionFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), "config.json");
}

export interface StoredSession {
  access_token: string;
  refresh_token: string;
  user: unknown;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The CLI's ~/.micropage/config.json. Reads tolerate the CLI's non-atomic
 * writes; our writes are atomic and only ever replace the token keys, so the
 * session is never cleared from here.
 */
export class SessionStore {
  constructor(readonly path: string) {}

  get lockPath(): string {
    return `${this.path}.lock`;
  }

  /** The whole config object, or null when there is no file. */
  async readConfig(): Promise<Record<string, unknown> | null> {
    for (let attempt = 0; ; attempt++) {
      let text: string;
      try {
        text = await readFile(this.path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new MicropageError("SESSION_UNREADABLE", `Could not read ${this.path}: ${(err as Error).message}`, {
          cause: err,
        });
      }
      try {
        const parsed: unknown = JSON.parse(text);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      } catch (err) {
        // The CLI writes this file in place, so a read can land mid-write.
        if (attempt < 3) {
          await sleep(25);
          continue;
        }
        throw new MicropageError(
          "SESSION_UNREADABLE",
          `${this.path} is not valid JSON. ${LOGIN_HINT}`,
          { cause: err },
        );
      }
    }
  }

  async readSession(): Promise<StoredSession | null> {
    const config = await this.readConfig();
    if (!config || !hasTokens(config)) return null;
    return { access_token: config.access_token as string, refresh_token: config.refresh_token as string, user: config.user ?? null };
  }

  /**
   * Replaces the token keys (and user, when given), keeping every other key.
   * Re-reads the file first and writes nothing when it no longer holds a
   * session: the user logged out while a refresh was in flight, and writing
   * the tokens back would undo that. Returns whether it wrote.
   */
  async writeTokens(tokens: { access_token: string; refresh_token: string; user?: unknown }): Promise<boolean> {
    const config = await this.readConfig();
    if (!config || !hasTokens(config)) return false;
    config.access_token = tokens.access_token;
    config.refresh_token = tokens.refresh_token;
    if (tokens.user !== undefined && tokens.user !== null) config.user = tokens.user;

    const mode = (await stat(this.path).catch(() => null))?.mode ?? 0o600;
    const tmp = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(config, null, 2), { encoding: "utf8", mode: mode & 0o777 });
      await rename(tmp, this.path);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    return true;
  }
}

function hasTokens(config: Record<string, unknown>): boolean {
  const { access_token, refresh_token } = config;
  return typeof access_token === "string" && access_token !== "" && typeof refresh_token === "string" && refresh_token !== "";
}

export interface SessionAuthOptions {
  config: Pick<MicropageConfig, "supabaseUrl" | "supabaseAnonKey">;
  /** Path of the CLI config file (see sessionFilePath()). */
  path: string;
  fetch?: FetchLike;
  now?: () => number;
  lock?: LockOptions;
  timeoutMs?: number;
  /** Where the one-time "could not save the session" notice goes; stderr by default (stdout is the MCP stream). */
  log?: (message: string) => void;
}

/**
 * Tokens a refresh produced that could not be written to the file. Supabase
 * has already spent the file's refresh token, so the file alone is a dead
 * session; these stand in for it while the file still holds that spent
 * token (fileRefreshToken), and are dropped once the file changes.
 */
interface MemorySession {
  session: StoredSession;
  fileRefreshToken: string;
}

interface TokenResponse {
  access_token?: unknown;
  refresh_token?: unknown;
  user?: unknown;
}

/**
 * Access tokens from the CLI's login session. Refreshes proactively within
 * 60 s of expiry; refreshes are single-flight in-process and serialised across
 * MCP processes by a lockfile next to the config. The CLI does not take that
 * lock, so a failed refresh re-reads the file and retries once if the CLI
 * rotated the refresh token meanwhile.
 */
export class SessionAuthProvider implements AuthProvider {
  readonly mode = "session" as const;
  readonly store: SessionStore;
  private readonly config: SessionAuthOptions["config"];
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly lockOptions: LockOptions;
  private readonly timeoutMs: number;
  private inflight: Promise<string> | null = null;
  private lastIssued: string | null = null;
  private memory: MemorySession | null = null;
  private warnedWriteFailure = false;
  private readonly log: (message: string) => void;

  constructor(options: SessionAuthOptions) {
    this.config = options.config;
    this.store = new SessionStore(options.path);
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
    this.lockOptions = options.lock ?? {};
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  }

  get path(): string {
    return this.store.path;
  }

  async hasSession(): Promise<boolean> {
    return (await this.currentSession()) !== null;
  }

  /** The file's session, or the in-memory one while the file still holds the refresh token it replaced. */
  private async currentSession(): Promise<StoredSession | null> {
    const file = await this.store.readSession();
    const memory = this.memory;
    if (memory) {
      if (file && file.refresh_token === memory.fileRefreshToken) return memory.session;
      // Logged in again, rotated by the CLI, or logged out: the file wins.
      this.memory = null;
    }
    return file;
  }

  async getAccessToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    // Re-read every call: the CLI may have logged in again or rotated tokens.
    const session = await this.requireSession();
    const fresh = !isJwtExpiring(session.access_token, this.now());
    if (!options.forceRefresh && fresh) return this.issue(session.access_token);

    // The token being given up on: the expiring one, or after a 401 the one we handed out.
    const stale = options.forceRefresh ? (this.lastIssued ?? session.access_token) : session.access_token;
    if (session.access_token !== stale && fresh) return this.issue(session.access_token);

    this.inflight ??= this.refreshUnderLock(stale).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private issue(token: string): string {
    this.lastIssued = token;
    return token;
  }

  private async requireSession(): Promise<StoredSession> {
    const session = await this.currentSession();
    if (!session) {
      throw new MicropageError("NOT_LOGGED_IN", `Not logged in to micropage. ${LOGIN_HINT}`);
    }
    return session;
  }

  private refreshUnderLock(stale: string): Promise<string> {
    return withFileLock(
      this.store.lockPath,
      async () => {
        const current = await this.requireSession();
        if (current.access_token !== stale && !isJwtExpiring(current.access_token, this.now())) {
          return this.issue(current.access_token);
        }
        try {
          return this.issue(await this.exchange(current));
        } catch (err) {
          const again = await this.currentSession().catch(() => null);
          if (!again || again.refresh_token === current.refresh_token) throw finalError(err);
          if (again.access_token !== stale && !isJwtExpiring(again.access_token, this.now())) {
            return this.issue(again.access_token);
          }
          try {
            return this.issue(await this.exchange(again));
          } catch (retryErr) {
            throw finalError(retryErr);
          }
        }
      },
      this.lockOptions,
    );
  }

  private async exchange(session: StoredSession): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: "POST",
        headers: {
          apikey: this.config.supabaseAnonKey,
          "Content-Type": "application/json",
          "User-Agent": `micropage-mcp/${VERSION}`,
        },
        body: JSON.stringify({ refresh_token: session.refresh_token }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new MicropageError(
        "NETWORK",
        `Refreshing the micropage login failed before a response arrived (${err instanceof Error ? err.message : String(err)}). Check the network and retry.`,
        { cause: err },
      );
    }

    const text = await res.text().catch(() => "");
    let data: TokenResponse | null = null;
    try {
      data = text ? (JSON.parse(text) as TokenResponse) : null;
    } catch {
      data = null;
    }

    if (res.status >= 500) {
      throw new MicropageError(
        "AUTH_UNAVAILABLE",
        `The micropage auth server returned HTTP ${res.status} while refreshing the login. Retry shortly.`,
        { status: res.status, data },
      );
    }
    if (!res.ok || typeof data?.access_token !== "string" || !data.access_token) {
      throw new MicropageError("REFRESH_REJECTED", `Token refresh was rejected (HTTP ${res.status}).`, {
        status: res.status,
        data,
      });
    }

    const next = {
      access_token: data.access_token,
      refresh_token: typeof data.refresh_token === "string" && data.refresh_token ? data.refresh_token : session.refresh_token,
      user: data.user ?? session.user,
    };
    // While the memory session is in use the file still holds the refresh
    // token it replaced; keep pointing at that one.
    const fileRefreshToken = this.memory?.session === session ? this.memory.fileRefreshToken : session.refresh_token;
    let written: boolean;
    try {
      written = await this.store.writeTokens(next);
    } catch (err) {
      this.memory = { session: next, fileRefreshToken };
      if (!this.warnedWriteFailure) {
        this.warnedWriteFailure = true;
        this.log(
          `micropage-mcp: could not save the refreshed login to ${this.store.path} (${err instanceof Error ? err.message : String(err)}). ` +
            "This server keeps using it in memory, but the micropage CLI's session there is now spent and may need `micropage login`.",
        );
      }
      return next.access_token;
    }
    if (!written) {
      this.memory = null;
      throw new MicropageError("NOT_LOGGED_IN", `The micropage CLI was logged out while the login was being refreshed. ${LOGIN_HINT}`);
    }
    this.memory = null;
    return next.access_token;
  }
}

/** Transport trouble stays retryable; anything else means the stored login is no good. */
function finalError(err: unknown): MicropageError {
  if (err instanceof MicropageError && (err.code === "NETWORK" || err.code === "AUTH_UNAVAILABLE" || err.code === "NOT_LOGGED_IN")) {
    return err;
  }
  return new MicropageError("SESSION_EXPIRED", `The micropage login session has expired. ${LOGIN_HINT}`, {
    cause: err,
  });
}
