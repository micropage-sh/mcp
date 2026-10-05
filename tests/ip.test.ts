import { isIP } from "node:net";

import { describe, expect, it } from "vitest";

import { ipFamily, isPrivateAddress } from "../src/client/ip.js";

// node:net is the reference the pure parser replaced; it must classify the
// same strings, so URL hostnames and resolver answers are judged as before.
const CORPUS = [
  "1.2.3.4", "0.0.0.0", "255.255.255.255", "256.1.1.1", "1.2.3", "1.2.3.4.5", "01.2.3.4", "1.2.3.04", "1..3.4", "a.b.c.d",
  "1.2.3.4 ", "", "::", "::1", "1::", "1:2:3:4:5:6:7:8", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7::", "::1:2:3:4:5:6:7",
  "1::2::3", ":::", ":1:2:3:4:5:6:7", "1:2:3:4:5:6:7:", "fe80::1", "fe80::1%eth0", "::ffff:1.2.3.4", "::ffff:7f00:1",
  "::1.2.3.4", "1:2:3:4:5:6:1.2.3.4", "1:2:3:4:5:6:7:1.2.3.4", "::ffff:256.1.1.1", "12345::", "g::1", "2606:4700::6810:84e5",
  "example.com", "localhost", "[::1]", "1.2.3.4%x",
];

describe("ipFamily", () => {
  it("agrees with net.isIP", () => {
    for (const ip of CORPUS) expect(ipFamily(ip), JSON.stringify(ip)).toBe(isIP(ip));
  });
});

describe("isPrivateAddress (pure)", () => {
  it("treats a zone-suffixed IPv4 string as unsafe rather than throwing", () => {
    expect(isPrivateAddress("1.2.3.4%x")).toBe(true);
  });
});
