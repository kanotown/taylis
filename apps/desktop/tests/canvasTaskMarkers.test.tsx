// @vitest-environment jsdom
/**
 * M80 (CANVAS.md §22): the hidden task markers of checklist items — the cases the three clients share
 * (apps/shared/canvas_task_markers.json), and on the real MainScreen: neither the preview nor the editor shows them, an
 * edit keeps them (at the end of their line), and 「タスクにする」 names the item without its marker.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { deleteBesideStandIns, stripStandIns, stripTaskMarkers, TaskMarkerTable, taskMarkerIds } from "../src/ui/canvasMarkers";
import { checklistItem } from "../src/ui/canvasTasks";
import { COMPACT_QUERY } from "../src/ui/compact";
import { type Block, parseBlocks, type Token } from "../src/ui/markdown";
import { MainScreen } from "../src/ui/MainScreen";
import { FakeServer } from "./fakeServer";

interface Fixture {
  strip: Array<{ text: string; expected: string }>;
  blocks: Array<{ name: string; body: string; blocks: unknown[] }>;
  editor: Array<{ name: string; wire: string; shown: string; edited: string; expected: string }>;
  delete: Array<{ text: string; backward: boolean; expected: string | null }>;
}

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "canvas_task_markers.json"), "utf8")) as Fixture;

/** ⟦n⟧ → the editor's stand-in n (U+E0020 + n). */
const standIns = (text: string) => text.replace(/⟦(\d+)⟧/g, (_, n: string) => String.fromCodePoint(0xe0020 + Number(n)));
const text = (tokens: Token[]): string => tokens.map((t) => ("text" in t ? t.text : t.kind === "link" ? t.label ?? t.url : "")).join("");
function describeBlock(block: Block): unknown {
  switch (block.kind) {
    case "heading":
      return { kind: "heading", level: block.level, text: text(block.tokens) };
    case "paragraph":
      return { kind: "paragraph", lines: block.lines.map(text) };
    case "list":
      return { kind: "list", ordered: block.ordered, items: block.items.map((item) => text(item.tokens)) };
    case "task":
      return { kind: "task", items: block.items.map((item) => ({ level: item.level, done: item.done, text: text(item.tokens), line: item.line })) };
    default:
      return { kind: block.kind };
  }
}

describe("task markers (apps/shared/canvas_task_markers.json)", () => {
  it.each(fixture.strip.map((c, i) => [i, c] as const))("strip %i", (_i, c) => {
    expect(stripTaskMarkers(c.text)).toBe(c.expected);
  });

  it.each(fixture.blocks.map((c) => [c.name, c] as const))("view: %s", (_name, c) => {
    expect(parseBlocks(c.body, { canvas: true }).map(describeBlock)).toEqual(c.blocks);
  });

  it.each(fixture.editor.map((c) => [c.name, c] as const))("editor: %s", (_name, c) => {
    const table = new TaskMarkerTable();
    expect(table.hide(c.wire)).toBe(standIns(c.shown));
    expect(table.show(standIns(c.edited))).toBe(c.expected);
  });

  it.each(fixture.delete.map((c, i) => [i, c] as const))("delete %i", (_i, c) => {
    const at = standIns(c.text);
    const caret = at.indexOf("|");
    const result = deleteBesideStandIns(at.replace("|", ""), caret, c.backward);
    if (c.expected === null) expect(result).toBeNull();
    else expect(result && result.text.slice(0, result.caret) + "|" + result.text.slice(result.caret)).toBe(standIns(c.expected));
  });
});

describe("the editor's table", () => {
  it("gives the same id the same stand-in, and leaves markers past 95 as text", () => {
    const table = new TaskMarkerTable();
    const id = (n: number) => `0190a2b4-0000-7000-8000-${String(n).padStart(12, "0")}`;
    const wire = Array.from({ length: 96 }, (_, n) => `- [ ] ${n} <!--task:${id(n)}-->`).join("\n");
    const shown = table.hide(wire);
    expect(shown.split("\n")[95]).toBe(`- [ ] 95 <!--task:${id(95)}-->`);
    expect(stripStandIns(shown.split("\n")[0]!)).toBe("- [ ] 0");
    expect(table.show(shown)).toBe(wire);
    expect(table.hide(`x <!--task:${id(3)}-->`)).toBe(`x${String.fromCodePoint(0xe0023)}`);
    expect(taskMarkerIds(wire).length).toBe(96);
  });

  it("「タスクにする」: the item's text without the marker, the line as stored", () => {
    const line = "- [ ] 予稿 <!--task:0190a2b4-0000-7000-8000-000000000001-->";
    expect(checklistItem(`# TODO\n${line}`, 1)).toEqual({ line, text: "予稿", done: false });
  });
});

// --- on the screen -------------------------------------------------------------------------------------------------

beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? false : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

function Screen({ controller, store, engine }: { controller: AppController; store: Store; engine: SyncEngine }) {
  useSyncExternalStore(
    (listener) => {
      const subs = [controller.subscribe(listener), store.subscribe(listener), engine.subscribe(listener)];
      return () => subs.forEach((unsubscribe) => unsubscribe());
    },
    () => `${controller.version}:${store.version}:${engine.status}`,
  );
  return <MainScreen controller={controller} />;
}

const MARKER = "<!--task:0190a2b4-0000-7000-8000-000000000001-->";

it("neither the preview nor the editor shows a marker; an edit keeps it at the end of its line", async () => {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channelId = server.createChannel("lab", alice.id).id;
  server.join(channelId, bob.id);
  const canvas = server.createCanvas(alice.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body: `# TODO\n- [ ] 予稿 ${MARKER}\n- [ ] ほか`, title: "議事録" });
  const store = new Store();
  const inner = server.apiFor(bob.id);
  const engine = new SyncEngine(
    { api: inner, connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {}, random: () => 0.5, isActive: () => true },
    { reconnectMinMs: 0, canvasSave: { debounceMs: 30, refreshDebounceMs: 10, retryDelaysMs: [20] } },
  );
  const api = new Proxy({ ...inner, baseUrl: "http://server" } as unknown as Record<string, unknown>, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await engine.start();
  await engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store, engine, me: store.me, leaving: false };
  render(<Screen controller={controller} store={store} engine={engine} />);
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: "キャンバス" }));
  await settle(30);

  const preview = screen.getByLabelText("キャンバスのプレビュー");
  expect(preview.textContent).toContain("予稿");
  expect(preview.textContent).not.toContain("task");
  const editor = screen.getByRole("textbox", { name: /キャンバスの本文/ }) as HTMLTextAreaElement;
  expect(editor.value).not.toContain("task");
  expect(stripStandIns(editor.value)).toBe("# TODO\n- [ ] 予稿\n- [ ] ほか");

  // Typing after the item (past its invisible stand-in) and swapping the lines: the marker follows its item.
  const [head, item, other] = editor.value.split("\n");
  fireEvent.change(editor, { target: { value: [head, other, `${item} を出す`].join("\n") } });
  await settle(80);
  expect(server.canvases.get(canvas.id)!.canvas.body).toBe(`# TODO\n- [ ] ほか\n- [ ] 予稿 を出す ${MARKER}`);
  expect(within(screen.getByLabelText("キャンバスのプレビュー")).queryByText(/task/)).toBeNull();
});
