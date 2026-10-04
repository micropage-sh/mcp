import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** An unsigned JWT with the given claims; the client only ever reads claims. */
export function makeJwt(claims: Record<string, unknown>): string {
  const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64(claims)}.sig`;
}

/** A token for `sub` expiring `inSeconds` from `nowMs`; `tag` keeps tokens distinct. */
export function tokenFor(sub: string, inSeconds: number, nowMs = Date.now(), tag = ""): string {
  return makeJwt({ sub, email: `${sub}@example.com`, exp: Math.floor(nowMs / 1000) + inSeconds, tag });
}

export interface TempConfig {
  dir: string;
  path: string;
  write(config: Record<string, unknown>): Promise<void>;
  read(): Promise<Record<string, unknown>>;
  raw(): Promise<string>;
  cleanup(): Promise<void>;
}

export async function tempConfig(): Promise<TempConfig> {
  const dir = await mkdtemp(join(tmpdir(), "micropage-mcp-test-"));
  const path = join(dir, "config.json");
  return {
    dir,
    path,
    write: (config) => writeFile(path, JSON.stringify(config, null, 2), "utf8"),
    read: async () => JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>,
    raw: () => readFile(path, "utf8"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
