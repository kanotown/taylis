/**
 * Custom emoji images and pack tab icons (docs/EMOJI.md §2.1, 2026-10-15 「毎回読み込みに時間がかかる」): kept as object URLs
 * for the session and, when the server names the image's version (`image_version`, `tab_version`), as Blobs in IndexedDB
 * across launches, keyed by (server, kind, id, version): a new version is a new key, so a replaced image is fetched
 * again and never mixed with the old one. Signing out of a workspace erases that server's images.
 *
 * Network fetches: at most MAX_FETCHES at once, the same image never twice at the same time; `?v=<version>` so the
 * response may be kept for good by the HTTP cache too. Without IndexedDB (a private window, the tests) only the memory
 * cache works, as before. A server without versions (older than 2026-10-15): memory only (its image may change).
 */

export type EmojiImageKind = "emoji" | "tab";

/** The persistent layer (IndexedDB in the app; a fake in the tests). Every method may fail: the caller falls back. */
export interface EmojiImageStore {
  getMany(keys: string[]): Promise<Map<string, Blob>>;
  put(key: string, server: string, blob: Blob): Promise<void>;
  clearServer(server: string): Promise<void>;
}

export type Fetcher = (path: string) => Promise<Blob>;

export const MAX_FETCHES = 6;
export const STORE_MAX_ENTRIES = 3000;
export const STORE_MAX_BYTES = 64 * 1024 * 1024;
/** A stored image read again is marked used at most this often (a write per read would be wasted). */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;

const urls = new Map<string, string>();
const loading = new Map<string, Promise<string | null>>();
const failed = new Set<string>();
/** server|kind:id → the key of the version in `urls` (an older version's URL is revoked when a newer one loads). */
const current = new Map<string, string>();
/** Bumped per server when it is cleared: a fetch started before lands nowhere. */
const generations = new Map<string, number>();

let store: EmojiImageStore | null | undefined; // undefined: not opened yet

function persistent(): EmojiImageStore | null {
  if (store === undefined) store = typeof indexedDB === "undefined" ? null : new IdbEmojiImageStore();
  return store;
}

/** Tests: a fake persistent layer (null: memory only); also empties the memory cache. */
export function setEmojiImageStore(next: EmojiImageStore | null): void {
  store = next;
  for (const url of urls.values()) URL.revokeObjectURL(url);
  urls.clear();
  loading.clear();
  failed.clear();
  current.clear();
  generations.clear();
  queue.length = 0;
  active = 0;
}

export function serverKey(baseUrl: string | undefined): string {
  return (baseUrl || (typeof location === "undefined" ? "" : location.origin)).replace(/\/+$/, "");
}

export function imageKey(server: string, kind: EmojiImageKind, id: string, version: string | null | undefined): string {
  return `${server}|${kind}:${id}:${version ?? ""}`;
}

export function imagePath(kind: EmojiImageKind, id: string, version: string | null | undefined): string {
  const path = kind === "emoji" ? `/api/v1/emoji/${id}/image` : `/api/v1/emoji/packs/${id}/tab`;
  return version ? `${path}?v=${encodeURIComponent(version)}` : path;
}

export interface ImageRef {
  server: string;
  kind: EmojiImageKind;
  id: string;
  version: string | null | undefined;
}

export function cachedImageUrl(ref: ImageRef): string | null {
  return urls.get(imageKey(ref.server, ref.kind, ref.id, ref.version)) ?? null;
}

export function imageFailed(ref: ImageRef): boolean {
  return failed.has(imageKey(ref.server, ref.kind, ref.id, ref.version));
}

/** The image's object URL: from memory, IndexedDB, or the network (once, however many ask); null if it failed. */
export function loadImageUrl(fetcher: Fetcher, ref: ImageRef): Promise<string | null> {
  const key = imageKey(ref.server, ref.kind, ref.id, ref.version);
  const hit = urls.get(key);
  if (hit) return Promise.resolve(hit);
  let pending = loading.get(key);
  if (pending) return pending;
  const generation = generations.get(ref.server) ?? 0;
  pending = (async () => {
    try {
      const stored = ref.version ? await readStored(key) : null;
      const blob = stored ?? (await limited(() => fetcher(imagePath(ref.kind, ref.id, ref.version))));
      if ((generations.get(ref.server) ?? 0) !== generation) return null; // signed out meanwhile
      if (!stored && ref.version) void persistent()?.put(key, ref.server, blob).catch(() => {});
      return remember(ref, key, blob);
    } catch {
      failed.add(key);
      return null;
    } finally {
      loading.delete(key);
    }
  })();
  loading.set(key, pending);
  return pending;
}

function remember(ref: ImageRef, key: string, blob: Blob): string {
  const url = URL.createObjectURL(blob);
  urls.set(key, url);
  failed.delete(key);
  const slot = `${ref.server}|${ref.kind}:${ref.id}`;
  const previous = current.get(slot);
  if (previous && previous !== key) {
    const old = urls.get(previous);
    if (old) URL.revokeObjectURL(old);
    urls.delete(previous);
  }
  current.set(slot, key);
  return url;
}

/** Signing out of `server` (docs/EMOJI.md §2.1): its images leave memory and the device. */
export async function clearEmojiImages(server: string): Promise<void> {
  const prefix = `${server}|`;
  generations.set(server, (generations.get(server) ?? 0) + 1);
  for (const [key, url] of urls) {
    if (!key.startsWith(prefix)) continue;
    URL.revokeObjectURL(url);
    urls.delete(key);
  }
  for (const key of [...failed]) if (key.startsWith(prefix)) failed.delete(key);
  for (const key of [...loading.keys()]) if (key.startsWith(prefix)) loading.delete(key);
  for (const slot of [...current.keys()]) if (slot.startsWith(prefix)) current.delete(slot);
  try {
    await persistent()?.clearServer(server);
  } catch (err) {
    console.error("could not erase the stored emoji images", err);
  }
}

// ---- reads from the store, batched: the images a screen asks for in one go are one transaction ----

let batch: Map<string, Array<(blob: Blob | null) => void>> | null = null;

function readStored(key: string): Promise<Blob | null> {
  const target = persistent();
  if (!target) return Promise.resolve(null);
  return new Promise((resolve) => {
    if (!batch) {
      const mine = new Map<string, Array<(blob: Blob | null) => void>>();
      batch = mine;
      queueMicrotask(() => {
        batch = null;
        target.getMany([...mine.keys()]).then(
          (found) => { for (const [k, waiters] of mine) for (const w of waiters) w(found.get(k) ?? null); },
          () => { for (const waiters of mine.values()) for (const w of waiters) w(null); },
        );
      });
    }
    const waiters = batch.get(key) ?? [];
    waiters.push(resolve);
    batch.set(key, waiters);
  });
}

// ---- at most MAX_FETCHES network fetches at once ----

const queue: Array<() => void> = [];
let active = 0;

async function limited<T>(task: () => Promise<T>): Promise<T> {
  if (active >= MAX_FETCHES) await new Promise<void>((resolve) => queue.push(resolve));
  active++;
  try {
    return await task();
  } finally {
    active--;
    queue.shift()?.();
  }
}

/** `rows` least recently used first: the keys to delete so that at most `maxEntries` and `maxBytes` stay. */
export function toEvict<K>(rows: ReadonlyArray<{ key: K; size: number }>, maxEntries: number, maxBytes: number): K[] {
  let count = rows.length;
  let bytes = rows.reduce((sum, r) => sum + r.size, 0);
  const out: K[] = [];
  for (const row of rows) {
    if (count <= maxEntries && bytes <= maxBytes) break;
    out.push(row.key);
    count--;
    bytes -= row.size;
  }
  return out;
}

// ---- IndexedDB ----

const DB_NAME = "chikuwa-emoji-images";
const STORE = "images";

interface Row {
  key: string;
  server: string;
  blob: Blob;
  size: number;
  used: number;
}

function done(request: IDBRequest | IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    if (request instanceof IDBTransaction) {
      request.oncomplete = () => resolve();
      request.onerror = () => reject(request.error);
      request.onabort = () => reject(request.error);
    } else {
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    }
  });
}

class IdbEmojiImageStore implements EmojiImageStore {
  private db: Promise<IDBDatabase> | null = null;
  private trimTimer: ReturnType<typeof setTimeout> | null = null;

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const objects = request.result.createObjectStore(STORE, { keyPath: "key" });
        objects.createIndex("server", "server");
        objects.createIndex("used", "used");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("emoji image store blocked"));
    }).catch((err) => {
      this.db = null;
      throw err;
    });
    return this.db;
  }

  async getMany(keys: string[]): Promise<Map<string, Blob>> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readonly");
    const objects = tx.objectStore(STORE);
    const found = new Map<string, Blob>();
    const stale: Row[] = [];
    const now = Date.now();
    for (const key of keys) {
      const request = objects.get(key);
      request.onsuccess = () => {
        const row = request.result as Row | undefined;
        if (!row) return;
        found.set(key, row.blob);
        if (now - row.used > TOUCH_AFTER_MS) stale.push(row);
      };
    }
    await done(tx);
    if (stale.length) {
      const touch = db.transaction(STORE, "readwrite");
      for (const row of stale) touch.objectStore(STORE).put({ ...row, used: now });
      void done(touch).catch(() => {});
    }
    return found;
  }

  async put(key: string, server: string, blob: Blob): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readwrite");
    const row: Row = { key, server, blob, size: blob.size, used: Date.now() };
    tx.objectStore(STORE).put(row);
    await done(tx);
    this.trimSoon();
  }

  async clearServer(server: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readwrite");
    const request = tx.objectStore(STORE).index("server").openKeyCursor(IDBKeyRange.only(server));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      tx.objectStore(STORE).delete(cursor.primaryKey);
      cursor.continue();
    };
    await done(tx);
  }

  /** After a burst of writes: over the caps, the least recently used images go. */
  private trimSoon(): void {
    if (this.trimTimer) return;
    this.trimTimer = setTimeout(() => {
      this.trimTimer = null;
      void this.trim().catch(() => {});
    }, 5000);
  }

  private async trim(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(STORE, "readwrite");
    const objects = tx.objectStore(STORE);
    const rows: Array<{ key: IDBValidKey; size: number }> = [];
    const request = objects.index("used").openCursor(); // least recently used first
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        rows.push({ key: cursor.primaryKey, size: (cursor.value as Row).size });
        cursor.continue();
        return;
      }
      // Still inside the transaction (a request's callback).
      for (const key of toEvict(rows, STORE_MAX_ENTRIES, STORE_MAX_BYTES)) objects.delete(key);
    };
    await done(tx);
  }
}
