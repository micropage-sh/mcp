import { eq, type Http } from "../client/http.js";
import type { Permissions } from "../context.js";
import { NO_PERMISSIONS } from "../guards.js";
import { BoundedCache } from "./cache.js";

export const PERMISSIONS_TTL_MS = 60_000;
const PERMISSIONS_MAX = 5_000;

interface PermissionRow {
  allow_send: boolean | null;
  allow_delete: boolean | null;
  allow_submissions: boolean | null;
}

/**
 * What the user allowed one connected app to do: the
 * mcp_connection_permissions row for (user, OAuth client), read with the
 * user's own token under RLS. No row means everything off. A change on the
 * Connected AI apps page takes effect within PERMISSIONS_TTL_MS.
 */
export class PermissionStore {
  private readonly cache: BoundedCache<Permissions>;

  constructor(private readonly now: () => number) {
    this.cache = new BoundedCache(PERMISSIONS_MAX, now);
  }

  /** A failed read is not cached and falls back to all off; `onError` hears about it. */
  async get(http: Http, sub: string, clientId: string, onError?: (err: unknown) => void): Promise<Permissions> {
    const key = `${sub}\n${clientId}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    let row: PermissionRow | null;
    try {
      row = await http.selectOne<PermissionRow>("mcp_connection_permissions", {
        select: "allow_send,allow_delete,allow_submissions",
        filters: { user_id: eq(sub), oauth_client_id: eq(clientId) },
      });
    } catch (err) {
      onError?.(err);
      return NO_PERMISSIONS;
    }
    const permissions: Permissions = row
      ? { allowSend: row.allow_send === true, allowDelete: row.allow_delete === true, allowSubmissions: row.allow_submissions === true }
      : NO_PERMISSIONS;
    this.cache.set(key, permissions, this.now() + PERMISSIONS_TTL_MS);
    return permissions;
  }

  clear(): void {
    this.cache.clear();
  }
}
