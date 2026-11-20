/** IndexedDB cache of decoded payloads, keyed by disc id + decoder version. Every call degrades to a no-op. */
const DB_NAME = 'crashbash-disc-cache';
const STORE = 'assets';

export interface AssetCache {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
  /** delete every entry whose key does not start with `prefix` (older disc ids / decoder versions) */
  prune(prefix: string): Promise<void>;
  clear(): Promise<void>;
  close(): void;
}

const wrap = <T>(req: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

/** Returns null when IndexedDB is missing or blocked (private mode, disabled storage, ...). */
export async function openCache(): Promise<AssetCache | null> {
  try {
    if (typeof indexedDB === 'undefined') return null;
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => { open.result.createObjectStore(STORE); };
    const db = await new Promise<IDBDatabase>((res, rej) => {
      open.onsuccess = () => res(open.result);
      open.onerror = () => rej(open.error);
      open.onblocked = () => rej(new Error('blocked'));
    });
    const tx = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE);
    return {
      async get(key) { try { return await wrap(tx('readonly').get(key)); } catch { return undefined; } },
      async put(key, value) { try { await wrap(tx('readwrite').put(value, key)); } catch { /* quota / unavailable: just don't cache */ } },
      async prune(prefix) {
        try {
          const keys = (await wrap(tx('readonly').getAllKeys())) as string[];
          for (const k of keys) if (typeof k === 'string' && !k.startsWith(prefix)) await wrap(tx('readwrite').delete(k));
        } catch { /* ignore */ }
      },
      async clear() { try { await wrap(tx('readwrite').clear()); } catch { /* ignore */ } },
      close() { db.close(); },
    };
  } catch {
    return null;
  }
}
