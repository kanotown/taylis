/**
 * M161 (docs/DRIVE.md §17): the drive screen's rules — breadcrumbs, pages, selection, sorting, which viewer opens,
 * the download route and its streaming, folder trees from a drop or an input, and the live signals.
 */
import { describe, expect, it, vi } from "vitest";

import type { DriveItemOut } from "../src/api/types";
import { browserDownload, downloadRoute, pipeToSink, ticketUrl } from "../src/drive/download";
import { appendPage, asAttachment, breadcrumbs, clickAction, clickSelection, documentSource, driveColumns, driveFileOf, driveTime, exactTime, formatBytes, iconKind, isOffice, isPdf, itemTime, locationName, nextSort, orderLocations, pathLine, stepItem, thumbnailPath, viewable, viewerKind } from "../src/drive/listing";
import { dirOf, emptyFolders, foldersOf, treeFromEntries, treeFromInput } from "../src/platform/driveFiles";
import { coalesce, DriveHub, type DriveSignal } from "../src/sync/drive";
import { setLocale } from "../src/i18n";

function item(id: string, extra: Partial<DriveItemOut> = {}): DriveItemOut {
  return {
    id, location_id: "loc", parent_id: "root", kind: "file", name: `${id}.txt`, size_bytes: 10, content_type: "text/plain",
    content_modified_at: null, created_by: null, created_at: "2026-10-01T00:00:00Z", updated_by: null, updated_at: "2026-10-02T00:00:00Z",
    version_count: 1, file: { attachment_id: `a-${id}`, version_id: `v-${id}`, width: null, height: null, has_thumbnail: false, has_poster: false, has_display: false, has_location: false, duration_ms: null, preview: null },
    link_count: 0, posted: false, ...extra,
  };
}

describe("breadcrumbs and paths", () => {
  it("names the root after the location and folds a deep path", () => {
    const path = [{ id: "r", name: "研究室ドライブ" }, { id: "a", name: "ゼミ" }, { id: "b", name: "2026" }, { id: "c", name: "前期" }, { id: "d", name: "発表" }, { id: "e", name: "資料" }];
    expect(breadcrumbs(path.slice(0, 3), "Lab drive")).toEqual({ shown: [{ id: "r", name: "Lab drive" }, path[1], path[2]], hidden: [] });
    const deep = breadcrumbs(path, "研究室ドライブ", 5);
    expect(deep.shown.map((crumb) => crumb.id)).toEqual(["r", "c", "d", "e"]);
    expect(deep.hidden.map((crumb) => crumb.id)).toEqual(["a", "b"]);
    expect(pathLine(path.slice(0, 3), "マイドライブ")).toBe("マイドライブ › ゼミ › 2026");
  });

  it("orders and names the locations", () => {
    setLocale("ja");
    const locations = [
      { kind: "channel", name: "z-lab" }, { kind: "user", name: "マイドライブ" }, { kind: "channel", name: "a-lab" }, { kind: "workspace", name: "研究室ドライブ" },
    ] as unknown as Parameters<typeof orderLocations>[0];
    expect(orderLocations(locations).map(locationName)).toEqual(["研究室ドライブ", "マイドライブ", "#a-lab", "#z-lab"]);
    setLocale("en");
    expect(locationName({ kind: "workspace", name: "研究室ドライブ" })).toBe("Lab drive");
    setLocale("ja");
  });
});

describe("pages, sorting and selection", () => {
  it("appends a page without repeating a row", () => {
    expect(appendPage([item("a"), item("b")], [item("b"), item("c")]).map((row) => row.id)).toEqual(["a", "b", "c"]);
  });

  it("turns the order round on the same column, starts newest first on time", () => {
    expect(nextSort({ sort: "name", order: "asc" }, "name")).toEqual({ sort: "name", order: "desc" });
    expect(nextSort({ sort: "name", order: "asc" }, "modified")).toEqual({ sort: "modified", order: "desc" });
    expect(nextSort({ sort: "size", order: "desc" }, "name")).toEqual({ sort: "name", order: "asc" });
  });

  it("selects alone, toggles with ⌘ / Ctrl, takes a range with Shift", () => {
    const order = ["a", "b", "c", "d", "e"];
    let state = clickSelection(order, new Set(), null, "b", { toggle: false, range: false });
    expect([...state.selected]).toEqual(["b"]);
    state = clickSelection(order, state.selected, state.anchor, "d", { toggle: false, range: true });
    expect([...state.selected].sort()).toEqual(["b", "c", "d"]);
    state = clickSelection(order, state.selected, state.anchor, "c", { toggle: true, range: false });
    expect([...state.selected].sort()).toEqual(["b", "d"]);
    expect(state.anchor).toBe("c");
    state = clickSelection(order, state.selected, state.anchor, "a", { toggle: true, range: true });
    expect([...state.selected].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("shows the file's own time when known", () => {
    expect(itemTime(item("a"))).toBe("2026-10-02T00:00:00Z");
    expect(itemTime(item("a", { content_modified_at: "2025-01-01T00:00:00Z" }))).toBe("2025-01-01T00:00:00Z");
    expect(formatBytes(5 * 1024 ** 3)).toBe("5.0 GB");
    expect(formatBytes(2048)).toBe("2 KB");
  });
});

describe("viewers", () => {
  const photo = item("p", { content_type: "image/png", file: { ...item("p").file!, has_thumbnail: true } });
  const big = item("big", { content_type: "image/png" }); // no thumbnail: too large for the server to read
  const clip = item("v", { content_type: "video/mp4", file: { ...item("v").file!, has_poster: true } });
  const pdf = item("d", { content_type: "application/pdf", file: { ...item("d").file!, preview: { status: "ready", pages: 3, width: 800, height: 1100 } } });
  const docx = item("w", { name: "w.docx", content_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", file: { ...item("w").file!, preview: { status: "pending", pages: null, width: null, height: null } } });
  const huge = item("h", { name: "scan.pdf", content_type: "application/pdf" }); // no preview (past the limit)
  const folder = item("f", { kind: "folder", file: null, content_type: null, size_bytes: null });

  it("opens photos, videos and every PDF / Office file; the rest have no viewer", () => {
    expect([photo, big, clip, pdf, docx, huge, folder, item("t")].map(viewerKind)).toEqual(["image", null, "video", "document", "document", "document", null, null]);
    expect(viewable([folder, photo, item("t"), clip]).map((row) => row.id)).toEqual(["p", "v"]);
    expect(stepItem([photo, clip], "p", 1)?.id).toBe("v");
    expect(stepItem([photo, clip], "p", -1)).toBeNull();
    expect(iconKind(folder)).toBe("folder");
    expect(iconKind(docx)).toBe("document");
    expect(iconKind(item("x", { name: "a.xlsx", content_type: "application/zip" }))).toBe("sheet");
  });

  it("thumbnails come from the attachment routes", () => {
    expect(thumbnailPath(photo)).toBe("/api/v1/attachments/a-p/thumbnail");
    expect(thumbnailPath(clip)).toBe("/api/v1/attachments/a-v/thumbnail");
    expect(thumbnailPath(pdf)).toBe("/api/v1/attachments/a-d/preview/thumbnail");
    expect(thumbnailPath(docx)).toBeNull();
    expect(thumbnailPath(folder)).toBeNull();
  });

  // §27 (2026-10-22): an imported PDF (no preview) downloaded when opened; now it never does.
  it("a document opens from its preview, a PDF without one from its own bytes, an Office file waits or asks", () => {
    const imported = item("i", { name: "論文.pdf", content_type: "application/pdf" });
    const sniffless = item("s", { name: "scan.PDF", content_type: "application/octet-stream" });
    const pdfMaking = item("m", { name: "m.pdf", content_type: "application/pdf", file: { ...item("m").file!, preview: { status: "pending", pages: null, width: null, height: null } } });
    const pdfFailed = item("f", { name: "f.pdf", content_type: "application/pdf", file: { ...item("f").file!, preview: { status: "failed", pages: null, width: null, height: null } } });
    const oldXls = item("x", { name: "名簿.xls", content_type: "application/x-ole-storage" });
    const pptxFailed = item("p", { name: "発表.pptx", content_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", file: { ...item("p").file!, preview: { status: "failed", pages: null, width: null, height: null } } });
    const zip = item("z", { name: "data.zip", content_type: "application/zip" });
    expect([imported, sniffless, pdfMaking, pdfFailed, oldXls, pptxFailed].map(viewerKind)).toEqual(Array(6).fill("document"));
    expect(viewerKind(zip)).toBeNull();
    expect(viewerKind(item("n", { name: "notes.pdf.txt" }))).toBeNull();
    expect([pdf, imported, sniffless, pdfMaking, pdfFailed, huge, docx, oldXls, pptxFailed].map(documentSource)).toEqual(["preview", "original", "original", "original", "original", "original", "making", "ask", "failed"]);
    expect([isPdf(sniffless), isPdf(item("j", { name: "a.pdf", content_type: "image/png" })), isOffice(oldXls), isOffice(zip)]).toEqual([true, false, true, false]);
  });

  it("a plain click opens (a folder, a viewer, else the details); ⌘ / Ctrl / Shift only select; a double click's second click does nothing", () => {
    const keys = { metaKey: false, ctrlKey: false, shiftKey: false };
    expect(clickAction(folder, keys)).toBe("folder");
    expect(clickAction(pdf, keys)).toBe("view");
    expect(clickAction(huge, keys)).toBe("view");
    expect(clickAction(item("t"), keys)).toBe("details");
    expect(clickAction(big, keys)).toBe("details");
    expect(clickAction(folder, { ...keys, metaKey: true })).toBe("select");
    expect(clickAction(pdf, { ...keys, ctrlKey: true })).toBe("select");
    expect(clickAction(item("t"), { ...keys, shiftKey: true })).toBe("select");
    expect(clickAction(folder, { ...keys, detail: 2 })).toBe("none");
  });

  it("the list's columns give way as the listing narrows: who changed it, then the size, then the time", () => {
    expect(driveColumns(1000)).toEqual({ modified: true, by: true, size: true });
    expect(driveColumns(700)).toEqual({ modified: true, by: true, size: true });
    expect(driveColumns(650)).toEqual({ modified: true, by: false, size: true });
    expect(driveColumns(480)).toEqual({ modified: true, by: false, size: false });
    expect(driveColumns(360)).toEqual({ modified: false, by: false, size: false });
  });

  it("a drive file in a viewer is an attachment that downloads the drive's way", () => {
    const attachment = asAttachment(pdf)!;
    expect(attachment).toMatchObject({ id: "a-d", filename: "d.txt", content_type: "application/pdf", preview: { status: "ready" } });
    expect(driveFileOf(attachment)).toEqual({ id: "d", name: "d.txt", size_bytes: 10 });
    expect(driveFileOf({ ...attachment })).toBeNull(); // only the one made here
    expect(asAttachment(folder)).toBeNull();
  });
});

describe("downloads", () => {
  it("the desktop app streams to a file, the browser follows a ticket", () => {
    expect(downloadRoute(true)).toBe("stream-to-file");
    expect(downloadRoute(false)).toBe("browser");
    expect(ticketUrl("", "/api/v1/drive/download/abc")).toBe("/api/v1/drive/download/abc");
    expect(ticketUrl("https://lab.example/", "/api/v1/drive/download/abc")).toBe("https://lab.example/api/v1/drive/download/abc");
  });

  it("the browser's own download is an anchor click on the ticket's URL", () => {
    const clicks: string[] = [];
    const anchor = { href: "", download: "", rel: "", style: { display: "" }, click: () => clicks.push(anchor.href), remove: vi.fn() };
    const doc = { createElement: () => anchor, body: { appendChild: vi.fn() } } as unknown as Pick<Document, "createElement" | "body">;
    browserDownload("/api/v1/drive/download/t", "修論.pdf", doc);
    expect(clicks).toEqual(["/api/v1/drive/download/t"]);
    expect(anchor.download).toBe("修論.pdf");
    expect(anchor.remove).toHaveBeenCalled();
  });

  const body = (chunks: Uint8Array[], failAfter?: number) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        chunks.forEach((chunk, index) => {
          if (failAfter !== undefined && index === failAfter) controller.error(new TypeError("network"));
          else if (failAfter === undefined || index < failAfter) controller.enqueue(chunk);
        });
        if (failAfter === undefined) controller.close();
      },
    });

  it("writes chunk after chunk and reports progress, never holding the whole body", async () => {
    const written: number[] = [];
    const sink = { write: vi.fn(async (chunk: Uint8Array) => { written.push(chunk.byteLength); }), close: vi.fn(async () => undefined), discard: vi.fn(async () => undefined) };
    const progress: number[] = [];
    const total = await pipeToSink(body([new Uint8Array(3), new Uint8Array(0), new Uint8Array(5)]), sink, (loaded) => progress.push(loaded));
    expect(total).toBe(8);
    expect(written).toEqual([3, 5]);
    expect(progress).toEqual([3, 8]);
    expect(sink.close).toHaveBeenCalledTimes(1);
    expect(sink.discard).not.toHaveBeenCalled();
  });

  it("a broken download removes the half-written file", async () => {
    const sink = { write: vi.fn(async () => undefined), close: vi.fn(async () => undefined), discard: vi.fn(async () => undefined) };
    await expect(pipeToSink(body([new Uint8Array(3), new Uint8Array(3)], 1), sink, () => undefined)).rejects.toThrow("network");
    expect(sink.discard).toHaveBeenCalledTimes(1);
    expect(sink.close).not.toHaveBeenCalled();
  });
});

describe("folder trees", () => {
  it("knows the folders of a tree and which are empty", () => {
    expect(dirOf("A/b/c.txt")).toBe("A/b");
    expect(dirOf("c.txt")).toBe("");
    expect(foldersOf(["A/b/c", "A/d"])).toEqual(["A", "A/b", "A/d", "A/b/c"]);
    expect(emptyFolders(["A", "A/b", "A/empty", "A/b/c", "A/b/c/deeper"], [{ relativeDir: "A/b/c" }])).toEqual(["A/empty", "A/b/c/deeper"]);
  });

  it("an input with webkitdirectory gives each file its folders", () => {
    const file = (name: string, path: string) => Object.assign(new File(["x"], name, { lastModified: 5 }), { webkitRelativePath: path });
    const tree = treeFromInput([file("a.pdf", "Seminar/2026/a.pdf"), file("b.pdf", "Seminar/b.pdf")]);
    expect(tree.files.map((source) => [source.name, source.relativeDir, source.size, source.lastModified])).toEqual([["a.pdf", "Seminar/2026", 1, 5], ["b.pdf", "Seminar", 1, 5]]);
  });

  it("a dropped folder is walked, empty folders included, readEntries read to its end", async () => {
    const fileEntry = (path: string) => ({ isFile: true, isDirectory: false, name: path.split("/").pop()!, fullPath: `/${path}`, file: (ok: (file: File) => void) => ok(new File(["abc"], path.split("/").pop()!)) });
    const dirEntry = (path: string, children: unknown[]) => ({
      isFile: false, isDirectory: true, name: path.split("/").pop()!, fullPath: `/${path}`,
      // Two batches, then an empty one (Chrome gives 100 at a time).
      createReader: () => {
        const batches = [children.slice(0, 1), children.slice(1), []];
        let next = 0;
        return { readEntries: (ok: (entries: unknown[]) => void) => ok(batches[Math.min(next++, 2)]!) };
      },
    });
    const tree = await treeFromEntries([
      dirEntry("Lab", [fileEntry("Lab/x.txt"), dirEntry("Lab/sub", [fileEntry("Lab/sub/y.txt")]), dirEntry("Lab/empty", [])]) as never,
      fileEntry("top.txt") as never,
    ]);
    expect(tree.files.map((source) => `${source.relativeDir}|${source.name}`).sort()).toEqual(["Lab/sub|y.txt", "Lab|x.txt", "|top.txt"]);
    expect(tree.folders.sort()).toEqual(["Lab", "Lab/empty", "Lab/sub"]);
    expect(emptyFolders(tree.folders, tree.files)).toEqual(["Lab/empty"]);
    expect(new TextDecoder().decode(await tree.files.find((source) => source.name === "x.txt")!.read(1, 3))).toBe("bc");
  });
});

describe("live signals", () => {
  it("drops a repeated or older drive.changed, passes the rest", () => {
    const hub = new DriveHub();
    const seen: DriveSignal[] = [];
    hub.subscribe((signal) => seen.push(signal));
    hub.applyEvent("drive.changed", { location_id: "L", folder_ids: ["f"], seq: 5 });
    hub.applyEvent("drive.changed", { location_id: "L", folder_ids: ["f"], seq: 5 });
    hub.applyEvent("drive.changed", { location_id: "L", folder_ids: ["g"], seq: 4 });
    hub.applyEvent("drive.changed", { location_id: "M", folder_ids: ["h"], seq: 1 });
    hub.applyEvent("drive.upload.updated", { upload: { id: "u" } });
    hub.online();
    hub.accessMayHaveChanged();
    expect(seen.map((signal) => signal.kind)).toEqual(["changed", "changed", "upload", "resync", "locations"]);
    expect(seen[1]).toEqual({ kind: "changed", locationId: "M", folderIds: ["h"] });
  });

  it("reads once for several signals within 300 ms", () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn();
      const { poke, cancel } = coalesce(run, 300);
      poke();
      poke();
      vi.advanceTimersByTime(299);
      expect(run).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(run).toHaveBeenCalledTimes(1);
      poke();
      cancel();
      vi.advanceTimersByTime(500);
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("times (§27)", () => {
  it("reads recent times relatively and older ones as a day; the tooltip has the exact time", () => {
    setLocale("ja");
    const now = new Date(2026, 9, 22, 15, 0);
    const at = (d: Date) => d.toISOString();
    expect(driveTime(at(new Date(2026, 9, 22, 14, 59, 40)), now)).toBe("たった今");
    expect(driveTime(at(new Date(2026, 9, 22, 14, 57)), now)).toBe("3 分前");
    expect(driveTime(at(new Date(2026, 9, 22, 10, 0)), now)).toBe("5 時間前");
    expect(driveTime(at(new Date(2026, 9, 21, 14, 5)), now)).toBe("昨日 14:05");
    expect(driveTime(at(new Date(2026, 9, 3, 9, 0)), now)).toMatch(/^10月3日/);
    expect(driveTime(at(new Date(2025, 9, 3, 9, 0)), now)).toMatch(/^2025年10月3日/);
    expect(exactTime(at(new Date(2026, 9, 22, 14, 5)))).toMatch(/^2026年10月22日.* 14:05$/);
  });
});
