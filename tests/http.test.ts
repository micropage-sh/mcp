import { describe, expect, it } from "vitest";

import { MicropageError } from "../src/client/errors.js";
import { Http, eq, inList } from "../src/client/http.js";
import { VERSION } from "../src/version.js";
import { FakeAuth, TEST_CONFIG, createFakeFetch, makeHttp } from "./helpers/fake-fetch.js";

describe("Http request headers", () => {
  it("sends the anon apikey, the user bearer and a versioned user agent", async () => {
    const fake = createFakeFetch({ body: { ok: true } });
    const http = new Http({ config: TEST_CONFIG, auth: new FakeAuth(["user-jwt"]), fetch: fake.fetch });

    await http.invoke("whoami-ish", { a: 1 });

    const [call] = fake.calls;
    expect(call?.method).toBe("POST");
    expect(call?.url).toBe("https://supabase.test/functions/v1/whoami-ish");
    expect(call?.headers.apikey).toBe("anon-key");
    expect(call?.headers.authorization).toBe("Bearer user-jwt");
    expect(call?.headers["user-agent"]).toBe(`micropage-mcp/${VERSION}`);
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(call?.body).toEqual({ a: 1 });
  });

  it("uses the anon key as bearer when auth is off", async () => {
    const fake = createFakeFetch({ body: {} });
    const auth = new FakeAuth(["user-jwt"]);
    await makeHttp(fake, auth).request("POST", "https://supabase.test/functions/v1/x", { auth: false, body: {} });
    expect(fake.calls[0]?.headers.authorization).toBe("Bearer anon-key");
  });
});

describe("Http 401 handling", () => {
  it("refreshes once via the provider and retries with the new token", async () => {
    const fake = createFakeFetch({ status: 401, body: { message: "JWT expired" } }, { body: [{ id: 1 }] });
    const auth = new FakeAuth(["old", "new"]);

    const rows = await makeHttp(fake, auth).select("projects");

    expect(rows).toEqual([{ id: 1 }]);
    expect(auth.refreshCount).toBe(1);
    expect(fake.calls.map((c) => c.headers.authorization)).toEqual(["Bearer old", "Bearer new"]);
  });

  it("gives up after one retry and names the fix", async () => {
    const fake = createFakeFetch({ status: 401 }, { status: 401 });
    const auth = new FakeAuth(["old", "new"]);

    const err = await makeHttp(fake, auth).select("projects").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MicropageError);
    expect((err as MicropageError).code).toBe("SESSION_EXPIRED");
    expect((err as MicropageError).message).toMatch(/micropage login/);
    expect(fake.calls).toHaveLength(2);
    expect(auth.refreshCount).toBe(1);
  });

  it("does not retry when the provider has no new token", async () => {
    const fake = createFakeFetch({ status: 401 });
    const auth = new FakeAuth(["only"]);

    await expect(makeHttp(fake, auth).invoke("x")).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(fake.calls).toHaveLength(1);
  });

  it("does not refresh on 401 for anon calls", async () => {
    const fake = createFakeFetch({ status: 401 });
    const auth = new FakeAuth(["a", "b"]);
    await expect(
      makeHttp(fake, auth).request("POST", "https://supabase.test/functions/v1/x", { auth: false }),
    ).rejects.toBeInstanceOf(MicropageError);
    expect(auth.refreshCount).toBe(0);
  });
});

describe("Http errors", () => {
  it("surfaces the server's message with method, path and status", async () => {
    const fake = createFakeFetch({ status: 403, body: { error: "Custom domains need a paid plan" } });
    const err = (await makeHttp(fake).invoke("save-custom-domain", {}).catch((e: unknown) => e)) as MicropageError;
    expect(err.code).toBe("HTTP");
    expect(err.status).toBe(403);
    expect(err.message).toBe("POST /functions/v1/save-custom-domain failed (HTTP 403): Custom domains need a paid plan");
  });

  it("maps a timeout to a TIMEOUT error", async () => {
    const http = new Http({
      config: TEST_CONFIG,
      auth: new FakeAuth(),
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    await expect(http.invoke("slow")).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("maps a thrown fetch to a NETWORK error", async () => {
    const http = new Http({
      config: TEST_CONFIG,
      auth: new FakeAuth(),
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(http.invoke("x")).rejects.toMatchObject({ code: "NETWORK" });
  });
});

describe("Http PostgREST helpers", () => {
  it("builds select URLs with filters, order and limit", async () => {
    const fake = createFakeFetch({ body: [] });
    await makeHttp(fake).select("builds", {
      select: "id,status",
      filters: { project_id: eq(7), status: inList(["draft", "failed"]) },
      order: "created_at.desc",
      limit: 5,
    });
    const url = new URL(fake.calls[0]!.url);
    expect(url.pathname).toBe("/rest/v1/builds");
    expect(url.searchParams.get("select")).toBe("id,status");
    expect(url.searchParams.get("project_id")).toBe("eq.7");
    expect(url.searchParams.get("status")).toBe("in.(draft,failed)");
    expect(url.searchParams.get("order")).toBe("created_at.desc");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  it("asks for the representation on insert and patch", async () => {
    const fake = createFakeFetch({ status: 201, body: [{ id: 9 }] }, { body: [{ id: 9 }] });
    const http = makeHttp(fake);
    await http.insert("builds", { status: "draft" });
    await http.patch("builds", { id: eq(9) }, { json_content: {} });
    expect(fake.calls[0]?.headers.prefer).toBe("return=representation");
    expect(fake.calls[1]?.method).toBe("PATCH");
    expect(new URL(fake.calls[1]!.url).searchParams.get("id")).toBe("eq.9");
  });

  it("refuses an unfiltered patch without calling the network", async () => {
    const fake = createFakeFetch();
    await expect(makeHttp(fake).patch("builds", {}, { status: "x" })).rejects.toBeInstanceOf(MicropageError);
    expect(fake.calls).toHaveLength(0);
  });

  it("encodes invokeGet params into the query string", async () => {
    const fake = createFakeFetch({ body: {} });
    await makeHttp(fake).invokeGet("get-file-url", { project_id: "7", filename: "a b.png" });
    const url = new URL(fake.calls[0]!.url);
    expect(fake.calls[0]?.method).toBe("GET");
    expect(url.searchParams.get("filename")).toBe("a b.png");
  });
});

describe("Http.count", () => {
  it("sends HEAD with Prefer: count=exact and reads the total from Content-Range", async () => {
    const fake = createFakeFetch({ headers: { "content-range": "0-999/3573" } });
    const n = await makeHttp(fake).count("newsletter_subscribers", { form_id: eq("f1"), unsubscribed_at: "is.null" });
    expect(n).toBe(3573);
    const [call] = fake.calls;
    expect(call?.method).toBe("HEAD");
    expect(call?.headers.prefer).toBe("count=exact");
    expect(call?.headers.authorization).toBe("Bearer token-1");
    const q = new URL(call!.url).searchParams;
    expect(q.get("form_id")).toBe("eq.f1");
    expect(q.get("unsubscribed_at")).toBe("is.null");
  });

  it("reads an empty result's */0", async () => {
    expect(await makeHttp(createFakeFetch({ headers: { "content-range": "*/0" } })).count("forms")).toBe(0);
  });

  it("retries once after a 401 like every other request", async () => {
    const fake = createFakeFetch({ status: 401 }, { headers: { "content-range": "*/7" } });
    expect(await makeHttp(fake, new FakeAuth(["old", "new"])).count("forms")).toBe(7);
    expect(fake.calls.map((c) => c.headers.authorization)).toEqual(["Bearer old", "Bearer new"]);
  });

  it("fails loudly without a Content-Range rather than guessing", async () => {
    const err = await makeHttp(createFakeFetch({ body: [] })).count("forms").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MicropageError);
    expect((err as MicropageError).message).toMatch(/no row count/);
  });

  it("reports HTTP errors", async () => {
    const err = await makeHttp(createFakeFetch({ status: 500, body: { message: "boom" } })).count("forms").catch((e: unknown) => e);
    expect((err as MicropageError).status).toBe(500);
  });
});
