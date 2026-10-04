import { describe, expect, it } from "vitest";

import { MicropageError } from "../src/client/errors.js";
import { ProjectRef, parseProjectRef, resolveProject, type ProjectRow } from "../src/client/project-ref.js";
import { FakeAuth, TEST_CONFIG, createFakeFetch, makeHttp } from "./helpers/fake-fetch.js";

const UUID = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-8888-7777-6666-555555555555";

const row = (over: Partial<ProjectRow> = {}): ProjectRow => ({
  id: 7,
  uuid: UUID,
  name: "Acme",
  domain: "acme",
  custom_domain: null,
  active_build_id: 30,
  status: "active",
  created_at: "2026-01-01T00:00:00Z",
  ...over,
});

function deps(fake: ReturnType<typeof createFakeFetch>, auth = new FakeAuth()) {
  return { http: makeHttp(fake, auth), auth, config: TEST_CONFIG };
}

const params = (fake: ReturnType<typeof createFakeFetch>) => new URL(fake.calls[0]!.url).searchParams;

describe("parseProjectRef", () => {
  it.each([
    [UUID.toUpperCase(), { kind: "uuid", value: UUID }],
    ["42", { kind: "id", value: 42 }],
    ["acme", { kind: "slug", value: "acme" }],
    ["acme.micropage.sh", { kind: "slug", value: "acme" }],
    ["https://Acme.micropage.sh/blog/post?x=1#y", { kind: "slug", value: "acme" }],
    ["www.acme.com", { kind: "host", value: "www.acme.com" }],
    ["https://www.acme.com:443/pricing/", { kind: "host", value: "www.acme.com" }],
    ["shop.acme.micropage.sh", { kind: "host", value: "shop.acme.micropage.sh" }],
  ])("%s", (input, expected) => {
    expect(parseProjectRef(input, "micropage.sh")).toEqual(expected);
  });

  it("rejects strings that are not a hostname (and so cannot reach the or= filter)", () => {
    expect(() => parseProjectRef("a.com,user_id.eq.x", "micropage.sh")).toThrow(MicropageError);
    expect(() => parseProjectRef("my project", "micropage.sh")).toThrow(/list_projects/);
  });
});

describe("ProjectRef schema", () => {
  it("is described and trims", () => {
    expect(ProjectRef.description).toMatch(/uuid/);
    expect(ProjectRef.parse("  acme ")).toBe("acme");
    expect(ProjectRef.safeParse("   ").success).toBe(false);
  });
});

describe("resolveProject", () => {
  it("by uuid", async () => {
    const fake = createFakeFetch({ body: [row()] });
    const p = await resolveProject(deps(fake), UUID);
    expect(params(fake).get("uuid")).toBe(`eq.${UUID}`);
    expect(p).toMatchObject({
      id: 7,
      uuid: UUID,
      live_url: "https://acme.micropage.sh",
      editor_url: "https://app.micropage.sh/editor/7",
    });
  });

  it("by numeric id", async () => {
    const fake = createFakeFetch({ body: [row()] });
    await resolveProject(deps(fake), "7");
    expect(params(fake).get("id")).toBe("eq.7");
  });

  it("by micropage hostname or URL", async () => {
    const fake = createFakeFetch({ body: [row()] });
    await resolveProject(deps(fake), "https://acme.micropage.sh/about");
    expect(params(fake).get("domain")).toBe("eq.acme");
  });

  it("by custom domain, preferring the custom_domain match and using it as the live URL", async () => {
    const fake = createFakeFetch({
      body: [row({ id: 3, uuid: OTHER, domain: "www.acme.com" }), row({ custom_domain: "www.acme.com" })],
    });
    const p = await resolveProject(deps(fake), "www.acme.com");
    expect(params(fake).get("or")).toBe("(custom_domain.eq.www.acme.com,domain.eq.www.acme.com)");
    expect(p.id).toBe(7);
    expect(p.live_url).toBe("https://www.acme.com");
  });

  it("reports PROJECT_NOT_FOUND and points at list_projects", async () => {
    const fake = createFakeFetch({ body: [] });
    const err = (await resolveProject(deps(fake), "nope").catch((e: unknown) => e)) as MicropageError;
    expect(err.code).toBe("PROJECT_NOT_FOUND");
    expect(err.message).toMatch(/list_projects/);
  });

  it("requires a ref in session mode", async () => {
    const fake = createFakeFetch();
    await expect(resolveProject(deps(fake), undefined)).rejects.toMatchObject({ code: "PROJECT_REQUIRED" });
    expect(fake.calls).toHaveLength(0);
  });

  describe("under a deploy token", () => {
    const pinned = () => new FakeAuth(["t"], { mode: "deploy_token", pinnedProjectUuid: UUID });

    it("refuses a foreign uuid before any network call", async () => {
      const fake = createFakeFetch();
      await expect(resolveProject(deps(fake, pinned()), OTHER)).rejects.toMatchObject({
        code: "NOT_ALLOWED_IN_DEPLOY_TOKEN_MODE",
      });
      expect(fake.calls).toHaveLength(0);
    });

    it("refuses a domain that resolves to another of the owner's projects", async () => {
      const fake = createFakeFetch({ body: [row({ uuid: OTHER, domain: "other" })] });
      await expect(resolveProject(deps(fake, pinned()), "other.micropage.sh")).rejects.toThrow(/pinned to project/);
    });

    it("allows the pinned project by domain, and defaults to it when the ref is omitted", async () => {
      const fake = createFakeFetch({ body: [row()] }, { body: [row()] });
      expect((await resolveProject(deps(fake, pinned()), "acme")).uuid).toBe(UUID);
      expect((await resolveProject(deps(fake, pinned()), undefined)).uuid).toBe(UUID);
      expect(new URL(fake.calls[1]!.url).searchParams.get("uuid")).toBe(`eq.${UUID}`);
    });
  });
});
