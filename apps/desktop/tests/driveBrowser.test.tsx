// @vitest-environment jsdom
/**
 * M161 (docs/DRIVE.md §17.2): a location's listing on screen — the breadcrumbs named after the location, the rows of a
 * folder read by cursor as the end comes into view, a click into a folder, sorting by a column, and the trash.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DriveChildrenOut, DriveItemOut, DriveLocationOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { DriveBrowser } from "../src/ui/DriveBrowser";
import { DriveHub } from "../src/sync/drive";

const LOCATION: DriveLocationOut = {
  id: "loc", kind: "workspace", channel_id: null, user_id: null, root_id: "root", name: "研究室ドライブ",
  can_write: true, can_manage: true, can_share: false, external_links: true, quota_bytes: null, used_bytes: 0, item_count: 0,
};

function row(id: string, kind: "file" | "folder", name: string): DriveItemOut {
  return {
    id, location_id: "loc", parent_id: "root", kind, name, size_bytes: kind === "file" ? 2048 : null, content_type: kind === "file" ? "text/plain" : null,
    content_modified_at: null, created_by: "u1", created_at: "2026-10-01T00:00:00Z", updated_by: "u1", updated_at: "2026-10-01T09:30:00Z",
    version_count: kind === "file" ? 1 : 0, file: null, link_count: 0, posted: false,
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
    const first: DriveChildrenOut = { folder: ROOT, path: [{ id: "root", name: "研究室ドライブ" }], items: [FOLDER, row("a", "file", "a.txt")], next_cursor: "c1", shared_above: 0 };
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
    // §27: a single click opens the folder; the second click of a double click does nothing more.
    fireEvent.click(document.querySelector('[data-drive-item="f1"]')!, { detail: 1 });
    expect(onFolder).toHaveBeenCalledWith("f1");
    fireEvent.click(document.querySelector('[data-drive-item="a"]')!, { detail: 2 });
    expect(onFolder).toHaveBeenCalledTimes(1);
  });

  it("sorts by a column: the server is asked again, newest first for the time", async () => {
    const driveChildren = vi.fn(async () => ({ folder: ROOT, path: [{ id: "root", name: "研究室ドライブ" }], items: [row("a", "file", "a.txt")], next_cursor: null }));
    render(<DriveBrowser controller={controllerWith({ driveChildren, searchDrive: vi.fn() })} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle("a.txt");
    const header = screen.getAllByRole("columnheader").find((cell) => cell.textContent?.includes("更新日時"))!;
    fireEvent.click(within(header).getByRole("button"));
    await waitFor(() => expect(driveChildren).toHaveBeenLastCalledWith("root", expect.objectContaining({ sort: "modified", order: "desc" })));
  });

  it("the drop frame covers the list from outside the scrolling element (it stays put however far the list is scrolled)", async () => {
    const driveChildren = vi.fn(async () => ({ folder: ROOT, path: [{ id: "root", name: "研究室ドライブ" }], items: [row("a", "file", "a.txt")], next_cursor: null }));
    render(<DriveBrowser controller={controllerWith({ driveChildren, searchDrive: vi.fn() })} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle("a.txt");
    const list = document.querySelector('[data-drop-zone="drive"]') as HTMLElement;
    expect(list.className).toContain("overflow-y-auto");
    const dataTransfer = { types: ["Files"], files: [], dropEffect: "none" };
    fireEvent.dragEnter(list, { dataTransfer });
    const overlay = document.querySelector("[data-drop-overlay]") as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(list.contains(overlay)).toBe(false);
    expect(overlay.parentElement!.contains(list)).toBe(true);
    expect(overlay.parentElement!.className).toContain("relative");
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

// --- §27 (2026-10-22): a click opens, nothing downloads by itself, the columns give way -----------------------------

// PDF.js does not run in jsdom: the viewer's loader hands back a document of one page that draws nothing.
const pdf = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../src/ui/pdfLoader", () => ({ openPdf: (data: ArrayBuffer) => pdf.open(data) }));

const PENDING = { status: "pending" as const, pages: null, width: null, height: null };
const READY = { status: "ready" as const, pages: 1, width: 800, height: 1100 };

function file(id: string, name: string, contentType: string, preview: NonNullable<DriveItemOut["file"]>["preview"] = null): DriveItemOut {
  return {
    ...row(id, "file", name), content_type: contentType,
    file: { attachment_id: `a-${id}`, version_id: `v-${id}`, width: null, height: null, has_thumbnail: false, has_poster: false, has_display: false, has_location: false, duration_ms: null, preview },
  };
}

describe("a click on a file (§27)", () => {
  const imported = file("p", "論文.pdf", "application/pdf");
  const word = file("w", "議事録.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  const text = file("t", "メモ.txt", "text/plain");
  const listing = (items: DriveItemOut[]) => vi.fn(async () => ({ folder: ROOT, path: [{ id: "root", name: "研究室ドライブ" }], items, next_cursor: null, shared_above: 0 }));

  beforeEach(() => {
    const page = { getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }), render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }) };
    pdf.open.mockReset().mockResolvedValue({ numPages: 1, getPage: async () => page, loadingTask: { destroy: vi.fn() } });
  });

  it("opens an imported PDF (no preview) from its own bytes in the viewer, never as a download", async () => {
    const fetchBlob = vi.fn(async () => new Blob(["%PDF-1.7"]));
    const requestDrivePreview = vi.fn(async () => ({ preview: PENDING }));
    const controller = controllerWith({ driveChildren: listing([imported, text]), searchDrive: vi.fn(), fetchBlob, requestDrivePreview });
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle("論文.pdf");
    fireEvent.click(document.querySelector('[data-drive-item="p"]')!, { detail: 1 });
    await waitFor(() => expect(document.querySelectorAll("[data-pdf-page]")).toHaveLength(1));
    expect(fetchBlob).toHaveBeenCalledWith("/api/v1/drive/items/p/content", undefined, expect.any(Number)); // a byte limit (2026-11-16)
    expect(requestDrivePreview).toHaveBeenCalledWith("p"); // its thumbnail is made meanwhile
    expect(controller.downloadDriveFile).not.toHaveBeenCalled();
  });

  it("an Office file without a preview asks for it, shows 「プレビューを作成中…」 and opens when drive.changed says it is ready", async () => {
    const hub = new DriveHub();
    const fetchBlob = vi.fn(async () => new Blob(["%PDF-1.7"]));
    const requestDrivePreview = vi.fn(async () => ({ preview: PENDING }));
    const driveItem = vi.fn(async () => ({ item: { ...word, file: { ...word.file!, preview: READY } }, path: [], location_kind: "workspace" }));
    const controller = { ...controllerWith({ driveChildren: listing([word]), searchDrive: vi.fn(), fetchBlob, requestDrivePreview, driveItem }), engine: { drive: hub } } as unknown as AppController;
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle("議事録.docx");
    fireEvent.click(document.querySelector('[data-drive-item="w"]')!, { detail: 1 });
    await waitFor(() => expect(requestDrivePreview).toHaveBeenCalledWith("w"));
    expect((await screen.findByText("プレビューを作成中…")).closest("[data-pdf-hold]")).toBeTruthy();
    expect(fetchBlob).not.toHaveBeenCalled();
    hub.applyEvent("drive.changed", { location_id: "loc", folder_ids: ["root"], seq: 1 });
    await waitFor(() => expect(document.querySelectorAll("[data-pdf-page]")).toHaveLength(1));
    expect(fetchBlob).toHaveBeenCalledWith("/api/v1/attachments/a-w/preview/pdf", undefined, expect.any(Number));
    expect(controller.downloadDriveFile).not.toHaveBeenCalled();
  });

  it("an Office file that gets no preview says so and offers the download (only that button downloads)", async () => {
    const requestDrivePreview = vi.fn(async () => ({ preview: null }));
    const downloadAttachment = vi.fn();
    const controller = { ...controllerWith({ driveChildren: listing([word]), searchDrive: vi.fn(), fetchBlob: vi.fn(), requestDrivePreview }), downloadAttachment } as unknown as AppController;
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle("議事録.docx");
    fireEvent.click(document.querySelector('[data-drive-item="w"]')!, { detail: 1 });
    await screen.findByText("このファイルはプレビューできません");
    expect(downloadAttachment).not.toHaveBeenCalled();
    fireEvent.click(within(document.querySelector("[data-pdf-hold]") as HTMLElement).getByRole("button", { name: "ダウンロード" }));
    expect(downloadAttachment).toHaveBeenCalledTimes(1);
  });

  it("a file no viewer shows opens its details; ⌘-click and the check box only select", async () => {
    const fetchBlob = vi.fn(async () => new Blob());
    const controller = controllerWith({ driveChildren: listing([imported, text]), searchDrive: vi.fn(), fetchBlob, requestDrivePreview: vi.fn() });
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle("メモ.txt");
    fireEvent.click(document.querySelector('[data-drive-item="t"]')!, { detail: 1 });
    const details = await screen.findByRole("complementary", { name: "詳細" });
    expect(details.textContent).toContain("メモ.txt");
    expect(controller.downloadDriveFile).not.toHaveBeenCalled();
    // ⌘-click: selected, not opened.
    fireEvent.click(document.querySelector('[data-drive-item="p"]')!, { detail: 1, metaKey: true });
    expect(document.querySelector('[data-drive-item="p"]')!.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('[data-drive-item="t"]')!.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
    // The check box takes one out again, without opening it.
    fireEvent.click(screen.getByRole("checkbox", { name: "論文.pdf を選ぶ" }));
    expect(document.querySelector('[data-drive-item="p"]')!.getAttribute("aria-selected")).toBe("false");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchBlob).not.toHaveBeenCalled();
  });

  it("rows look clickable and the list's columns give way to the names as the listing narrows", async () => {
    let width = 1200;
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { callbacks.push(callback); }
      observe() {}
      disconnect() {}
    });
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
    render(<DriveBrowser controller={controllerWith({ driveChildren: listing([text]), searchDrive: vi.fn() })} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle("メモ.txt");
    const table = () => document.querySelector("table")!;
    expect(table().dataset["driveColumns"]).toBe("modified by size");
    expect(document.querySelector('[data-drive-item="t"]')!.className).toContain("cursor-pointer");
    const headers = () => screen.getAllByRole("columnheader").map((cell) => cell.textContent);
    width = 600;
    act(() => callbacks.forEach((callback) => callback()));
    expect(table().dataset["driveColumns"]).toBe("modified size");
    expect(headers()).not.toContain("更新した人");
    width = 400;
    act(() => callbacks.forEach((callback) => callback()));
    expect(table().dataset["driveColumns"]).toBe("");
    expect(document.querySelector('[data-drive-item="t"]')!.querySelectorAll("td")).toHaveLength(3); // check box, name, ⋯
    rect.mockRestore();
  });
});

describe("the selection bar, the row actions and the locations column (§27)", () => {
  const listing = (items: DriveItemOut[]) => vi.fn(async () => ({ folder: ROOT, path: [{ id: "root", name: "研究室ドライブ" }], items, next_cursor: null, shared_above: 0 }));

  it("a selection shows a bar with its count and actions; Esc clears it without leaving the screen", async () => {
    const a = file("a", "a.pdf", "application/pdf");
    const b = file("b", "b.txt", "text/plain");
    const controller = { ...controllerWith({ driveChildren: listing([FOLDER, a, b]), searchDrive: vi.fn() }), downloadDriveZip: vi.fn() } as unknown as AppController;
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle("b.txt");
    expect(document.querySelector("[data-drive-selection-bar]")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "a.pdf を選ぶ" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "ゼミ資料 を選ぶ" }));
    const bar = document.querySelector("[data-drive-selection-bar]") as HTMLElement;
    expect(bar.textContent).toContain("2 件を選択中");
    fireEvent.click(within(bar).getByRole("button", { name: /ZIP でダウンロード/ }));
    expect(controller.downloadDriveZip).toHaveBeenCalledWith(["f1", "a"]);
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "Escape" });
    window.removeEventListener("keydown", outer);
    expect(document.querySelector("[data-drive-selection-bar]")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it("§27.7: the header box selects every loaded row or none, a dash when some; Shift on the boxes checks or clears a run; ⌘A from a box", async () => {
    const rows = [FOLDER, file("a", "a.pdf", "application/pdf"), file("b", "b.txt", "text/plain"), file("c", "c.txt", "text/plain"), file("d", "d.txt", "text/plain")];
    const onFolder = vi.fn();
    const controller = controllerWith({ driveChildren: listing(rows), searchDrive: vi.fn() });
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={onFolder} />);
    await screen.findByTitle("d.txt");
    const all = document.querySelector<HTMLInputElement>("[data-drive-check-all]")!;
    const box = (name: string) => screen.getByRole("checkbox", { name: `${name} を選ぶ` }) as HTMLInputElement;
    const picked = () => [...document.querySelectorAll("[data-drive-item][aria-selected=true]")].map((el) => el.getAttribute("data-drive-item"));
    expect(all.getAttribute("data-drive-check-all")).toBe("none");
    expect(all.getAttribute("aria-label")).toBe("すべて選択");
    fireEvent.click(all);
    expect(picked()).toEqual(["f1", "a", "b", "c", "d"]);
    expect(all.checked).toBe(true);
    expect(all.getAttribute("aria-label")).toBe("選択を解除");
    fireEvent.click(all);
    expect(picked()).toEqual([]);
    // One row: the header shows a dash.
    fireEvent.click(box("a.pdf"));
    expect(all.getAttribute("data-drive-check-all")).toBe("some");
    expect(all.indeterminate).toBe(true);
    // Shift on a box: the run from the last box pressed takes its state.
    fireEvent.click(box("d.txt"), { shiftKey: true });
    expect(picked()).toEqual(["a", "b", "c", "d"]);
    fireEvent.click(box("c.txt")); // cleared: the anchor now off
    fireEvent.click(box("a.pdf"), { shiftKey: true });
    expect(picked()).toEqual(["d"]);
    // A dash pressed selects all.
    fireEvent.click(all);
    expect(picked()).toEqual(["f1", "a", "b", "c", "d"]);
    fireEvent.click(all);
    // ⌘A with the focus on a box (it is an input, but not a text field).
    box("b.txt").focus();
    fireEvent.keyDown(box("b.txt"), { key: "a", metaKey: true });
    expect(picked()).toEqual(["f1", "a", "b", "c", "d"]);
    expect(onFolder).not.toHaveBeenCalled(); // nothing opened on the way
    // A plain click on a row still opens it.
    fireEvent.click(document.querySelector('[data-drive-item="f1"]')!);
    expect(onFolder).toHaveBeenCalledWith("f1");
  });

  it("a row's download button downloads that file only (the row does not open)", async () => {
    const a = file("a", "a.pdf", "application/pdf");
    const fetchBlob = vi.fn();
    const controller = controllerWith({ driveChildren: listing([a]), searchDrive: vi.fn(), fetchBlob });
    render(<DriveBrowser controller={controller} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle("a.pdf");
    fireEvent.click(document.querySelector('[data-drive-item="a"] [data-drive-row-download]')!);
    expect(controller.downloadDriveFile).toHaveBeenCalledWith(a);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchBlob).not.toHaveBeenCalled();
    expect(document.querySelector('[data-drive-item="a"] [data-drive-icon]')!.getAttribute("data-drive-icon")).toBe("pdf");
  });
});

describe("the pickers' columns (2026-10-31, §27.8)", () => {
  it("give both columns one height, so the rows fill their box (no band under the list beside a long locations column)", async () => {
    const { DIALOG_COLUMNS, DIALOG_LIST } = await import("../src/ui/DriveDialogs");
    const columns = DIALOG_COLUMNS.split(" ");
    const list = DIALOG_LIST.split(" ");
    expect(columns).toContain("sm:h-80");
    expect(list).toEqual(expect.arrayContaining(["flex-1", "min-h-0", "overflow-y-auto"]));
    // A fixed height only where the columns stack (a phone).
    expect(list.filter((name) => /^h-/.test(name))).toEqual([]);
    expect(list).toContain("max-sm:h-72");
  });
});

describe("the list's column widths (§27.9)", () => {
  const long = file("l", "研究報告書_最終版_修正済み_2026年度_提出用_とても長い名前のファイル.pdf", "application/pdf");
  const listing = () => vi.fn(async () => ({ folder: ROOT, path: [{ id: "root", name: "研究室ドライブ" }], items: [long], next_cursor: null, shared_above: 0 }));

  /** The listing measured `width` px wide (ResizeObserver and getBoundingClientRect stand in for layout). */
  function measuredAt(width: number) {
    const callbacks: Array<() => void> = [];
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { callbacks.push(callback); }
      observe() {}
      disconnect() {}
    });
    let current = width;
    const rect = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: current, height: 600, top: 0, left: 0, right: current, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect);
    return {
      resize: (next: number) => {
        current = next;
        act(() => callbacks.forEach((callback) => callback()));
      },
      restore: () => rect.mockRestore(),
    };
  }

  const handle = (name: string) => screen.getByRole("separator", { name });
  const headerWidth = (name: string) => (handle(name).closest("th") as HTMLElement).style.width;
  const handleNames = () => screen.getAllByRole("separator").map((element) => element.getAttribute("aria-label"));

  afterEach(() => localStorage.clear());

  it("a handle between the columns drags the one on its right; the name keeps the rest; no sort; kept on this device", async () => {
    const layout = measuredAt(1000);
    const driveChildren = listing();
    const { unmount } = render(<DriveBrowser controller={controllerWith({ driveChildren, searchDrive: vi.fn() })} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle(long.name);
    // The whole name on hover, however it is shortened.
    expect(document.querySelector('[data-drive-item="l"] [data-file-name]')!.getAttribute("title")).toBe(long.name);
    // One handle per boundary from the name to the size: name|modified, modified|by, by|size.
    expect(handleNames()).toEqual(["更新日時の幅", "更新した人の幅", "大きさの幅"]);
    const modified = handle("更新日時の幅");
    expect(modified.getAttribute("aria-orientation")).toBe("vertical");
    expect(modified.tabIndex).toBe(0);
    expect(headerWidth("更新日時の幅")).toBe("144px");
    expect(modified.getAttribute("aria-valuenow")).toBe("144");
    expect(modified.getAttribute("aria-valuemin")).toBe("72");
    expect(modified.getAttribute("aria-valuemax")).toBe("320");

    // Dragged left 60 px: the date column 60 px wider (the name narrower); far left: its maximum.
    fireEvent.pointerDown(modified, { pointerId: 1, button: 0, clientX: 500 });
    expect(modified.hasAttribute("data-dragging")).toBe(true);
    fireEvent.pointerMove(modified, { pointerId: 1, clientX: 440 });
    expect(headerWidth("更新日時の幅")).toBe("204px");
    fireEvent.pointerMove(modified, { pointerId: 1, clientX: -2000 });
    expect(headerWidth("更新日時の幅")).toBe("320px");
    // Another pointer does not move it.
    fireEvent.pointerMove(modified, { pointerId: 2, clientX: 600 });
    expect(headerWidth("更新日時の幅")).toBe("320px");
    fireEvent.pointerUp(modified, { pointerId: 1, clientX: -2000 });
    fireEvent.click(modified);
    expect(modified.hasAttribute("data-dragging")).toBe(false);
    expect(JSON.parse(localStorage.getItem("chikuwa.prefs.driveColumns")!)).toEqual({ modified: 320 });
    // Not a sort: the listing was read once, by name.
    expect(driveChildren).toHaveBeenCalledTimes(1);
    expect(handle("更新日時の幅").closest("th")!.getAttribute("aria-sort")).toBeNull();

    // Dragged right: narrower, down to its minimum (the name gets the room).
    fireEvent.pointerDown(handle("大きさの幅"), { pointerId: 3, button: 0, clientX: 800 });
    fireEvent.pointerMove(handle("大きさの幅"), { pointerId: 3, clientX: 900 });
    fireEvent.pointerUp(handle("大きさの幅"), { pointerId: 3, clientX: 900 });
    expect(headerWidth("大きさの幅")).toBe("56px");

    // The next listing (any location's) opens with the same widths.
    unmount();
    render(<DriveBrowser controller={controllerWith({ driveChildren: listing(), searchDrive: vi.fn() })} location={{ ...LOCATION, id: "mine", kind: "user" }} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle(long.name);
    expect(headerWidth("更新日時の幅")).toBe("320px");
    expect(headerWidth("大きさの幅")).toBe("56px");
    // A double click puts the default width back (and forgets it).
    fireEvent.doubleClick(handle("更新日時の幅"));
    expect(headerWidth("更新日時の幅")).toBe("144px");
    expect(JSON.parse(localStorage.getItem("chikuwa.prefs.driveColumns")!)).toEqual({ size: 56 });
    layout.restore();
  });

  it("the keyboard moves a focused handle by 16 px within its limits, without reaching the list's keys", async () => {
    const layout = measuredAt(1000);
    render(<DriveBrowser controller={controllerWith({ driveChildren: listing(), searchDrive: vi.fn() })} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle(long.name);
    const size = handle("大きさの幅");
    size.focus();
    expect(document.activeElement).toBe(size);
    const outer = vi.fn();
    window.addEventListener("keydown", outer);
    fireEvent.keyDown(size, { key: "ArrowLeft" });
    expect(size.getAttribute("aria-valuenow")).toBe("96");
    expect(headerWidth("大きさの幅")).toBe("96px");
    fireEvent.keyDown(size, { key: "ArrowRight" });
    fireEvent.keyDown(size, { key: "ArrowRight" });
    fireEvent.keyDown(size, { key: "ArrowRight" });
    expect(size.getAttribute("aria-valuenow")).toBe("56");
    expect(JSON.parse(localStorage.getItem("chikuwa.prefs.driveColumns")!)).toEqual({ size: 56 });
    expect(outer).not.toHaveBeenCalled();
    window.removeEventListener("keydown", outer);
    layout.restore();
  });

  it("the name keeps its minimum: a drag stops there, and a widened column hides before squeezing it", async () => {
    const layout = measuredAt(700);
    render(<DriveBrowser controller={controllerWith({ driveChildren: listing(), searchDrive: vi.fn() })} location={LOCATION} folderId="root" onFolder={vi.fn()} />);
    await screen.findByTitle(long.name);
    const table = () => document.querySelector("table")!;
    expect(table().dataset["driveColumns"]).toBe("modified by size");
    // 700 px: check box 40, date 144, by 128, size 80, actions 104 → the name has 204, so the date may grow by 4.
    const modified = handle("更新日時の幅");
    expect(modified.getAttribute("aria-valuemax")).toBe("148");
    fireEvent.pointerDown(modified, { pointerId: 1, button: 0, clientX: 300 });
    fireEvent.pointerMove(modified, { pointerId: 1, clientX: 100 });
    expect(table().dataset["driveColumns"]).toBe("modified by size");
    fireEvent.pointerUp(modified, { pointerId: 1, clientX: 100 });
    expect(headerWidth("更新日時の幅")).toBe("148px");
    // Widened further in a wider window, the date column makes who changed it give way sooner when it narrows again.
    layout.resize(1000);
    fireEvent.keyDown(handle("更新日時の幅"), { key: "ArrowLeft" });
    expect(headerWidth("更新日時の幅")).toBe("164px");
    layout.resize(700);
    expect(table().dataset["driveColumns"]).toBe("modified size");
    expect(handleNames()).toEqual(["更新日時の幅", "大きさの幅"]);
    layout.restore();
  });
});
