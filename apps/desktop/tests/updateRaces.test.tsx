// @vitest-environment jsdom
/**
 * Review v0.1.30 #3 and #6 (「更新して再起動」).
 * #3: the server's wait and the local store's are apart: the local writes of every workspace are always waited for,
 *     a failed or stuck one stops the update with the error, and what was saved comes back after the restart.
 * #6: an install under way is held apart from the shown status: a check answering late (found / failed / nothing)
 *     neither re-enables the button nor lets a second install start.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { describeError, UserMessageError } from "../src/api/errors";
import { AppController } from "../src/state/app";
import { type AvailableUpdate, UpdateChecker, type UpdaterDeps } from "../src/state/updates";
import { Store } from "../src/sync/store";
import { UpdateBanner } from "../src/ui/UpdateBanner";
import { MemoryPersistence } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A MemoryPersistence whose meta writes wait for `gate` (a slow disk) or fail. */
class SlowPersistence extends MemoryPersistence {
  gate: Promise<void> = Promise.resolve();
  fail: Error | null = null;
  override async saveMeta(key: string, value: string | null): Promise<void> {
    await this.gate;
    if (this.fail) throw this.fail;
    await super.saveMeta(key, value);
  }
}

const stuck = () => new Promise<void>(() => {});

/** A session the controller saves before the restart: an engine whose server never answers, and a real Store. */
function sessionWith(serverUrl: string, persistence: SlowPersistence, server: () => Promise<void> = stuck) {
  const store = new Store(persistence);
  const engine = { flushDrafts: server, canvases: { flushAll: server }, flushOutbox: server };
  return { serverUrl, store, engine };
}

function controllerWith(active: unknown, others: unknown[] = []): AppController {
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = active;
  const sessions = (controller as unknown as { sessions: Map<string, unknown> }).sessions;
  for (const s of [active, ...others]) sessions.set((s as { serverUrl: string }).serverUrl, s);
  return controller;
}

// --- #3 ----------------------------------------------------------------------------------

it("#3: the server stuck and the disk slow: the network wait ends, the local writes are still waited for", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const disk = new SlowPersistence();
  const slow = deferred();
  disk.gate = slow.promise;
  const session = sessionWith("https://a", disk);
  session.store.setDraft("c1", null, { text: "まだ保存していない下書き" });
  const controller = controllerWith(session);
  const done = vi.fn();
  void controller.prepareForRestart(1000, 60_000).then(done);
  await vi.advanceTimersByTimeAsync(5000); // well past the network deadline
  expect(done).not.toHaveBeenCalled();
  expect(disk.meta.size).toBe(0);
  slow.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toHaveBeenCalled();
  expect(disk.meta.has("draft:c1:")).toBe(true);
});

it("#3: a failed local write stops the update before install, with the error shown", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
  const disk = new SlowPersistence();
  disk.fail = new Error("SQLITE_FULL");
  const session = sessionWith("https://a", disk, async () => {});
  session.store.setDraft("c1", null, { text: "下書き" });
  const controller = controllerWith(session);
  const update = { version: "0.1.31", download: vi.fn(async () => {}), install: vi.fn(async () => {}) };
  const relaunch = vi.fn(async () => {});
  const onError = vi.fn();
  const updates = new UpdateChecker({ isDesktop: () => true, check: async () => update, relaunch, currentVersion: async () => "0.1.30" }, onError);
  await updates.check(false);
  expect(await updates.install(() => controller.prepareForRestart(1000, 1000))).toBe(false);
  expect(update.install).not.toHaveBeenCalled();
  expect(relaunch).not.toHaveBeenCalled();
  expect(onError).toHaveBeenCalledWith(expect.any(UserMessageError));
  expect(describeError(onError.mock.calls[0]![0])).toContain("更新を中止しました");
  expect(updates.status).toBe("available");
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

it("#3: local writes that never finish stop the update after the local deadline", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const disk = new SlowPersistence();
  disk.gate = stuck();
  const session = sessionWith("https://a", disk);
  session.store.setDraft("c1", null, { text: "下書き" });
  const controller = controllerWith(session);
  const failed = vi.fn();
  void controller.prepareForRestart(1000, 5000).catch(failed);
  await vi.advanceTimersByTimeAsync(5999);
  expect(failed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(failed).toHaveBeenCalledWith(expect.any(UserMessageError));
});

it("#3: a workspace not on screen with unsaved local writes holds the update too", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const shownDisk = new SlowPersistence();
  const hiddenDisk = new SlowPersistence();
  const slow = deferred();
  hiddenDisk.gate = slow.promise;
  const shown = sessionWith("https://a", shownDisk, async () => {});
  const hidden = sessionWith("https://b", hiddenDisk);
  hidden.store.addOutbox({ client_msg_id: "k1", channel_id: "c9", body: "送信待ち", created_at: "2026-10-04T00:00:00Z" });
  hidden.store.setDraft("c9", null, { text: "裏の下書き" });
  const controller = controllerWith(shown, [hidden]);
  const done = vi.fn();
  void controller.prepareForRestart(1000, 60_000).then(done);
  await vi.advanceTimersByTimeAsync(3000);
  expect(done).not.toHaveBeenCalled();
  slow.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(done).toHaveBeenCalled();
});

it("#3: after the local save, a restart (a new Store on the same disk) has the draft, the canvas and the send queue", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const disk = new SlowPersistence();
  const session = sessionWith("https://a", disk, async () => {});
  session.store.setDraft("c1", "p1", { text: "スレッドの下書き" });
  session.store.setPendingCanvas("cv1", { channelId: "c1", baseRevId: "r1", synced: "old", text: "new text", version: 3, inFlight: null });
  session.store.addOutbox({ client_msg_id: "k1", channel_id: "c1", body: "送信待ち", created_at: "2026-10-04T00:00:00Z" });
  await controllerWith(session).prepareForRestart(100, 1000);
  const restarted = new Store(disk);
  await restarted.load();
  expect(restarted.draft("c1", "p1").text).toBe("スレッドの下書き");
  expect(restarted.pendingCanvas("cv1")?.text).toBe("new text");
  expect(restarted.outbox.map((i) => i.body)).toEqual(["送信待ち"]);
});

// --- #6 ----------------------------------------------------------------------------------

function racingChecker() {
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
  const download = deferred();
  const update: AvailableUpdate & { download: ReturnType<typeof vi.fn>; install: ReturnType<typeof vi.fn> } = {
    version: "0.1.31",
    download: vi.fn(() => download.promise),
    install: vi.fn(async () => {}),
  };
  const checks: Array<ReturnType<typeof deferred<AvailableUpdate | null>>> = [];
  const relaunch = vi.fn(async () => {});
  const deps: UpdaterDeps = {
    isDesktop: () => true,
    check: () => {
      const next = deferred<AvailableUpdate | null>();
      checks.push(next);
      return next.promise;
    },
    relaunch,
    currentVersion: async () => "0.1.30",
  };
  const onError = vi.fn();
  const updates = new UpdateChecker(deps, onError);
  const prepare = vi.fn(async () => {});
  const controller = { updates, prepareForRestart: prepare } as unknown as AppController;
  return { updates, update, checks, download, relaunch, prepare, controller, onError };
}

for (const late of ["found", "failed", "nothing"] as const) {
  it(`#6: a re-check answering late (${late}) during the install keeps the progress and installs once`, async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = racingChecker();
    render(<UpdateBanner controller={t.controller} />);
    // The banner is up.
    await act(async () => { const first = t.updates.check(false); t.checks[0]!.resolve(t.update); await first; });
    // A periodic / manual re-check starts …
    let recheck!: Promise<unknown>;
    act(() => { recheck = t.updates.check(true); });
    expect(t.updates.status).toBe("checking");
    // … and 「更新して再起動」 is pressed while it runs.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "更新して再起動" })); });
    expect(t.updates.status).toBe("downloading");
    // The re-check answers late.
    await act(async () => {
      if (late === "found") t.checks[1]!.resolve({ ...t.update, version: "0.1.31" });
      else if (late === "failed") t.checks[1]!.reject(new Error("offline"));
      else t.checks[1]!.resolve(null);
      await recheck;
    });
    expect(t.updates.status).toBe("downloading");
    expect(t.updates.installInProgress).toBe(true);
    expect(screen.queryByRole("button", { name: "更新して再起動" })).toBeNull();
    expect(screen.getByRole("progressbar", { name: "ダウンロード" })).toBeTruthy();
    expect(t.onError).not.toHaveBeenCalled();
    // A second press (by the API: the button is gone) starts nothing, nor does a check.
    expect(await t.updates.install(t.prepare)).toBe(false);
    await t.updates.check(false);
    expect(t.checks).toHaveLength(2);
    await act(async () => { t.download.resolve(); });
    await act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });
    expect(t.update.download).toHaveBeenCalledTimes(1);
    expect(t.prepare).toHaveBeenCalledTimes(1);
    expect(t.update.install).toHaveBeenCalledTimes(1);
    expect(t.relaunch).toHaveBeenCalledTimes(1);
    delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
  });
}

it("#6: after a failed install another try may start (once)", async () => {
  const t = racingChecker();
  await act(async () => { const first = t.updates.check(false); t.checks[0]!.resolve(t.update); await first; });
  t.update.download.mockRejectedValueOnce(new Error("signature mismatch"));
  expect(await t.updates.install(t.prepare)).toBe(false);
  expect(t.updates.installInProgress).toBe(false);
  expect(t.updates.status).toBe("available");
  const second = t.updates.install(t.prepare);
  expect(await t.updates.install(t.prepare)).toBe(false);
  t.download.resolve();
  expect(await second).toBe(true);
  expect(t.update.install).toHaveBeenCalledTimes(1);
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});
