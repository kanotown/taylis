/**
 * AL2 (docs/ALBUMS.md §6.1, §10.3): the album viewer's pictures as object URLs, fetched with the bearer token, the
 * shown one and its neighbours read ahead. At most `size` are kept: the oldest not asked for lately is revoked when a
 * new one comes (a slideshow through 500 photos never holds more than a few). `clear()` revokes everything (the viewer
 * closed).
 */
export interface BlobFetcher {
  fetchBlob(path: string): Promise<Blob>;
}

interface Held {
  promise: Promise<string>;
  url: string | null;
}

export class BlobCache {
  private readonly held = new Map<string, Held>();
  private cleared = false;

  constructor(
    private readonly api: BlobFetcher,
    private readonly size = 8,
    private readonly urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
  ) {}

  /** The picture at `path` (one fetch however often asked; a failure is not kept, so asking again retries). */
  get(path: string): Promise<string> {
    const found = this.held.get(path);
    if (found) {
      // The most recently asked last: the first one is the next to go.
      this.held.delete(path);
      this.held.set(path, found);
      return found.promise;
    }
    const entry: Held = { url: null, promise: Promise.resolve("") };
    entry.promise = this.api.fetchBlob(path).then(
      (blob) => {
        const url = this.urls.createObjectURL(blob);
        if (this.cleared || this.held.get(path) !== entry) {
          this.urls.revokeObjectURL(url);
          throw new Error("dropped");
        }
        entry.url = url;
        return url;
      },
      (error: unknown) => {
        if (this.held.get(path) === entry) this.held.delete(path);
        throw error;
      },
    );
    this.held.set(path, entry);
    this.trim(path);
    return entry.promise;
  }

  /** Reads ahead without waiting (a failure is ignored: the viewer asks again when it gets there). */
  warm(path: string): void {
    this.get(path).catch(() => undefined);
  }

  has(path: string): boolean {
    return this.held.has(path);
  }

  get count(): number {
    return this.held.size;
  }

  private trim(keep: string): void {
    for (const [path, entry] of this.held) {
      if (this.held.size <= this.size) break;
      if (path === keep) continue;
      this.held.delete(path);
      if (entry.url) this.urls.revokeObjectURL(entry.url);
    }
  }

  clear(): void {
    this.cleared = true;
    for (const entry of this.held.values()) if (entry.url) this.urls.revokeObjectURL(entry.url);
    this.held.clear();
  }
}
