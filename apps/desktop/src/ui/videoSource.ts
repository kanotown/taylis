import type { Box } from "./attachmentLayout";

/** What the video code needs from the API client: the authenticated GET that images use too. */
export interface BlobSource {
  fetchBlob(path: string): Promise<Blob>;
}

interface Entry {
  api: BlobSource;
  promise: Promise<string>;
  url: string | null;
  refs: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * A video's bytes, fetched once with the bearer token and shared as one object URL by its tile and the viewer (M38),
 * so opening a clip that is already on screen does not download it again. The URL is revoked a moment after the last
 * holder lets go (the delay keeps it across a remount, e.g. React's double effects or the row being redrawn).
 */
const entries = new Map<string, Entry>();
export const VIDEO_RELEASE_DELAY_MS = 5000;

export interface VideoHandle {
  promise: Promise<string>;
  release: () => void;
}

export function acquireVideo(api: BlobSource, attachmentId: string): VideoHandle {
  let entry = entries.get(attachmentId);
  if (entry && entry.api !== api) {
    drop(attachmentId, entry); // another session: never reuse its bytes
    entry = undefined;
  }
  if (!entry) {
    const created: Entry = { api, url: null, refs: 0, timer: null, promise: Promise.resolve("") };
    created.promise = api.fetchBlob(`/api/v1/attachments/${attachmentId}/content`).then(
      (blob) => {
        const url = URL.createObjectURL(blob);
        if (entries.get(attachmentId) === created) created.url = url;
        else URL.revokeObjectURL(url); // dropped while it was on its way
        return url;
      },
      (error: unknown) => {
        if (entries.get(attachmentId) === created) entries.delete(attachmentId); // a retry fetches again
        throw error;
      },
    );
    entries.set(attachmentId, created);
    entry = created;
  }
  const held = entry;
  if (held.timer) {
    clearTimeout(held.timer);
    held.timer = null;
  }
  held.refs += 1;
  let released = false;
  return {
    promise: held.promise,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0 || entries.get(attachmentId) !== held) return;
      held.timer = setTimeout(() => drop(attachmentId, held), VIDEO_RELEASE_DELAY_MS);
    },
  };
}

function drop(attachmentId: string, entry: Entry) {
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  if (entries.get(attachmentId) === entry) entries.delete(attachmentId);
  if (entry.url) URL.revokeObjectURL(entry.url);
  entry.url = null;
}

/** Test hook: forget every cached video (revoking their URLs). */
export function resetVideoCache() {
  for (const [id, entry] of [...entries]) drop(id, entry);
  sizes.clear();
  listeners.forEach((listener) => listener());
}

// --- the shape each video turned out to have, so its tile keeps it when redrawn (where the server does not know it: before M79) ---

const sizes = new Map<string, Box>();
const listeners = new Set<() => void>();

export function rememberVideoSize(attachmentId: string, width: number, height: number) {
  if (!width || !height) return;
  const known = sizes.get(attachmentId);
  if (known && known.width === width && known.height === height) return;
  sizes.set(attachmentId, { width, height });
  listeners.forEach((listener) => listener());
}

export function knownVideoSize(attachmentId: string): Box | undefined {
  return sizes.get(attachmentId);
}

export function subscribeVideoSizes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
