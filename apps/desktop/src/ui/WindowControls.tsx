/**
 * Windows: the window has no system title bar (tauri.windows.conf.json "decorations": false), as in Slack. Our top row
 * is the title bar (data-tauri-drag-region: drag to move, double-click to maximise) and ends with these buttons.
 * macOS keeps its own traffic lights over our top bar (overlay); Linux and the browser keep a system title bar.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { titleBarKind, type TitleBarKind } from "../platform/env";
import { cn } from "./primitives";

/** The part of Tauri's window API the buttons use (a fake in tests). */
export interface ControlledWindow {
  minimize(): Promise<void>;
  toggleMaximize(): Promise<void>;
  close(): Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(handler: () => void): Promise<() => void>;
}

async function tauriWindow(): Promise<ControlledWindow> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  return {
    minimize: () => win.minimize(),
    toggleMaximize: () => win.toggleMaximize(),
    close: () => win.close(),
    isMaximized: () => win.isMaximized(),
    onResized: (handler) => win.onResized(() => handler()),
  };
}

/** Over the sidebar-coloured top row, or over a screen's own background (login and the like). */
export type ControlsTone = "sidebar" | "canvas";

const BUTTON = "inline-flex h-full w-[46px] items-center justify-center transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent";
const TONES: Record<ControlsTone, string> = {
  sidebar: "text-sidebar-fg hover:bg-white/10 hover:text-white active:bg-white/20",
  canvas: "text-muted hover:bg-ink/10 hover:text-ink active:bg-ink/15",
};
/** Windows 11's close button: red on hover, white glyph. */
const CLOSE = "hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/85 active:text-white";

/** The minimise / maximise-restore / close buttons, 46 px wide and as tall as the row, at its right end. */
export function WindowControls({ tone = "sidebar", source = tauriWindow }: { tone?: ControlsTone; source?: () => Promise<ControlledWindow> }) {
  const [maximized, setMaximized] = useState(false);
  const win = useRef<Promise<ControlledWindow> | null>(null);
  const current = () => (win.current ??= source());

  // The maximise button turns into restore while maximised (also by double-click, Win+Up or a snap): ask on every resize.
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;
    void (async () => {
      try {
        const w = await current();
        const ask = () => {
          w.isMaximized().then(
            (value) => {
              if (alive) setMaximized(value);
            },
            (err) => console.warn("could not read the window's maximised state", err),
          );
        };
        const stop = await w.onResized(ask);
        if (alive) unlisten = stop;
        else stop();
        ask();
      } catch (err) {
        console.warn("could not follow the window's maximised state", err);
      }
    })();
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []); // one window for the component's life

  const run = (action: (w: ControlledWindow) => Promise<void>) => () => {
    current()
      .then(action)
      .catch((err) => console.warn("window button failed", err));
  };

  const toggleLabel = maximized ? "元に戻す" : "最大化";
  return (
    <div className="flex h-full shrink-0 self-stretch" role="group" aria-label="ウィンドウ">
      <button type="button" aria-label="最小化" title="最小化" className={cn(BUTTON, TONES[tone])} onClick={run((w) => w.minimize())}>
        <MinimiseGlyph />
      </button>
      <button type="button" aria-label={toggleLabel} title={toggleLabel} className={cn(BUTTON, TONES[tone])} onClick={run((w) => w.toggleMaximize())}>
        {maximized ? <RestoreGlyph /> : <MaximiseGlyph />}
      </button>
      <button type="button" aria-label="閉じる" title="閉じる" className={cn(BUTTON, TONES[tone], CLOSE)} onClick={run((w) => w.close())}>
        <CloseGlyph />
      </button>
    </div>
  );
}

/**
 * Screens without the top row (boot, login, invite, password change) still need a title bar: a strip along the top to
 * drag the window by, and on Windows the window buttons at its right. Nothing where the system draws one.
 * `leftInset` keeps the strip off the workspace rail on Windows (the rail's first tile sits under 32 px there).
 */
export function ScreenTitleStrip({ kind = titleBarKind(), leftInset = 0, source }: { kind?: TitleBarKind; leftInset?: number; source?: () => Promise<ControlledWindow> }) {
  if (kind === "native") return null;
  if (kind === "overlay") return <div data-tauri-drag-region className="fixed inset-x-0 top-0 z-50 h-8" />;
  return (
    <div data-tauri-drag-region data-testid="title-strip" className="fixed right-0 top-0 z-50 flex h-8 justify-end" style={{ left: leftInset }}>
      <WindowControls tone="canvas" source={source} />
    </div>
  );
}

// Segoe Fluent-style glyphs, 10 px, drawn with 1 px lines.
function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1" shapeRendering="crispEdges" aria-hidden="true">
      {children}
    </svg>
  );
}

function MinimiseGlyph() {
  return (
    <Glyph>
      <path d="M0 5.5h10" />
    </Glyph>
  );
}

function MaximiseGlyph() {
  return (
    <Glyph>
      <rect x="0.5" y="0.5" width="9" height="9" />
    </Glyph>
  );
}

function RestoreGlyph() {
  return (
    <Glyph>
      <rect x="0.5" y="2.5" width="7" height="7" />
      <path d="M2.5 2.5V0.5h7v7h-2" />
    </Glyph>
  );
}

function CloseGlyph() {
  return (
    <Glyph>
      <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" shapeRendering="geometricPrecision" />
    </Glyph>
  );
}
