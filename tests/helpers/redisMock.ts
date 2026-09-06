/**
 * A minimal in-memory stand-in for the Redis commands this codebase uses.
 *
 * Running the suite against a real Redis would make the tests depend on a
 * service being up, and `ioredis-mock` does not cover the list operations the
 * matching queue relies on. This fake implements exactly the surface the app
 * touches, with the same semantics — including TTL expiry, which several auth
 * tests depend on.
 */
type Entry = { value: string; expiresAt: number | null };

export class FakeRedis {
  public status = 'ready';

  private store = new Map<string, Entry>();

  private lists = new Map<string, string[]>();

  private sets = new Map<string, Set<string>>();

  private live(key: string): Entry | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, mode?: string, ttl?: number): Promise<'OK'> {
    const expiresAt = mode === 'EX' && typeof ttl === 'number' ? Date.now() + ttl * 1_000 : null;
    this.store.set(key, { value, expiresAt });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    keys.forEach((key) => {
      if (this.store.delete(key)) removed += 1;
      if (this.lists.delete(key)) removed += 1;
      if (this.sets.delete(key)) removed += 1;
    });
    return removed;
  }

  async exists(key: string): Promise<number> {
    return this.live(key) ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    const current = Number(this.live(key)?.value ?? '0') + 1;
    const existing = this.store.get(key);
    this.store.set(key, { value: String(current), expiresAt: existing?.expiresAt ?? null });
    return current;
  }

  async expire(key: string, seconds: number): Promise<number> {
    const entry = this.store.get(key);
    if (!entry) return 0;
    entry.expiresAt = Date.now() + seconds * 1_000;
    return 1;
  }

  async scan(cursor: string, _match: string, pattern: string): Promise<[string, string[]]> {
    const regex = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
    const matched = [...this.store.keys()].filter((key) => regex.test(key) && this.live(key));
    return ['0', matched];
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lpop(key: string): Promise<string | null> {
    const list = this.lists.get(key);
    if (!list || list.length === 0) return null;
    return list.shift() ?? null;
  }

  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    const before = set.size;
    members.forEach((member) => set.add(member));
    this.sets.set(key, set);
    return set.size - before;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    members.forEach((member) => {
      if (set.delete(member)) removed += 1;
    });
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async call(): Promise<unknown> {
    return null;
  }

  async connect(): Promise<void> {}

  async quit(): Promise<'OK'> {
    return 'OK';
  }

  disconnect(): void {}

  on(): this {
    return this;
  }

  /** Test helper — wipes every namespace between cases. */
  flush(): void {
    this.store.clear();
    this.lists.clear();
    this.sets.clear();
  }
}

export const fakeRedis = new FakeRedis();
