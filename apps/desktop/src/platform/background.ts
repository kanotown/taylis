import { subscribeLocale, t } from "../i18n";
import { isTauri, isWindows } from "./env";

/**
 * 「ウィンドウを閉じてもバックグラウンドで動かす」 (desktop app; docs/PUSH_NOTIFICATIONS.md §9.2). The Rust side holds
 * the setting (src-tauri/src/background.rs: window.json in the app's config directory, this device only) and hides the
 * window on close while it is on; this side shows the switch and sends the texts of the tray menu, the macOS menu item
 * and the Windows hint in the app's language.
 */

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(command, args);
}

/** The setting (on by default); null outside the desktop app or when the app cannot say. */
export async function readRunInBackground(): Promise<boolean | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<boolean>("background_get");
  } catch (err) {
    console.warn("could not read the background setting", err);
    return null;
  }
}

export async function writeRunInBackground(enabled: boolean): Promise<void> {
  await invoke<void>("background_set", { enabled });
}

/** The texts the Rust side shows (tray menu, macOS Window menu, the Windows hint), in the current language. */
export function shellLabels(): Record<"showWindow" | "open" | "quit" | "hintTitle" | "hintBody", string> {
  return {
    showWindow: t("shell.showWindow"),
    open: t("shell.trayOpen"),
    quit: t("shell.trayQuit"),
    hintTitle: t("shell.trayHintTitle"),
    hintBody: t("shell.trayHintBody"),
  };
}

/** At start (main.tsx) and on every language change. Nothing outside the desktop app. */
export function setUpShellLabels(desktop: boolean = isTauri()): () => void {
  if (!desktop) return () => {};
  const send = () =>
    void invoke<void>("shell_labels_set", { labels: shellLabels() }).catch((err: unknown) => console.warn("could not send the menu texts", err));
  send();
  return subscribeLocale(send);
}

/** The switch's note: where the window goes and how to quit, per OS. */
export function runInBackgroundNote(windows: boolean = isWindows()): string {
  return windows ? t("settings.background.noteWindows") : t("settings.background.noteMac");
}
