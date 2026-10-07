// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// 「ウィンドウを閉じてもバックグラウンドで動かす」: the Rust side holds the setting (src-tauri/src/background.rs); the page shows
// the switch and sends the tray / menu texts in the app's language.
const state = vi.hoisted(() => ({
  enabled: true,
  failSet: false,
  calls: [] as Array<{ command: string; args?: Record<string, unknown> }>,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    state.calls.push({ command, args });
    if (command === "background_get") return state.enabled;
    if (command === "background_set") {
      if (state.failSet) throw new Error("disk full");
      state.enabled = args!.enabled as boolean;
      return null;
    }
    if (command === "shell_labels_set") return null;
    throw new Error(`unexpected ${command}`);
  },
}));

import { setLocale } from "../src/i18n";
import { readRunInBackground, runInBackgroundNote, setUpShellLabels } from "../src/platform/background";
import { RunInBackgroundCard } from "../src/ui/Settings";

function asDesktop() {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
}

afterEach(() => {
  cleanup();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  state.enabled = true;
  state.failSet = false;
  state.calls = [];
  setLocale("ja");
});

describe("run in the background", () => {
  it("has no setting outside the desktop app", async () => {
    expect(await readRunInBackground()).toBeNull();
    expect(state.calls).toEqual([]);
  });

  it("reads and changes the setting through the app", async () => {
    asDesktop();
    render(<RunInBackgroundCard windows={false} />);
    const toggle = (await screen.findByRole("switch")) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(screen.getByText("ウィンドウを閉じてもバックグラウンドで動かす")).toBeTruthy();
    fireEvent.click(toggle);
    await waitFor(() => expect(state.enabled).toBe(false));
    expect(toggle.checked).toBe(false);
    expect(state.calls.at(-1)).toEqual({ command: "background_set", args: { enabled: false } });
  });

  it("goes back and says so when the setting cannot be saved", async () => {
    asDesktop();
    state.failSet = true;
    render(<RunInBackgroundCard windows />);
    const toggle = (await screen.findByRole("switch")) as HTMLInputElement;
    fireEvent.click(toggle);
    expect((await screen.findByRole("alert")).textContent).toBe("設定を保存できませんでした。");
    expect(toggle.checked).toBe(true);
  });

  it("explains each OS's way back and way out", () => {
    expect(runInBackgroundNote(false)).toContain("Dock");
    expect(runInBackgroundNote(false)).toContain("⌘Q");
    expect(runInBackgroundNote(true)).toContain("通知領域");
    expect(runInBackgroundNote(true)).toContain("「終了」");
  });

  it("sends the tray and menu texts at start and again when the language changes", async () => {
    asDesktop();
    const stop = setUpShellLabels();
    await waitFor(() => expect(state.calls.filter((c) => c.command === "shell_labels_set")).toHaveLength(1));
    expect(state.calls[0]!.args).toEqual({
      labels: expect.objectContaining({ open: "Taylis を開く", quit: "終了", showWindow: "ウィンドウを表示" }),
    });
    act(() => setLocale("en"));
    await waitFor(() => expect(state.calls.filter((c) => c.command === "shell_labels_set")).toHaveLength(2));
    expect(state.calls.at(-1)!.args).toEqual({ labels: expect.objectContaining({ open: "Open Taylis", quit: "Quit" }) });
    stop();
  });

  it("sends nothing outside the desktop app", () => {
    setUpShellLabels(false)();
    expect(state.calls).toEqual([]);
  });
});
