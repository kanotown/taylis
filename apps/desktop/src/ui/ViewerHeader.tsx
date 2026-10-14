/**
 * The frame of the photo / video / document viewers (docs/PREVIEWS.md §11), a modal as Slack draws one: the app stays
 * in sight, dimmed, behind a dark card with rounded corners that holds a header (the file's name, its buttons and an
 * obvious ×) over the photo, the clip or the pages, centred in it.
 *
 * What a press does where (2026-10-14):
 * - Moves the window (desktop app): the strip along the window's top above the card (the title row's height; the
 *   macOS window buttons sit in it, on Windows it ends with our minimise / maximise / close) and the card's header
 *   (`data-tauri-drag-region="deep"`: its empty space and its text; Tauri's drag script leaves the buttons alone).
 *   Neither closes the viewer. Without a title bar of ours (the browser, Linux) there is no strip.
 * - Closes the viewer: the dimmed margin around the card, and the card's empty dark space around the photo / pages,
 *   when the press both starts and ends there (a drag or a text selection that begins on the pages and ends outside
 *   them does not close; neither does a scroll bar, which belongs to the scroller, not to the backdrop under it).
 *   Also the × and Esc.
 */
import { X } from "lucide-react";
import { Dialog } from "radix-ui";
import { type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode, type Ref, type UIEvent, useRef } from "react";

import { TITLE_ROW_HEIGHT, titleBarKind, type TitleBarKind } from "../platform/env";
import { cn } from "./primitives";
import { WindowControls } from "./WindowControls";
import { t } from "../i18n";

/**
 * Handlers for an element that closes the viewer when it is pressed itself (not a child): the press must go down and
 * come up on it. Both pointer and mouse events are heard, as a WebView that lost a mouseup to the window drag may send
 * the next press as a bare `mousedown` (dismissOutside.ts).
 */
export function useBackdropClose(onClose: () => void) {
  const down = useRef(false);
  const up = useRef(false);
  const onDown = (event: ReactMouseEvent) => {
    down.current = event.button === 0 && event.target === event.currentTarget;
    up.current = false;
  };
  const onUp = (event: ReactMouseEvent) => {
    up.current = event.button === 0 && event.target === event.currentTarget;
  };
  return {
    onPointerDown: onDown,
    onMouseDown: onDown,
    onPointerUp: onUp,
    onMouseUp: onUp,
    onClick: (event: ReactMouseEvent) => {
      const closes = down.current && up.current && event.target === event.currentTarget;
      down.current = false;
      up.current = false;
      if (closes) onClose();
    },
  };
}

export function ViewerFrame({ title, description, header, children, onClose, onKeyDown, onPointerDownOutside, kind = titleBarKind() }: {
  title: string;
  description: string;
  /** The header's contents: the name, the file's buttons and the × (ViewerCloseButton), last. */
  header: ReactNode;
  /** The body (ViewerBody). */
  children: ReactNode;
  onClose: () => void;
  onKeyDown?: (event: ReactKeyboardEvent) => void;
  onPointerDownOutside?: (event: { target: EventTarget | null; preventDefault: () => void }) => void;
  kind?: TitleBarKind;
}) {
  const backdrop = useBackdropClose(onClose);
  const content = useRef<HTMLDivElement | null>(null);
  return (
    <Dialog.Root open onOpenChange={(value) => { if (!value) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="rx-overlay fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content
          data-viewer-frame=""
          className={cn("fixed inset-0 z-50 flex flex-col px-3 pb-3 focus:outline-none sm:px-8 sm:pb-6 lg:px-14 lg:pb-10", kind === "native" && "pt-3 sm:pt-6 lg:pt-10")}
          ref={content}
          onKeyDown={onKeyDown}
          onPointerDownOutside={onPointerDownOutside}
          // The viewer itself takes the focus (its keys work at once), not its first button, which showed a focus ring.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            content.current?.focus();
          }}
          {...backdrop}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <Dialog.Description className="sr-only">{description}</Dialog.Description>
          {kind !== "native" && (
            <div
              data-tauri-drag-region="deep"
              data-viewer-drag-strip=""
              className={cn("-mx-3 flex shrink-0 justify-end sm:-mx-8 lg:-mx-14", kind === "custom" ? "h-10" : undefined)}
              style={kind === "overlay" ? { height: TITLE_ROW_HEIGHT } : undefined}
            >
              {kind === "custom" && <WindowControls tone="overlay" />}
            </div>
          )}
          <div data-viewer-card="" className="mx-auto flex min-h-0 w-full max-w-[1400px] flex-1 flex-col overflow-hidden rounded-xl bg-[#1a1d21] text-white shadow-2xl ring-1 ring-white/10">
            <div
              data-tauri-drag-region="deep"
              data-viewer-header=""
              className="flex min-h-[52px] shrink-0 select-none flex-wrap items-center justify-end gap-1.5 border-b border-white/10 py-1.5 pl-4 pr-2"
            >
              {header}
            </div>
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/**
 * The scrolling body of a viewer's card. Its single child is centred (`m-auto` in a box at least as large as the
 * view), so a short page or a small photo sits in the middle and a tall one scrolls from its top (a centred overflow
 * would cut its top off). `fill` keeps the box the view's size, for content that shrinks to fit it (a fitted photo).
 */
export function ViewerBody({ onClose, fill = false, scrollerRef, onScroll, children, label }: {
  onClose: () => void;
  fill?: boolean;
  scrollerRef?: Ref<HTMLDivElement>;
  onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  children: ReactNode;
  label?: string;
}) {
  const backdrop = useBackdropClose(onClose);
  return (
    <div ref={scrollerRef} data-viewer-scroller="" tabIndex={-1} aria-label={label} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-auto overscroll-contain focus:outline-none">
      <div data-viewer-backdrop="" className={cn("flex p-4", fill ? "h-full w-full" : "min-h-full w-max min-w-full")} {...backdrop}>
        {children}
      </div>
    </div>
  );
}

/** A round button of the viewers' header. */
export const VIEWER_BUTTON = "inline-flex items-center justify-center rounded-lg p-2 text-white hover:bg-white/15 disabled:opacity-40 disabled:hover:bg-transparent";
/** The viewers' ×, last in the header: set apart from the other buttons, so it reads as the way out. */
export function ViewerCloseButton() {
  return (
    <>
      <span className="mx-1 h-5 w-px bg-white/20" aria-hidden />
      <Dialog.Close asChild>
        <button type="button" data-viewer-close="" className={VIEWER_CLOSE_BUTTON} title={t("attach.closeEsc")} aria-label={t("common.close")}>
          <X size={20} />
        </button>
      </Dialog.Close>
    </>
  );
}

const VIEWER_CLOSE_BUTTON = "ml-1 inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/10 text-white hover:bg-white/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70";
