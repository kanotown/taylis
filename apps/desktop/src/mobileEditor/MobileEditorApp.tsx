/**
 * M153a (WIKI.md §30.3): the page the phones show while a Docs page is edited — the 見たまま editor (ui/PageEditor.tsx)
 * alone, full page, driven by the native bridge (apps/shared/mobile-editor/src/bridge.ts). `load` mounts a new editor
 * for a body; `replace` brings a merged body in (the same changed-blocks-only replacement as Desktop, never during an
 * IME composition); `requestBody` answers with the body as held now; the people, pages and emoji come from native.
 * The editor's `changed` goes out when typing pauses (300 ms, as Desktop) — native's CanvasSaver does the saving.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { type Bridge, BRIDGE_VERSION, type EditorTheme } from "../../../shared/mobile-editor/src/bridge";
import { deviceLocale, normalizeLocale, setLocale } from "../i18n";
import type { DocEditorLinks } from "../ui/CanvasEditor";
import PageEditor, { type PageEditorHandle } from "../ui/PageEditor";
import { BridgeDirectory, BridgeSink, bridgePageEditorEnv } from "./bridgeEnv";

interface Session {
  key: number;
  sink: BridgeSink;
  readOnly: boolean;
  caretLine: number | null;
}

/** `<html data-theme>`: the app's light / dark tokens (app.css); "system" follows the OS. */
export function applyEditorTheme(theme: EditorTheme, root: HTMLElement = document.documentElement): void {
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

/** What the keyboard covers (mobile.css: the formatting row above it, room under the body for the caret). */
export function applyViewport(keyboardHeight: number, safeBottom = 0, root: HTMLElement = document.documentElement): void {
  root.style.setProperty("--keyboard-height", `${Math.max(0, Math.round(keyboardHeight))}px`);
  root.style.setProperty("--safe-bottom", `${Math.max(0, Math.round(safeBottom))}px`);
}

export function MobileEditorApp({ bridge }: { bridge: Bridge }) {
  const directory = useMemo(() => new BridgeDirectory(bridge), [bridge]);
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const handle = useRef<PageEditorHandle | null>(null);
  const counter = useRef(0);
  const env = useMemo(() => bridgePageEditorEnv(bridge, directory, () => sessionRef.current?.readOnly ?? false), [bridge, directory]);
  const links = useMemo<DocEditorLinks>(() => ({ lookup: (q) => directory.lookupPages(q) }), [directory]);

  useEffect(() => {
    const stop = bridge.listen((message) => {
      switch (message.type) {
        case "load": {
          if (message.theme) applyEditorTheme(message.theme);
          if (message.locale !== undefined) setLocale(normalizeLocale(message.locale) ?? deviceLocale());
          if (message.title !== undefined) document.title = message.title;
          directory.attachmentUrl = message.attachmentUrl ?? null;
          const sink = new BridgeSink(bridge, message.body, () => handle.current?.caretLine() ?? 0);
          const next: Session = { key: ++counter.current, sink, readOnly: !!message.readOnly, caretLine: message.caretLine ?? null };
          sessionRef.current = next;
          // The editor is up before the next message is read (a requestBody right after a load).
          flushSync(() => setSession(next));
          break;
        }
        case "replace":
          sessionRef.current?.sink.replace(message.body);
          break;
        case "setTheme":
          applyEditorTheme(message.theme);
          break;
        case "setViewport":
          applyViewport(message.keyboardHeight, message.safeBottom);
          handle.current?.revealCaret();
          break;
        case "insertImage":
          if (message.url) directory.setImageUrl(message.attachmentId, message.url);
          handle.current?.insertImage(message.attachmentId, message.alt ?? "");
          break;
        case "providePeople":
          directory.setPeople(message.people);
          break;
        case "providePages":
          directory.setPages(message.query, message.pages);
          break;
        case "provideEmoji":
          directory.setEmoji(message.emoji);
          break;
        case "focus":
          handle.current?.focus();
          break;
        case "blur":
          handle.current?.blur();
          break;
        case "requestBody": {
          const current = sessionRef.current;
          if (!current) {
            bridge.send({ type: "bodyRequested", body: "", dirty: false, caretLine: 0 });
            break;
          }
          // The document written now, without a `changed` of its own: the answer carries it.
          current.sink.quiet(() => handle.current?.commit());
          bridge.send({ type: "bodyRequested", body: current.sink.text, dirty: current.sink.dirty, caretLine: handle.current?.caretLine() ?? 0 });
          break;
        }
        case "command":
          handle.current?.command(message.name);
          break;
      }
    });
    bridge.send({ type: "ready", version: BRIDGE_VERSION });
    return stop;
  }, [bridge, directory]);

  // The document's height, for a WebView sized to its content (once a frame, when it changed).
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    let last = -1;
    let frame = 0;
    const report = () => {
      frame = 0;
      const px = Math.round(document.documentElement.scrollHeight);
      if (px === last) return;
      last = px;
      bridge.send({ type: "height", px });
    };
    const observer = new ResizeObserver(() => {
      if (!frame) frame = requestAnimationFrame(report);
    });
    observer.observe(document.body);
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [bridge]);

  if (!session) return null;
  return <PageEditor key={session.key} env={env} saver={session.sink} links={links} initialLine={session.caretLine} handle={handle} onTitle={() => bridge.send({ type: "focusTitle" })} className="mobile-editor" />;
}
