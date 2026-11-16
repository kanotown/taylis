/**
 * The most bytes a body is read into memory (2026-11-16, a hostile-server review: a server could answer a picture with
 * a body that never ends and use up the app's memory). Content-Length over the limit fails at once; a body that keeps
 * coming is cut off at it. Its own module, without imports: the phones' editor bundle names the limits too.
 *
 * Profile pictures, custom emoji, workspace icons and notification pictures (the server makes them small) …
 */
export const SMALL_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
/** … and what a conversation, a page or an album draws by itself: pictures, thumbnails, previews (fetchBlob's default). */
export const INLINE_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

/**
 * The limit for a file the server says is `declared` bytes (a download, a video, a viewer's PDF): room for `factor`
 * times that, never less than INLINE_MEDIA_MAX_BYTES; no limit when it says nothing. What the screen showed bounds
 * what is read.
 */
export function blobLimitFor(declared: number | null | undefined, factor = 2): number {
  return declared && declared > 0 ? Math.max(INLINE_MEDIA_MAX_BYTES, declared * factor) : Number.POSITIVE_INFINITY;
}

/** A body longer than the limit its reader set (it was cut off; nothing of it is kept). */
export class ResponseTooLargeError extends Error {
  constructor(public readonly limit: number) {
    super(`the answer is larger than ${limit} bytes`);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * `response`'s body as a Blob, read at most `maxBytes` (ResponseTooLargeError past it). `onProgress`: the bytes so
 * far and Content-Length (0 when none), as they arrive.
 */
export async function readBlobLimited(response: Response, maxBytes: number, onProgress?: (loaded: number, total: number) => void): Promise<Blob> {
  const total = Number(response.headers.get("Content-Length")) || 0;
  const type = response.headers.get("Content-Type") ?? "";
  if (total > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseTooLargeError(maxBytes);
  }
  if (!response.body) {
    const blob = await response.blob();
    if (blob.size > maxBytes) throw new ResponseTooLargeError(maxBytes);
    return blob;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  onProgress?.(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    loaded += value.byteLength;
    if (loaded > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
    onProgress?.(loaded, total);
  }
  return new Blob(chunks as BlobPart[], { type });
}
