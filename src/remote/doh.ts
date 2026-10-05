import type { HostLookup } from "../client/assets.js";
import type { FetchLike } from "../client/http.js";

export const DOH_ENDPOINT = "https://cloudflare-dns.com/dns-query";

const TYPE_A = 1;
const TYPE_AAAA = 28;

interface DohAnswer {
  Status?: number;
  Answer?: Array<{ type?: number; data?: string }>;
}

/**
 * HostLookup over DNS-over-HTTPS (Cloudflare's JSON API), for a runtime
 * without a resolver. Returns every A and AAAA address, CNAMEs followed by
 * the resolver. NXDOMAIN and empty answers yield no addresses, which the
 * upload refuses; a failed query throws.
 */
export function dohLookup(fetchImpl: FetchLike = (input, init) => fetch(input, init), options: { endpoint?: string; timeoutMs?: number } = {}): HostLookup {
  const endpoint = options.endpoint ?? DOH_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 5_000;

  const query = async (hostname: string, type: "A" | "AAAA"): Promise<Array<{ address: string; family: number }>> => {
    const url = `${endpoint}?name=${encodeURIComponent(hostname)}&type=${type}`;
    const res = await fetchImpl(url, { headers: { Accept: "application/dns-json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`DNS-over-HTTPS query failed (HTTP ${res.status})`);
    }
    const data = (await res.json()) as DohAnswer;
    // 3 = NXDOMAIN: the name does not exist, so it has no addresses.
    if (data.Status !== 0 && data.Status !== 3) throw new Error(`DNS-over-HTTPS query failed (status ${data.Status ?? "unknown"})`);
    const want = type === "A" ? TYPE_A : TYPE_AAAA;
    return (data.Answer ?? [])
      .filter((a) => a.type === want && typeof a.data === "string")
      .map((a) => ({ address: a.data!, family: type === "A" ? 4 : 6 }));
  };

  return async (hostname) => {
    const [v4, v6] = await Promise.all([query(hostname, "A"), query(hostname, "AAAA")]);
    return [...v4, ...v6];
  };
}
