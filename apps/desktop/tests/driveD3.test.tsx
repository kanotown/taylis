// @vitest-environment jsdom
/**
 * M162 (docs/DRIVE.md §10.2, §10.3, §11.2, §17.2) on screen: ⌘C / ⌘X then ⌘V in a folder, a folder's download as a
 * ZIP, the version history (download, restore, delete after asking), and 「管理 → ドライブ」 with its quota field.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DriveItemOut, DriveLocationOut, DriveUsageOut, DriveVersionListOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { AdminDriveTab } from "../src/ui/AdminDriveTab";
import { DriveBrowser } from "../src/ui/DriveBrowser";
import { VersionsDialog } from "../src/ui/DriveVersions";

const LOCATION: DriveLocationOut = {
  id: "loc", kind: "workspace", channel_id: null, user_id: null, root_id: "root", name: "研究室ドライブ",
  can_write: true, can_manage: false, can_share: false, external_links: true, quota_bytes: null, used_bytes: 0, item_count: 0,
};

function row(id: string, kind: "file" | "folder", name: string, parent = "root"): DriveItemOut {
  return {
    id, location_id: "loc", parent_id: parent, kind, name, size_bytes: kind === "file" ? 2048 : null, content_type: kind === "file" ? "text/plain" : null,
    content_modified_at: null, created_by: "u1", created_at: "2026-10-01T00:00:00Z", updated_by: "u1", updated_at: "2026-10-01T09:30:00Z",
    version_count: kind === "file" ? 3 : 0, file: null, link_count: 0,
  };
}

const ROOT = row("root", "folder", "");

function controllerWith(api: Record<string, unknown>, extra: Record<string, unknown> = {}): AppController {
  return {
    api,
    engine: null,
    accountKey: "test",
    store: { users: new Map([["u1", { id: "u1", display_name: "加納" }]]) },
    setError: vi.fn(),
    setNotice: vi.fn(),
    downloadDriveFile: vi.fn(),
    downloadDriveZip: vi.fn(),
    ...extra,
  } as unknown as AppController;
}

beforeEach(() => {
  vi.stubGlobal("IntersectionObserver", class {
    observe() {}
    disconnect() {}
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("copy and paste", () => {
  it("⌘C then ⌘V copies (into the same folder too), ⌘X then ⌘V moves", async () => {
    const items = [row("f1", "folder", "ゼミ資料"), row("a", "file", "a.txt")];
    const driveChildren = vi.fn(async () => ({ folder: ROOT, path: [{ id: "root", name: "研究室ドライブ" }], items, next_cursor: null }));
    const copyDriveItems = vi.fn(async (ids: string[], _target: string, _onConflict: string, _opId: string) => ({ results: ids.map((id) => ({ id, ok: true, error: null, new_id: `${id}-copy` })) }));
    const moveDriveItems = vi.fn(async (ids: string[]) => ({ results: ids.map((id) => ({ id, ok: true, error: null })) }));
    const controller = controllerWith({ driveChildren, copyDriveItems, moveDriveItems, searchDrive: vi.fn() });
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle("a.txt");
    const grid = screen.getByRole("grid");
    fireEvent.click(document.querySelector('[data-drive-item="a"]')!);
    fireEvent.keyDown(grid, { key: "c", metaKey: true });
    fireEvent.keyDown(grid, { key: "v", metaKey: true });
    await waitFor(() => expect(copyDriveItems).toHaveBeenCalledWith(["a"], "root", "rename", expect.any(String)));
    // A copy stays on the clipboard: pasted again, copied again (another op id).
    fireEvent.keyDown(grid, { key: "v", metaKey: true });
    await waitFor(() => expect(copyDriveItems).toHaveBeenCalledTimes(2));
    expect(copyDriveItems.mock.calls[0]![3]).not.toBe(copyDriveItems.mock.calls[1]![3]);
    expect(controller.setNotice).toHaveBeenCalledWith("1 件のコピーを作りました");
    // A cut into the folder it is in does nothing.
    fireEvent.keyDown(grid, { key: "x", metaKey: true });
    fireEvent.keyDown(grid, { key: "v", metaKey: true });
    expect(moveDriveItems).not.toHaveBeenCalled();
  });

  it("a folder's menu downloads it as a ZIP and copies it with the folder dialog", async () => {
    const items = [row("f1", "folder", "ゼミ資料")];
    const driveChildren = vi.fn(async () => ({ folder: ROOT, path: [{ id: "root", name: "研究室ドライブ" }], items, next_cursor: null }));
    const controller = controllerWith({ driveChildren, searchDrive: vi.fn(), driveLocations: vi.fn(async () => ({ locations: [LOCATION] })) });
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByText("ゼミ資料");
    fireEvent.contextMenu(document.querySelector('[data-drive-item="f1"]')!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /ZIP でダウンロード/ }));
    expect(controller.downloadDriveZip).toHaveBeenCalledWith(["f1"]);
    fireEvent.contextMenu(document.querySelector('[data-drive-item="f1"]')!);
    fireEvent.click(await screen.findByRole("menuitem", { name: /コピー/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText("「ゼミ資料」をコピー").length).toBeGreaterThan(0);
    expect(within(dialog).getByRole("button", { name: "ここにコピー" })).toBeTruthy();
  });
});

describe("VersionsDialog", () => {
  const versions: DriveVersionListOut = {
    keep_versions: 10,
    keep_days: 30,
    versions: [
      { id: "v3", number: 3, size_bytes: 300, source: "restore", uploaded_by: "u1", created_at: "2026-10-21T01:00:00Z", content_modified_at: null, current: true, sha256: null },
      { id: "v2", number: 2, size_bytes: 200, source: "upload", uploaded_by: "u1", created_at: "2026-10-20T01:00:00Z", content_modified_at: null, current: false, sha256: null },
    ],
  };

  it("lists the versions, downloads any, restores an older one", async () => {
    const restoreDriveVersion = vi.fn(async () => row("a", "file", "a.txt"));
    const controller = controllerWith({ driveVersions: vi.fn(async () => versions), restoreDriveVersion });
    const onChanged = vi.fn();
    render(<VersionsDialog controller={controller} item={row("a", "file", "a.txt")} location={LOCATION} onClose={vi.fn()} onChanged={onChanged} />);
    await screen.findByText("版 3");
    expect(document.body.textContent).toContain("今の版");
    expect(document.body.textContent).toContain("前の版から戻した");
    expect(document.body.textContent).toContain("10 版まで");
    // Only the older version restores; nobody here may delete for good.
    expect(screen.getAllByRole("button", { name: /この版に戻す/ }).length).toBe(1);
    expect(screen.queryByRole("button", { name: /版 2 を削除/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "版 2 をダウンロード" }));
    expect(controller.downloadDriveFile).toHaveBeenCalledWith({ id: "a", name: "a.txt", size_bytes: 200 }, { versionId: "v2" });
    fireEvent.click(screen.getByRole("button", { name: /この版に戻す/ }));
    await waitFor(() => expect(restoreDriveVersion).toHaveBeenCalledWith("a", "v2"));
    expect(onChanged).toHaveBeenCalledWith(row("a", "file", "a.txt"));
    expect(controller.setNotice).toHaveBeenCalledWith("版 2 を今の版として戻しました");
  });

  it("deletes an older version after asking (those who may delete for good)", async () => {
    const deleteDriveVersion = vi.fn(async () => undefined);
    const controller = controllerWith({ driveVersions: vi.fn(async () => versions), deleteDriveVersion });
    render(<VersionsDialog controller={controller} item={row("a", "file", "a.txt")} location={{ can_write: true, can_manage: true }} onClose={vi.fn()} onChanged={vi.fn()} />);
    fireEvent.click(await screen.findByRole("button", { name: "版 2 を削除" }));
    const ask = (await screen.findAllByRole("dialog")).at(-1)!;
    expect(ask.textContent).toContain("元に戻せません");
    fireEvent.click(within(ask).getByRole("button", { name: "削除" }));
    await waitFor(() => expect(deleteDriveVersion).toHaveBeenCalledWith("a", "v2"));
  });
});

describe("AdminDriveTab", () => {
  const usage: DriveUsageOut = {
    total: {
      used_bytes: 3 * 1024 ** 3, item_count: 1200, location_count: 2, current_bytes: 2 * 1024 ** 3, old_versions_bytes: 512 * 1024 ** 2, trash_bytes: 512 * 1024 ** 2,
      total_quota_bytes: 150 * 1024 ** 3, user_default_quota_bytes: null, chat_attachments_bytes: 1024 ** 3, chat_attachment_count: 4000,
    },
    locations: [
      { id: "w", kind: "workspace", channel_id: null, user_id: null, name: "研究室ドライブ", archived: false, used_bytes: 2 * 1024 ** 3, item_count: 1000, quota_bytes: null, effective_quota_bytes: null, updated_at: "2026-10-21T00:00:00Z", current_bytes: 1, old_versions_bytes: 0, trash_bytes: 0 },
      { id: "c", kind: "channel", channel_id: "ch", user_id: null, name: "m2-seminar", archived: true, used_bytes: 1024 ** 3, item_count: 200, quota_bytes: 2 * 1024 ** 3, effective_quota_bytes: 2 * 1024 ** 3, updated_at: "2026-10-21T00:00:00Z", current_bytes: 1, old_versions_bytes: 0, trash_bytes: 0 },
    ],
    people: [{ user_id: "u1", bytes: 3 * 1024 ** 3, versions: 1300 }],
  };

  it("shows the totals and each location, and saves a quota in GB", async () => {
    const setDriveQuota = vi.fn(async (id: string, bytes: number | null) => ({ ...usage.locations[0]!, id, quota_bytes: bytes, effective_quota_bytes: bytes }));
    // The share-link section (D4) loads beside the usage; both settle before the field is used (CI 2026-10-22 lost the
    // typed value once while that section was still loading).
    const adminDriveLinks = vi.fn(async () => ({ links: [], next_cursor: null }));
    const adminDriveShareSettings = vi.fn(async () => null);
    const controller = controllerWith({ adminDriveUsage: vi.fn(async () => usage), setDriveQuota, adminDriveLinks, adminDriveShareSettings });
    render(<AdminDriveTab controller={controller} />);
    await screen.findByText("#m2-seminar");
    await waitFor(() => expect(adminDriveLinks).toHaveBeenCalled());
    expect(document.body.textContent).toContain("3.0 GB");
    expect(document.body.textContent).toContain("全体の上限 150 GB");
    expect(document.body.textContent).toContain("アーカイブ済み");
    expect(document.body.textContent).toContain("df");
    expect(screen.getAllByRole("meter").length).toBe(2); // the whole drive and the channel with a quota
    const field = screen.getByRole("textbox", { name: "研究室ドライブ の上限（GB）" });
    fireEvent.change(field, { target: { value: "100" } });
    fireEvent.click(await within(field.closest("form")!).findByRole("button", { name: "保存" }));
    await waitFor(() => expect(setDriveQuota).toHaveBeenCalledWith("w", 100 * 1024 ** 3));
    // Invalid: no save button.
    fireEvent.change(screen.getByRole("textbox", { name: "#m2-seminar の上限（GB）" }), { target: { value: "abc" } });
    const other = screen.getByRole("textbox", { name: "#m2-seminar の上限（GB）" });
    expect(within(other.closest("form")!).queryAllByRole("button", { name: "保存" }).length).toBe(0);
  });
});
