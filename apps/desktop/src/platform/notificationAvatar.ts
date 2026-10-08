/**
 * The sender's picture for a message notification (docs/PUSH_NOTIFICATIONS.md §9.1, as the phones do in §16 / §16.1): a
 * 128 px PNG circle of the profile picture, fetched with the workspace's session (the same authenticated path as the
 * avatars in the app, ui/avatars.ts), or the default initials avatar (the shared rule, apps/shared/avatar-initials.json)
 * when the person has none, the fetch fails, or it takes longer than `AVATAR_TIMEOUT_MS`: a notification is never held
 * up for its picture. Pictures are kept per (workspace, user, picture version) — initials per (workspace, user,
 * letters) — so each is fetched and drawn once.
 *
 * The bytes go to the native side (macOS: a communication notification or an attachment; Windows: the toast's logo),
 * or become a data URL for the browser's Notification `icon`.
 */
import { avatarPath } from "../ui/avatars";
import { avatarHue, initials } from "../ui/format";

/** Side of the square picture, in pixels (a notification shows it at most ~64 pt; 2x for Retina / 200 % scaling). */
export const NOTIFICATION_AVATAR_PX = 128;
/** How long a notification waits for a picture not fetched yet; then the initials (the fetch finishes for next time). */
export const AVATAR_TIMEOUT_MS = 1500;
const CACHE_LIMIT = 64;

/** Who a notification is from, and how to fetch their picture. */
export interface AvatarSender {
  /** The workspace (its server URL): ids and versions are per server. */
  scope: string;
  userId: string;
  name: string;
  /** `avatar_updated_at`: null = no picture (the initials). */
  version: string | null;
  /** The workspace's authenticated fetch (ApiClient.fetchBlob). */
  fetchBlob: (path: string) => Promise<Blob>;
}

export interface NotificationAvatar {
  /** Names the picture for the native side's file cache. */
  key: string;
  png: Uint8Array;
  /** The profile picture (true) or the initials avatar. */
  picture: boolean;
}

/** Draws the PNGs (a canvas in the app; tests put their own). Throws where it cannot draw. */
export interface AvatarPainter {
  picture(image: Blob, size: number): Promise<Uint8Array>;
  initials(letters: string, hue: number, size: number): Promise<Uint8Array>;
}

const cache = new Map<string, Promise<NotificationAvatar | null>>();

function remember(key: string, made: () => Promise<NotificationAvatar | null>): Promise<NotificationAvatar | null> {
  const known = cache.get(key);
  if (known) {
    cache.delete(key); // most recently used: to the end
    cache.set(key, known);
    return known;
  }
  const pending = made().catch((err: unknown) => {
    console.warn("could not draw the notification picture", err);
    return null;
  });
  // A failure is not kept: the next notification tries again.
  void pending.then((avatar) => { if (!avatar && cache.get(key) === pending) cache.delete(key); });
  cache.set(key, pending);
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  return pending;
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/**
 * The picture to show for `sender`: the profile picture when there is one and it arrives in time, else the initials
 * avatar; null only when nothing can be drawn (the notification then shows without a picture).
 */
export async function notificationAvatar(sender: AvatarSender, timeoutMs = AVATAR_TIMEOUT_MS): Promise<NotificationAvatar | null> {
  const painter = currentPainter;
  if (sender.version) {
    const key = `${sender.scope}|${sender.userId}|${sender.version}`;
    const { version } = sender;
    const picture = await within(remember(key, async () => {
      const blob = await sender.fetchBlob(avatarPath(sender.userId, version));
      return { key, png: await painter.picture(blob, NOTIFICATION_AVATAR_PX), picture: true };
    }), timeoutMs);
    if (picture) return picture;
  }
  const letters = initials(sender.name);
  const key = `${sender.scope}|${sender.userId}|initials|${letters}`;
  return remember(key, async () => ({ key, png: await painter.initials(letters, avatarHue(sender.userId), NOTIFICATION_AVATAR_PX), picture: false }));
}

/** Sign-out: no one's picture stays in memory. */
export function clearNotificationAvatars(): void {
  cache.clear();
}

/** The PNG as a data URL (the browser's Notification `icon`: no request, no object URL to revoke). */
export function pngDataUrl(png: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < png.length; i += 0x8000) binary += String.fromCharCode(...png.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}

// --- drawing ------------------------------------------------------------------------------------------

function canvas(size: number): { context: CanvasRenderingContext2D; done: () => Promise<Uint8Array> } {
  const element = document.createElement("canvas");
  element.width = size;
  element.height = size;
  const context = element.getContext("2d");
  if (!context) throw new Error("no 2d canvas");
  // A circle: Windows and macOS crop it so too, and the browser's icon and the attachment's thumbnail look the same.
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  context.closePath();
  context.clip();
  const done = () =>
    new Promise<Uint8Array>((resolve, reject) => {
      element.toBlob((blob) => {
        if (!blob) return reject(new Error("could not encode the picture"));
        void blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject);
      }, "image/png");
    });
  return { context, done };
}

async function decode(image: Blob): Promise<CanvasImageSource & { width: number; height: number }> {
  if (typeof createImageBitmap === "function") return createImageBitmap(image);
  const url = URL.createObjectURL(image);
  try {
    const element = new Image();
    element.src = url;
    await element.decode();
    return element;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const canvasPainter: AvatarPainter = {
  async picture(image, size) {
    const source = await decode(image);
    const { context, done } = canvas(size);
    // Cover: the centre square of the picture, like the round avatars in the app (object-fit: cover).
    const side = Math.min(source.width, source.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(source, (source.width - side) / 2, (source.height - side) / 2, side, side, 0, 0, size, size);
    return done();
  },
  async initials(letters, hue, size) {
    const { context, done } = canvas(size);
    context.fillStyle = `hsl(${hue}, 55%, 45%)`;
    context.fillRect(0, 0, size, size);
    context.fillStyle = "#fff";
    context.font = `bold ${Math.round(size * 0.42)}px -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Noto Sans JP", sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(letters, size / 2, size / 2 + size * 0.02);
    return done();
  },
};

let currentPainter: AvatarPainter = canvasPainter;

/** Tests: draw with `painter` (null: the canvas again); the cache is emptied either way. */
export function setAvatarPainter(painter: AvatarPainter | null): void {
  currentPainter = painter ?? canvasPainter;
  cache.clear();
}
