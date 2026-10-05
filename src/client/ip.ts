// Pure IP-literal parsing, so the address checks run where node:net does not
// exist. Accepts the same textual forms as Node's net.isIP (dotted-quad IPv4
// without leading zeros; IPv6 with "::", an embedded IPv4 tail, and a zone id).

/** The four bytes of a dotted-quad IPv4 address, or null when it is not one. */
export function ipv4Bytes(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const bytes = parts.map((p) => (/^(0|[1-9]\d{0,2})$/.test(p) ? Number(p) : Number.NaN));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : null;
}

/** 16 bytes of an IPv6 address (zone id dropped), or null when it does not parse. */
export function ipv6Bytes(raw: string): number[] | null {
  const parts = raw.split("%");
  if (parts.length > 2 || (parts.length === 2 && !parts[1])) return null;
  let ip = parts[0]!;
  let tail: number[] = [];
  const lastColon = ip.lastIndexOf(":");
  if (lastColon < 0) return null;
  if (ip.slice(lastColon + 1).includes(".")) {
    const v4 = ipv4Bytes(ip.slice(lastColon + 1));
    if (!v4) return null;
    tail = v4;
    ip = `${ip.slice(0, lastColon + 1)}0:0`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string): string[] => (h === "" ? [] : h.split(":"));
  const head = groups(halves[0]!);
  const back = halves.length === 2 ? groups(halves[1]!) : [];
  const fill = 8 - head.length - back.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  const all = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...back];
  const bytes: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

/** 4 or 6 for an IP literal, 0 otherwise (as net.isIP). */
export function ipFamily(ip: string): 0 | 4 | 6 {
  if (ipv4Bytes(ip)) return 4;
  if (ipv6Bytes(ip)) return 6;
  return 0;
}

function blockedV4([a, b]: number[]): boolean {
  return (
    a === 0 || // 0.0.0.0/8 "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18/15
    a! >= 224 // multicast 224/4 and reserved 240/4, incl. broadcast
  );
}

/**
 * True for loopback, private, link-local, CGNAT, benchmarking, ULA, multicast
 * and unspecified addresses, in any notation, and for the NAT64 (64:ff9b::/96)
 * and 6to4 (2002::/16) prefixes, which can carry any IPv4 address, private ones included.
 */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ipv4Bytes(ip);
  if (v4) return blockedV4(v4);
  const b = ipv6Bytes(ip);
  if (!b) return true;
  const zeros = (n: number): boolean => b.slice(0, n).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, which also covers :: and ::1).
  if ((zeros(10) && b[10] === 0xff && b[11] === 0xff) || zeros(12)) return blockedV4(b.slice(12));
  return (
    (b[0] === 0xfe && (b[1]! & 0xc0) === 0x80) || // fe80::/10 link-local
    (b[0]! & 0xfe) === 0xfc || // fc00::/7 unique local
    b[0] === 0xff || // ff00::/8 multicast
    (b[0] === 0x20 && b[1] === 0x02) || // 2002::/16 6to4
    (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((x) => x === 0)) // 64:ff9b::/96 NAT64
  );
}
