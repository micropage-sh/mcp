/**
 * A per-isolate map whose entries expire at their own deadline and whose size
 * is capped: past the cap, expired entries go first, then the oldest
 * insertions. Isolates are short-lived and not shared, so this only saves
 * upstream calls; it is never the source of truth.
 */
export class BoundedCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {}

  get(key: string): V | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V, expiresAt: number): void {
    this.entries.delete(key);
    if (this.entries.size >= this.maxEntries) {
      const now = this.now();
      for (const [k, e] of this.entries) if (e.expiresAt <= now) this.entries.delete(k);
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, { value, expiresAt });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
