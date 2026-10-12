// @vitest-environment jsdom
/** Downloads (docs/PREVIEWS.md §9): where the desktop app saves, the names it picks, the toast and its buttons. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { AttachmentOut } from "../src/api/types";
import { canOpenDownloaded, freePath, releasePath, numberedName, readAskDownloadLocation, safeFileName, saveDownload, writeAskDownloadLocation } from "../src/platform/download";
import { AppController, type DownloadItem } from "../src/state/app";
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

const inTauri = () => Object.assign(window, { __TAURI_INTERNALS__: {} });
const inBrowser = () => { delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__; };

const pdf: AttachmentOut = {
  id: "a1", filename: "報告書.pdf", content_type: "application/pdf", size_bytes: 3 * 1024 * 1024, has_thumbnail: false, has_poster: false,
  duration_ms: null, status: "attached", created_at: "", width: null, height: null,
};

beforeEach(() => {
  disk.clear();
  written.length = 0;
  save.mockReset();
  revealItemInDir.mockClear();
  openPath.mockClear();
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
