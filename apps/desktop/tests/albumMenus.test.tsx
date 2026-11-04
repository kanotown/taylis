// @vitest-environment jsdom
/**
 * docs/ALBUMS.md §27: the drive's item menu in the album view — a tile's ⋯ (and its right click) with the same items
 * as the listing's row plus 「表紙にする」, never opening or selecting the photo; the album's own ⋯ with the folder's
 * items; an album card's ⋯ in 「アルバム」; what may be done follows the permissions; the trash and the move go through
 * the warning for posted files.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AlbumDetailOut, AlbumOut, DriveChildrenOut, DriveItemOut, DriveLocationOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { AlbumsHome } from "../src/ui/AlbumsHome";
import { AlbumView } from "../src/ui/AlbumView";
import { DriveBrowser } from "../src/ui/DriveBrowser";

const LOCATION: DriveLocationOut = {
  id: "loc", kind: "workspace", channel_id: null, user_id: null, root_id: "root", name: "研究室ドライブ",
  can_write: true, can_manage: true, can_share: true, external_links: true, quota_bytes: null, used_bytes: 0, item_count: 0,
};
const READ_ONLY: DriveLocationOut = { ...LOCATION, can_write: false, can_manage: false, can_share: false };

const ALBUM: AlbumOut = {
  folder_id: "album", description: "", cover: { item_id: "p0", attachment_id: "a-p0" }, cover_item_id: null,
  sort: "taken", sort_order: "asc", starts_on: null, ends_on: null, taken_from: null, taken_to: null,
  photo_count: 3, video_count: 0, size_bytes: 1, preview_attachment_ids: ["a-p0"], updated_at: "2026-09-20T00:00:00Z",
  created_at: "2026-09-20T00:00:00Z", created_by: "u1",
};

const ALBUM_FOLDER: DriveItemOut = {
  id: "album", location_id: "loc", parent_id: "albums", kind: "folder", name: "応用物理学会 2026", size_bytes: null, content_type: null,
  content_modified_at: null, created_by: "u1", created_at: "2026-09-20T00:00:00Z", updated_by: "u1", updated_at: "2026-09-20T00:00:00Z",
  version_count: 0, file: null, link_count: 0, posted: false, album: ALBUM,
};

function photo(id: string, type = "image/jpeg"): DriveItemOut {
  return {
    id, location_id: "loc", parent_id: "album", kind: "file", name: `${id}.jpg`, size_bytes: 1000, content_type: type,
    content_modified_at: null, created_by: "u1", created_at: "2026-09-20T00:00:00Z", updated_by: "u1", updated_at: "2026-09-20T00:00:00Z",
    version_count: 1, link_count: 0, posted: false,
    file: {
      attachment_id: `a-${id}`, version_id: `v-${id}`, width: 4000, height: 3000, has_thumbnail: true, has_poster: false, has_display: true,
      has_location: false, duration_ms: type.startsWith("video/") ? 5000 : null, preview: null, taken_at: new Date(2026, 8, 16, 9).toISOString(),
    },
  };
}

function detail(items: DriveItemOut[], extra: Partial<AlbumDetailOut> = {}): AlbumDetailOut {
  return {
    folder: ALBUM_FOLDER, album: ALBUM, path: [{ id: "root", name: "研究室ドライブ" }, { id: "albums", name: "アルバム" }], location_kind: "workspace",
    can_write: true, items, next_cursor: null, folder_count: 0, other_count: 0, shared_above: 0, ...extra,
  };
}

function controllerWith(api: Record<string, unknown>): AppController {
  return {
    api: {
      baseUrl: "https://chat.example.com",
      fetchBlob: vi.fn(async () => new Blob(["x"])),
      driveImpact: vi.fn(async () => ({ posted_messages: 0, channels: [] })),
      trashDriveItems: vi.fn(async (ids: string[]) => ({ results: ids.map((id) => ({ id, ok: true })) })),
      ...api,
    },
    engine: null,
    accountKey: null,
    isGuest: false,
    store: { me: { id: "u1" }, users: new Map([["u1", { id: "u1", display_name: "加納" }]]), channels: new Map(), getChannel: () => ({ name: "学会" }), draft: () => ({ text: "" }), setDraft: vi.fn() },
    can: () => false,
    setError: vi.fn(),
    setNotice: vi.fn(),
    downloadDriveFile: vi.fn(),
    downloadDriveZip: vi.fn(),
    openDriveLink: vi.fn(),
    requestShowInDrive: vi.fn(),
    copyToClipboard: vi.fn(async () => true),
  } as unknown as AppController;
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });
  // The drop-down menu measures its trigger.
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  URL.createObjectURL = vi.fn(() => "blob:x");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const labels = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.textContent!.trim());

async function albumWith(items: DriveItemOut[], options: { location?: DriveLocationOut; canWrite?: boolean; api?: Record<string, unknown>; onFolder?: () => void } = {}) {
  const api = { driveAlbum: vi.fn(async () => detail(items, { can_write: options.canWrite ?? true })), driveChildren: vi.fn(), ...options.api };
  const controller = controllerWith(api);
  render(<AlbumView controller={controller} location={options.location ?? LOCATION} folderId="album" onFolder={options.onFolder ?? vi.fn()} onShowFiles={vi.fn()} onNotAlbum={vi.fn()} />);
  await waitFor(() => expect(document.querySelector("[data-album-tile-menu='p1']")).toBeTruthy());
  return controller;
}

function openTileMenu(id: string): HTMLElement {
  fireEvent.click(document.querySelector(`[data-album-tile-menu='${id}']`)!);
  return screen.getByRole("menu");
}

describe("a tile's ⋯", () => {
  it("is a button on the tile that opens the item's menu without opening or selecting the photo", async () => {
    const controller = await albumWith([photo("p0"), photo("p1")]);
    const button = document.querySelector("[data-album-tile-menu='p1']") as HTMLButtonElement;
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-label")).toBe("操作");
    // Reachable with the keyboard: a button of its own, after the tile's open button.
    button.focus();
    expect(document.activeElement).toBe(button);
    const menu = openTileMenu("p1");
    expect(labels(menu)).toEqual(["プレビュー", "ダウンロード", "バージョン履歴", "共有リンク", "会話に送る", "リンクをコピー", "表紙にする", "コピー", "名前を変更", "移動", "ゴミ箱へ"]);
    // Neither the viewer nor the selection.
    expect(document.querySelector("[data-album-selection-bar]")).toBeNull();
    expect((controller.api!.fetchBlob as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]))).not.toContain("/api/v1/attachments/a-p1/display");
    expect(document.querySelector("[data-album-tile='p1']")!.getAttribute("aria-selected")).toBe("false");
  });

  it("opens the same menu on a right click", async () => {
    await albumWith([photo("p0"), photo("p1")]);
    fireEvent.contextMenu(document.querySelector("[data-album-tile='p1']")!);
    expect(labels(screen.getByRole("menu"))).toContain("表紙にする");
  });

  it("offers the items the listing's row offers for the same photo, plus 「表紙にする」", async () => {
    const children: DriveChildrenOut = { folder: { ...ALBUM_FOLDER, album: null }, path: [{ id: "root", name: "研究室ドライブ" }], items: [photo("p1")], next_cursor: null, shared_above: 0 };
    const listController = controllerWith({ driveChildren: vi.fn(async () => children), searchDrive: vi.fn() });
    render(<DriveBrowser controller={listController} location={LOCATION} folderId="album" onFolder={vi.fn()} />);
    await waitFor(() => expect(document.querySelector('[data-drive-item="p1"]')).toBeTruthy());
    fireEvent.contextMenu(document.querySelector('[data-drive-item="p1"]')!);
    const listed = labels(await screen.findByRole("menu"));
    cleanup();
    await albumWith([photo("p0"), photo("p1")]);
    expect(labels(openTileMenu("p1")).filter((label) => label !== "表紙にする")).toEqual(listed);
  });

  it("copies the link, downloads, opens, and makes the cover through the same actions", async () => {
    const putDriveAlbum = vi.fn(async () => ({ ...ALBUM, cover: { item_id: "p1", attachment_id: "a-p1" } }));
    const controller = await albumWith([photo("p0"), photo("p1")], { api: { putDriveAlbum } });
    fireEvent.click(within(openTileMenu("p1")).getByRole("menuitem", { name: "リンクをコピー" }));
    expect(controller.copyToClipboard).toHaveBeenCalledWith("https://chat.example.com/d/p1", expect.any(String));
    fireEvent.click(within(openTileMenu("p1")).getByRole("menuitem", { name: "ダウンロード" }));
    expect(controller.downloadDriveFile).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }));
    fireEvent.click(within(openTileMenu("p1")).getByRole("menuitem", { name: "表紙にする" }));
    await waitFor(() => expect(putDriveAlbum).toHaveBeenCalledWith("album", { cover_item_id: "p1" }));
    fireEvent.click(within(openTileMenu("p1")).getByRole("menuitem", { name: "プレビュー" }));
    await waitFor(() => expect((controller.api!.fetchBlob as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]))).toContain("/api/v1/attachments/a-p1/display"));
  });

  it("acts on the whole selection when the tile is part of it", async () => {
    const controller = await albumWith([photo("p0"), photo("p1"), photo("p2")]);
    fireEvent.click(document.querySelector("[data-album-check='p1']")!);
    fireEvent.click(document.querySelector("[data-album-check='p2']")!);
    const menu = openTileMenu("p2");
    expect(labels(menu)).toEqual(["ZIP でダウンロード", "コピー", "移動", "ゴミ箱へ"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "ZIP でダウンロード" }));
    expect(controller.downloadDriveZip).toHaveBeenCalledWith(["p1", "p2"]);
  });

  it("trashes through the warning for posted files", async () => {
    const driveImpact = vi.fn(async () => ({ posted_messages: 2, channels: [{ channel_id: "c1", messages: 2, unreadable_after: 0, unreadable_guests: 0 }] }));
    const trashDriveItems = vi.fn(async (ids: string[]) => ({ results: ids.map((id) => ({ id, ok: true })) }));
    await albumWith([photo("p0"), photo("p1")], { api: { driveImpact, trashDriveItems } });
    fireEvent.click(within(openTileMenu("p1")).getByRole("menuitem", { name: "ゴミ箱へ" }));
    await waitFor(() => expect(driveImpact).toHaveBeenCalledWith(["p1"], null));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("[data-drive-impact='trash']")).toBeTruthy();
    expect(trashDriveItems).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "ゴミ箱へ" }));
    await waitFor(() => expect(trashDriveItems).toHaveBeenCalledWith(["p1"]));
    await waitFor(() => expect(document.querySelector("[data-album-tile='p1']")).toBeNull());
  });

  it("offers only reading where I cannot write or share, and no cover for a video", async () => {
    await albumWith([photo("p0"), photo("p1", "video/mp4")], { location: READ_ONLY, canWrite: false });
    expect(labels(openTileMenu("p1"))).toEqual(["プレビュー", "ダウンロード", "バージョン履歴", "会話に送る", "リンクをコピー", "コピー"]);
  });
});

describe("the album's ⋯", () => {
  const openMore = () => {
    fireEvent.keyDown(document.querySelector("[data-album-more]")!, { key: "Enter" });
    return screen.getByRole("menu");
  };

  it("has the folder's items besides the album's own", async () => {
    const deleteDriveAlbum = vi.fn(async () => undefined);
    const controller = await albumWith([photo("p0"), photo("p1")], { api: { deleteDriveAlbum } });
    const items = labels(openMore());
    for (const label of ["共有リンク", "リンクをコピー", "コピー", "名前を変更", "アルバムを解除", "移動", "ゴミ箱へ"]) expect(items).toContain(label);
    // The buttons beside it already download and tell the channel.
    expect(items).not.toContain("ZIP でダウンロード");
    expect(items).not.toContain("会話に送る");
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "リンクをコピー" }));
    expect(controller.copyToClipboard).toHaveBeenCalledWith("https://chat.example.com/d/album", expect.any(String));
    fireEvent.click(within(openMore()).getByRole("menuitem", { name: "アルバムを解除" }));
    await waitFor(() => expect(deleteDriveAlbum).toHaveBeenCalledWith("album"));
  });

  it("leaves for the folder above when the album goes to the trash", async () => {
    const onFolder = vi.fn();
    const trashDriveItems = vi.fn(async (ids: string[]) => ({ results: ids.map((id) => ({ id, ok: true })) }));
    await albumWith([photo("p0"), photo("p1")], { onFolder, api: { trashDriveItems } });
    fireEvent.click(within(openMore()).getByRole("menuitem", { name: "ゴミ箱へ" }));
    await waitFor(() => expect(trashDriveItems).toHaveBeenCalledWith(["album"]));
    await waitFor(() => expect(onFolder).toHaveBeenCalledWith("albums"));
  });

  it("has no writing items where I cannot write", async () => {
    await albumWith([photo("p0"), photo("p1")], { location: READ_ONLY, canWrite: false });
    const items = labels(openMore());
    for (const label of ["名前を変更", "アルバムを解除", "移動", "ゴミ箱へ", "共有リンク"]) expect(items).not.toContain(label);
    expect(items).toContain("リンクをコピー");
  });
});

describe("an album card's ⋯", () => {
  const entries = { items: [{ folder: ALBUM_FOLDER, album: ALBUM, path: [{ id: "root", name: "研究室ドライブ" }, { id: "albums", name: "アルバム" }], location_kind: "workspace" as const }], next_cursor: null };

  it("opens the folder's menu without opening the album, and moves through the move dialog", async () => {
    const onOpen = vi.fn();
    const controller = controllerWith({ driveAlbums: vi.fn(async () => entries), searchDrive: vi.fn(), driveChildren: vi.fn(async () => ({ folder: null, path: [], items: [], next_cursor: null })), driveLocations: vi.fn(async () => ({ locations: [LOCATION] })) });
    render(<AlbumsHome controller={controller} locations={[LOCATION]} onOpen={onOpen} />);
    const button = await waitFor(() => { const found = document.querySelector("[data-album-entry-menu='album']") as HTMLElement | null; expect(found).toBeTruthy(); return found!; });
    fireEvent.click(button);
    const menu = screen.getByRole("menu");
    expect(onOpen).not.toHaveBeenCalled();
    expect(labels(menu)).toEqual(["開く", "ZIP でダウンロード", "共有リンク", "会話に送る", "リンクをコピー", "コピー", "名前を変更", "アルバムを解除", "移動", "ゴミ箱へ"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "移動" }));
    expect(within(await screen.findByRole("dialog")).getByRole("button", { name: "ここに移動" })).toBeTruthy();
  });

  it("opens on a right click too, and only reads in a location I cannot write", async () => {
    const controller = controllerWith({ driveAlbums: vi.fn(async () => entries), searchDrive: vi.fn() });
    render(<AlbumsHome controller={controller} locations={[READ_ONLY]} onOpen={vi.fn()} />);
    await waitFor(() => expect(document.querySelector("[data-album-entry='album']")).toBeTruthy());
    fireEvent.contextMenu(document.querySelector("[data-album-entry='album']")!);
    expect(labels(screen.getByRole("menu"))).toEqual(["開く", "ZIP でダウンロード", "会話に送る", "リンクをコピー", "コピー"]);
  });
});
