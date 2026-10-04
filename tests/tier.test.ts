import { describe, expect, it } from "vitest";

import { MicropageError } from "../src/client/errors.js";
import { PLAN_CACHE_TTL_MS, PlanGate, PRICING_URL } from "../src/client/tier.js";
import { FakeAuth, createFakeFetch, makeHttp } from "./helpers/fake-fetch.js";
import { tokenFor } from "./helpers/session.js";

const TOKEN = tokenFor("user-1", 3600);

function gate(fake: ReturnType<typeof createFakeFetch>, clock = { now: 1_000_000 }, auth = new FakeAuth([TOKEN])) {
  return new PlanGate({ http: makeHttp(fake, auth), auth, now: () => clock.now });
}

describe("PlanGate", () => {
  it("reads customers.plan_tier for the token's user, as the CLI does", async () => {
    const fake = createFakeFetch({ body: [{ plan_tier: "pro" }] });
    expect(await gate(fake).getPlanTier()).toBe("pro");
    const url = new URL(fake.calls[0]!.url);
    expect(url.pathname).toBe("/rest/v1/customers");
    expect(url.searchParams.get("select")).toBe("plan_tier");
    expect(url.searchParams.get("user_id")).toBe("eq.user-1");
    expect(url.searchParams.get("limit")).toBe("1");
  });

  it("caches the tier for 5 minutes", async () => {
    const clock = { now: 1_000_000 };
    const fake = createFakeFetch({ body: [{ plan_tier: "pro" }] }, { body: [{ plan_tier: "free" }] });
    const g = gate(fake, clock);
    await g.requirePaidPlan();
    clock.now += PLAN_CACHE_TTL_MS - 1;
    await g.requirePaidPlan();
    expect(fake.calls).toHaveLength(1);

    clock.now += 2;
    await expect(g.requirePaidPlan()).rejects.toMatchObject({ code: "PLAN_REQUIRED" });
    expect(fake.calls).toHaveLength(2);
  });

  it("refuses the free plan with the upgrade message", async () => {
    const fake = createFakeFetch({ body: [{ plan_tier: "free" }] });
    const err = (await gate(fake).requirePaidPlan().catch((e: unknown) => e)) as MicropageError;
    expect(err).toBeInstanceOf(MicropageError);
    expect(err.code).toBe("PLAN_REQUIRED");
    expect(err.message).toContain(PRICING_URL);
    expect(err.message).toMatch(/paid plans only/);
  });

  it("treats a missing customer row as free", async () => {
    await expect(gate(createFakeFetch({ body: [] })).requirePaidPlan()).rejects.toMatchObject({ code: "PLAN_REQUIRED" });
  });

  it("lets pro_plus through", async () => {
    await expect(gate(createFakeFetch({ body: [{ plan_tier: "pro_plus" }] })).requirePaidPlan()).resolves.toBeUndefined();
  });

  it("does not cache a failed lookup as free", async () => {
    const fake = createFakeFetch({ status: 500, body: { message: "boom" } }, { body: [{ plan_tier: "pro" }] });
    const g = gate(fake);
    await expect(g.requirePaidPlan()).rejects.toMatchObject({ code: "HTTP" });
    await expect(g.requirePaidPlan()).resolves.toBeUndefined();
  });

  it("does not reuse one user's cached tier for another", async () => {
    const auth = new FakeAuth([tokenFor("user-1", 3600), tokenFor("user-2", 3600)]);
    const fake = createFakeFetch({ body: [{ plan_tier: "pro" }] }, { body: [{ plan_tier: "free" }] });
    const g = gate(fake, { now: 1 }, auth);
    await g.requirePaidPlan();
    await auth.getAccessToken({ forceRefresh: true }); // the session now belongs to user-2
    await expect(g.requirePaidPlan()).rejects.toMatchObject({ code: "PLAN_REQUIRED" });
  });

  it("skips the lookup in deploy-token mode (deploy tokens are Pro+ only)", async () => {
    const fake = createFakeFetch();
    const auth = new FakeAuth([TOKEN], { mode: "deploy_token", pinnedProjectUuid: "x" });
    await expect(gate(fake, { now: 1 }, auth).requirePaidPlan()).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });
});
