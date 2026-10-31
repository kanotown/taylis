// @vitest-environment jsdom
/**
 * AL2 (docs/ALBUMS.md §10): the albums' plain rules — the day headings, the album's days and count, the grid's rows
 * and the rows drawn for a scroll position (the virtualisation: only those read their thumbnails), the viewer's
 * sources and read-ahead, the swipe, the slideshow's order and durations, the notify draft, the public page's saves,
 * the blob cache that holds the viewer's pictures.
 */
import { describe, expect, it, vi } from "vitest";

import type { DriveItemOut } from "../src/api/types";
import { addSummary, albumAttachments, albumCount, albumDates, albumLine, albumNameFor, canBecomeAlbum, datesProblem, dayGroups, durationLabel, gridColumns, hasPicture, isAlbumMedia, layoutGrid, mediaTime, neighbours, notifyDraft, originalsDefault, publicSave, SLIDESHOW_VIDEO_GRACE_MS, SLIDESHOW_VIDEO_MAX_MS, slideDuration, slideshowItems, slideshowOrder, swipeStep, viewerSources, visibleRows, webpName } from "../src/drive/albums";
import { BlobCache } from "../src/drive/blobCache";

function photo(id: string, extra: { taken?: string | null; modified?: string | null; type?: string; display?: boolean; thumb?: boolean; duration?: number | null } = {}): DriveItemOut {
  return {
    id, location_id: "loc", parent_id: "album", kind: "file", name: `${id}.jpg`, size_bytes: 1000, content_type: extra.type ?? "image/jpeg",
    content_modified_at: extra.modified ?? null, created_by: "me", created_at: "2026-09-20T00:00:00Z", updated_by: "me", updated_at: "2026-09-20T00:00:00Z",
    version_count: 1, link_count: 0, posted: false,
    file: { attachment_id: `a-${id}`, version_id: `v-${id}`, width: 4000, height: 3000, has_thumbnail: extra.thumb ?? true, has_poster: false, has_display: extra.display ?? true, has_location: false, duration_ms: extra.duration ?? null, preview: null, taken_at: extra.taken ?? null },
  };
}

describe("what an album shows", () => {
  it("takes photos and videos, sorts by the capture time, else the file's, else made", () => {
    expect(isAlbumMedia(photo("a"))).toBe(true);
    expect(isAlbumMedia(photo("v", { type: "video/mp4" }))).toBe(true);
    expect(isAlbumMedia(photo("p", { type: "application/pdf" }))).toBe(false);
    expect(isAlbumMedia({ kind: "folder", content_type: null })).toBe(false);
    expect(mediaTime(photo("a", { taken: "2026-09-16T09:00:00+09:00", modified: "2026-10-01T00:00:00Z" }))).toBe("2026-09-16T09:00:00+09:00");
    expect(mediaTime(photo("a", { modified: "2026-10-01T00:00:00Z" }))).toBe("2026-10-01T00:00:00Z");
    expect(mediaTime(photo("a"))).toBe("2026-09-20T00:00:00Z");
  });

  it("groups the capture-date order by day with headings, and other orders not at all", () => {
    const now = new Date(2026, 9, 29);
    const items = [
      photo("a", { taken: new Date(2026, 8, 16, 9).toISOString() }),
      photo("b", { taken: new Date(2026, 8, 16, 18).toISOString() }),
      photo("c", { taken: new Date(2026, 8, 17, 8).toISOString() }),
    ];
    const groups = dayGroups(items, "taken", now);
    expect(groups.map((group) => group.items.map((item) => item.id))).toEqual([["a", "b"], ["c"]]);
    expect(groups[0]!.label).toBe("9月16日（水）");
    expect(dayGroups([photo("x", { taken: new Date(2025, 0, 2).toISOString() })], "taken", now)[0]!.label).toBe("2025年1月2日（木）");
    expect(dayGroups(items, "name", now)).toEqual([{ key: "all", label: null, items }]);
    expect(dayGroups([], "taken", now)).toEqual([]);
  });

  it("tells the album's days: its own, else its photos' range", () => {
    expect(albumDates({ starts_on: "2026-09-16", ends_on: "2026-09-19", taken_from: null, taken_to: null })).toBe("2026/9/16〜9/19");
    expect(albumDates({ starts_on: "2026-09-16", ends_on: null, taken_from: "2026-01-01T00:00:00Z", taken_to: null })).toBe("2026/9/16");
    expect(albumDates({ starts_on: "2026-12-30", ends_on: "2027-01-02", taken_from: null, taken_to: null })).toBe("2026/12/30〜2027/1/2");
    expect(albumDates({ starts_on: null, ends_on: null, taken_from: new Date(2026, 8, 16, 9).toISOString(), taken_to: new Date(2026, 8, 18, 9).toISOString() })).toBe("2026/9/16〜9/18");
    expect(albumDates({ starts_on: null, ends_on: null, taken_from: null, taken_to: null })).toBe("");
  });

  it("counts photos and videos", () => {
    expect(albumCount({ photo_count: 312, video_count: 0 })).toBe("312 枚");
    expect(albumCount({ photo_count: 312, video_count: 8 })).toBe("312 枚 · 動画 8 本");
    expect(albumCount({ photo_count: 0, video_count: 0 })).toBe("写真はまだありません");
    expect(albumLine({ photo_count: 3, video_count: 0, starts_on: "2026-09-16", ends_on: "2026-09-19", taken_from: null, taken_to: null })).toBe("3 枚 · 2026/9/16〜9/19");
  });
});

describe("the grid", () => {
  it("puts 3 to 8 tiles across", () => {
    expect(gridColumns(300)).toBe(3);
    expect(gridColumns(800)).toBe(5);
    expect(gridColumns(3000)).toBe(8);
    expect(gridColumns(0)).toBe(4);
  });

  it("lays out headings and rows, and draws only the rows near the view", () => {
    const items = Array.from({ length: 500 }, (_, index) => photo(`p${index}`, { taken: new Date(2026, 8, 16 + Math.floor(index / 100), 9, index % 60).toISOString() }));
    const layout = layoutGrid(dayGroups(items, "taken"), 800);
    expect(layout.columns).toBe(5);
    const headings = layout.rows.filter((row) => row.kind === "heading");
    expect(headings).toHaveLength(5);
    const tiles = layout.rows.filter((row) => row.kind === "tiles");
    expect(tiles).toHaveLength(100); // 100 a day, 5 across
    expect(tiles.flatMap((row) => (row.kind === "tiles" ? row.items : [])).length).toBe(500);
    // Rows are in order without overlap.
    for (let i = 1; i < layout.rows.length; i++) expect(layout.rows[i]!.top).toBeGreaterThanOrEqual(layout.rows[i - 1]!.top + layout.rows[i - 1]!.height);
    const first = visibleRows(layout.rows, 0, 700, 0);
    expect(first.from).toBe(0);
    const drawn = layout.rows.slice(first.from, first.to).flatMap((row) => (row.kind === "tiles" ? row.items : []));
    expect(drawn.length).toBeLessThan(40);
    expect(drawn.length).toBeGreaterThan(0);
    // Far down: the first rows are not drawn any more.
    const far = visibleRows(layout.rows, layout.height / 2, 700, 600);
    expect(far.from).toBeGreaterThan(10);
    expect(far.to - far.from).toBeLessThan(20);
    expect(visibleRows([], 0, 700)).toEqual({ from: 0, to: 0 });
  });

  it("writes a video's length", () => {
    expect(durationLabel(42_400)).toBe("0:42");
    expect(durationLabel(3_910_000)).toBe("1:05:10");
    expect(durationLabel(null)).toBe("");
  });
});

describe("the viewer", () => {
  it("reads the display size, the original on request, and nothing for a HEIC without a picture", () => {
    expect(viewerSources(photo("a"))).toEqual({ display: "/api/v1/attachments/a-a/display", fallback: "/api/v1/attachments/a-a/content", original: "/api/v1/drive/items/a/content?inline=1" });
    const heic = photo("h", { type: "image/heic", display: false, thumb: false });
    expect(hasPicture(heic)).toBe(false);
    expect(viewerSources(heic)).toBeNull();
    // An old JPEG not read yet: the server answers its original raster for /display.
    expect(viewerSources(photo("old", { display: false, thumb: false }))).not.toBeNull();
    expect(viewerSources(photo("v", { type: "video/mp4" }))).toBeNull();
  });

  it("reads two on each side ahead, nearest first", () => {
    expect(neighbours(["a", "b", "c", "d", "e", "f"], 2)).toEqual(["d", "b", "e", "a"]);
    expect(neighbours(["a", "b"], 0)).toEqual(["b"]);
  });

  it("tells a swipe from a tap and a scroll", () => {
    expect(swipeStep(-120, 10)).toBe(1);
    expect(swipeStep(120, 10)).toBe(-1);
    expect(swipeStep(20, 0)).toBe(0);
    expect(swipeStep(80, 100)).toBe(0);
  });
});

describe("the slideshow", () => {
  const items = [photo("a"), photo("v", { type: "video/mp4", duration: 20_000 }), photo("b"), photo("h", { type: "image/heic", display: false, thumb: false }), photo("c")];

  it("shows photos that can be drawn and videos unless they are skipped", () => {
    expect(slideshowItems(items, false).map((item) => item.id)).toEqual(["a", "v", "b", "c"]);
    expect(slideshowItems(items, true).map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("goes in order from the start, or shuffled with the start first", () => {
    const shown = slideshowItems(items, false);
    expect(slideshowOrder(shown, "order", "b").map((item) => item.id)).toEqual(["b", "c", "a", "v"]);
    expect(slideshowOrder(shown, "order", null).map((item) => item.id)).toEqual(["a", "v", "b", "c"]);
    const random = vi.fn(() => 0);
    const shuffled = slideshowOrder(shown, "random", "b", random).map((item) => item.id);
    expect(shuffled[0]).toBe("b");
    expect([...shuffled].sort()).toEqual(["a", "b", "c", "v"]);
    expect(random).toHaveBeenCalled();
  });

  it("keeps a photo the interval and a video to its end, 60 seconds at most", () => {
    expect(slideDuration(photo("a"), 5)).toBe(5000);
    expect(slideDuration(photo("v", { type: "video/mp4", duration: 20_000 }), 5)).toBe(20_000 + SLIDESHOW_VIDEO_GRACE_MS);
    expect(slideDuration(photo("v", { type: "video/mp4", duration: 600_000 }), 5)).toBe(SLIDESHOW_VIDEO_MAX_MS);
    expect(slideDuration(photo("v", { type: "video/mp4", duration: null }), 5)).toBe(SLIDESHOW_VIDEO_MAX_MS);
  });
});

describe("the rest", () => {
  it("drafts 「チャンネルに知らせる」 with the count added here", () => {
    expect(notifyDraft("", "https://x/d/f", 12)).toBe("写真を追加しました（12 枚）\nhttps://x/d/f ");
    expect(notifyDraft("", "https://x/d/f", 0)).toBe("https://x/d/f ");
    expect(notifyDraft("見てください  ", "https://x/d/f", 0)).toBe("見てください\nhttps://x/d/f ");
  });

  it("names an album made from a post and keeps a message's photos only", () => {
    expect(albumNameFor("学会", new Date(2026, 8, 16, 10).toISOString())).toBe("#学会 2026-09-16");
    expect(albumNameFor(null, new Date(2026, 8, 16, 10).toISOString())).toBe("2026-09-16");
    const base = { id: "x", filename: "a", size_bytes: 1, width: null, height: null, has_thumbnail: false, has_poster: false, has_display: false, duration_ms: null, created_at: "" };
    expect(albumAttachments([
      { ...base, id: "1", content_type: "image/jpeg", status: "attached" },
      { ...base, id: "2", content_type: "video/mp4", status: "attached" },
      { ...base, id: "3", content_type: "application/pdf", status: "attached" },
      { ...base, id: "4", content_type: "image/png", status: "pending" },
    ]).map((a) => a.id)).toEqual(["1", "2"]);
  });

  it("offers 「アルバムにする」 for a plain folder below the top only", () => {
    expect(canBecomeAlbum({ kind: "folder", parent_id: "root", album: null })).toBe(true);
    expect(canBecomeAlbum({ kind: "folder", parent_id: null, album: null })).toBe(false);
    expect(canBecomeAlbum({ kind: "folder", parent_id: "root", album: null, system_role: "channel_posts" })).toBe(false);
    expect(canBecomeAlbum({ kind: "file", parent_id: "root", album: null })).toBe(false);
  });

  it("keeps the originals back from an album's new link by default", () => {
    expect(originalsDefault({ kind: "folder", album: { folder_id: "f" } as never })).toBe(false);
    expect(originalsDefault({ kind: "folder", album: null })).toBe(true);
    expect(originalsDefault({ kind: "file", album: null })).toBe(true);
  });

  it("saves the display size from a link without originals, videos and GIFs as they are, nothing else", () => {
    const image = { kind: "file" as const, content_type: "image/jpeg", has_display: true };
    expect(publicSave(image, true)).toBe("original");
    expect(publicSave(image, false)).toBe("display");
    expect(publicSave({ ...image, has_display: false }, false)).toBeNull();
    expect(publicSave({ kind: "file", content_type: "video/mp4", has_display: false }, false)).toBe("original");
    expect(publicSave({ kind: "file", content_type: "image/gif", has_display: false }, false)).toBe("original");
    expect(publicSave({ kind: "file", content_type: "application/pdf", has_display: false }, false)).toBeNull();
    expect(publicSave({ kind: "folder", content_type: null, has_display: false }, true)).toBeNull();
    expect(webpName("IMG_1234.JPG")).toBe("IMG_1234.webp");
    expect(webpName("noext")).toBe("noext.webp");
  });

  it("checks the settings' dates and sums an add", () => {
    expect(datesProblem("", "")).toBeNull();
    expect(datesProblem("2026-09-19", "2026-09-16")).toContain("終了日は開始日より後");
    expect(datesProblem("2026-9-1", "")).toContain("日付");
    expect(addSummary([{ ok: true }, { ok: false, error: "drive_read_only" }, { ok: true }])).toEqual({ done: 2, failed: 1, error: "drive_read_only" });
  });
});

describe("the viewer's blob cache", () => {
  function fakeUrls() {
    let n = 0;
    const revoked: string[] = [];
    return { revoked, urls: { createObjectURL: () => `blob:${++n}`, revokeObjectURL: (url: string) => void revoked.push(url) } };
  }

  it("fetches once, keeps at most its size and revokes the oldest, clears everything", async () => {
    const fetchBlob = vi.fn(async () => new Blob(["x"]));
    const { urls, revoked } = fakeUrls();
    const cache = new BlobCache({ fetchBlob }, 2, urls as never);
    const a = await cache.get("/a");
    expect(await cache.get("/a")).toBe(a);
    expect(fetchBlob).toHaveBeenCalledTimes(1);
    await cache.get("/b");
    await cache.get("/c");
    expect(cache.count).toBe(2);
    expect(cache.has("/a")).toBe(false);
    expect(revoked).toEqual([a]);
    cache.clear();
    expect(revoked).toHaveLength(3);
  });

  it("forgets a failure so that asking again retries", async () => {
    const fetchBlob = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new Blob(["x"]));
    const { urls } = fakeUrls();
    const cache = new BlobCache({ fetchBlob }, 4, urls as never);
    await expect(cache.get("/a")).rejects.toThrow("offline");
    await expect(cache.get("/a")).resolves.toMatch(/^blob:/);
  });
});
