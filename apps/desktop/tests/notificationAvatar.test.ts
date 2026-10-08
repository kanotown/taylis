/**
 * The sender's picture on a desktop / web notification (PUSH_NOTIFICATIONS.md §9.1, 2026-10-08): the profile picture
 * fetched with the workspace's session, else the initials avatar of the shared rule (apps/shared/avatar-initials.json);
 * cached per (workspace, user, version); never holding a notification up past the timeout.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AVATAR_TIMEOUT_MS, notificationAvatar, pngDataUrl, setAvatarPainter, clearNotificationAvatars, type AvatarSender } from "../src/platform/notificationAvatar";

type Vectors = { initials: { name: string; initials: string }[]; colors: { id: string; hue: number }[] };
const vectors = JSON.parse(readFileSync(new URL("../../shared/avatar-initials.json", import.meta.url), "utf8")) as Vectors;

const drawn: Array<{ kind: "picture"; type: string; size: number } | { kind: "initials"; letters: string; hue: number; size: number }> = [];
const png = (tag: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, tag]);

beforeEach(() => {
  drawn.length = 0;
  setAvatarPainter({
    picture: async (image, size) => {
      drawn.push({ kind: "picture", type: image.type, size });
      return png(1);
    },
    initials: async (letters, hue, size) => {
      drawn.push({ kind: "initials", letters, hue, size });
      return png(2);
    },
  });
});

afterEach(() => {
  setAvatarPainter(null);
  vi.useRealTimers();
});

function sender(patch: Partial<AvatarSender> = {}): AvatarSender & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    scope: "https://a.example.com",
    userId: "alice",
    name: "Alice Smith",
    version: "2026-10-08T01:02:03.000004Z",
    fetchBlob: async (path) => {
      fetched.push(path);
      return new Blob(["x"], { type: "image/png" });
    },
    ...patch,
    fetched,
  };
}

describe("notification avatars", () => {
  it("the profile picture, fetched through the authenticated avatar path at 128 px", async () => {
    const s = sender();
    const avatar = await notificationAvatar(s);
    expect(avatar).toEqual({ key: "https://a.example.com|alice|2026-10-08T01:02:03.000004Z", png: png(1), picture: true });
    expect(s.fetched).toEqual(["/api/v1/users/alice/avatar?v=2026-10-08T01%3A02%3A03.000004Z"]);
    expect(drawn).toEqual([{ kind: "picture", type: "image/png", size: 128 }]);
  });

  it("no picture: the initials avatar of the shared rule (letters and hue), no request", async () => {
    for (const { name, initials } of vectors.initials) {
      const s = sender({ userId: `u-${name}`, name, version: null });
      const avatar = await notificationAvatar(s);
      expect(avatar?.picture).toBe(false);
      expect(s.fetched).toEqual([]);
      expect(drawn.at(-1)).toEqual({ kind: "initials", letters: initials, hue: expect.any(Number), size: 128 });
    }
    for (const { id, hue } of vectors.colors) {
      await notificationAvatar(sender({ userId: id, version: null }));
      expect(drawn.at(-1)).toMatchObject({ hue });
    }
  });

  it("cached per workspace, user and version: one fetch for many notifications, a new version fetches again", async () => {
    const s = sender();
    await notificationAvatar(s);
    await notificationAvatar(s);
    expect(s.fetched).toHaveLength(1);
    const changed = sender({ version: "2026-10-09T00:00:00Z", fetchBlob: s.fetchBlob });
    expect((await notificationAvatar(changed))?.key).toBe("https://a.example.com|alice|2026-10-09T00:00:00Z");
    expect(s.fetched).toHaveLength(2);
    // The same user id on another server is another person.
    await notificationAvatar(sender({ scope: "https://b.example.com", fetchBlob: s.fetchBlob }));
    expect(s.fetched).toHaveLength(3);
    // Sign-out empties it.
    clearNotificationAvatars();
    await notificationAvatar(s);
    expect(s.fetched).toHaveLength(4);
  });

  it("a failed fetch: the initials now, and a new try next time (a failure is not kept)", async () => {
    let fail = true;
    const s = sender({ fetchBlob: async () => { if (fail) throw new Error("503"); return new Blob(["x"], { type: "image/jpeg" }); } });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await notificationAvatar(s))?.picture).toBe(false);
    fail = false;
    expect((await notificationAvatar(s))?.picture).toBe(true);
  });

  it("a slow fetch: the initials once the timeout passes; the picture lands in the cache for the next one", async () => {
    vi.useFakeTimers();
    let arrive!: (blob: Blob) => void;
    const s = sender({ fetchBlob: () => new Promise<Blob>((resolve) => { arrive = resolve; }) });
    const first = notificationAvatar(s);
    await vi.advanceTimersByTimeAsync(AVATAR_TIMEOUT_MS - 1);
    let settled = false;
    void first.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await first)?.picture).toBe(false); // not held up any longer
    arrive(new Blob(["x"], { type: "image/png" }));
    await vi.advanceTimersByTimeAsync(0);
    expect((await notificationAvatar(s))?.picture).toBe(true);
  });

  it("nothing drawable (no canvas): null, the notification shows without a picture", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    setAvatarPainter({ picture: async () => { throw new Error("no 2d canvas"); }, initials: async () => { throw new Error("no 2d canvas"); } });
    expect(await notificationAvatar(sender())).toBeNull();
    expect(await notificationAvatar(sender({ version: null }))).toBeNull();
  });

  it("a data URL for the browser's Notification icon", () => {
    expect(pngDataUrl(png(7))).toBe(`data:image/png;base64,${Buffer.from(png(7)).toString("base64")}`);
  });
});
