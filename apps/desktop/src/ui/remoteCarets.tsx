/**
 * CANVAS.md §25: where the others are typing in a canvas — a thin caret in their colour with their name above it, drawn
 * over the Markdown editor's text area from the `caret` of their `canvas_presence` frames (volatile, never stored).
 *
 * The caret travels in the stored body's terms (a line and a UTF-16 column of the body as saved, mentions as `<@uuid>`),
 * so every client can place it in its own form of the text: the same line, the column through the line's mentions.
 * Approximate on purpose — the other person's unsaved typing is not here yet; the column is clamped to the line.
 */
import { useEffect, useState } from "react";

import type { CanvasCaret } from "../sync/types";

/** Readable on the light and the dark canvas; a person keeps theirs (by their id). */
const CARET_COLORS = ["#e5484d", "#0090ff", "#30a46c", "#f76b15", "#8e4ec6", "#d6409f", "#12a594", "#ad7f58"] as const;

export function caretColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  return CARET_COLORS[hash % CARET_COLORS.length]!;
}

/** My caret (an offset into the text as shown) in the stored body's terms; `encodeLine` writes a shown line's start as stored. */
export function storedCaret(shown: string, offset: number, encodeLine: (shownPrefix: string) => string): CanvasCaret {
  const at = Math.max(0, Math.min(offset, shown.length));
  const lineStart = shown.lastIndexOf("\n", at - 1) + 1;
  const line = shown.slice(0, lineStart).split("\n").length - 1;
  return { line, column: encodeLine(shown.slice(lineStart, at)).length };
}

/**
 * Someone's caret (stored terms) as an offset into the text as shown here; null when their line is not here (yet).
 * `decodeLine` turns the start of a stored line into what it looks like here.
 */
export function shownOffset(stored: string, shown: string, caret: CanvasCaret, decodeLine: (storedPrefix: string) => string): number | null {
  const storedLines = stored.split("\n");
  const shownLines = shown.split("\n");
  if (caret.line >= storedLines.length || caret.line >= shownLines.length) return null;
  const column = Math.min(decodeLine(storedLines[caret.line]!.slice(0, caret.column)).length, shownLines[caret.line]!.length);
  let offset = 0;
  for (let k = 0; k < caret.line; k++) offset += shownLines[k]!.length + 1;
  return offset + column;
}

export interface RemoteCaret {
  userId: string;
  name: string;
  /** Offset into the text area's value. */
  offset: number;
}

const MIRRORED = [
  "boxSizing", "width", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight", "textTransform", "wordSpacing", "textIndent", "tabSize",
] as const;

/** Where an offset of a text area's value is drawn (its top-left, within the text area's content, before scrolling). */
function caretPoint(area: HTMLTextAreaElement, offset: number): { top: number; left: number; height: number } {
  const mirror = document.createElement("div");
  const style = getComputedStyle(area);
  for (const key of MIRRORED) (mirror.style as unknown as Record<string, string>)[key] = style[key];
  Object.assign(mirror.style, { position: "absolute", visibility: "hidden", top: "0", left: "-9999px", whiteSpace: "pre-wrap", overflowWrap: "break-word", overflow: "hidden" });
  mirror.style.width = `${area.clientWidth}px`;
  mirror.style.borderWidth = "0";
  mirror.textContent = area.value.slice(0, offset);
  const marker = document.createElement("span");
  marker.textContent = area.value.slice(offset, offset + 1) || "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const point = { top: marker.offsetTop, left: marker.offsetLeft, height: parseFloat(style.lineHeight) || marker.offsetHeight || 20 };
  mirror.remove();
  return point;
}

/** The others' carets over `area` (a sibling of this layer inside a `relative` box). */
export function RemoteCarets({ area, carets, text }: { area: HTMLTextAreaElement | null; carets: readonly RemoteCaret[]; text: string }) {
  const [, setTick] = useState(0);
  // Scrolling and resizing move them.
  useEffect(() => {
    if (!area) return;
    const redraw = () => setTick((n) => n + 1);
    area.addEventListener("scroll", redraw, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(redraw);
    observer?.observe(area);
    return () => {
      area.removeEventListener("scroll", redraw);
      observer?.disconnect();
    };
  }, [area]);
  if (!area || carets.length === 0) return null;
  // Measured on every render (the text, the carets, the scroll or the size may have changed; a few carets, cheap).
  const points = carets.map((caret) => ({ caret, ...caretPoint(area, Math.min(caret.offset, area.value.length)) }));
  const top0 = area.offsetTop - area.scrollTop;
  const left0 = area.offsetLeft - area.scrollLeft;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1] overflow-hidden" data-remote-carets={points.length} data-text-length={text.length}>
      {points.map(({ caret, top, left, height }) => {
        const y = top0 + top;
        if (y + height < area.offsetTop || y > area.offsetTop + area.clientHeight) return null; // scrolled out of view
        const color = caretColor(caret.userId);
        return (
          <div key={caret.userId} className="absolute" style={{ top: y, left: left0 + left - 1, height }} data-remote-caret={caret.userId}>
            <div className="h-full w-0.5 rounded-full" style={{ backgroundColor: color }} />
            <div className="absolute bottom-full left-0 mb-px whitespace-nowrap rounded px-1 py-px text-[10px] font-medium leading-tight text-white" style={{ backgroundColor: color }}>
              {caret.name}
            </div>
          </div>
        );
      })}
    </div>
  );
}
