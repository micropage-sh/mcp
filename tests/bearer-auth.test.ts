import { describe, expect, it } from "vitest";

import { currentUserId, type AuthProvider } from "../src/client/auth-provider.js";
import { BearerAuthProvider } from "../src/client/bearer-auth.js";
import { MicropageError } from "../src/client/errors.js";
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
