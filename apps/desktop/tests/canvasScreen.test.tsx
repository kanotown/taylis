// @vitest-environment jsdom
/**
 * M43 (CANVAS.md §4.1 / §5): a conversation's 「キャンバス」 on the real MainScreen, a real SyncEngine and the fake server —
 * the tab in the header (wide) and in the conversation's tab row (phone), a canvas from a template, the editor saving
 * after the pause, someone else's save showing up, a member who may only tick, the conflict choice, and the trash.
 * The save loop runs with short pauses here (its timing is tests/canvasSave.test.ts's).
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { COMPACT_QUERY } from "../src/ui/compact";
import { MainScreen } from "../src/ui/MainScreen";
import { FakeServer } from "./fakeServer";

let compact = false;

beforeEach(() => {
  compact = false;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? compact : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const TASKS = "# 学会準備\n- [ ] 参加登録\n- [ ] 旅費申請\n- [ ] 予稿";

/** Channel #lab of alice with bob in it; bob is on this device, the channel open. */
async function setup() {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channelId = server.createChannel("lab", alice.id).id;
  server.join(channelId, bob.id);
  server.post(channelId, alice.id, "こんにちは");
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
  return { server, alice, bob, channelId, store, engine, controller };
}

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

/** Real time passes (the save loop's short pauses), then React settles. */
const settle = (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const canvasTab = () => screen.getByRole("tab", { name: "キャンバス" });
const editor = () => screen.queryByRole("textbox", { name: /キャンバスの本文/ }) as HTMLTextAreaElement | null;
const saveState = () => document.querySelector("[data-save-state]")?.getAttribute("data-save-state") ?? null;
const bodyOf = (server: FakeServer, canvasId: string) => server.canvases.get(canvasId)!.canvas.body;
const type = async (value: string) => {
  fireEvent.change(editor()!, { target: { value } });
  await settle(80); // the pause, the PUT, its answer
};
async function openCanvasTab() {
  fireEvent.click(canvasTab());
  await settle(20);
}

it("wide: 「メッセージ | キャンバス」 in the header; a canvas from a template; the editor saves after the pause", async () => {
  const { server, channelId } = await setup();
  expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["メッセージ", "キャンバス"]);
  await openCanvasTab();
  expect(screen.getByText("この会話にはまだキャンバスがありません")).toBeTruthy();
  expect(document.querySelector(".timeline")?.closest("[inert]")).toBeTruthy(); // the conversation is covered, not read

  fireEvent.click(screen.getByRole("button", { name: /キャンバスを作成/ }));
  await settle(10);
  const dialog = screen.getByRole("dialog", { name: "新しいキャンバス" });
  fireEvent.click(within(dialog).getByRole("radio", { name: /議事録/ }));
  expect((within(dialog).getByRole("checkbox", { name: /会話のキャンバスにする/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(dialog).getByRole("button", { name: "作成" }));
  await settle(30);
  const [canvas] = server.listCanvases(server.userByName("bob").id, channelId);
  expect(canvas).toMatchObject({ title: "議事録 2026-10-01 (木)", is_channel_tab: true, template_key: "minutes" });
  expect(editor()!.value).toBe("# 議事録 2026-10-01 (木)\n## 決定事項\n\n## TODO\n- [ ] 担当 @ / 期限 📅\n");
  expect(saveState()).toBe("saved");

  fireEvent.change(editor()!, { target: { value: editor()!.value + "- [ ] 予稿 @alice\n" } });
  expect(saveState()).toBe("editing");
  await settle(80);
  // Stored with the mention as a token; shown as @alice.
  expect(bodyOf(server, canvas!.id)).toBe(`# 議事録 2026-10-01 (木)\n## 決定事項\n\n## TODO\n- [ ] 担当 @ / 期限 📅\n- [ ] 予稿 <@${server.userByName("alice").id}>\n`);
  expect(editor()!.value.endsWith("- [ ] 予稿 @alice\n")).toBe(true);
  expect(saveState()).toBe("saved");
  // The preview beside it renders the tasks.
  expect(within(screen.getByLabelText("キャンバスのプレビュー")).getAllByRole("checkbox")).toHaveLength(2);

  // Back to the messages: the tab comes back as it was left.
  fireEvent.click(screen.getByRole("tab", { name: "メッセージ" }));
  await settle();
  expect(document.querySelector(".timeline")?.closest("[inert]")).toBeNull();
});

it("phone: 「キャンバス」 in the conversation's tab row; someone else's save shows up while reading", async () => {
  compact = true;
  const { server, alice, channelId } = await setup();
  const canvas = server.createCanvas(alice.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body: TASKS, title: "学会準備" });
  fireEvent.click(screen.getByTitle("#lab"));
  await settle(20);
  expect(within(screen.getByRole("tablist", { name: "会話の表示" })).getAllByRole("tab").map((t) => t.textContent)).toEqual(["メッセージ", "キャンバス", "ピン留め", "ファイル"]);
  await openCanvasTab();
  // A phone opens it to read (the editor is a tap away).
  expect(editor()).toBeNull();
  expect(screen.getByRole("heading", { level: 1, name: "学会準備" })).toBeTruthy();
  expect(screen.getByText("旅費申請")).toBeTruthy();

  server.saveCanvas(alice.id, canvas.id, { base_rev_id: canvas.head_rev_id, body: TASKS + "\n- [ ] 発表練習", client_save_id: crypto.randomUUID(), on_conflict: "fail" });
  await settle(60); // canvas.updated → GET (If-None-Match) → the new body
  expect(screen.getByText("発表練習")).toBeTruthy();

  fireEvent.click(screen.getByRole("tab", { name: "編集" }));
  await settle();
  expect(editor()!.value).toBe(TASKS + "\n- [ ] 発表練習");
});

it("a member who may only tick (edit_policy owners): no editor, the reason, and a tick is saved", async () => {
  const { server, alice, channelId } = await setup();
  const canvas = server.createCanvas(alice.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body: TASKS, title: "学会準備" });
  server.updateCanvas(alice.id, canvas.id, { edit_policy: "owners" });
  await openCanvasTab();
  expect(screen.queryByRole("tab", { name: "編集" })).toBeNull();
  expect(editor()).toBeNull();
  expect(screen.getByText(/チェックだけ付けられます/)).toBeTruthy();
  // M44: ⋯ is there for everyone (share, link, history), but no title / settings / trash for bob.
  fireEvent.keyDown(screen.getByRole("button", { name: "キャンバスの操作" }), { key: "Enter" });
  await settle();
  expect(screen.getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(["会話に共有", "リンクをコピー", "履歴…"]);
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await settle();

  fireEvent.click(screen.getAllByRole("checkbox", { name: "完了にする" })[1]!);
  await settle(40);
  expect(bodyOf(server, canvas.id)).toBe("# 学会準備\n- [ ] 参加登録\n- [x] 旅費申請\n- [ ] 予稿");
  expect(screen.getByRole("checkbox", { name: "完了を取り消す" })).toBeTruthy();
  expect(saveState()).toBe("saved");
});

it("the same words changed by someone else: 自分の版 / 相手の版 / 両方残す, and 自分の版 wins", async () => {
  const { server, alice, channelId } = await setup();
  const body = "# 議事録\n来週までに研究計画を提出する。\n";
  const canvas = server.createCanvas(alice.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body, title: "議事録" });
  await openCanvasTab();
  expect(editor()!.value).toBe(body);
  server.holdEvents = true; // alice's save arrives while bob types (its event later)
  server.saveCanvas(alice.id, canvas.id, { base_rev_id: canvas.head_rev_id, body: body.replace("研究計画", "発表資料"), client_save_id: crypto.randomUUID(), on_conflict: "fail" });
  await type(body.replace("研究計画", "予稿"));
  const dialog = screen.getByRole("dialog", { name: "同じ箇所がほかの人にも変更されました" });
  expect(within(dialog).getByText("来週までに予稿を提出する。")).toBeTruthy();
  expect(within(dialog).getByText("来週までに発表資料を提出する。")).toBeTruthy();
  expect(within(dialog).getAllByRole("button").map((b) => b.textContent)).toEqual(expect.arrayContaining(["自分の版", "相手の版", "両方残す", "あとで"]));
  expect(saveState()).toBe("conflict");
  fireEvent.click(within(dialog).getByRole("button", { name: "自分の版" }));
  await settle(40);
  server.holdEvents = false;
  server.release();
  await settle(40);
  expect(bodyOf(server, canvas.id)).toBe(body.replace("研究計画", "予稿"));
  expect(editor()!.value).toBe(body.replace("研究計画", "予稿"));
  expect(saveState()).toBe("saved");
});

it("to the trash from ⋯ and back from 「ゴミ箱」", async () => {
  const { server, bob, channelId } = await setup();
  const canvas = server.createCanvas(bob.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: false, body: "メモ", title: "自分のメモ" });
  await openCanvasTab();
  fireEvent.keyDown(screen.getByRole("button", { name: "キャンバスの操作" }), { key: "Enter" });
  await settle();
  fireEvent.click(screen.getByRole("menuitem", { name: /ゴミ箱に移す/ }));
  await settle(20);
  expect(server.canvases.get(canvas.id)!.deleted).toBe(true);
  expect(screen.getByText("この会話にはまだキャンバスがありません")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: /ゴミ箱/ }));
  await settle(20);
  const trash = screen.getByRole("dialog", { name: "キャンバスのゴミ箱" });
  expect(within(trash).getByText("自分のメモ")).toBeTruthy();
  fireEvent.click(within(trash).getByRole("button", { name: /戻す/ }));
  await settle(30);
  expect(server.canvases.get(canvas.id)!.deleted).toBe(false);
  expect(screen.queryByRole("dialog", { name: "キャンバスのゴミ箱" })).toBeNull();
  expect(editor()!.value).toBe("メモ");
});
