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

describe("isPrivateAddress: transition and benchmarking ranges", () => {
  it("refuses NAT64 64:ff9b::/96, 6to4 2002::/16 and 198.18.0.0/15", () => {
    for (const ip of [
      "64:ff9b::a00:1",
      "64:ff9b::10.0.0.1",
      "64:ff9b::8.8.8.8",
      "64:FF9B::7f00:1",
      "2002::1",
      "2002:c0a8:101::1",
      "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "198.18.0.0",
      "198.18.0.1",
      "198.19.255.255",
      "::ffff:198.18.0.1",
    ]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it("keeps the public neighbours of those ranges public", () => {
    for (const ip of ["198.17.255.255", "198.20.0.0", "64:ff9b:0:0:0:1::1", "64:ff9a::1", "2001:db9::1", "2003::1", "2606:4700::6810:84e5"]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });
});
