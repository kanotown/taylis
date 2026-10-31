// @vitest-environment jsdom
/**
 * AL2 (docs/ALBUMS.md §10, §7, §9): the albums on screen — an album folder opening as the album (header, the rows in
 * view only, subfolders and other files only when it has some, a reread on drive.changed), the viewer (the display
 * size, ← →, 「元の画像を開く」, 「位置情報あり」), the slideshow (the interval, 「動画を飛ばす」, Space), the `/d/`
 * album card, the share dialog's `originals`, the public page of an album link, 「アルバムに追加」 from a message, and
 * the albums list with its search.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AlbumDetailOut, AlbumListEntryOut, AlbumOut, AttachmentOut, DriveChildrenOut, DriveItemDetailOut, DriveItemLinksOut, DriveItemOut, DriveLocationOut, ShareInfoOut, SharedChildrenOut, SharedItemOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { ShareApi } from "../src/share/api";
import { SharePage } from "../src/share/SharePage";
import { DriveHub } from "../src/sync/drive";
import { AddToAlbumDialog } from "../src/ui/AlbumDialogs";
import { AlbumsHome } from "../src/ui/AlbumsHome";
import { AlbumView } from "../src/ui/AlbumView";
import { Slideshow } from "../src/ui/AlbumViewer";
import { DriveBrowser } from "../src/ui/DriveBrowser";
import { DriveLinkCard } from "../src/ui/DriveLinkCard";
import { ShareLinksDialog } from "../src/ui/DriveShareDialog";
import { messageActions } from "../src/ui/messageActions";

const LOCATION: DriveLocationOut = {
  id: "loc", kind: "workspace", channel_id: null, user_id: null, root_id: "root", name: "研究室ドライブ",
  can_write: true, can_manage: true, can_share: true, external_links: true, quota_bytes: null, used_bytes: 0, item_count: 0,
};

const ALBUM: AlbumOut = {
  folder_id: "album", description: "2026 年秋の応用物理学会（名古屋）", cover: { item_id: "p0", attachment_id: "a-p0" }, cover_item_id: null,
  sort: "taken", sort_order: "asc", starts_on: "2026-09-16", ends_on: "2026-09-19", taken_from: null, taken_to: null,
  photo_count: 312, video_count: 8, size_bytes: 1, preview_attachment_ids: ["a-p0", "a-p1", "a-p2", "a-p3"], updated_at: "2026-09-20T00:00:00Z",
  created_at: "2026-09-20T00:00:00Z", created_by: "u1",
};

function folder(id: string, name: string, album: AlbumOut | null = null, parent: string | null = "albums"): DriveItemOut {
  return {
    id, location_id: "loc", parent_id: parent, kind: "folder", name, size_bytes: null, content_type: null, content_modified_at: null,
    created_by: "u1", created_at: "2026-09-20T00:00:00Z", updated_by: "u1", updated_at: "2026-09-20T00:00:00Z", version_count: 0, file: null,
    link_count: 0, posted: false, album,
  };
}

function photo(id: string, extra: { type?: string; day?: number; location?: boolean; duration?: number | null } = {}): DriveItemOut {
  return {
    id, location_id: "loc", parent_id: "album", kind: "file", name: `${id}.jpg`, size_bytes: 1000, content_type: extra.type ?? "image/jpeg",
    content_modified_at: null, created_by: "u1", created_at: "2026-09-20T00:00:00Z", updated_by: "u1", updated_at: "2026-09-20T00:00:00Z",
    version_count: 1, link_count: 0, posted: false,
    file: {
      attachment_id: `a-${id}`, version_id: `v-${id}`, width: 4000, height: 3000, has_thumbnail: true, has_poster: false, has_display: true,
      has_location: extra.location ?? false, duration_ms: extra.duration ?? null, preview: null, taken_at: new Date(2026, 8, extra.day ?? 16, 9).toISOString(),
    },
  };
}

const ALBUM_FOLDER = folder("album", "応用物理学会 2026", ALBUM);

function detail(items: DriveItemOut[], extra: Partial<AlbumDetailOut> = {}): AlbumDetailOut {
  return {
    folder: ALBUM_FOLDER, album: ALBUM, path: [{ id: "root", name: "研究室ドライブ" }, { id: "albums", name: "アルバム" }], location_kind: "workspace",
    can_write: true, items, next_cursor: null, folder_count: 0, other_count: 0, shared_above: 0, ...extra,
  };
}

function controllerWith(api: Record<string, unknown>, extra: Record<string, unknown> = {}): AppController {
  return {
    api: { baseUrl: "https://chat.example.com", fetchBlob: vi.fn(async () => new Blob(["x"])), ...api },
    engine: null,
    accountKey: null,
    isGuest: false,
    store: { me: { id: "u1" }, users: new Map([["u1", { id: "u1", display_name: "加納" }]]), channels: new Map(), draft: () => ({ text: "" }), setDraft: vi.fn() },
    can: () => false,
    setError: vi.fn(),
    setNotice: vi.fn(),
    downloadDriveFile: vi.fn(),
    downloadDriveZip: vi.fn(),
    openDriveLink: vi.fn(),
    requestShowInDrive: vi.fn(),
    copyToClipboard: vi.fn(async () => true),
    ...extra,
  } as unknown as AppController;
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
  try {
    localStorage.clear();
  } catch {
    /* none */
  }
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

function fetchedPaths(controller: AppController): string[] {
  return (controller.api!.fetchBlob as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
}

describe("the album screen", () => {
  it("opens an album folder as the album, with its header, and draws only the rows near the view", async () => {
    const items = Array.from({ length: 100 }, (_, index) => photo(`p${index}`, { day: 16 + Math.floor(index / 50) }));
    const driveAlbum = vi.fn(async () => detail(items, { next_cursor: "more" }));
    const driveChildren = vi.fn(async (): Promise<DriveChildrenOut> => ({ folder: ALBUM_FOLDER, path: [], items: [], next_cursor: null, shared_above: 0 }));
    const controller = controllerWith({ driveAlbum, driveChildren, searchDrive: vi.fn() });
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="album" onFolder={vi.fn()} onMode={vi.fn()} />);
    await waitFor(() => expect(document.querySelector("[data-album-view='album']")).toBeTruthy());
    expect(screen.getByRole("heading", { name: /応用物理学会 2026/ })).toBeTruthy();
    expect(document.querySelector("[data-album-summary]")!.textContent).toBe("2026/9/16〜9/19 · 312 枚 · 動画 8 本");
    expect(document.querySelector("[data-album-description]")!.textContent).toContain("名古屋");
    expect(screen.getByRole("navigation", { name: "フォルダの場所" }).textContent).toContain("研究室ドライブアルバム");
    // Day headings, and far fewer tiles than photos (the rest are drawn as they scroll near).
    expect(document.querySelectorAll("[data-album-day]")[0]!.textContent).toBe("9月16日（水）");
    const tiles = document.querySelectorAll("[data-album-tile]").length;
    expect(tiles).toBeGreaterThan(0);
    expect(tiles).toBeLessThan(100);
    // Only the drawn tiles read their thumbnails (and the cover).
    await waitFor(() => expect(fetchedPaths(controller).filter((path) => path.endsWith("/thumbnail")).length).toBeGreaterThan(0));
    expect(fetchedPaths(controller).filter((path) => path.endsWith("/thumbnail")).length).toBeLessThanOrEqual(tiles + 1);
    // No subfolders or other files: the children are not read.
    expect(driveChildren.mock.calls.filter((call) => ((call as unknown[])[1] as { limit?: number } | undefined)?.limit === 200)).toHaveLength(0);
  });

  it("lists its subfolders and other files when it has some, and reads itself again on drive.changed", async () => {
    const hub = new DriveHub();
    const driveAlbum = vi.fn(async () => detail([photo("p0")], { folder_count: 1, other_count: 1 }));
    const children: DriveChildrenOut = { folder: ALBUM_FOLDER, path: [], items: [folder("sub", "初日", null, "album"), { ...photo("doc"), name: "プログラム.pdf", content_type: "application/pdf" }, photo("p0")], next_cursor: null, shared_above: 0 };
    const driveChildren = vi.fn(async () => children);
    const onFolder = vi.fn();
    const controller = controllerWith({ driveAlbum, driveChildren }, { engine: { drive: hub } });
    render(<AlbumView controller={controller} location={LOCATION} folderId="album" onFolder={onFolder} onShowFiles={vi.fn()} onNotAlbum={vi.fn()} />);
    await screen.findByText("初日");
    fireEvent.click(screen.getByText("初日"));
    expect(onFolder).toHaveBeenCalledWith("sub");
    const others = document.querySelector("[data-album-others]")!;
    expect(others.textContent).toContain("ほかのファイル（1）");
    fireEvent.click(within(others as HTMLElement).getByRole("button", { expanded: false }));
    expect(others.textContent).toContain("プログラム");
    expect(driveAlbum).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    act(() => hub.applyEvent("drive.changed", { location_id: "loc", folder_ids: ["album"], seq: 1 }));
    act(() => hub.applyEvent("drive.changed", { location_id: "loc", folder_ids: ["other"], seq: 2 }));
    await act(async () => {
      vi.advanceTimersByTime(400);
    });
    vi.useRealTimers();
    await waitFor(() => expect(driveAlbum).toHaveBeenCalledTimes(2));
  });

  it("selects with the check box and offers ZIP, the cover and the trash", async () => {
    const driveAlbum = vi.fn(async () => detail([photo("p0"), photo("p1"), photo("p2")]));
    const putDriveAlbum = vi.fn(async () => ({ ...ALBUM, cover_item_id: "p1", cover: { item_id: "p1", attachment_id: "a-p1" } }));
    const controller = controllerWith({ driveAlbum, putDriveAlbum, driveChildren: vi.fn() });
    render(<AlbumView controller={controller} location={LOCATION} folderId="album" onFolder={vi.fn()} onShowFiles={vi.fn()} onNotAlbum={vi.fn()} />);
    await waitFor(() => expect(document.querySelector("[data-album-check='p1']")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-album-check='p1']")!);
    const bar = document.querySelector("[data-album-selection-bar]") as HTMLElement;
    expect(bar.textContent).toContain("1 枚を選択中");
    fireEvent.click(bar.querySelector("[data-album-cover-selected]")!);
    await waitFor(() => expect(putDriveAlbum).toHaveBeenCalledWith("album", { cover_item_id: "p1" }));
    // A second photo: the cover is for one photo only; the download is one ZIP.
    fireEvent.click(document.querySelector("[data-album-check='p2']")!);
    expect(bar.querySelector("[data-album-cover-selected]")).toBeNull();
    fireEvent.click(within(bar).getByRole("button", { name: /ZIP/ }));
    expect(controller.downloadDriveZip).toHaveBeenCalledWith(["p1", "p2"]);
    // 「すべてダウンロード」 after clearing: the folder as one ZIP.
    fireEvent.click(within(bar).getByRole("button", { name: "選択を解除" }));
    fireEvent.click(screen.getByRole("button", { name: /すべてダウンロード/ }));
    expect(controller.downloadDriveZip).toHaveBeenLastCalledWith(["album"]);
  });

  it("opens a photo full screen at the display size, steps with → and opens the original", async () => {
    const driveAlbum = vi.fn(async () => detail([photo("p0", { location: true }), photo("p1"), photo("p2"), photo("p3")]));
    const controller = controllerWith({ driveAlbum, driveChildren: vi.fn() });
    render(<AlbumView controller={controller} location={LOCATION} folderId="album" onFolder={vi.fn()} onShowFiles={vi.fn()} onNotAlbum={vi.fn()} />);
    await waitFor(() => expect(document.querySelector("[data-album-tile='p0'] button")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-album-tile='p0'] button")!);
    await waitFor(() => expect(fetchedPaths(controller)).toContain("/api/v1/attachments/a-p0/display"));
    expect(document.querySelector("[data-album-location]")!.textContent!.trim()).toBe("位置情報あり");
    // The neighbours are read ahead.
    await waitFor(() => expect(fetchedPaths(controller)).toContain("/api/v1/attachments/a-p2/display"));
    expect(fetchedPaths(controller)).not.toContain("/api/v1/drive/items/p0/content?inline=1");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByText("2 ／ 4")).toBeTruthy());
    expect(document.querySelector("[data-album-location]")).toBeNull();
    fireEvent.click(document.querySelector("[data-album-original]")!);
    await waitFor(() => expect(fetchedPaths(controller)).toContain("/api/v1/drive/items/p1/content?inline=1"));
  });
});

describe("the slideshow", () => {
  it("moves on after the interval, skips videos when asked, pauses with Space and ends with Esc", async () => {
    vi.useFakeTimers();
    const items = [photo("p0"), photo("v", { type: "video/mp4", duration: 10_000 }), photo("p1")];
    const onClose = vi.fn();
    const controller = controllerWith({});
    render(<Slideshow controller={controller} items={items} startId={null} settings={{ interval: 3, random: false, skipVideos: true }} onClose={onClose} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector("[data-album-slideshow]")!.textContent).toContain("1 / 2");
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });
    expect(document.querySelector("[data-album-slideshow]")!.textContent).toContain("2 / 2");
    fireEvent.keyDown(window, { key: " " });
    expect(document.querySelector("[data-album-slideshow='paused']")).toBeTruthy();
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(document.querySelector("[data-album-slideshow]")!.textContent).toContain("2 / 2");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("the album card", () => {
  it("shows four photos, the title, the count and the days, and opens the album", async () => {
    const state: { state: "ok"; detail: DriveItemDetailOut } = { state: "ok", detail: { item: ALBUM_FOLDER, path: [{ id: "root", name: "研究室ドライブ" }, { id: "albums", name: "アルバム" }], location_kind: "workspace" } };
    const controller = controllerWith({}, { driveLink: vi.fn(async () => state) });
    render(<DriveLinkCard controller={controller} itemId="album" url="https://chat.example.com/d/album" />);
    await waitFor(() => expect(document.querySelector("[data-album-card]")).toBeTruthy());
    const card = document.querySelector("[data-album-card]") as HTMLElement;
    expect(card.querySelector("[data-album-card-photos]")!.getAttribute("data-album-card-photos")).toBe("4");
    expect(card.textContent).toContain("応用物理学会 2026");
    expect(card.querySelector("[data-album-card-line]")!.textContent).toBe("312 枚 · 動画 8 本 · 2026/9/16〜9/19");
    expect(card.textContent).toContain("研究室ドライブ › アルバム");
    fireEvent.click(card);
    expect(controller.openDriveLink).toHaveBeenCalledWith("album");
  });

  it("tells nothing of an album that cannot be read", async () => {
    const controller = controllerWith({}, { driveLink: vi.fn(async () => ({ state: "unreadable" })) });
    render(<DriveLinkCard controller={controller} itemId="album" url="https://chat.example.com/d/album" />);
    await screen.findByText("表示できないファイル");
    expect(document.body.textContent).not.toContain("応用物理学会");
    expect(document.querySelector("[data-album-card]")).toBeNull();
  });
});

describe("the share link of an album", () => {
  const policy = { enabled: true, location_enabled: true, can_share: true, max_days: 90, default_days: 7, password_required: false };

  it("keeps the originals back unless 「元の写真のダウンロードを許す」 is ticked", async () => {
    const links: DriveItemLinksOut = { links: [], policy };
    const createDriveLink = vi.fn(async () => ({ url: "/s/abc", link: { has_password: false } }));
    const controller = controllerWith({ driveItemLinks: vi.fn(async () => links), createDriveLink });
    render(<ShareLinksDialog controller={controller} item={ALBUM_FOLDER} onClose={vi.fn()} onChanged={vi.fn()} />);
    const box = await waitFor(() => { const found = document.querySelector("[data-share-originals] input") as HTMLInputElement | null; expect(found).toBeTruthy(); return found!; });
    expect(box.checked).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /リンクを作る/ }));
    await waitFor(() => expect(createDriveLink).toHaveBeenCalledWith("album", expect.objectContaining({ originals: false })));
    cleanup();
    render(<ShareLinksDialog controller={controller} item={ALBUM_FOLDER} onClose={vi.fn()} onChanged={vi.fn()} />);
    const again = await waitFor(() => { const found = document.querySelector("[data-share-originals] input") as HTMLInputElement | null; expect(found).toBeTruthy(); return found!; });
    fireEvent.click(again);
    fireEvent.click(screen.getByRole("button", { name: /リンクを作る/ }));
    await waitFor(() => expect(createDriveLink).toHaveBeenLastCalledWith("album", expect.objectContaining({ originals: true })));
  });

  it("offers no originals box for a plain folder, and switches a link's originals", async () => {
    const link = {
      id: "l1", item_id: "album", item_name: "応用物理学会 2026", item_kind: "folder", location_id: "loc", location_kind: "workspace", location_name: "研究室ドライブ",
      created_by: "u1", created_by_name: "加納", created_at: "2026-10-01T00:00:00Z", expires_at: "2026-10-08T00:00:00Z", has_password: false,
      max_downloads: null, download_count: 0, note: null, last_used_at: null, state: "active", can_edit: true, can_revoke: true, originals: false,
    };
    const updateDriveLink = vi.fn(async () => ({ ...link, originals: true }));
    const controller = controllerWith({ driveItemLinks: vi.fn(async () => ({ links: [link], policy })), createDriveLink: vi.fn(), updateDriveLink });
    render(<ShareLinksDialog controller={controller} item={ALBUM_FOLDER} onClose={vi.fn()} onChanged={vi.fn()} />);
    await waitFor(() => expect(document.querySelector("[data-share-display-only]")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-share-toggle-originals]")!);
    await waitFor(() => expect(updateDriveLink).toHaveBeenCalledWith("l1", { originals: true }));
    cleanup();
    render(<ShareLinksDialog controller={controller} item={folder("plain", "資料", null)} onClose={vi.fn()} onChanged={vi.fn()} />);
    await screen.findByRole("button", { name: /リンクを作る/ });
    expect(document.querySelector("[data-share-originals]")).toBeNull();
  });
});

describe("the public page of an album link", () => {
  const TOKEN = "AbC_d-0123456789abcdefghijklmnopqrstuvwxyz0";
  function shared(id: string, kind: "file" | "folder", name: string, extra: Partial<SharedItemOut> = {}): SharedItemOut {
    return { id, kind, name, size_bytes: kind === "file" ? 1024 : null, content_type: kind === "file" ? "image/jpeg" : null, modified_at: "2026-10-01T00:00:00Z", has_thumbnail: kind === "file", has_display: kind === "file", has_poster: false, width: null, height: null, preview: null, ...extra };
  }
  const sharedAlbum = { cover_item_id: null, description: "名古屋", ends_on: "2026-09-19", photo_count: 2, sort: "taken" as const, sort_order: "asc" as const, starts_on: "2026-09-16", taken_from: null, taken_to: null, video_count: 1 };
  function page(originals: boolean) {
    const children: SharedChildrenOut = {
      folder: shared("f", "folder", "応用物理学会 2026"), path: [{ id: "f", name: "応用物理学会 2026" }], album: sharedAlbum, next_cursor: null,
      items: [shared("p1", "file", "IMG_1.JPG"), shared("p2", "file", "IMG_2.JPG"), shared("v1", "file", "clip.mov", { content_type: "video/quicktime", has_display: false, has_poster: true, duration_ms: 12_000 }), shared("doc", "file", "プログラム.pdf", { content_type: "application/pdf", has_display: false, has_thumbnail: false })],
    };
    const information: ShareInfoOut = { state: "active", kind: "folder", password_required: false, unlocked: true, expires_at: null, downloads_left: null, root_id: "f", item: shared("f", "folder", "応用物理学会 2026"), workspace_name: "加納研", album: sharedAlbum, originals };
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const body = url.includes("/children") ? children : information;
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });
  }

  it("shows the grid and the viewer at the display size, and never offers an original when originals are kept back", async () => {
    render(<SharePage api={new ShareApi(TOKEN, page(false) as unknown as typeof fetch)} />);
    await waitFor(() => expect(document.querySelector("[data-share-album]")).toBeTruthy());
    expect(document.querySelector("[data-share-album-summary]")!.textContent).toBe("2026/9/16〜9/19 · 2 枚 · 動画 1 本");
    expect(document.querySelectorAll("[data-share-tile]")).toHaveLength(3);
    const zip = document.querySelector("[data-share-album-zip]") as HTMLAnchorElement;
    expect(zip.getAttribute("href")).toBe(`/api/v1/shares/${TOKEN}/zip?size=display`);
    expect(document.querySelector("[data-share-display-note]")).toBeTruthy();
    // The PDF cannot be saved (the server refuses originals).
    expect(document.querySelector("[data-share-other='doc'] a")).toBeNull();
    fireEvent.click(document.querySelector("[data-share-tile='p1']")!);
    const image = await waitFor(() => document.querySelector("[data-share-image]") as HTMLImageElement);
    expect(image.getAttribute("src")).toBe(`/api/v1/shares/${TOKEN}/items/p1/display`);
    const save = document.querySelector("[data-share-save]") as HTMLAnchorElement;
    expect(save.getAttribute("href")).toBe(`/api/v1/shares/${TOKEN}/items/p1/display`);
    expect(save.getAttribute("download")).toBe("IMG_1.webp");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    await waitFor(() => expect((document.querySelector("[data-share-image]") as HTMLImageElement).getAttribute("src")).toBe(`/api/v1/shares/${TOKEN}/items/p2/display`));
    fireEvent.keyDown(window, { key: "ArrowRight" });
    const video = await waitFor(() => document.querySelector("[data-share-video]") as HTMLVideoElement);
    expect(video.getAttribute("src")).toBe(`/api/v1/shares/${TOKEN}/items/v1/content?inline=1`);
    expect(document.body.innerHTML).not.toContain("/items/p1/content");
  });

  it("hands out the originals when the link allows them", async () => {
    render(<SharePage api={new ShareApi(TOKEN, page(true) as unknown as typeof fetch)} />);
    await waitFor(() => expect(document.querySelector("[data-share-album]")).toBeTruthy());
    expect((document.querySelector("[data-share-album-zip]") as HTMLAnchorElement).getAttribute("href")).toBe(`/api/v1/shares/${TOKEN}/zip`);
    expect((document.querySelector("[data-share-other='doc'] a") as HTMLAnchorElement).getAttribute("href")).toBe(`/api/v1/shares/${TOKEN}/items/doc/content`);
    expect(document.querySelector("[data-share-display-note]")).toBeNull();
  });
});

describe("「アルバムに追加」 from a message", () => {
  const attachment = (id: string, posted: boolean): AttachmentOut => ({
    id, filename: `${id}.jpg`, content_type: "image/jpeg", size_bytes: 10, width: null, height: null, has_thumbnail: true, has_poster: false, has_display: true, duration_ms: null,
    status: "attached", created_at: "2026-09-16T01:00:00Z", ...(posted ? { drive: { item_id: `item-${id}`, state: "available" as const, version_id: "v", version_number: 1 } } : {}),
  });
  const channel = { id: "c1", type: "public", name: "学会" } as never;
  const channelLocation: DriveLocationOut = { ...LOCATION, id: "chloc", kind: "channel", channel_id: "c1", root_id: "chroot", name: "学会" };
  function entry(id: string, name: string, locationId: string): AlbumListEntryOut {
    return { folder: { ...folder(id, name, ALBUM), location_id: locationId }, album: ALBUM, path: [{ id: "r", name: "x" }], location_kind: locationId === "chloc" ? "channel" : "workspace" };
  }

  it("lists the channel's own albums first, adds by the mode chosen, and asks before moving posted files", async () => {
    const driveAlbums = vi.fn(async () => ({ items: [entry("lab", "研究室の行事", "loc"), entry("mine", "#学会 の写真", "chloc")], next_cursor: null }));
    const resolveDriveLocation = vi.fn(async () => channelLocation);
    const addToDriveAlbum = vi.fn(async () => ({ results: [{ source_id: "x1", ok: true, item_id: "n1", action: "moved" as const }, { source_id: "x2", ok: true, item_id: "n2", action: "copied" as const }] }));
    const driveImpact = vi.fn(async () => ({ posted_messages: 0, channels: [] }));
    const controller = controllerWith({ driveAlbums, resolveDriveLocation, addToDriveAlbum, driveImpact });
    render(<AddToAlbumDialog controller={controller} attachments={[attachment("x1", true), attachment("x2", false)]} channel={channel} postedAt="2026-09-16T01:00:00Z" onClose={vi.fn()} />);
    await waitFor(() => expect(document.querySelectorAll("[data-album-choice]").length).toBe(3));
    const order = [...document.querySelectorAll("[data-album-choice]")].map((element) => element.getAttribute("data-album-choice"));
    expect(order).toEqual(["new", "mine", "lab"]);
    fireEvent.click(document.querySelector("[data-album-choice='mine']")!);
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() => expect(addToDriveAlbum).toHaveBeenCalledWith("mine", expect.objectContaining({ attachment_ids: ["x1", "x2"], mode: "auto" })));
    expect(driveImpact).not.toHaveBeenCalled();
    expect(controller.setNotice).toHaveBeenCalledWith("2 件を「#学会 の写真」に追加しました", expect.objectContaining({ label: "アルバムを開く" }));
    cleanup();
    render(<AddToAlbumDialog controller={controller} attachments={[attachment("x1", true)]} channel={channel} postedAt="2026-09-16T01:00:00Z" onClose={vi.fn()} />);
    await waitFor(() => expect(document.querySelector("[data-album-choice='lab']")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-album-choice='lab']")!);
    fireEvent.click(screen.getByLabelText("移動する（元のファイルはアルバムに移ります）"));
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() => expect(driveImpact).toHaveBeenCalledWith(["item-x1"], "lab"));
    await waitFor(() => expect(addToDriveAlbum).toHaveBeenLastCalledWith("lab", expect.objectContaining({ mode: "move" })));
  });

  it("makes a new album in the channel's drive named after the channel and the day", async () => {
    const createDriveAlbum = vi.fn(async () => ({ folder: { ...folder("new", "#学会 2026-09-16", ALBUM), location_id: "chloc" }, album: ALBUM }));
    const addToDriveAlbum = vi.fn(async () => ({ results: [{ source_id: "x1", ok: true, item_id: "n1", action: "moved" as const }] }));
    const controller = controllerWith({ driveAlbums: vi.fn(async () => ({ items: [], next_cursor: null })), resolveDriveLocation: vi.fn(async () => channelLocation), createDriveAlbum, addToDriveAlbum });
    render(<AddToAlbumDialog controller={controller} attachments={[attachment("x1", true)]} channel={channel} postedAt={new Date(2026, 8, 16, 10).toISOString()} onClose={vi.fn()} />);
    await waitFor(() => expect(document.querySelector("[data-album-choice='new']")).toBeTruthy());
    fireEvent.click(document.querySelector("[data-album-choice='new']")!);
    expect((screen.getByLabelText("アルバムの名前") as HTMLInputElement).value).toBe("#学会 2026-09-16");
    fireEvent.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() => expect(createDriveAlbum).toHaveBeenCalledWith(expect.objectContaining({ location_id: "chloc", name: "#学会 2026-09-16" })));
    await waitFor(() => expect(addToDriveAlbum).toHaveBeenCalledWith("new", expect.objectContaining({ attachment_ids: ["x1"] })));
  });

  it("is offered in the message's menu only for stored photos and videos", () => {
    const message = { id: "m", body: "", pending: false, deleted: false, seq: 1, reactions: [], attachments: [], pinned_at: null } as never;
    const base = { message, mine: true, isAdmin: false, saved: false, thread: false, editable: false, showReactions: false, canMakeTask: false, canRequestReview: false, unreadOffered: false };
    expect(messageActions({ ...base, canAddToAlbum: true }).map((action) => action.key)).toContain("addToAlbum");
    expect(messageActions(base).map((action) => action.key)).not.toContain("addToAlbum");
  });
});

describe("the albums list", () => {
  it("lists every album with its cover and line, opens one, and searches with kind=album", async () => {
    const driveAlbums = vi.fn(async () => ({ items: [{ folder: ALBUM_FOLDER, album: ALBUM, path: [{ id: "root", name: "研究室ドライブ" }, { id: "albums", name: "アルバム" }], location_kind: "workspace" as const }], next_cursor: null }));
    const searchDrive = vi.fn(async () => ({ items: [], next_cursor: null }));
    const onOpen = vi.fn();
    const controller = controllerWith({ driveAlbums, searchDrive });
    render(<AlbumsHome controller={controller} locations={[LOCATION]} onOpen={onOpen} />);
    const tile = await waitFor(() => { const found = document.querySelector("[data-album-entry='album']") as HTMLElement | null; expect(found).toBeTruthy(); return found!; });
    expect(tile.textContent).toContain("応用物理学会 2026");
    expect(tile.textContent).toContain("312 枚 · 動画 8 本 · 2026/9/16〜9/19");
    expect(tile.textContent).toContain("研究室ドライブ › アルバム");
    fireEvent.click(tile);
    expect(onOpen).toHaveBeenCalledWith({ locationId: "loc", folderId: "album" });
    fireEvent.change(screen.getByLabelText("アルバムを探す"), { target: { value: "学会" } });
    await waitFor(() => expect(searchDrive).toHaveBeenCalledWith({ q: "学会", kind: "album", limit: 50 }));
    await screen.findByText("一致するアルバムはありません");
  });
});
