import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./ui/App";
import { AppController } from "./state/app";
import { guardFileDrops } from "./platform/fileDrops";
import { watchIdle } from "./platform/idle";
import { followVisualViewport } from "./platform/viewport";
import { applyTheme, readTheme } from "./ui/theme";
import "./styles.css";

// M40 「表示」: this device's light / dark choice, before the first paint.
applyTheme(readTheme());

const controller = new AppController();
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App controller={controller} />
  </React.StrictMode>,
);
void controller.boot();
followVisualViewport();
guardFileDrops();

// Focus and visibility changes reach the server at once, not at the next heartbeat: while this window is not in
// use, the reader's phone gets pushes again (PUSH_NOTIFICATIONS.md §4.1). So does leaving it idle, focused or not.
const reportActivity = () => controller.engine?.reportActivity();
window.addEventListener("focus", reportActivity);
window.addEventListener("blur", reportActivity);
document.addEventListener("visibilitychange", reportActivity);
watchIdle(reportActivity);
