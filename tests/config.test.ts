import { describe, expect, it } from "vitest";

import { CNAME_TARGET, loadConfig, platformDomains, platformSlug, projectUrl } from "../src/client/config.js";
import { normalizeDomain } from "../src/tools/projects.js";

describe("loadConfig", () => {
  it("defaults the platform domain to micropage.live and keeps the micropage.sh services", () => {
    const c = loadConfig({});
    expect(c.baseDomain).toBe("micropage.live");
    expect(c.appUrl).toBe("https://app.micropage.sh");
    expect(c.buildCompilerUrl).toBe("https://build-compiler.micropage.sh");
  });

  it("takes MICROPAGE_BASE_DOMAIN", () => {
    expect(loadConfig({ MICROPAGE_BASE_DOMAIN: "mp.test" }).baseDomain).toBe("mp.test");
  });
});

describe("projectUrl", () => {
  it("builds the live URL on the configured platform domain, custom domain first", () => {
    const c = loadConfig({});
    expect(projectUrl(c, "acme")).toBe("https://acme.micropage.live");
    expect(projectUrl(c, "acme", "www.acme.com")).toBe("https://www.acme.com");
    expect(projectUrl(c, "acme", "http://www.acme.com")).toBe("http://www.acme.com");
    expect(projectUrl({ baseDomain: "mp.test" }, "acme")).toBe("https://acme.mp.test");
    expect(projectUrl(c, null)).toBeNull();
    expect(projectUrl(c, "  ")).toBeNull();
  });
});

describe("platform domains", () => {
  it("lists the configured, current and legacy domains once each", () => {
    expect(platformDomains("micropage.live")).toEqual(["micropage.live", "micropage.sh"]);
    expect(platformDomains("Micropage.SH")).toEqual(["micropage.sh", "micropage.live"]);
    expect(platformDomains("mp.test")).toEqual(["mp.test", "micropage.live", "micropage.sh"]);
  });

  it("extracts a slug from a one-label platform hostname only", () => {
    expect(platformSlug("acme.micropage.live", "micropage.live")).toBe("acme");
    expect(platformSlug("acme.micropage.sh", "micropage.live")).toBe("acme");
    expect(platformSlug("acme.mp.test", "mp.test")).toBe("acme");
    expect(platformSlug("shop.acme.micropage.live", "micropage.live")).toBeNull();
    expect(platformSlug("micropage.live", "micropage.live")).toBeNull();
    expect(platformSlug("acme", "micropage.live")).toBeNull();
    expect(platformSlug("www.acme.com", "micropage.live")).toBeNull();
  });

  it("keeps the custom-domain CNAME target on the micropage.sh zone", () => {
    expect(CNAME_TARGET).toBe("cname.micropage.sh");
  });
});

describe("normalizeDomain", () => {
  it("strips either platform suffix, a scheme and a path", () => {
    expect(normalizeDomain("acme", "micropage.live")).toBe("acme");
    expect(normalizeDomain("Acme.micropage.live", "micropage.live")).toBe("acme");
    expect(normalizeDomain("acme.micropage.sh", "micropage.live")).toBe("acme");
    expect(normalizeDomain("https://acme.micropage.live/", "micropage.live")).toBe("acme");
    expect(normalizeDomain("acme.mp.test", "mp.test")).toBe("acme");
  });

  it("rejects anything that is not one slug label", () => {
    expect(() => normalizeDomain("shop.acme.micropage.live", "micropage.live")).toThrow(/not a valid micropage subdomain/);
    expect(() => normalizeDomain("www.acme.com", "micropage.live")).toThrow(/not a valid micropage subdomain/);
    expect(() => normalizeDomain("-bad-", "micropage.live")).toThrow(/not a valid micropage subdomain/);
  });
});
