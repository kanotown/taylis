// @vitest-environment jsdom
/**
 * Downloads (docs/PREVIEWS.md §9): where the desktop app saves, the names it picks, the toast and its buttons. Since
 * 2026-11-16 (a hostile-server review): 「開く」 only for an allowlist of kinds (the capability's scope too), the mark
 * of the internet on every saved file, no format characters in a saved name, and a page's file chip names its file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { AttachmentOut } from "../src/api/types";
import { canOpenDownloaded, freePath, OPENABLE_EXTENSIONS, openableScopePattern, releasePath, numberedName, readAskDownloadLocation, safeFileName, saveDownload, writeAskDownloadLocation } from "../src/platform/download";
import { AppController, type DownloadItem } from "../src/state/app";
import { FileLinkChip } from "../src/ui/PageLinkChip";
import { DOWNLOAD_TOAST_MS, DownloadToasts } from "../src/ui/Toast";
import { DownloadLocationCard } from "../src/ui/Settings";

// The Tauri side, faked: a Downloads folder holding a few names, the save dialog, the opener.
const disk = new Set<string>();
const written: Array<{ path: string; size: number; options: unknown }> = [];
const save = vi.fn<(options: unknown) => Promise<string | null>>();
const revealItemInDir = vi.fn(async (_path: string) => {});
const openPath = vi.fn(async (_path: string) => {});
vi.mock("@tauri-apps/api/path", () => ({
  downloadDir: async () => "/Users/me/Downloads",
  join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: async (path: string) => disk.has(path),
  writeFile: async (path: string, data: Uint8Array, options?: { createNew?: boolean }) => {
    if (options?.createNew && disk.has(path)) throw new Error("exists");
    disk.add(path);
    written.push({ path, size: data.byteLength, options });
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (options: unknown) => save(options) }));
vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (path: string) => revealItemInDir(path),
  openPath: (path: string) => openPath(path),
}));
// The Rust side's mark of the internet (src-tauri/src/downloads.rs).
const invoke = vi.fn(async (_command: string, _args?: unknown): Promise<unknown> => null);
vi.mock("@tauri-apps/api/core", () => ({ invoke: (command: string, args?: unknown) => invoke(command, args) }));

const inTauri = () => Object.assign(window, { __TAURI_INTERNALS__: {} });
const inBrowser = () => { delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; };

const pdf: AttachmentOut = {
  id: "a1", filename: "報告書.pdf", content_type: "application/pdf", size_bytes: 3 * 1024 * 1024, has_thumbnail: false, has_poster: false, has_display: false,
  duration_ms: null, status: "attached", created_at: "", width: null, height: null,
};

beforeEach(() => {
  disk.clear();
  written.length = 0;
  save.mockReset();
  revealItemInDir.mockClear();
  openPath.mockClear();
  invoke.mockClear();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  inBrowser();
  vi.useRealTimers();
});

describe("names", () => {
  it("numbers a taken name before its extension, as Finder and Explorer do", () => {
    expect(numberedName("report.pdf", 0)).toBe("report.pdf");
    expect(numberedName("report.pdf", 1)).toBe("report (1).pdf");
    expect(numberedName("archive.tar.gz", 2)).toBe("archive.tar (2).gz");
    expect(numberedName("README", 3)).toBe("README (3)");
    expect(numberedName(".env", 1)).toBe(".env (1)");
  });

  it("never trusts the uploader's name as a path", () => {
    expect(safeFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(safeFileName("a:b*c?.txt")).toBe("a_b_c_.txt");
    expect(safeFileName(".hidden")).toBe("hidden");
    expect(safeFileName("name. ")).toBe("name");
    expect(safeFileName("CON.txt")).toBe("_CON.txt");
    expect(safeFileName("")).toBe("download");
    const long = safeFileName(`${"あ".repeat(300)}.pdf`);
    expect(long).toHaveLength(200);
    expect(long.endsWith(".pdf")).toBe(true);
  });

  it("finds the first free name in the folder", async () => {
    const taken = new Set(["/d/a.pdf", "/d/a (1).pdf"]);
    const path = await freePath("/d", "a.pdf", async (p) => taken.has(p), async (...parts) => parts.join("/"));
    expect(path).toBe("/d/a (2).pdf");
  });

  it("holds a found name until it is written, so two downloads at once get different names", async () => {
    const join = async (...parts: string[]) => parts.join("/");
    const [a, b] = await Promise.all([freePath("/e", "x.txt", async () => false, join), freePath("/e", "x.txt", async () => false, join)]);
    expect([a, b].sort()).toEqual(["/e/x (1).txt", "/e/x.txt"]);
    releasePath(a);
    expect(await freePath("/e", "x.txt", async () => false, join)).toBe("/e/x.txt");
  });

  it("opens documents and pictures but never a program or a script", () => {
    expect(canOpenDownloaded("/Users/me/Downloads/報告書.pdf")).toBe(true);
    expect(canOpenDownloaded("C:\\Users\\me\\Downloads\\photo.JPG")).toBe(true);
    for (const name of ["setup.exe", "run.BAT", "x.command", "x.sh", "App.app", "x.ps1", "noextension"]) expect(canOpenDownloaded(`/d/${name}`)).toBe(false);
  });

  it("opens only the allowlisted kinds (2026-11-16): whatever else a server names is only revealed", () => {
    for (const name of ["a.pdf", "a.DOCX", "a.xlsx", "a.pptx", "a.odt", "a.txt", "a.csv", "a.md", "a.json", "a.png", "a.HEIC", "a.mp3", "a.m4a", "a.mp4", "a.MOV", "a.zip", "a.7z", "a.tar", "a.gz", "a.tgz", "報告書 (1).pdf"]) {
      expect(canOpenDownloaded(`C:\\Users\\me\\Downloads\\${name}`), name).toBe(true);
    }
    // Windows runs or trusts these by their extension; a browser opens web pages with a local file's rights.
    for (const name of ["a.hta", "a.chm", "a.scf", "a.library-ms", "a.settingcontent-ms", "a.url", "a.lnk", "a.msix", "a.appx", "a.iso", "a.img", "a.vhd", "a.html", "a.htm", "a.svg", "a.xml", "a.docm", "a.xlsm", "a.pdf.exe", "a.jse", "a.wsf", "a.pif", "a.cpl", ".pdf", "pdf"]) {
      expect(canOpenDownloaded(`C:\\Users\\me\\Downloads\\${name}`), name).toBe(false);
    }
  });

  it("the opener's scope in the capability is the same allowlist, in any case (a script cannot open more)", () => {
    const capability = JSON.parse(readFileSync(join(process.cwd(), "src-tauri", "capabilities", "default.json"), "utf8")) as { permissions: Array<string | { identifier: string; allow?: Array<{ path?: string }>; deny?: unknown }> };
    const opener = capability.permissions.find((p) => typeof p === "object" && p.identifier === "opener:allow-open-path") as { allow: Array<{ path: string }>; deny?: unknown };
    expect(opener.allow.map((entry) => entry.path)).toEqual(OPENABLE_EXTENSIONS.map(openableScopePattern));
    expect(opener.deny).toBeUndefined();
    expect(openableScopePattern("pdf")).toBe("$DOWNLOAD/**/*.[pP][dD][fF]");
    expect(openableScopePattern("7z")).toBe("$DOWNLOAD/**/*.7[zZ]");
    // Nothing broader than Downloads' allowlisted files.
    expect(capability.permissions.filter((p) => typeof p === "object" && p.identifier.startsWith("opener:allow-open-path"))).toHaveLength(1);
  });

  it("drops Unicode format characters: a right-to-left override cannot make a program look like a PDF", () => {
    expect(safeFileName("report\u202Efdp.exe")).toBe("reportfdp.exe");
    expect(safeFileName("in\u2066voice\u2069.pdf")).toBe("invoice.pdf");
    expect(safeFileName("\uFEFFa\u200Bb\u200E\u200F.txt")).toBe("ab.txt");
    expect(safeFileName("\u202E")).toBe("download");
    expect(safeFileName("写真 2026.jpg")).toBe("写真 2026.jpg");
  });
});

describe("saveDownload", () => {
  it("desktop app: straight into Downloads under a free name, never over a file", async () => {
    inTauri();
    disk.add("/Users/me/Downloads/報告書.pdf");
    const saved = await saveDownload("報告書.pdf", new Blob(["%PDF"]));
    expect(saved).toEqual({ path: "/Users/me/Downloads/報告書 (1).pdf", inDownloads: true });
    expect(written[0]).toMatchObject({ path: "/Users/me/Downloads/報告書 (1).pdf", size: 4, options: { createNew: true } });
    expect(save).not.toHaveBeenCalled();
  });

  it("「保存先を毎回選ぶ」: the save dialog, starting in Downloads; cancelled is null", async () => {
    inTauri();
    expect(readAskDownloadLocation()).toBe(false);
    writeAskDownloadLocation(true);
    save.mockResolvedValueOnce("/Volumes/USB/報告書.pdf").mockResolvedValueOnce(null);
    expect(await saveDownload("報告書.pdf", new Blob(["%PDF"]))).toEqual({ path: "/Volumes/USB/報告書.pdf", inDownloads: false });
    expect(save).toHaveBeenCalledWith({ defaultPath: "/Users/me/Downloads/報告書.pdf" });
    expect(written[0]?.options).toBeUndefined(); // the dialog asked about replacing
    expect(await saveDownload("報告書.pdf", new Blob(["%PDF"]))).toBeNull();
    // `ask: false` (the viewers' 「開く」) skips the dialog whatever the setting.
    expect((await saveDownload("報告書.pdf", new Blob(["%PDF"]), { ask: false }))?.inDownloads).toBe(true);
  });

  it("marks the written file as from the internet, naming the server (Zone.Identifier / quarantine)", async () => {
    inTauri();
    const saved = await saveDownload("報告書.pdf", new Blob(["%PDF"]), { source: "https://chat.example.com" });
    expect(invoke).toHaveBeenCalledWith("download_mark", { path: saved!.path, source: "https://chat.example.com" });
    // A disk that cannot hold the mark keeps the download.
    invoke.mockRejectedValueOnce(new Error("no streams on FAT"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect((await saveDownload("b.pdf", new Blob(["%PDF"])))?.path).toBe("/Users/me/Downloads/b.pdf");
    expect(invoke).toHaveBeenLastCalledWith("download_mark", { path: "/Users/me/Downloads/b.pdf", source: null });
    warn.mockRestore();
  });

  it("browser: the browser's own download", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    expect(await saveDownload("a.csv", new Blob(["1"]))).toEqual({ path: null, inDownloads: false });
    expect(click).toHaveBeenCalledTimes(1);
    click.mockRestore();
  });
});

describe("the controller and the toast", () => {
  /** A body that arrives in two halves, so the toast shows a step between. */
  function streamingApi(release: Promise<void>) {
    return {
      fetchBlob: async (_path: string, onProgress?: (loaded: number, total: number) => void) => {
        onProgress?.(0, 4);
        await release;
        onProgress?.(2, 4);
        onProgress?.(4, 4);
        return new Blob(["%PDF"]);
      },
    } as unknown as ApiClient;
  }

  it("shows progress, then 「ダウンロードしました」 with 開く / フォルダを開く (desktop app)", async () => {
    inTauri();
    const controller = new AppController();
    let go!: () => void;
    controller.api = streamingApi(new Promise<void>((resolve) => { go = resolve; }));
    const view = render(<DownloadToasts controller={controller} />);
    const done = controller.downloadAttachment(pdf);
    await act(async () => {});
    view.rerender(<DownloadToasts controller={controller} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    expect(screen.getByText("ダウンロード中")).toBeTruthy();
    await act(async () => { go(); await done; });
    view.rerender(<DownloadToasts controller={controller} />);
    expect(screen.getByText("ダウンロードしました")).toBeTruthy();
    expect(screen.getByTitle("報告書.pdf")).toBeTruthy();
    expect(controller.downloads[0]).toMatchObject({ state: "done", path: "/Users/me/Downloads/報告書.pdf", openable: true });

    fireEvent.click(screen.getByRole("button", { name: /フォルダを開く/ }));
    await act(async () => {});
    expect(revealItemInDir).toHaveBeenCalledWith("/Users/me/Downloads/報告書.pdf");
    expect(controller.downloads).toHaveLength(0); // a button closes its toast
  });

  it("「開く」 opens the saved file; the viewers' 開く saves and opens in one go", async () => {
    inTauri();
    const controller = new AppController();
    controller.api = streamingApi(Promise.resolve());
    await controller.downloadAttachment(pdf, { open: true });
    expect(openPath).toHaveBeenCalledWith("/Users/me/Downloads/報告書.pdf");
    const item = controller.downloads[0]!;
    render(<DownloadToasts controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: /^開く$/ }));
    await act(async () => {});
    expect(openPath).toHaveBeenLastCalledWith(item.path);
  });

  it("the viewers' 開く on a kind not allowlisted only shows it in its folder; the mark names the server", async () => {
    inTauri();
    const controller = new AppController();
    controller.api = Object.assign(streamingApi(Promise.resolve()), { baseUrl: "https://chat.example.com" });
    await controller.downloadAttachment({ ...pdf, filename: "invoice.hta" }, { open: true });
    expect(openPath).not.toHaveBeenCalled();
    expect(revealItemInDir).toHaveBeenCalledWith("/Users/me/Downloads/invoice.hta");
    expect(invoke).toHaveBeenCalledWith("download_mark", { path: "/Users/me/Downloads/invoice.hta", source: "https://chat.example.com" });
    // The mark comes before anything opens it.
    await controller.downloadAttachment(pdf, { open: true });
    expect(invoke.mock.invocationCallOrder.at(-1)!).toBeLessThan(openPath.mock.invocationCallOrder[0]!);
  });

  it("offers no 開く for a program, and only the line in a browser", async () => {
    inTauri();
    const controller = new AppController();
    controller.api = streamingApi(Promise.resolve());
    await controller.downloadAttachment({ ...pdf, filename: "setup.exe" });
    const view = render(<DownloadToasts controller={controller} />);
    expect(screen.queryByRole("button", { name: /^開く$/ })).toBeNull();
    expect(screen.getByRole("button", { name: /フォルダを開く/ })).toBeTruthy();
    view.unmount();

    inBrowser();
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    Object.assign(URL, { createObjectURL: vi.fn(() => "blob:x"), revokeObjectURL: vi.fn() });
    const web = new AppController();
    web.api = streamingApi(Promise.resolve());
    await web.downloadAttachment(pdf);
    render(<DownloadToasts controller={web} />);
    expect(screen.getByText("ダウンロードしました")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /フォルダを開く/ })).toBeNull();
  });

  it("a cancelled save dialog leaves no toast; a failure says why", async () => {
    inTauri();
    writeAskDownloadLocation(true);
    save.mockResolvedValueOnce(null);
    const controller = new AppController();
    controller.api = streamingApi(Promise.resolve());
    await controller.downloadAttachment(pdf);
    expect(controller.downloads).toHaveLength(0);
    controller.api = { fetchBlob: async () => { throw new Error("offline"); } } as unknown as ApiClient;
    await controller.downloadAttachment(pdf);
    expect(controller.downloads).toHaveLength(0);
    expect(controller.error).toBeTruthy();
  });

  it("a finished toast goes by itself after a while, not while the pointer is on it", () => {
    vi.useFakeTimers();
    const dismissDownload = vi.fn();
    const item: DownloadItem = { id: 1, filename: "a.pdf", loaded: 1, total: 1, state: "done", path: "/d/a.pdf", openable: true };
    render(<DownloadToasts controller={{ downloads: [item], dismissDownload } as unknown as AppController} />);
    const toast = document.querySelector("[data-download='done']")!;
    fireEvent.pointerEnter(toast);
    act(() => { vi.advanceTimersByTime(DOWNLOAD_TOAST_MS + 100); });
    expect(dismissDownload).not.toHaveBeenCalled();
    fireEvent.pointerLeave(toast);
    act(() => { vi.advanceTimersByTime(DOWNLOAD_TOAST_MS + 100); });
    expect(dismissDownload).toHaveBeenCalledWith(1);
  });
});

it("「保存先を毎回選ぶ」 is off until switched on, on this device", () => {
  render(<DownloadLocationCard />);
  const toggle = screen.getByRole("switch", { name: /保存先を毎回選ぶ/ }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  expect(screen.getByText(/「ダウンロード」フォルダに保存します/)).toBeTruthy();
  fireEvent.click(toggle);
  expect(readAskDownloadLocation()).toBe(true);
  expect(screen.getByText("ダウンロードのたびに保存先を尋ねます")).toBeTruthy();
});

describe("a page's file chip (`[label](attachment:<id>)`, M121)", () => {
  function chip(label: string | undefined, filename: string) {
    const downloadAttachment = vi.fn(async (_attachment: AttachmentOut) => {});
    const controller = { attachmentMeta: async () => ({ ...pdf, filename }), downloadAttachment } as unknown as AppController;
    render(<FileLinkChip controller={controller} attachmentId="a1" label={label} />);
    return downloadAttachment;
  }

  it("names the file that downloads when the label says something else (2026-11-16)", async () => {
    const download = chip("report.pdf", "setup.exe");
    await act(async () => {});
    const button = document.querySelector("[data-file-link]")!;
    expect(button.textContent).toContain("report.pdf");
    expect(button.textContent).toContain("setup.exe");
    expect(screen.getByTitle("setup.exe")).toBeTruthy();
    fireEvent.click(button);
    expect(download).toHaveBeenCalledWith(expect.objectContaining({ filename: "setup.exe" }));
  });

  it("shows the name once when the label is the file's name, or there is no label", async () => {
    chip("報告書.pdf", "報告書.pdf");
    await act(async () => {});
    expect(document.querySelector("[data-file-link-label]")).toBeNull();
    expect(document.querySelector("[data-file-link]")!.textContent).toBe("報告書.pdf");
    cleanup();
    chip(undefined, "data.csv");
    await act(async () => {});
    expect(document.querySelector("[data-file-link]")!.textContent).toBe("data.csv");
  });
});
