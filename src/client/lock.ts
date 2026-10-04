import { randomBytes } from "node:crypto";
import { open, readFile, stat, unlink } from "node:fs/promises";

import { MicropageError } from "./errors.js";

export interface LockOptions {
  /** A lock older than this is assumed abandoned (its holder crashed) and is broken. */
  staleMs?: number;
  /** Poll interval while another process holds the lock. */
  retryMs?: number;
  /** Give up waiting after this long. */
  timeoutMs?: number;
}

export const DEFAULT_LOCK_STALE_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Cross-process mutex on a lockfile created with O_EXCL. Serialises token
 * refreshes between MCP server processes sharing one CLI session file, since
 * Supabase rotates the refresh token and a second use of the old one fails.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const release = await acquireFileLock(lockPath, options);
  try {
    return await fn();
  } finally {
    await release();
  }
}

export async function acquireFileLock(lockPath: string, options: LockOptions = {}): Promise<() => Promise<void>> {
  const staleMs = options.staleMs ?? DEFAULT_LOCK_STALE_MS;
  const retryMs = options.retryMs ?? 50;
  const timeoutMs = options.timeoutMs ?? staleMs + 5_000;
  const nonce = `${process.pid}.${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(nonce, "utf8");
      } finally {
        await handle.close();
      }
      return async () => {
        // Only remove our own lock: if we overran staleMs, someone else may hold it now.
        if ((await readFile(lockPath, "utf8").catch(() => null)) === nonce) {
          await unlink(lockPath).catch(() => undefined);
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    await breakIfStale(lockPath, staleMs);
    if (Date.now() >= deadline) {
      throw new MicropageError(
        "SESSION_LOCKED",
        `Timed out waiting for another micropage process to finish refreshing the login session (${lockPath}). Retry shortly.`,
      );
    }
    await sleep(retryMs);
  }
}

async function breakIfStale(lockPath: string, staleMs: number): Promise<void> {
  const info = await stat(lockPath).catch(() => null);
  if (!info || Date.now() - info.mtimeMs < staleMs) return;
  // Re-check the holder right before unlinking so two waiters breaking the
  // same stale lock are unlikely to delete a fresh lock the other just took.
  const holder = await readFile(lockPath, "utf8").catch(() => null);
  const again = await stat(lockPath).catch(() => null);
  if (!again || again.mtimeMs !== info.mtimeMs) return;
  if ((await readFile(lockPath, "utf8").catch(() => null)) !== holder) return;
  await unlink(lockPath).catch(() => undefined);
}
