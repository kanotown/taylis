/**
 * 2026-11-16 (a hostile-server review): a body is read into memory only up to a limit — 2 MB for profile pictures,
 * custom emoji, workspace icons and notification pictures, 50 MB for what a conversation draws by itself, and up to
 * what a file said it is for a download, a video or a viewer's PDF — so a server cannot use up the app's memory with a
 * body that never ends.
 */
import { describe, expect, it } from "vitest";

import { blobLimitFor, INLINE_MEDIA_MAX_BYTES, readBlobLimited, ResponseTooLargeError, SMALL_IMAGE_MAX_BYTES } from "../src/api/blobLimits";
import { ApiClient } from "../src/api/client";

const MB = 1024 * 1024;

/** A body of `chunks` × `size` bytes, with `length` as Content-Length (none when null); counts what was pulled. */
function body(chunks: number, size: number, length: number | null) {
  let pulled = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks) return controller.close();
      pulled += 1;
      controller.enqueue(new Uint8Array(size));
    },
    cancel() {
      cancelled = true;
    },
  });
  const headers: Record<string, string> = { "Content-Type": "image/png" };
  if (length !== null) headers["Content-Length"] = String(length);
  return { response: new Response(stream, { headers }), pulled: () => pulled, cancelled: () => cancelled };
}

describe("reading a body with a limit", () => {
  it("refuses a Content-Length over the limit without reading the body", async () => {
    const answer = body(100, MB, 100 * MB);
    await expect(readBlobLimited(answer.response, SMALL_IMAGE_MAX_BYTES)).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect(answer.pulled()).toBeLessThanOrEqual(1);
    expect(answer.cancelled()).toBe(true);
  });

  it("cuts off a body that keeps coming past the limit (no or a false Content-Length)", async () => {
    for (const length of [null, 1000]) {
      const answer = body(1000, MB, length);
      await expect(readBlobLimited(answer.response, 3 * MB)).rejects.toBeInstanceOf(ResponseTooLargeError);
      expect(answer.pulled()).toBeLessThan(10);
      expect(answer.cancelled()).toBe(true);
    }
  });

  it("returns a body within the limit whole, with its type, telling the progress", async () => {
    const answer = body(3, 1000, 3000);
    const seen: Array<[number, number]> = [];
    const blob = await readBlobLimited(answer.response, 3000, (loaded, total) => seen.push([loaded, total]));
    expect(blob.size).toBe(3000);
    expect(blob.type).toBe("image/png");
    expect(seen).toEqual([[0, 3000], [1000, 3000], [2000, 3000], [3000, 3000]]);
  });

  it("the limit for a file of a known size: twice that, at least the inline limit; none when unknown", () => {
    expect(blobLimitFor(200 * MB)).toBe(400 * MB);
    expect(blobLimitFor(1 * MB)).toBe(INLINE_MEDIA_MAX_BYTES);
    expect(blobLimitFor(10 * MB, 4)).toBe(INLINE_MEDIA_MAX_BYTES);
    expect(blobLimitFor(null)).toBe(Number.POSITIVE_INFINITY);
    expect(blobLimitFor(0)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("fetchBlob", () => {
  const client = (response: () => Response) => {
    const api = new ApiClient("http://server", { fetchImpl: async () => response() });
    api.accessToken = "token";
    return api;
  };

  it("reads 50 MB at most unless told otherwise; a caller can ask for less or for the file's own size", async () => {
    const huge = () => body(1, 1, 60 * MB).response;
    await expect(client(huge).fetchBlob("/api/v1/attachments/a/thumbnail")).rejects.toBeInstanceOf(ResponseTooLargeError);
    const avatar = () => body(3, MB, null).response;
    await expect(client(avatar).fetchBlob("/api/v1/users/u/avatar", undefined, SMALL_IMAGE_MAX_BYTES)).rejects.toBeInstanceOf(ResponseTooLargeError);
    const file = () => body(2, 1000, 2000).response;
    expect((await client(file).fetchBlob("/api/v1/attachments/a/content", undefined, blobLimitFor(2000))).size).toBe(2000);
  });

  it("the workspace icon (public) is read up to 2 MB", async () => {
    await expect(client(() => body(3, MB, null).response).serverIcon("v1")).rejects.toBeInstanceOf(ResponseTooLargeError);
    expect((await client(() => body(1, 500, 500).response).serverIcon("v1")).size).toBe(500);
  });
});
