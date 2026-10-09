/**
 * M153a (WIKI.md §30.3): the entry of the page editor bundled for the phones (apps/shared/mobile-editor/dist, built
 * by `npm run build:mobile-editor` with vite.mobile-editor.config.ts). No app shell, no API client, no router: the
 * editor alone, driven by the native bridge. `?dev=1` stands in for native (src/mobileEditor/devHarness.ts), `?theme=`
 * sets the theme before the first paint (native sends it with `load` otherwise).
 */
import { createRoot } from "react-dom/client";

import { createBridge, detectTransport, installBridge } from "../../shared/mobile-editor/src/bridge";
import { markStarted } from "../src/i18n";
import { createDevHarness } from "../src/mobileEditor/devHarness";
import { applyEditorTheme, MobileEditorApp } from "../src/mobileEditor/MobileEditorApp";
import "./mobile.css";

const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark") applyEditorTheme(theme);
const harness = params.get("dev") === "1" ? createDevHarness(window, { quiet: params.get("quiet") === "1" }) : null;
const bridge = createBridge(harness ? harness.transport : detectTransport(window));
installBridge(window, bridge);
harness?.attach(bridge);
// The texts are looked up while rendering (the locale comes with `load`).
markStarted();
createRoot(document.getElementById("root")!).render(<MobileEditorApp bridge={bridge} />);
