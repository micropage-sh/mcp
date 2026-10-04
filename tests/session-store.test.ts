import { readdir, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MicropageError } from "../src/client/errors.js";
import { Http } from "../src/client/http.js";
import { SessionAuthProvider, configDir, sessionFilePath } from "../src/client/session-store.js";
import { TEST_CONFIG, createFakeFetch, type RecordedCall, type ScriptedResponse } from "./helpers/fake-fetch.js";
import { tempConfig, tokenFor, type TempConfig } from "./helpers/session.js";

const REFRESH_URL = "https://supabase.test/auth/v1/token?grant_type=refresh_token";
const USER = { id: "user-1", email: "user-1@example.com" };

let cfg: TempConfig;
beforeEach(async () => {
  cfg = await tempConfig();
});
afterEach(async () => {
  await cfg.cleanup();
});

function provider(fetch: ReturnType<typeof createFakeFetch>["fetch"], extra: { lockTimeoutMs?: number } = {}) {
  return new SessionAuthProvider({
    config: TEST_CONFIG,
    path: cfg.path,
    fetch,
    lock: { retryMs: 5, ...(extra.lockTimeoutMs ? { timeoutMs: extra.lockTimeoutMs } : {}) },
  });
}

/** A refresh responder that answers with the given access/refresh pair. */
function refreshOk(access: string, refresh: string, delayMs = 0) {
  return async (call: RecordedCall): Promise<ScriptedResponse> => {
    expect(call.url).toBe(REFRESH_URL);
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return { body: { access_token: access, refresh_token: refresh, user: USER } };
  };
}

describe("session file location", () => {
  it("defaults to ~/.micropage/config.json and honours MICROPAGE_CONFIG_DIR", () => {
    expect(sessionFilePath({ HOME: "/home/x" })).toBe("/home/x/.micropage/config.json");
    expect(configDir({ HOME: "/home/x", MICROPAGE_CONFIG_DIR: "/etc/mp" })).toBe("/etc/mp");
    expect(sessionFilePath({ HOME: "/home/x", MICROPAGE_CONFIG_DIR: "/etc/mp" })).toBe("/etc/mp/config.json");
  });
});

describe("SessionAuthProvider", () => {
  it("returns the stored token without a network call while it is fresh", async () => {
    const access = tokenFor("user-1", 3600);
    await cfg.write({ access_token: access, refresh_token: "r1", user: USER });
    const fake = createFakeFetch();
    expect(await provider(fake.fetch).getAccessToken()).toBe(access);
    expect(fake.calls).toHaveLength(0);
  });

  it("throws NOT_LOGGED_IN with the login hint when there is no session file", async () => {
    const fake = createFakeFetch();
    const err = (await provider(fake.fetch).getAccessToken().catch((e: unknown) => e)) as MicropageError;
    expect(err).toBeInstanceOf(MicropageError);
    expect(err.code).toBe("NOT_LOGGED_IN");
    expect(err.message).toMatch(/Run `micropage login` in a terminal, then retry\./);
  });

  it("treats a file without tokens (CLI logged out) as not logged in", async () => {
    await cfg.write({ token: "legacy" });
    await expect(provider(createFakeFetch().fetch).getAccessToken()).rejects.toMatchObject({ code: "NOT_LOGGED_IN" });
  });

  it("refreshes proactively within 60s of exp and writes the tokens back, keeping other keys", async () => {
    const old = tokenFor("user-1", 30);
    const next = tokenFor("user-1", 3600, Date.now(), "next");
    await cfg.write({ access_token: old, refresh_token: "r1", user: { id: "user-1" }, token: "legacy", extra: { a: 1 } });
    const fake = createFakeFetch(refreshOk(next, "r2"));

    expect(await provider(fake.fetch).getAccessToken()).toBe(next);

    const [call] = fake.calls;
    expect(call?.method).toBe("POST");
    expect(call?.headers.apikey).toBe("anon-key");
    expect(call?.body).toEqual({ refresh_token: "r1" });
    expect(await cfg.read()).toEqual({
      access_token: next,
      refresh_token: "r2",
      user: USER,
      token: "legacy",
      extra: { a: 1 },
    });
    // Atomic write: no temp or lock files left behind.
    expect((await readdir(cfg.dir)).sort()).toEqual(["config.json"]);
  });

  it("keeps the file's permissions on rewrite", async () => {
    await cfg.write({ access_token: tokenFor("user-1", 10), refresh_token: "r1" });
    const { chmod } = await import("node:fs/promises");
    await chmod(cfg.path, 0o600);
    await provider(createFakeFetch(refreshOk(tokenFor("user-1", 3600), "r2")).fetch).getAccessToken();
    expect((await stat(cfg.path)).mode & 0o777).toBe(0o600);
  });

  it("refreshes after a 401 through Http and retries with a NEW token", async () => {
    const a = tokenFor("user-1", 3600, Date.now(), "a");
    const b = tokenFor("user-1", 3600, Date.now(), "b");
    await cfg.write({ access_token: a, refresh_token: "r1", user: USER });
    const fake = createFakeFetch({ status: 401, body: { message: "JWT expired" } }, refreshOk(b, "r2"), { body: [{ id: 1 }] });
    const auth = provider(fake.fetch);
    const http = new Http({ config: TEST_CONFIG, auth, fetch: fake.fetch });

    expect(await http.select("projects")).toEqual([{ id: 1 }]);
    expect(fake.calls.map((c) => c.headers.authorization ?? null)).toEqual([`Bearer ${a}`, null, `Bearer ${b}`]);
    expect((await cfg.read()).refresh_token).toBe("r2");
  });

  it("is single-flight within one process", async () => {
    await cfg.write({ access_token: tokenFor("user-1", 5), refresh_token: "r1" });
    const next = tokenFor("user-1", 3600, Date.now(), "next");
    const fake = createFakeFetch(refreshOk(next, "r2", 30));
    const auth = provider(fake.fetch);
    const tokens = await Promise.all([auth.getAccessToken(), auth.getAccessToken(), auth.getAccessToken()]);
    expect(tokens).toEqual([next, next, next]);
    expect(fake.calls).toHaveLength(1);
  });

  it("serialises refreshes across providers with the lockfile and re-reads after taking it", async () => {
    await cfg.write({ access_token: tokenFor("user-1", 5), refresh_token: "r1" });
    const next = tokenFor("user-1", 3600, Date.now(), "next");
    // Separate fetch fakes: each provider stands in for its own process.
    const fakeA = createFakeFetch(refreshOk(next, "r2", 60));
    const fakeB = createFakeFetch(refreshOk(tokenFor("user-1", 3600, Date.now(), "other"), "r3"));
    const [ta, tb] = await Promise.all([provider(fakeA.fetch).getAccessToken(), provider(fakeB.fetch).getAccessToken()]);

    expect(ta).toBe(next);
    expect(tb).toBe(next);
    expect(fakeA.calls.length + fakeB.calls.length).toBe(1);
    expect((await cfg.read()).refresh_token).toBe("r2");
  });

  it("uses a token another writer already rotated instead of refreshing on forceRefresh", async () => {
    const a = tokenFor("user-1", 3600, Date.now(), "a");
    const b = tokenFor("user-1", 3600, Date.now(), "b");
    await cfg.write({ access_token: a, refresh_token: "r1" });
    const fake = createFakeFetch();
    const auth = provider(fake.fetch);
    expect(await auth.getAccessToken()).toBe(a);

    await cfg.write({ access_token: b, refresh_token: "r2" });
    expect(await auth.getAccessToken({ forceRefresh: true })).toBe(b);
    expect(fake.calls).toHaveLength(0);
  });

  it("on a rejected refresh, retries once with the refresh token the CLI rotated in meanwhile", async () => {
    await cfg.write({ access_token: tokenFor("user-1", 5), refresh_token: "r1", keep: true });
    const final = tokenFor("user-1", 3600, Date.now(), "final");
    const fake = createFakeFetch(
      async () => {
        // The CLI (which ignores our lock) refreshed first: r1 is spent.
        await cfg.write({ access_token: tokenFor("user-1", 5, Date.now(), "cli"), refresh_token: "r2", keep: true });
        return { status: 400, body: { error: "invalid_grant", error_description: "Already Used" } };
      },
      refreshOk(final, "r3"),
    );

    expect(await provider(fake.fetch).getAccessToken()).toBe(final);
    expect(fake.calls.map((c) => c.body)).toEqual([{ refresh_token: "r1" }, { refresh_token: "r2" }]);
    expect(await cfg.read()).toMatchObject({ access_token: final, refresh_token: "r3", keep: true });
  });

  it("on a rejected refresh, takes a fresh token the CLI wrote without another request", async () => {
    await cfg.write({ access_token: tokenFor("user-1", 5), refresh_token: "r1" });
    const cliToken = tokenFor("user-1", 3600, Date.now(), "cli");
    const fake = createFakeFetch(async () => {
      await cfg.write({ access_token: cliToken, refresh_token: "r2" });
      return { status: 400, body: { error: "invalid_grant" } };
    });
    expect(await provider(fake.fetch).getAccessToken()).toBe(cliToken);
    expect(fake.calls).toHaveLength(1);
  });

  it("never clears or rewrites the session when the refresh finally fails", async () => {
    await cfg.write({ access_token: tokenFor("user-1", 5), refresh_token: "r1", user: USER, token: "legacy" });
    const before = await cfg.raw();
    const fake = createFakeFetch({ status: 400, body: { error: "invalid_grant" } });

    const err = (await provider(fake.fetch).getAccessToken().catch((e: unknown) => e)) as MicropageError;

    expect(err.code).toBe("SESSION_EXPIRED");
    expect(err.message).toMatch(/Run `micropage login` in a terminal, then retry\./);
    expect(fake.calls).toHaveLength(1);
    expect(await cfg.raw()).toBe(before);
    expect(await readdir(cfg.dir)).toEqual(["config.json"]);
  });

  it("reports a network failure as retryable, not as an expired session", async () => {
    await cfg.write({ access_token: tokenFor("user-1", 5), refresh_token: "r1" });
    const before = await cfg.raw();
    const auth = new SessionAuthProvider({
      config: TEST_CONFIG,
      path: cfg.path,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(auth.getAccessToken()).rejects.toMatchObject({ code: "NETWORK" });
    expect(await cfg.raw()).toBe(before);
  });

  it("breaks a stale lock left by a crashed process", async () => {
    await cfg.write({ access_token: tokenFor("user-1", 5), refresh_token: "r1" });
    const lock = join(cfg.dir, "config.json.lock");
    await writeFile(lock, "999999.dead");
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const next = tokenFor("user-1", 3600, Date.now(), "next");

    expect(await provider(createFakeFetch(refreshOk(next, "r2")).fetch).getAccessToken()).toBe(next);
    expect(await readdir(cfg.dir)).toEqual(["config.json"]);
  });

  it("waits for a live lock and gives up with SESSION_LOCKED instead of refreshing concurrently", async () => {
    await cfg.write({ access_token: tokenFor("user-1", 5), refresh_token: "r1" });
    await writeFile(join(cfg.dir, "config.json.lock"), "12345.alive");
    const fake = createFakeFetch();
    await expect(provider(fake.fetch, { lockTimeoutMs: 60 }).getAccessToken()).rejects.toMatchObject({
      code: "SESSION_LOCKED",
    });
    expect(fake.calls).toHaveLength(0);
  });
});
