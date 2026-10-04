// @vitest-environment jsdom
/**
 * 「更新して再起動」 (desktop in-app updates): when the app looks (start, every 6 hours, never in the web build), the
 * banner (found → shown, 「あとで」 → hidden until the next start), the install order (download → save what is
 * pending → install → relaunch), the error toast, and the settings' 「アップデートを確認」. The Tauri plugins are mocked.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { AppController } from "../src/state/app";
import { notesFirstLine, UPDATE_CHECK_INTERVAL_MS, UpdateChecker, type UpdateDownloadEvent } from "../src/state/updates";
import { menuSections, SettingsSectionBody } from "../src/ui/Settings";
import { UpdateBanner } from "../src/ui/UpdateBanner";

const plugin = vi.hoisted(() => ({
  check: vi.fn(),
  relaunch: vi.fn(async () => {}),
  getVersion: vi.fn(async () => "0.1.19"),
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: plugin.check }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: plugin.relaunch }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: plugin.getVersion }));

const steps: string[] = [];

function fakeUpdate(version = "0.1.20", body = "## 「更新して再起動」が使えます\n\n- 細かな修正") {
  return {
    version,
    body,
    download: vi.fn(async (onEvent: (event: UpdateDownloadEvent) => void) => {
      steps.push("download");
      onEvent({ event: "Started", data: { contentLength: 4 * 1024 * 1024 } });
      onEvent({ event: "Progress", data: { chunkLength: 1024 * 1024 } });
      onEvent({ event: "Progress", data: { chunkLength: 3 * 1024 * 1024 } });
      onEvent({ event: "Finished" });
    }),
    install: vi.fn(async () => { steps.push("install"); }),
  };
}

function desktop(): void {
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
}

/** What the banner and the settings section use of the app controller. */
function controllerWith(updates: UpdateChecker, prepare = vi.fn(async () => { steps.push("prepare"); })) {
  return { controller: { updates, prepareForRestart: prepare } as unknown as AppController, prepare };
}

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  steps.length = 0;
  plugin.check.mockReset();
  plugin.relaunch.mockReset();
  plugin.relaunch.mockImplementation(async () => { steps.push("relaunch"); });
  plugin.getVersion.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

it("looks at start and finds nothing: no banner", async () => {
  desktop();
  plugin.check.mockResolvedValue(null);
  const onError = vi.fn();
  const updates = new UpdateChecker(undefined, onError);
  const { controller } = controllerWith(updates);
  render(<UpdateBanner controller={controller} />);
  await act(async () => { updates.start(); });
  await flush();
  expect(plugin.check).toHaveBeenCalledTimes(1);
  expect(updates.status).toBe("idle");
  expect(updates.currentVersion).toBe("0.1.19");
  expect(screen.queryByRole("status", { name: "アップデート" })).toBeNull();
  expect(onError).not.toHaveBeenCalled();
  updates.stop();
});

it("an update shows the banner with the version and the notes' first line", async () => {
  desktop();
  plugin.check.mockResolvedValue(fakeUpdate());
  const updates = new UpdateChecker();
  const { controller } = controllerWith(updates);
  render(<UpdateBanner controller={controller} />);
  await act(async () => { await updates.check(false); });
  expect(screen.getByText("新しい版 (v0.1.20) があります")).toBeTruthy();
  expect(screen.getByText("「更新して再起動」が使えます")).toBeTruthy();
  expect(screen.getByRole("button", { name: "更新して再起動" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "あとで" })).toBeTruthy();
});

it("「あとで」 hides it until the next start; a newer version or the settings button brings it back", async () => {
  desktop();
  plugin.check.mockResolvedValue(fakeUpdate("0.1.20"));
  const updates = new UpdateChecker();
  const { controller } = controllerWith(updates);
  render(<UpdateBanner controller={controller} />);
  await act(async () => { await updates.check(false); });
  fireEvent.click(screen.getByRole("button", { name: "あとで" }));
  expect(screen.queryByText("新しい版 (v0.1.20) があります")).toBeNull();
  // The 6-hour check finds the same version: still hidden.
  await act(async () => { await updates.check(false); });
  expect(screen.queryByText("新しい版 (v0.1.20) があります")).toBeNull();
  // A newer one comes back.
  plugin.check.mockResolvedValue(fakeUpdate("0.1.21"));
  await act(async () => { await updates.check(false); });
  expect(screen.getByText("新しい版 (v0.1.21) があります")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "あとで" }));
  // 「アップデートを確認」 asks on purpose: shown again.
  await act(async () => { await updates.check(true); });
  expect(screen.getByText("新しい版 (v0.1.21) があります")).toBeTruthy();
  // The next start is a new checker: shown again.
  cleanup();
  const next = new UpdateChecker();
  render(<UpdateBanner controller={controllerWith(next).controller} />);
  await act(async () => { await next.check(false); });
  expect(screen.getByText("新しい版 (v0.1.21) があります")).toBeTruthy();
});

it("looks again every 6 hours while running", async () => {
  vi.useFakeTimers();
  desktop();
  plugin.check.mockResolvedValue(null);
  const updates = new UpdateChecker();
  updates.start();
  updates.start(); // a second start does not add a second timer
  await vi.advanceTimersByTimeAsync(0);
  expect(plugin.check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1000);
  expect(plugin.check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(plugin.check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
  expect(plugin.check).toHaveBeenCalledTimes(3);
  updates.stop();
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
  expect(plugin.check).toHaveBeenCalledTimes(3);
});

it("更新: download with progress, save what is pending, install, relaunch — in that order", async () => {
  desktop();
  const update = fakeUpdate();
  plugin.check.mockResolvedValue(update);
  const updates = new UpdateChecker();
  const seen: (string | null)[] = [];
  updates.subscribe(() => { if (updates.status === "downloading" && updates.progress?.total) seen.push(`${updates.progress.downloaded}/${updates.progress.total}`); });
  const { controller, prepare } = controllerWith(updates);
  render(<UpdateBanner controller={controller} />);
  await act(async () => { await updates.check(false); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "更新して再起動" })); });
  await flush();
  expect(steps).toEqual(["download", "prepare", "install", "relaunch"]);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(seen).toContain(`${4 * 1024 * 1024}/${4 * 1024 * 1024}`);
  expect(updates.status).toBe("installing");
  expect(screen.getByRole("progressbar", { name: "ダウンロード" })).toBeTruthy();
});

it("a failed download shows the error toast and leaves the banner for another try", async () => {
  desktop();
  const update = fakeUpdate();
  update.download.mockRejectedValueOnce(new Error("signature mismatch"));
  plugin.check.mockResolvedValue(update);
  const onError = vi.fn();
  const updates = new UpdateChecker(undefined, onError);
  const { controller, prepare } = controllerWith(updates);
  render(<UpdateBanner controller={controller} />);
  await act(async () => { await updates.check(false); });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "更新して再起動" })); });
  await flush();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "signature mismatch" }));
  expect(prepare).not.toHaveBeenCalled();
  expect(update.install).not.toHaveBeenCalled();
  expect(plugin.relaunch).not.toHaveBeenCalled();
  expect(updates.status).toBe("available");
  expect(screen.getByRole("button", { name: "更新して再起動" })).toBeTruthy();
});

it("a failed automatic check stays quiet; the settings button shows the error", async () => {
  desktop();
  plugin.check.mockRejectedValue(new Error("offline"));
  const onError = vi.fn();
  const updates = new UpdateChecker(undefined, onError);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  await updates.check(false);
  expect(onError).not.toHaveBeenCalled();
  expect(updates.status).toBe("idle");
  await updates.check(true);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(updates.lastCheckFailed).toBe(true);
});

it("the web build never looks for an update and has no 「このアプリについて」", async () => {
  vi.useFakeTimers();
  plugin.check.mockResolvedValue(fakeUpdate());
  const updates = new UpdateChecker();
  const { controller } = controllerWith(updates);
  render(<UpdateBanner controller={controller} />);
  updates.start();
  await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
  expect(await updates.check(true)).toBeNull();
  expect(await updates.readCurrentVersion()).toBeNull();
  expect(plugin.check).not.toHaveBeenCalled();
  expect(plugin.getVersion).not.toHaveBeenCalled();
  expect(screen.queryByRole("status", { name: "アップデート" })).toBeNull();
  expect(menuSections(false)).not.toContain("about");
  expect(menuSections(true, true)).toEqual(["notifications", "appearance", "input", "profile", "account", "workspaces", "about", "admin"]);
});

it("settings 「このアプリについて」: the version, 「アップデートを確認」 → 最新の版です / 新しい版", async () => {
  desktop();
  plugin.check.mockResolvedValue(null);
  const updates = new UpdateChecker();
  await updates.readCurrentVersion();
  const { controller } = controllerWith(updates);
  render(<SettingsSectionBody controller={controller} section="about" />);
  expect(screen.getByText("バージョン v0.1.19")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "アップデートを確認" })); });
  await flush();
  expect(screen.getByText("最新の版です。")).toBeTruthy();
  plugin.check.mockResolvedValue(fakeUpdate("0.1.20"));
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "アップデートを確認" })); });
  await flush();
  expect(screen.getByText("新しい版 (v0.1.20) があります")).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "更新して再起動" })); });
  await flush();
  expect(steps).toEqual(["download", "prepare", "install", "relaunch"]);
});

it("prepareForRestart saves drafts, canvases and the send queue, and does not wait for ever", async () => {
  const calls: string[] = [];
  const engine = {
    flushDrafts: async () => { calls.push("drafts"); },
    canvases: { flushAll: async () => { calls.push("canvases"); } },
    flushOutbox: async () => { calls.push("outbox"); },
  };
  const store = { flushPersistence: async () => { calls.push("persist"); } };
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "https://a", engine, store };
  await controller.prepareForRestart();
  expect(calls).toEqual(["drafts", "canvases", "outbox", "persist"]);

  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  engine.flushOutbox = () => new Promise<void>(() => {}); // a server that never answers
  const done = vi.fn();
  void controller.prepareForRestart(1000).then(done);
  await vi.advanceTimersByTimeAsync(999);
  expect(done).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(done).toHaveBeenCalled();
});

it("the notes' first line skips blank lines and a heading mark", () => {
  expect(notesFirstLine("\n\n## Taylis v0.1.20\nmore")).toBe("Taylis v0.1.20");
  expect(notesFirstLine(undefined)).toBe("");
});
