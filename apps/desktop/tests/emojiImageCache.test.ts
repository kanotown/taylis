import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cachedImageUrl,
  clearEmojiImages,
  type EmojiImageStore,
  imageKey,
  type ImageRef,
  loadImageUrl,
  MAX_FETCHES,
  setEmojiImageStore,
  toEvict,
} from "../src/ui/emojiImageCache";

/** The persistent layer as a Map (IndexedDB in the app). */
class FakeStore implements EmojiImageStore {
  rows = new Map<string, { server: string; blob: Blob }>();
  reads = 0;
  async getMany(keys: string[]): Promise<Map<string, Blob>> {
    this.reads++;
    const found = new Map<string, Blob>();
    for (const k of keys) { const row = this.rows.get(k); if (row) found.set(k, row.blob); }
    return found;
  }
  async put(key: string, server: string, blob: Blob): Promise<void> { this.rows.set(key, { server, blob }); }
  async clearServer(server: string): Promise<void> { for (const [k, r] of this.rows) if (r.server === server) this.rows.delete(k); }
}

const A = "https://a.example";
const B = "https://b.example";
const ref = (id: string, version: string | null = "v1", server = A): ImageRef => ({ server, kind: "emoji", id, version });
const flush = () => new Promise((r) => setTimeout(r, 0));

let store: FakeStore;
let next = 0;
const revoked: string[] = [];

beforeEach(() => {
  store = new FakeStore();
  setEmojiImageStore(store);
  next = 0;
  revoked.length = 0;
  URL.createObjectURL = vi.fn(() => `blob:${++next}`);
  URL.revokeObjectURL = vi.fn((u: string) => { revoked.push(u); });
});
afterEach(() => { setEmojiImageStore(null); vi.restoreAllMocks(); });

describe("custom emoji image cache (docs/EMOJI.md §2.1)", () => {
  it("a stored image (an earlier launch) needs no network; all asked together are one read", async () => {
    store.rows.set(imageKey(A, "emoji", "e1", "v1"), { server: A, blob: new Blob(["1"]) });
    store.rows.set(imageKey(A, "emoji", "e2", "v1"), { server: A, blob: new Blob(["2"]) });
    const fetcher = vi.fn(async () => new Blob(["net"]));
    const urls = await Promise.all([loadImageUrl(fetcher, ref("e1")), loadImageUrl(fetcher, ref("e2"))]);
    expect(urls.every((u) => u?.startsWith("blob:"))).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    expect(store.reads).toBe(1);
    expect(cachedImageUrl(ref("e1"))).toBe(urls[0]); // drawn at once on the next mount
  });

  it("fetches a missing one once with ?v= and keeps it for the next launch", async () => {
    const fetcher = vi.fn(async () => new Blob(["net"]));
    await loadImageUrl(fetcher, ref("e1", "abc"));
    expect(fetcher).toHaveBeenCalledWith("/api/v1/emoji/e1/image?v=abc");
    await flush();
    expect([...store.rows.keys()]).toEqual([imageKey(A, "emoji", "e1", "abc")]);
    await loadImageUrl(fetcher, ref("e1", "abc"));
    expect(fetcher).toHaveBeenCalledTimes(1);
    // The next launch: memory empty, the stored copy is used.
    setEmojiImageStore(store);
    expect(cachedImageUrl(ref("e1", "abc"))).toBeNull();
    await loadImageUrl(fetcher, ref("e1", "abc"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a new version (the image was replaced) is fetched again and the old URL let go", async () => {
    const fetcher = vi.fn(async () => new Blob(["net"]));
    const first = await loadImageUrl(fetcher, ref("e1", "v1"));
    const second = await loadImageUrl(fetcher, ref("e1", "v2"));
    expect(fetcher.mock.calls.map((c) => (c as unknown[])[0])).toEqual(["/api/v1/emoji/e1/image?v=v1", "/api/v1/emoji/e1/image?v=v2"]);
    expect(second).not.toBe(first);
    expect(revoked).toEqual([first]);
    expect(cachedImageUrl(ref("e1", "v1"))).toBeNull();
  });

  it("a server without versions: not kept on the device, asked without ?v=", async () => {
    const fetcher = vi.fn(async () => new Blob(["net"]));
    await loadImageUrl(fetcher, ref("e1", null));
    await flush();
    expect(fetcher).toHaveBeenCalledWith("/api/v1/emoji/e1/image");
    expect(store.rows.size).toBe(0);
    expect(store.reads).toBe(0);
  });

  it("pack tab icons are their own kind", async () => {
    const fetcher = vi.fn(async () => new Blob(["net"]));
    await loadImageUrl(fetcher, { server: A, kind: "tab", id: "p1", version: "t9" });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/emoji/packs/p1/tab?v=t9");
  });

  it("signing out erases that server's images (memory and device), not another workspace's", async () => {
    const fetcher = vi.fn(async () => new Blob(["net"]));
    await loadImageUrl(fetcher, ref("e1", "v1", A));
    await loadImageUrl(fetcher, ref("e2", "v1", B));
    await flush();
    expect(store.rows.size).toBe(2);
    await clearEmojiImages(A);
    expect(cachedImageUrl(ref("e1", "v1", A))).toBeNull();
    expect(cachedImageUrl(ref("e2", "v1", B))).not.toBeNull();
    expect([...store.rows.keys()]).toEqual([imageKey(B, "emoji", "e2", "v1")]);
  });

  it("a fetch that finishes after signing out is not kept", async () => {
    let release: (b: Blob) => void = () => {};
    const fetcher = vi.fn(() => new Promise<Blob>((r) => { release = r; }));
    const pending = loadImageUrl(fetcher, ref("e1"));
    await flush();
    await clearEmojiImages(A);
    release(new Blob(["late"]));
    expect(await pending).toBeNull();
    await flush();
    expect(store.rows.size).toBe(0);
    expect(cachedImageUrl(ref("e1"))).toBeNull();
  });

  it("the same image asked many times is one request; at most MAX_FETCHES at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const fetcher = vi.fn(() => new Promise<Blob>((resolve) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      releases.push(() => { inFlight--; resolve(new Blob(["x"])); });
    }));
    const same = Array.from({ length: 5 }, () => loadImageUrl(fetcher, ref("dup")));
    const many = Array.from({ length: 20 }, (_, i) => loadImageUrl(fetcher, ref(`e${i}`)));
    for (let i = 0; i < 40; i++) {
      await flush();
      releases.splice(0).forEach((r) => r());
    }
    const all = await Promise.all([...same, ...many]);
    expect(all.every((u) => u)).toBe(true);
    expect(new Set(await Promise.all(same)).size).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(21);
    expect(peak).toBe(MAX_FETCHES);
  });

  it("a failed image is reported (shown as :name:) and asked again for a new version", async () => {
    const fetcher = vi.fn(async () => { throw new Error("offline"); });
    expect(await loadImageUrl(fetcher, ref("e1", "v1"))).toBeNull();
    const ok = vi.fn(async () => new Blob(["x"]));
    expect(await loadImageUrl(ok, ref("e1", "v2"))).not.toBeNull();
  });

  it("works without a device store (a private window): memory only", async () => {
    setEmojiImageStore(null);
    const fetcher = vi.fn(async () => new Blob(["x"]));
    expect(await loadImageUrl(fetcher, ref("e1"))).not.toBeNull();
    expect(await loadImageUrl(fetcher, ref("e1"))).not.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("a broken device store falls back to the network", async () => {
    setEmojiImageStore({
      getMany: async () => { throw new Error("idb"); },
      put: async () => { throw new Error("idb"); },
      clearServer: async () => { throw new Error("idb"); },
    });
    const fetcher = vi.fn(async () => new Blob(["x"]));
    expect(await loadImageUrl(fetcher, ref("e1"))).not.toBeNull();
    await expect(clearEmojiImages(A)).resolves.toBeUndefined();
  });

  it("eviction: least recently used first until both caps hold", () => {
    const rows = [{ key: "old", size: 10 }, { key: "mid", size: 10 }, { key: "new", size: 10 }];
    expect(toEvict(rows, 2, 1000)).toEqual(["old"]);
    expect(toEvict(rows, 10, 15)).toEqual(["old", "mid"]);
    expect(toEvict(rows, 10, 1000)).toEqual([]);
  });
});
