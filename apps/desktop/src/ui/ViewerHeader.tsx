/**
 * The top row of the full-window viewers (photos, videos, documents; docs/PREVIEWS.md §11). They cover the whole window,
 * the app's own title row included, so this row is the title bar while one is open: it moves the window
 * (`data-tauri-drag-region="deep"`: its empty space and its text; Tauri's drag script leaves the buttons alone), on macOS
 * it keeps the room of the window buttons on its left and their row's height, and on Windows it ends with our own
 * minimise / maximise / close (the system has none there).
 */
import type { ReactNode } from "react";

import { TITLE_ROW_HEIGHT, TRAFFIC_LIGHTS_INSET, titleBarKind, type TitleBarKind } from "../platform/env";
import { WindowControls } from "./WindowControls";

export function ViewerHeader({ children, kind = titleBarKind() }: { children: ReactNode; kind?: TitleBarKind }) {
  return (
    <div
      data-tauri-drag-region="deep"
      data-viewer-header=""
      className="flex shrink-0 select-none items-center gap-1.5 px-4 py-2 text-white"
      style={
        kind === "overlay"
          ? { paddingLeft: `calc(${TRAFFIC_LIGHTS_INSET}px / var(--ui-zoom, 1))`, minHeight: TITLE_ROW_HEIGHT }
          : kind === "custom"
            ? { paddingTop: 0, paddingBottom: 0, paddingRight: 0, minHeight: 40 }
            : undefined
      }
      onClick={(event) => event.stopPropagation()}
    >
      {children}
      {kind === "custom" && (
        <div className="ml-2 flex h-10 self-start">
          <WindowControls tone="overlay" />
        </div>
      )}
    </div>
  );
}

/** A round button of the viewers' top row. */
export const VIEWER_BUTTON = "inline-flex items-center justify-center rounded-lg p-2 text-white hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent";
