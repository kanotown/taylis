// @vitest-environment jsdom
/**
 * AL follow-ups (docs/ALBUMS.md §23): the 「アルバム」 folder (`system_role = albums`) is named in the UI language while it
 * keeps its stored name and is an ordinary folder otherwise; the photo viewer reads the display size first (a HEIC
 * original is no picture Chromium draws), then the original, then a HEIC's thumbnail, with 「元の画像を開く」.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AttachmentOut, DriveItemOut } from "../src/api/types";
import { canBecomeAlbum, viewerSources } from "../src/drive/albums";
import { canRearrange, crumbName, isSystemFolder, itemName, localizedPath } from "../src/drive/channelFiles";
import { setLocale } from "../src/i18n";
import type { AppController } from "../src/state/app";
import { Lightbox } from "../src/ui/Attachments";
import { viewerPictures } from "../src/ui/attachmentLayout";

const JPEG: AttachmentOut = { id: "j1", filename: "集合写真.jpg", content_type: "image/jpeg", size_bytes: 4_000_000, has_thumbnail: true, has_poster: false, has_display: true, duration_ms: null, status: "attached", created_at: "2026-10-29T06:00:00Z", width: 4032, height: 3024 };
const HEIC: AttachmentOut = { ...JPEG, id: "h1", filename: "IMG_0001.HEIC", content_type: "image/heic" };

function controllerWith(fetchBlob: (path: string) => Promise<Blob>) {
  return {
    api: { fetchBlob: vi.fn(fetchBlob) },
    engine: null,
    accountKey: "test",
    store: { users: new Map(), getChannel: () => undefined, workspaceSettings: {} },
    driveLink: vi.fn(async () => ({ state: "unreadable" })),
    downloadAttachment: vi.fn(),
    setError: vi.fn(),
    setNotice: vi.fn(),
  } as unknown as AppController & { api: { fetchBlob: ReturnType<typeof vi.fn> } };
}

function fetched(controller: ReturnType<typeof controllerWith>): string[] {
  return controller.api.fetchBlob.mock.calls.map((call) => String(call[0]));
}

let made = 0;
beforeEach(() => {
  setLocale("ja");
  made = 0;
  vi.stubGlobal("URL", class extends URL {
    static override createObjectURL = vi.fn(() => `blob:${++made}`);
    static override revokeObjectURL = vi.fn();
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setLocale("ja");
});

describe("the 「アルバム」 folder (§23)", () => {
  const folder = { name: "アルバム", system_role: "albums" as const };

  it("is named in the UI language while it keeps the stored name", () => {
    expect(itemName(folder)).toBe("アルバム");
    setLocale("en");
    expect(itemName(folder)).toBe("Albums");
    expect(crumbName({ id: "a", ...folder }, 1, "workspace")).toBe("Albums");
    expect(localizedPath([{ id: "root", name: "研究室ドライブ" }, { id: "a", ...folder }], "workspace").map((c) => c.name)).toEqual(["研究室ドライブ", "Albums"]);
    setLocale("zh-Hans");
    expect(itemName(folder)).toBe("相册");
  });

  it("shows the name someone gave it, and a person's own 「アルバム」 folder as it is", () => {
    setLocale("en");
    expect(itemName({ name: "写真", system_role: "albums" })).toBe("写真");
    expect(crumbName({ id: "a", name: "写真", system_role: "albums" }, 1, "workspace")).toBe("写真");
    expect(itemName({ name: "アルバム", system_role: null })).toBe("アルバム");
  });

  it("is an ordinary folder: renamed, moved, trashed; not an album itself", () => {
    expect(isSystemFolder(folder)).toBe(false);
    expect(canRearrange([folder])).toBe(true);
    expect(isSystemFolder({ system_role: "channel_posts" })).toBe(true);
    expect(canBecomeAlbum({ kind: "folder", parent_id: "root", album: null, system_role: "albums" })).toBe(false);
  });
});

describe("which picture the viewer reads", () => {
  it("prefers the display size, falls back to the original, and a HEIC to its thumbnail", () => {
    expect(viewerPictures(JPEG)).toEqual(["display", "content"]);
    expect(viewerPictures({ ...JPEG, has_display: false })).toEqual(["content"]);
    expect(viewerPictures(HEIC)).toEqual(["display", "content", "thumbnail"]);
    // A posted HEIC outside the drive has no display size: asked all the same (the server says 404).
    expect(viewerPictures({ ...HEIC, has_display: false })).toEqual(["display", "content", "thumbnail"]);
    expect(viewerPictures({ ...HEIC, has_thumbnail: false })).toEqual(["display", "content"]);
    expect(viewerPictures({ ...JPEG, content_type: "image/gif" })).toEqual(["content"]);
  });

  it("the album viewer reads a HEIC's thumbnail when there is no display size, and offers no original", () => {
    const item = {
      id: "i1", kind: "file", name: "IMG_0001.HEIC", content_type: "image/heic",
      file: { attachment_id: "h1", has_display: true, has_thumbnail: true },
    } as unknown as DriveItemOut;
    expect(viewerSources(item)).toEqual({ display: "/api/v1/attachments/h1/display", fallback: "/api/v1/attachments/h1/thumbnail", original: null });
    const jpeg = { ...item, name: "a.jpg", content_type: "image/jpeg" } as DriveItemOut;
    expect(viewerSources(jpeg)).toEqual({ display: "/api/v1/attachments/h1/display", fallback: "/api/v1/attachments/h1/content", original: "/api/v1/drive/items/i1/content?inline=1" });
  });
});

describe("the photo viewer (Lightbox)", () => {
  it("shows a HEIC's display size", async () => {
    const controller = controllerWith(async () => new Blob(["x"]));
    render(<Lightbox attachment={HEIC} controller={controller} onClose={() => undefined} />);
    const image = await screen.findByRole("img");
    expect(image.getAttribute("data-viewer-picture")).toBe("display");
    expect(fetched(controller)).toEqual(["/api/v1/attachments/h1/display"]);
    // No 「元の画像を開く」 for a HEIC (download gives the original).
    expect(screen.queryByRole("button", { name: "元の画像を開く" })).toBeNull();
  });

  it("falls back to the original, then to the thumbnail when the engine cannot draw it", async () => {
    const controller = controllerWith(async (path) => {
      if (path.endsWith("/display")) throw new Error("404 display_not_found");
      return new Blob(["x"]);
    });
    render(<Lightbox attachment={{ ...HEIC, has_display: false }} controller={controller} onClose={() => undefined} />);
    const original = await screen.findByRole("img");
    expect(original.getAttribute("data-viewer-picture")).toBe("content");
    fireEvent.error(original); // Chromium cannot draw a HEIC
    await waitFor(() => expect(screen.getByRole("img").getAttribute("data-viewer-picture")).toBe("thumbnail"));
    expect(fetched(controller)).toEqual(["/api/v1/attachments/h1/display", "/api/v1/attachments/h1/content", "/api/v1/attachments/h1/thumbnail"]);
  });

  it("says it failed when nothing can be drawn, and tries again from the first", async () => {
    const controller = controllerWith(async () => { throw new Error("offline"); });
    render(<Lightbox attachment={HEIC} controller={controller} onClose={() => undefined} />);
    await screen.findByText("画像を読み込めませんでした");
    expect(fetched(controller)).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    await waitFor(() => expect(fetched(controller)).toHaveLength(6));
    expect(fetched(controller)[3]).toBe("/api/v1/attachments/h1/display");
  });

  it("a JPEG's display size offers 「元の画像を開く」, which reads the original", async () => {
    const controller = controllerWith(async () => new Blob(["x"]));
    render(<Lightbox attachment={JPEG} controller={controller} onClose={() => undefined} />);
    expect((await screen.findByRole("img")).getAttribute("data-viewer-picture")).toBe("display");
    fireEvent.click(screen.getByRole("button", { name: "元の画像を開く" }));
    await waitFor(() => expect(screen.getByRole("img").getAttribute("data-viewer-picture")).toBe("content"));
    expect(fetched(controller)).toEqual(["/api/v1/attachments/j1/display", "/api/v1/attachments/j1/content"]);
    expect(screen.queryByRole("button", { name: "元の画像を開く" })).toBeNull();
  });

  it("a chat photo without a display size reads its original only", async () => {
    const controller = controllerWith(async () => new Blob(["x"]));
    render(<Lightbox attachment={{ ...JPEG, has_display: false }} controller={controller} onClose={() => undefined} />);
    expect((await screen.findByRole("img")).getAttribute("data-viewer-picture")).toBe("content");
    expect(fetched(controller)).toEqual(["/api/v1/attachments/j1/content"]);
  });
});
