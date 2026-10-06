/**
 * The DOM side of the canvas editor's scroll sync (CANVAS.md §23; the mapping is canvasScrollSync.ts). The side the
 * person scrolls drives: the last one that got a wheel, a pointer, a touch, a key or the focus. Scroll events of the
 * other side (the ones this sets, and the browser clamping it when its content shrinks) are ignored, so the two never
 * chase each other. The editor's lines are measured in a hidden copy of the text area (same width, font and wrapping),
 * the preview's blocks by their `data-line` wrappers (ui/CanvasBody.tsx); both are kept until the text, a size or a
 * picture changes (ResizeObserver), then measured again on the next scroll. After an edit the preview follows the
 * editor; after a size change (a picture loading, the split moved) the side not driving follows the one driving, so
 * what is being read stays put.
 */
import { useEffect, useLayoutEffect, useRef } from "react";

import { buildAnchors, mapScroll, type PreviewBlock, type ScrollAnchor } from "./canvasScrollSync";

type Side = "editor" | "preview";

/** Text-area styles the hidden copy takes over (what decides where its lines wrap and how high they are). */
const MIRRORED = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontStretch", "fontVariantLigatures", "fontFeatureSettings",
  "letterSpacing", "wordSpacing", "lineHeight", "textTransform", "textIndent", "tabSize",
  "whiteSpace", "overflowWrap", "wordBreak", "lineBreak",
  "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
] as const;

export function useCanvasScrollSync(editor: HTMLTextAreaElement | null, preview: HTMLElement | null, body: string) {
  /** Set while both sides are on screen: the text changed. */
  const bodyChanged = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!editor || !preview) return;
    const mirror = document.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    Object.assign(mirror.style, { position: "absolute", top: "0", left: "-10000px", visibility: "hidden", boxSizing: "border-box", border: "0", margin: "0", overflow: "hidden", contain: "layout style" });
    document.body.appendChild(mirror);

    let lineTops: number[] = [];
    let editorEnd = 0;
    let measuredText: string | null = null;
    let measuredWidth = -1;
    let anchors: ScrollAnchor[] | null = null;
    let driver: Side = "editor";
    const expected: Record<Side, number> = { editor: Number.NaN, preview: Number.NaN };
    let frame = 0;

    /** Where each line of the text area starts: a hidden copy with one block per line (an empty line keeps its height). */
    const measureEditor = () => {
      const text = editor.value;
      const width = editor.clientWidth;
      if (text === measuredText && width === measuredWidth) return;
      const style = getComputedStyle(editor);
      for (const key of MIRRORED) mirror.style[key] = style[key];
      mirror.style.width = `${width}px`;
      const lines = text.split("\n");
      const rows = mirror.children;
      while (rows.length > lines.length) mirror.lastChild!.remove();
      while (rows.length < lines.length) mirror.appendChild(document.createElement("div"));
      lines.forEach((line, k) => {
        const row = rows[k]!;
        const shown = line === "" ? "​" : line;
        if (row.textContent !== shown) row.textContent = shown;
      });
      lineTops = Array.from(rows, (row) => (row as HTMLElement).offsetTop);
      const last = rows[rows.length - 1] as HTMLElement | undefined;
      editorEnd = last ? last.offsetTop + last.offsetHeight : 0;
      measuredText = text;
      measuredWidth = width;
    };

    const measurePreview = (): PreviewBlock[] => {
      const box = preview.getBoundingClientRect();
      const blocks: PreviewBlock[] = [];
      for (const wrapper of preview.querySelectorAll<HTMLElement>("[data-line]")) {
        const element = wrapper.firstElementChild;
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue; // hidden
        blocks.push({ line: Number(wrapper.dataset.line), top: rect.top - box.top + preview.scrollTop });
      }
      return blocks;
    };

    const currentAnchors = () => {
      if (anchors) return anchors;
      measureEditor();
      anchors = buildAnchors(lineTops, editorEnd, measurePreview(), editor.scrollHeight - editor.clientHeight, preview.scrollHeight - preview.clientHeight);
      return anchors;
    };

    /** The other side follows `from`. */
    const follow = (from: Side) => {
      const source = from === "editor" ? editor : preview;
      const target = from === "editor" ? preview : editor;
      const max = target.scrollHeight - target.clientHeight;
      const wanted = Math.round(Math.min(Math.max(0, mapScroll(currentAnchors(), source.scrollTop, from)), Math.max(0, max)));
      if (Math.abs(target.scrollTop - wanted) < 1) return;
      target.scrollTop = wanted;
      expected[from === "editor" ? "preview" : "editor"] = target.scrollTop;
    };

    /** After a layout change: measured again, the other side follows `from` once the frame is laid out. */
    const resync = (from: () => Side) => {
      anchors = null;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => follow(from()));
    };

    const onScroll = (side: Side) => () => {
      const element = side === "editor" ? editor : preview;
      if (side !== driver) return;
      if (Math.abs(element.scrollTop - expected[side]) < 1) return; // the one set by `follow`
      expected[side] = Number.NaN;
      follow(side);
    };
    const drive = (side: Side) => () => {
      driver = side;
    };
    const DRIVING = ["wheel", "pointerdown", "touchstart", "keydown", "focusin"] as const;
    const listeners: Array<[HTMLElement, string, () => void]> = [];
    for (const [side, element] of [["editor", editor], ["preview", preview]] as const) {
      listeners.push([element, "scroll", onScroll(side)]);
      for (const type of DRIVING) listeners.push([element, type, drive(side)]);
    }
    for (const [element, type, listener] of listeners) element.addEventListener(type, listener, { passive: true });

    const resized = new ResizeObserver(() => resync(() => driver));
    resized.observe(editor);
    resized.observe(preview);
    const content = preview.firstElementChild;
    if (content) resized.observe(content);

    bodyChanged.current = () => resync(() => "editor");
    follow("editor");

    return () => {
      bodyChanged.current = null;
      cancelAnimationFrame(frame);
      resized.disconnect();
      for (const [element, type, listener] of listeners) element.removeEventListener(type, listener);
      mirror.remove();
    };
  }, [editor, preview]);

  // An edit (or a box ticked in the preview): the preview, laid out again, follows the editor.
  useLayoutEffect(() => {
    bodyChanged.current?.();
  }, [body]);
}
