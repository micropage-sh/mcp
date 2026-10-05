import { describe, expect, it } from "vitest";

import { currentUserId, type AuthProvider } from "../src/client/auth-provider.js";
import { BearerAuthProvider } from "../src/client/bearer-auth.js";
import { MicropageError } from "../src/client/errors.js";
import { PlanGate } from "../src/client/tier.js";
import { REMOTE_DEPLOY_TOKEN_HINTS, REMOTE_OAUTH_HINTS } from "../src/hints.js";
import { makeJwt } from "./helpers/session.js";
import { createFakeFetch, makeHttp } from "./helpers/fake-fetch.js";
import { tokenFor } from "./helpers/session.js";

describe("BearerAuthProvider", () => {
  const token = tokenFor("user-9", 3600);

  it("serves the verified token in oauth mode", async () => {
    const auth: AuthProvider = new BearerAuthProvider(token);
    expect(auth.mode).toBe("oauth");
    expect(auth.pinnedProjectUuid).toBeUndefined();
    expect(auth.sessionPath).toBeUndefined();
    expect(await auth.getAccessToken()).toBe(token);
    expect(await auth.getAccessToken({ forceRefresh: false })).toBe(token);
  });

  it("cannot refresh: forceRefresh throws AUTH_EXPIRED telling the client to re-authenticate", async () => {
    const err = await new BearerAuthProvider(token).getAccessToken({ forceRefresh: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MicropageError);
    expect((err as MicropageError).code).toBe("AUTH_EXPIRED");
    expect((err as MicropageError).message).toMatch(/re-authenticate/);
  });

  it("refuses an empty token", () => {
    expect(() => new BearerAuthProvider("  ")).toThrow(MicropageError);
  });

  it("turns an API 401 into AUTH_EXPIRED after exactly one request", async () => {
    const fake = createFakeFetch({ status: 401, body: { message: "JWT expired" } });
    const http = makeHttp(fake, new BearerAuthProvider(token));
    await expect(http.select("projects")).rejects.toMatchObject({ code: "AUTH_EXPIRED" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.headers.authorization).toBe(`Bearer ${token}`);
  });

  it("exposes the user id through the token's sub", async () => {
    expect(await currentUserId(new BearerAuthProvider(token))).toBe("user-9");
  });
});

describe("currentUserId wording", () => {
  const noSub: AuthProvider = { mode: "oauth", getAccessToken: async () => makeJwt({ exp: 4_000_000_000 }) };

  it("keeps the stdio wording by default and drops `micropage login` for a hosted connection", async () => {
    await expect(currentUserId(noSub)).rejects.toMatchObject({ code: "SESSION_EXPIRED", message: expect.stringMatching(/micropage login/) });
    for (const hints of [REMOTE_OAUTH_HINTS, REMOTE_DEPLOY_TOKEN_HINTS]) {
      const err = (await currentUserId(noSub, hints).catch((e: unknown) => e)) as MicropageError;
      expect(err.message).toBe(hints.tokenNoUser);
      expect(err.message).not.toMatch(/micropage login|MICROPAGE_/);
      const gate = new PlanGate({ http: makeHttp(createFakeFetch(), noSub), auth: noSub, hints });
      await expect(gate.currentUserId()).rejects.toMatchObject({ message: hints.tokenNoUser });
    }
  });
});
