import { describe, expect, it } from "vitest";

import { DeployTokenAuthProvider, readDeployTokenEnv } from "../src/client/deploy-token.js";
import { MicropageError } from "../src/client/errors.js";
import { SessionAuthProvider } from "../src/client/session-store.js";
import { REMOTE_DEPLOY_TOKEN_HINTS } from "../src/hints.js";
import { createDeps } from "../src/node/deps.js";
import { TEST_CONFIG, createFakeFetch, type ScriptedResponse } from "./helpers/fake-fetch.js";

const UUID = "11111111-2222-3333-4444-555555555555";
const EXCHANGE_URL = "https://supabase.test/functions/v1/exchange-deploy-token";

function exchanged(token: string, expiresAtSec: number): ScriptedResponse {
  return { body: { access_token: token, token_type: "bearer", expires_in: 1800, expires_at: expiresAtSec, project_id: 42 } };
}

describe("readDeployTokenEnv", () => {
  it("is null when neither variable is set", () => {
    expect(readDeployTokenEnv({})).toBeNull();
    expect(readDeployTokenEnv({ MICROPAGE_DEPLOY_TOKEN: "  ", MICROPAGE_DEPLOY_PROJECT: "" })).toBeNull();
  });

  it("returns both when both are set", () => {
    expect(readDeployTokenEnv({ MICROPAGE_DEPLOY_TOKEN: " mpd_x ", MICROPAGE_DEPLOY_PROJECT: UUID.toUpperCase() })).toEqual({
      token: "mpd_x",
      projectUuid: UUID,
    });
  });

  it.each([
    [{ MICROPAGE_DEPLOY_TOKEN: "mpd_x" }, /MICROPAGE_DEPLOY_PROJECT is not/],
    [{ MICROPAGE_DEPLOY_PROJECT: UUID }, /MICROPAGE_DEPLOY_TOKEN is not/],
    [{ MICROPAGE_DEPLOY_TOKEN: "mpd_x", MICROPAGE_DEPLOY_PROJECT: "acme.micropage.sh" }, /must be the project's uuid/],
  ])("rejects a partial or malformed config %#", (env, message) => {
    let err: unknown;
    try {
      readDeployTokenEnv(env);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MicropageError);
    expect((err as MicropageError).code).toBe("DEPLOY_TOKEN_CONFIG");
    expect((err as MicropageError).message).toMatch(message);
  });
});

describe("createDeps auth resolution", () => {
  it("uses the deploy token when both variables are set", () => {
    const deps = createDeps({ HOME: "/nonexistent", MICROPAGE_DEPLOY_TOKEN: "mpd_x", MICROPAGE_DEPLOY_PROJECT: UUID });
    expect(deps.auth.mode).toBe("deploy_token");
    expect(deps.auth.pinnedProjectUuid).toBe(UUID);
  });

  it("falls back to the CLI session file, honouring MICROPAGE_CONFIG_DIR", () => {
    const deps = createDeps({ HOME: "/home/x", MICROPAGE_CONFIG_DIR: "/tmp/mp-test" });
    expect(deps.auth).toBeInstanceOf(SessionAuthProvider);
    expect((deps.auth as SessionAuthProvider).path).toBe("/tmp/mp-test/config.json");
  });

  it("fails clearly when only one deploy variable is set", () => {
    expect(() => createDeps({ MICROPAGE_DEPLOY_TOKEN: "mpd_x" })).toThrow(/MICROPAGE_DEPLOY_PROJECT is not/);
    expect(() => createDeps({ MICROPAGE_DEPLOY_PROJECT: UUID })).toThrow(/MICROPAGE_DEPLOY_TOKEN is not/);
  });
});

describe("DeployTokenAuthProvider", () => {
  const nowSec = 1_800_000_000;

  function make(fake: ReturnType<typeof createFakeFetch>, clock: { now: number }) {
    return new DeployTokenAuthProvider({
      config: TEST_CONFIG,
      token: "mpd_secret",
      projectUuid: UUID,
      fetch: fake.fetch,
      now: () => clock.now,
    });
  }

  it("exchanges with the CLI's request shape and pins the project", async () => {
    const clock = { now: nowSec * 1000 };
    const fake = createFakeFetch(exchanged("jwt-1", nowSec + 1800));
    const auth = make(fake, clock);

    expect(await auth.getAccessToken()).toBe("jwt-1");
    expect(auth.mode).toBe("deploy_token");
    expect(auth.pinnedProjectUuid).toBe(UUID);
    expect(auth.projectId).toBe(42);

    const [call] = fake.calls;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe(EXCHANGE_URL);
    expect(call?.headers.authorization).toBe("Bearer mpd_secret");
    expect(call?.headers.apikey).toBe("anon-key");
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.body).toEqual({ projectUuid: UUID, expiresInSeconds: 1800 });
  });

  it("caches the JWT and re-exchanges 60s before it expires", async () => {
    const clock = { now: nowSec * 1000 };
    const fake = createFakeFetch(exchanged("jwt-1", nowSec + 1800), exchanged("jwt-2", nowSec + 3600));
    const auth = make(fake, clock);

    expect(await auth.getAccessToken()).toBe("jwt-1");
    clock.now = (nowSec + 1700) * 1000;
    expect(await auth.getAccessToken()).toBe("jwt-1");
    expect(fake.calls).toHaveLength(1);

    clock.now = (nowSec + 1745) * 1000;
    expect(await auth.getAccessToken()).toBe("jwt-2");
    expect(fake.calls).toHaveLength(2);
  });

  it("re-exchanges on forceRefresh and single-flights concurrent callers", async () => {
    const clock = { now: nowSec * 1000 };
    const fake = createFakeFetch(exchanged("jwt-1", nowSec + 1800), exchanged("jwt-2", nowSec + 1801));
    const auth = make(fake, clock);
    const [a, b] = await Promise.all([auth.getAccessToken(), auth.getAccessToken()]);
    expect([a, b]).toEqual(["jwt-1", "jwt-1"]);
    expect(await auth.getAccessToken({ forceRefresh: true })).toBe("jwt-2");
    expect(fake.calls).toHaveLength(2);
  });

  it("throws rather than hand back the same JWT after a forced refresh", async () => {
    const clock = { now: nowSec * 1000 };
    const fake = createFakeFetch(exchanged("jwt-1", nowSec + 1800), exchanged("jwt-1", nowSec + 1800));
    const auth = make(fake, clock);
    await auth.getAccessToken();
    await expect(auth.getAccessToken({ forceRefresh: true })).rejects.toMatchObject({ code: "DEPLOY_TOKEN_INVALID" });
  });

  it("explains a rejected deploy token", async () => {
    const fake = createFakeFetch({ status: 401, body: { error: "Invalid deploy token" } });
    const err = (await make(fake, { now: nowSec * 1000 })
      .getAccessToken()
      .catch((e: unknown) => e)) as MicropageError;
    expect(err.code).toBe("DEPLOY_TOKEN_INVALID");
    expect(err.message).toMatch(/Invalid deploy token/);
    expect(err.message).toMatch(/MICROPAGE_DEPLOY_TOKEN/);
  });

  it("reports a plan refusal as PLAN_REQUIRED, not as an invalid token", async () => {
    const body = {
      error: "Deploy tokens require the Pro+ plan.",
      code: "plan_required",
      required_tier: "pro_plus",
      upgrade_url: "https://micropage.sh/pricing",
    };
    const fake = createFakeFetch({ status: 403, body });
    const err = (await make(fake, { now: nowSec * 1000 })
      .getAccessToken()
      .catch((e: unknown) => e)) as MicropageError;
    expect(err).toBeInstanceOf(MicropageError);
    expect(err.code).toBe("PLAN_REQUIRED");
    expect(err.status).toBe(403);
    expect(err.data).toEqual(body);
    expect(err.message).toBe("Deploy tokens require the Pro+ plan. Upgrade at https://micropage.sh/pricing.");
    expect(err.message).not.toMatch(/rejected|MICROPAGE_DEPLOY_TOKEN/);
  });

  it("still treats a bare 403 as an invalid token", async () => {
    const fake = createFakeFetch({ status: 403, body: { error: "Token revoked" } });
    await expect(make(fake, { now: nowSec * 1000 }).getAccessToken()).rejects.toMatchObject({
      code: "DEPLOY_TOKEN_INVALID",
      status: 403,
    });
  });
});

describe("DeployTokenAuthProvider wording for a hosted connection", () => {
  const make = (status: number, body: unknown) =>
    new DeployTokenAuthProvider({
      config: TEST_CONFIG,
      token: "mpd_secret",
      projectUuid: UUID,
      fetch: createFakeFetch({ status, body }).fetch,
      hints: REMOTE_DEPLOY_TOKEN_HINTS,
    });

  it("points at the connector settings, never at env vars", async () => {
    const rejected = (await make(403, { error: "Invalid deploy token" }).getAccessToken().catch((e: unknown) => e)) as MicropageError;
    expect(rejected.code).toBe("DEPLOY_TOKEN_INVALID");
    expect(rejected.message).toBe(`The deploy token was rejected (Invalid deploy token). ${REMOTE_DEPLOY_TOKEN_HINTS.deployTokenCheck}`);
    const missing = (await make(404, { error: "Project not found" }).getAccessToken().catch((e: unknown) => e)) as MicropageError;
    expect(missing.message).toBe(`No project with uuid ${UUID} exists (Project not found). ${REMOTE_DEPLOY_TOKEN_HINTS.deployProjectCheck}`);
    for (const err of [rejected, missing]) expect(err.message).not.toMatch(/MICROPAGE_|micropage login/);
  });

  it("reports whether the cached JWT is fresh enough to skip an exchange", async () => {
    const nowSec = 1_800_000_000;
    const clock = { now: nowSec * 1000 };
    const auth = new DeployTokenAuthProvider({
      config: TEST_CONFIG,
      token: "mpd_secret",
      projectUuid: UUID,
      fetch: createFakeFetch(exchanged("jwt-1", nowSec + 300)).fetch,
      now: () => clock.now,
    });
    expect(auth.hasFreshToken()).toBe(false);
    await auth.getAccessToken();
    expect(auth.hasFreshToken()).toBe(true);
    clock.now = (nowSec + 241) * 1000;
    expect(auth.hasFreshToken()).toBe(false);
  });
});
