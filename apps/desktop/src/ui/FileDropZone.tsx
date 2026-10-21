/**
 * Drag and drop upload onto a whole pane (docs/PREVIEWS.md §10): while files from the desktop are dragged over the
 * conversation or the thread pane, the pane dims behind a dashed frame saying where they will go (「#general に添付」,
 * 「スレッドに添付」), or why they cannot (archived, owners only, not a member). Each pane is its own zone, so with a
 * thread open the two say which one takes the files. A drop hands the files to that pane's composer, which uploads
 * them as its 📎 button does.
 *
 * - Only drags carrying files count: text, links and pictures dragged inside the app (their drag starts in this page,
 *   platform/fileDrops.ts `isInternalDrag`) are left to whatever takes them.
 * - dragenter / dragleave fire for every child the pointer crosses: a counter of enters minus leaves says whether the
 *   pointer is still inside (no flicker), reset on drop, on dragend / drop anywhere in the window, and by a watchdog
 *   when no dragover came for a while (WebKit can lose the last dragleave when the pointer leaves the window fast).
 * - The desktop app gets these HTML5 events too: its window leaves drag and drop to the page (tauri.conf.json
 *   `dragDropEnabled: false`), so the drop carries File objects as in a browser.
 */
import { Ban, Upload } from "lucide-react";
import { type DragEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";

import { isFileDrag, watchInternalDrags } from "../platform/fileDrops";
import { cn } from "./primitives";
import { t } from "../i18n";

/** A composer's way in for dropped files, by conversation and thread (`composerKey`). */
const composers = new Map<string, (files: File[]) => void>();

export function composerKey(channelId: string, parentId: string | null): string {
  return `${channelId}:${parentId ?? ""}`;
}

/** The composer of `key` takes dropped files with `take` until the returned function is called. */
export function registerComposerFiles(key: string, take: (files: File[]) => void): () => void {
  composers.set(key, take);
  return () => {
    if (composers.get(key) === take) composers.delete(key);
  };
}

/** Hands `files` to the composer of `key`; false when none is on screen. */
export function deliverToComposer(key: string, files: File[]): boolean {
  const take = composers.get(key);
  if (!take) return false;
  take(files);
  return true;
}

/** No dragover for this long while "inside": the drag has gone (WebKit fires dragover at least every 350 ms). */
export const DROP_WATCHDOG_MS = 1200;

export interface FileDropOptions {
  /** False: the zone ignores drags (another tab covers the pane). */
  enabled: boolean;
  /** Why files cannot be dropped here (shown on the overlay), or null when they can. */
  blocked: string | null;
  onFiles: (files: File[]) => void;
  /**
   * M161 (the drive): the whole drop instead of its files, called in the drop handler itself (a folder's entries can
   * only be taken there, DataTransferItem.webkitGetAsEntry).
   */
  onData?: (data: DataTransfer) => void;
}

/** The zone's state and the handlers to put on its element. */
export function useFileDropZone({ enabled, blocked, onFiles, onData }: FileDropOptions) {
  const [active, setActive] = useState(false);
  const depth = useRef(0);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ blocked, onFiles, onData });
  latest.current = { blocked, onFiles, onData };

  const reset = useCallback(() => {
    depth.current = 0;
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = null;
    setActive(false);
  }, []);
  const arm = useCallback(() => {
    if (watchdog.current) clearTimeout(watchdog.current);
    watchdog.current = setTimeout(reset, DROP_WATCHDOG_MS);
  }, [reset]);

  useEffect(() => {
    watchInternalDrags();
    if (!enabled) {
      reset();
      return;
    }
    // A drop or the end of a drag anywhere (another pane, outside the window) ends this zone's too.
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
      if (watchdog.current) clearTimeout(watchdog.current);
    };
  }, [enabled, reset]);

  const accepts = (event: DragEvent) => enabled && isFileDrag(event);
  const handlers = {
    onDragEnter: (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      depth.current += 1;
      setActive(true);
      arm();
    },
    onDragOver: (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = latest.current.blocked ? "none" : "copy";
      if (depth.current === 0) depth.current = 1; // the enter went unseen (the zone appeared under the pointer)
      setActive(true);
      arm();
    },
    onDragLeave: (event: DragEvent) => {
      if (!accepts(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) reset();
    },
    onDrop: (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      // Not stopped: the window's listener (above) ends the other zones' state too.
      const files = Array.from(event.dataTransfer.files ?? []);
      reset();
      if (latest.current.blocked || files.length === 0) return;
      if (latest.current.onData) latest.current.onData(event.dataTransfer);
      else latest.current.onFiles(files);
    },
  };
  return { active, handlers };
}

/**
 * The frame over a pane while files are dragged over it: dimmed, a dashed border, an icon and what a drop does. Never
 * takes the pointer itself (the pane's own elements keep receiving the drag events the counter follows).
 */
export function DropOverlay({ active, blocked, destination }: { active: boolean; blocked: string | null; destination: string }) {
  if (!active) return null;
  return (
    <div
      data-drop-overlay={blocked ? "blocked" : "ready"}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 z-40 flex items-center justify-center p-3",
        blocked ? "bg-canvas/75" : "bg-accent-soft/70",
        "backdrop-blur-[1.5px]",
      )}
    >
      <div
        className={cn(
          "flex h-full w-full flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 text-center",
          blocked ? "border-muted/60 text-muted" : "border-accent text-accent",
        )}
      >
        <span className={cn("flex h-14 w-14 items-center justify-center rounded-2xl", blocked ? "bg-ink/8" : "bg-accent text-white shadow-lg")}>
          {blocked ? <Ban size={26} /> : <Upload size={26} />}
        </span>
        <strong className="text-base text-ink">{blocked ? t("drop.blocked") : t("drop.here")}</strong>
        <span className="max-w-full truncate text-sm">{blocked ?? destination}</span>
      </div>
    </div>
  );
}

/**
 * A pane that takes dropped files for the composer of `target` (composerKey), with the overlay over it. `className`
 * lays the pane out (it is positioned: the overlay covers it). `onUnavailable`: the drop found no composer on screen.
 */
export function FileDropPane({ enabled, blocked, destination, target, onUnavailable, className, children }: {
  enabled: boolean;
  blocked: string | null;
  destination: string;
  target: string;
  onUnavailable: () => void;
  className?: string;
  children: ReactNode;
}) {
  const { active, handlers } = useFileDropZone({
    enabled,
    blocked,
    onFiles: (files) => {
      if (!deliverToComposer(target, files)) onUnavailable();
    },
  });
  return (
    <div data-drop-zone={target} className={cn("relative", className)} {...handlers}>
      {children}
      <DropOverlay active={active} blocked={blocked} destination={destination} />
    </div>
  );
}