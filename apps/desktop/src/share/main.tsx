/**
 * The entry of share.html (M163, docs/DRIVE.md §9.3): the public page of a drive share link at `/s/<token>`. A separate
 * Vite entry, without the app's session, sync or storage: it only reads the token in the path and the public API.
 */
import React from "react";
import { createRoot } from "react-dom/client";

import { getLocale, markStarted } from "../i18n";
import { applyTheme, readTheme } from "../ui/theme";
import { ShareApi, tokenFromPath } from "./api";
import { SharePage } from "./SharePage";
import "@fontsource-variable/noto-sans-jp/wght.css";
import "../styles.css";

// The device's light / dark and language (a choice saved in this browser by the app on the same server applies too).
applyTheme(readTheme());
document.documentElement.lang = getLocale();
markStarted();

const token = tokenFromPath(window.location.pathname);
const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    {token ? (
      <SharePage api={new ShareApi(token)} />
    ) : (
      <p className="p-10 text-center text-sm text-muted">Link not found.</p>
    )}
  </React.StrictMode>,
);
