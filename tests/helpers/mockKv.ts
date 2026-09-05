interface StoredEntry {
  value: string;
  expiresAtMs?: number;
}

export function createMockKv() {
  const store = new Map<string, StoredEntry>();

  function isExpired(entry: StoredEntry): boolean {
    return entry.expiresAtMs !== undefined && entry.expiresAtMs <= Date.now();
  }

  return {
    async get(key: string, type?: string) {
      const entry = store.get(key);
      if (!entry || isExpired(entry)) return null;
      return type === "json" ? JSON.parse(entry.value) : entry.value;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      const expiresAtMs = opts?.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : undefined;
      store.set(key, { value, expiresAtMs });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(opts?: { prefix?: string; cursor?: string }) {
      const prefix = opts?.prefix ?? "";
      const keys = [...store.keys()]
        .filter((k) => k.startsWith(prefix) && !isExpired(store.get(k)!))
        .map((name) => ({ name }));
      return { keys, list_complete: true, cursor: undefined as string | undefined };
    },
    _raw: store,
  };
}

export type MockKv = ReturnType<typeof createMockKv>;
