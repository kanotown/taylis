/**
 * M153a (WIKI.md §30.3): `?dev=1` — a stand-in for the native side, so the bundled editor can be tried in a desktop
 * browser (`npm run preview:mobile-editor`, then /?dev=1) and measured over CDP. It answers `ready` with a sample page,
 * people and emoji, `needPages` with sample pages, `pickImage` with a small picture, and logs what the page sends.
 * `window.__taylis` has what the console and the measuring script use: `sent`, `receive`, `loadSample`,
 * `measureLoad(body)` (the time from `load` to the frame after the editor is up) and `frames` (each transaction's
 * time to the next frame, for typing latency). `?dev=1&quiet=1` installs it without loading the sample.
 */
import type { Bridge, Transport, WebMessage } from "../../../shared/mobile-editor/src/bridge";

export interface DevHarness {
  sent: WebMessage[];
  receive(raw: unknown): void;
  loadSample(): void;
  measureLoad(body: string): Promise<number>;
  /** Each transaction's time to the next animation frame, in ms, since the last `load`. */
  frames: number[];
  sample: string;
}

export const SAMPLE_BODY = [
  "# 試作のページ",
  "",
  "同梱したエディタを **太字**・_斜体_・`code`・$e^{i\\pi}+1=0$ で確かめる。:smile: :lab:",
  "",
  "- 箇条書き",
  "  - 2 段目",
  "1. 番号",
  "- [ ] やること <@0190a2b4-0000-7000-8000-0000000000e2>",
  "",
  "::: callout 💡",
  "コールアウトの中の行。[設計メモ](page:0190a2b4-0000-7000-8000-0000000000c1)",
  ":::",
  "",
  "| 列 | 値 |",
  "| --- | --- |",
  "| a | 1 |",
  "",
  "$$",
  "\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2}",
  "$$",
  "",
  "![写真](attachment:0190a2b4-0000-7000-8000-00000000a001)",
  "",
  "::: toggle 開いて読む",
  "トグルの中。",
  ":::",
  "",
  "> 引用",
  "",
  "```",
  "code block",
  "```",
  "",
].join("\n");

const SAMPLE_PAGES = [
  { id: "0190a2b4-0000-7000-8000-0000000000c1", title: "設計メモ", icon: "📐", kind: "page" as const },
  { id: "0190a2b4-0000-7000-8000-0000000000c2", title: "議事録 2026-10", icon: null, kind: "page" as const },
  { id: "0190a2b4-0000-7000-8000-0000000000c3", title: "機材台帳", icon: "🔧", kind: "database" as const },
];

const SAMPLE_PEOPLE = [
  { id: "0190a2b4-0000-7000-8000-0000000000e2", username: "hanako", display_name: "花子" },
  { id: "0190a2b4-0000-7000-8000-0000000000e3", username: "taro", display_name: "太郎" },
  { id: "0190a2b4-0000-7000-8000-0000000000e9", username: "assistant", display_name: "アシスタント", ai: true },
  { id: "0190a2b4-0000-7000-8000-0000000000f1", username: "m2", display_name: "M2", kind: "group" as const, members: 4, description: "修士 2 年" },
];

/** A 2 × 2 PNG (blue), as a picked picture. */
const SAMPLE_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAD0lEQVR4nGNgYPjPwMDwHwADAgH/9mF6iQAAAABJRU5ErkJggg==";
/** Where the sample's `attachment:` images "load" from: a grey SVG that names the id (the `{id}` of load.attachmentUrl). */
const SAMPLE_ATTACHMENT_URL = "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='120'%3E%3Crect width='100%25' height='100%25' fill='%2390a4ae'/%3E%3Ctext x='8' y='64' font-size='11' fill='white'%3E{id}%3C/text%3E%3C/svg%3E";

/** The harness: its transport goes into `createBridge`; `attach` the bridge once it exists. */
export function createDevHarness(win: Window & { __taylis?: DevHarness }, options: { quiet: boolean }): { transport: Transport; attach(bridge: Bridge): DevHarness } {
  const sent: WebMessage[] = [];
  let bridge: Bridge | null = null;
  const frames: number[] = [];
  const react = (message: WebMessage) => {
    const level = message.type === "log" ? message.level : "debug";
    // A body is logged by its length (printing 100,000 characters to the console would cost more than the editor).
    const shown = "body" in message ? { ...message, body: `${message.body.length} chars` } : message;
    (console[level === "debug" ? "debug" : level] as (...args: unknown[]) => void)("taylis editor →", shown);
    if (!bridge) return;
    switch (message.type) {
      case "ready":
        if (!options.quiet) harness.loadSample();
        break;
      case "needPages": {
        const q = message.query.toLowerCase();
        setTimeout(() => bridge?.receive({ type: "providePages", query: message.query, pages: SAMPLE_PAGES.filter((page) => !q || page.title.toLowerCase().includes(q)) }), 50);
        break;
      }
      case "pickImage":
        setTimeout(() => bridge?.receive({ type: "insertImage", attachmentId: `0190a2b4-0000-7000-8000-0000${Date.now().toString(16).slice(-8)}`, url: SAMPLE_IMAGE, alt: "" }), 200);
        break;
      default:
        break;
    }
  };
  const transport: Transport = {
    kind: "dev",
    post: (json) => {
      const message = JSON.parse(json) as WebMessage;
      sent.push(message);
      react(message);
    },
  };
  /** The editor's transactions, each timed to the next frame (typing latency, WIKI.md §27.6). */
  const watchFrames = () => {
    const dom = win.document.querySelector(".page-editor") as (Element & { editor?: { on(event: "transaction", fn: () => void): void } }) | null;
    dom?.editor?.on("transaction", () => {
      const started = performance.now();
      requestAnimationFrame(() => frames.push(performance.now() - started));
    });
  };
  const harness: DevHarness = {
    sent,
    frames,
    sample: SAMPLE_BODY,
    receive: (raw) => bridge?.receive(raw),
    loadSample: () => {
      bridge?.receive({ type: "load", body: SAMPLE_BODY, title: "試作のページ", attachmentUrl: SAMPLE_ATTACHMENT_URL });
      bridge?.receive({ type: "providePeople", people: SAMPLE_PEOPLE });
      bridge?.receive({ type: "provideEmoji", emoji: [{ name: "lab", url: SAMPLE_IMAGE, label: "研究室", width: 2, height: 2 }, { name: "ok", label: "OK", kind: "text", color: "green" }] });
      bridge?.receive({ type: "setViewport", keyboardHeight: 0 });
      watchFrames();
    },
    measureLoad: (body) =>
      new Promise((resolve) => {
        frames.length = 0;
        const started = performance.now();
        bridge?.receive({ type: "load", body });
        requestAnimationFrame(() => requestAnimationFrame(() => {
          watchFrames();
          resolve(performance.now() - started);
        }));
      }),
  };
  return {
    transport,
    attach(next) {
      bridge = next;
      win.__taylis = harness;
      return harness;
    },
  };
}
