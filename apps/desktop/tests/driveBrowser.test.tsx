// @vitest-environment jsdom
/**
 * M161 (docs/DRIVE.md §17.2): a location's listing on screen — the breadcrumbs named after the location, the rows of a
 * folder read by cursor as the end comes into view, a click into a folder, sorting by a column, and the trash.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DriveChildrenOut, DriveItemOut, DriveLocationOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { DriveBrowser } from "../src/ui/DriveBrowser";

const LOCATION: DriveLocationOut = {
  id: "loc", kind: "workspace", channel_id: null, user_id: null, root_id: "root", name: "研究室ドライブ",
  can_write: true, can_manage: true, can_share: false, external_links: true, quota_bytes: null, used_bytes: 0, item_count: 0,
};

function row(id: string, kind: "file" | "folder", name: string): DriveItemOut {
  return {
    id, location_id: "loc", parent_id: "root", kind, name, size_bytes: kind === "file" ? 2048 : null, content_type: kind === "file" ? "text/plain" : null,
    content_modified_at: null, created_by: "u1", created_at: "2026-10-01T00:00:00Z", updated_by: "u1", updated_at: "2026-10-01T09:30:00Z",
    version_count: kind === "file" ? 1 : 0, file: null, link_count: 0,
  };
}

const ROOT = row("root", "folder", "");
const FOLDER = row("f1", "folder", "ゼミ資料");

function controllerWith(api: Record<string, unknown>): AppController {
  return {
    api,
    engine: null,
    accountKey: "test",
    store: { users: new Map([["u1", { id: "u1", display_name: "加納" }]]) },
    setError: vi.fn(),
    setNotice: vi.fn(),
    downloadDriveFile: vi.fn(),
  } as unknown as AppController;
}

let observers: Array<() => void> = [];

beforeEach(() => {
  observers = [];
  // The listing reads its next page when the end comes into view.
  vi.stubGlobal("IntersectionObserver", class {
    constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() {
      observers.push(() => this.callback([{ isIntersecting: true }]));
    }
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DriveBrowser", () => {
  it("lists a folder page by page, folders first, with breadcrumbs named after the location", async () => {
    const first: DriveChildrenOut = { folder: ROOT, path: [{ id: "root", name: "研究室ドライブ" }], items: [FOLDER, row("a", "file", "a.txt")], next_cursor: "c1" };
    const second: DriveChildrenOut = { ...first, items: [row("a", "file", "a.txt"), row("b", "file", "b.txt")], next_cursor: null };
    const driveChildren = vi.fn(async (_id: string, query: { cursor?: string | null }) => (query.cursor ? second : first));
    const onFolder = vi.fn();
    render(<DriveBrowser controller={controllerWith({ driveChildren, searchDrive: vi.fn() })} location={LOCATION} folderId="root" onFolder={onFolder} onMode={vi.fn()} />);
    await screen.findByText("ゼミ資料");
    expect(screen.getByRole("navigation", { name: "フォルダの場所" }).textContent).toContain("研究室ドライブ");
    // The end in view: the next page, without repeating a row.
    for (const fire of observers) fire();
    await screen.findByTitle("b.txt");
    expect(driveChildren).toHaveBeenLastCalledWith("root", expect.objectContaining({ cursor: "c1" }));
    const names = [...document.querySelectorAll("[data-drive-item]")].map((element) => element.querySelector("[title]")?.getAttribute("title") ?? element.textContent);
    expect(names.length).toBe(3);
    expect(document.querySelectorAll("[data-drive-item]")[0]!.textContent).toContain("ゼミ資料");
    expect(screen.getAllByText("加納").length).toBeGreaterThan(0);
    // A double click opens the folder.
    fireEvent.doubleClick(document.querySelector('[data-drive-item="f1"]')!);
    expect(onFolder).toHaveBeenCalledWith("f1");
  });

  it("sorts by a column: the server is asked again, newest first for the time", async () => {
    const driveChildren = vi.fn(async () => ({ folder: ROOT, path: [{ id: "root", name: "研究室ドライブ" }], items: [row("a", "file", "a.txt")], next_cursor: null }));
    render(<DriveBrowser controller={controllerWith({ driveChildren, searchDrive: vi.fn() })} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle("a.txt");
    const header = screen.getAllByRole("columnheader").find((cell) => cell.textContent?.includes("更新日時"))!;
    fireEvent.click(within(header).getByRole("button"));
    await waitFor(() => expect(driveChildren).toHaveBeenLastCalledWith("root", expect.objectContaining({ sort: "modified", order: "desc" })));
  });

  it("a folder gone (deleted, or no longer readable) goes back to the location's top", async () => {
    const { ApiError } = await import("../src/api/errors");
    const driveChildren = vi.fn(async () => { throw new ApiError(404, "drive_item_not_found", "gone"); });
    const onFolder = vi.fn();
    render(<DriveBrowser controller={controllerWith({ driveChildren, searchDrive: vi.fn() })} location={LOCATION} folderId="f1" onFolder={onFolder} />);
    await waitFor(() => expect(onFolder).toHaveBeenCalledWith("root"));
  });

  it("the trash restores a group and deletes one for good after asking", async () => {
    const trashed = { ...row("t", "folder", "古い資料"), trashed_at: "2026-10-20T00:00:00Z", trashed_by: "u1" };
    const driveTrash = vi.fn(async () => ({ entries: [{ item: trashed, trashed_at: "2026-10-20T00:00:00Z", trashed_by: "u1", item_count: 4, size_bytes: 9000 }], next_cursor: null }));
    const restoreDriveItem = vi.fn(async () => trashed);
    const deleteDriveItem = vi.fn(async () => undefined);
    render(<DriveBrowser controller={controllerWith({ driveChildren: vi.fn(), driveTrash, restoreDriveItem, deleteDriveItem, searchDrive: vi.fn() })} location={LOCATION} folderId="root" onFolder={vi.fn()} mode="trash" onMode={vi.fn()} />);
    await screen.findByText("古い資料");
    expect(document.body.textContent).toContain("中に 3 件");
    fireEvent.click(screen.getByRole("button", { name: /元に戻す/ }));
    await waitFor(() => expect(restoreDriveItem).toHaveBeenCalledWith("t", "rename"));
    fireEvent.click(screen.getByRole("button", { name: /完全に削除/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "完全に削除" }));
    await waitFor(() => expect(deleteDriveItem).toHaveBeenCalledWith("t"));
  });
});
