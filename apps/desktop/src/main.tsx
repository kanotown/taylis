import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./ui/App";
import { AppController } from "./state/app";
import { guardFileDrops } from "./platform/fileDrops";
import { watchIdle } from "./platform/idle";
import { followVisualViewport } from "./platform/viewport";
import { setUpZoom } from "./platform/zoom";
import { applyFont, applyPalette, applySidebarTone, applyTheme, readFont, readPalette, readSidebarTone, readTheme } from "./ui/theme";
// Noto Sans JP (variable, the weight axis only): split by unicode-range, so only the subsets the text needs are fetched.
import "@fontsource-variable/noto-sans-jp/wght.css";
import "./styles.css";

// M40 「表示」: this device's light / dark choice, 「テーマの色」, 「サイドバー」 and 「フォント」, before the first paint (nothing is
// drawn in the palette's colours before React mounts: the page behind is --canvas).
applyTheme(readTheme());
applyPalette(readPalette());
applySidebarTone(readSidebarTone());
applyFont(readFont());
// 「文字の大きさ」 (desktop app): the saved zoom, and ⌘ / Ctrl + 「+」 「-」 「0」.
setUpZoom();

const controller = new AppController();
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
