import React from "react";
import { createRoot } from "react-dom/client";

import { markStarted } from "./i18n";
import { App } from "./ui/App";
import { AppController } from "./state/app";
import { guardFileDrops } from "./platform/fileDrops";
import { watchIdle } from "./platform/idle";
import { followVisualViewport } from "./platform/viewport";
import { setUpZoom } from "./platform/zoom";
import { savedActiveWorkspace } from "./state/workspaces";
import { applyFont, applyPalette, applySidebarTone, applyTheme, readFont, readPalette, readSidebarTone, readTheme, setThemeWorkspace } from "./ui/theme";
// Noto Sans JP (variable, the weight axis only): split by unicode-range, so only the subsets the text needs are fetched.
import "@fontsource-variable/noto-sans-jp/wght.css";
// JetBrains Mono (variable, upright only) for code (styles.css --font-code); fetched only where code is shown.
import "@fontsource-variable/jetbrains-mono/wght.css";
import "./styles.css";

// M40 「表示」: this device's light / dark choice, 「テーマの色」, 「サイドバー」 and 「フォント」, before the first paint (nothing is
// drawn in the palette's colours before React mounts: the page behind is --canvas). The palette and the sidebar tone
// are the last active workspace's (its own choice, else the one for every workspace).
applyTheme(readTheme());
setThemeWorkspace(savedActiveWorkspace());
applyPalette(readPalette());
applySidebarTone(readSidebarTone());
applyFont(readFont());
// 「文字の大きさ」 (desktop app): the saved zoom, and ⌘ / Ctrl + 「+」 「-」 「0」.
setUpZoom();

const controller = new AppController();
// M115: from here on the texts are looked up while rendering (the language can change at runtime).
markStarted();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App controller={controller} />
  </React.StrictMode>,
);
// 「更新して再起動」 (desktop only): look for an update after starting, then every 6 hours. Not from `tauri dev` (the
// development build is not an installed app; the settings button still asks).
void controller.boot().finally(() => {
  if (!import.meta.env.DEV) controller.updates.start();
});
followVisualViewport();
guardFileDrops();

// Focus and visibility changes reach the server at once, not at the next heartbeat: while this window is not in
// use, the reader's phone gets pushes again (PUSH_NOTIFICATIONS.md §4.1). So does leaving it idle, focused or not.
const reportActivity = () => controller.engine?.reportActivity();
window.addEventListener("focus", reportActivity);
window.addEventListener("blur", reportActivity);
document.addEventListener("visibilitychange", reportActivity);
watchIdle(reportActivity);
