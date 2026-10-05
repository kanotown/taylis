// @vitest-environment jsdom
/**
 * M44 (CANVAS.md §4.8–§4.13, §5): the canvas's history (versions, the comparison, restore, a name, erasing a body), sharing
 * to the conversation and its /c/ card (a member opens it, others see 「メンバーではありません」), the comments as the
 * shared message's thread, images pasted into the editor, the search's 「キャンバス」 tab, the sidebar's 「キャンバス」 and
 * ⌘K, the administrators' templates, and the web tab closing — on the real MainScreen, a real SyncEngine and the fake
 * server.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { CanvasTemplatesTab } from "../src/ui/CanvasTemplatesTab";
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
  URL.createObjectURL = () => "blob:canvas-image";
  URL.revokeObjectURL = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const MINUTES = "# 議事録\n来週までに研究計画を提出する。\n- [ ] 資料";

/** Channel #lab of alice with bob in it; bob is on this device. */
async function setup(options: { bobOwner?: boolean; bobAdmin?: boolean; api?: Record<string, unknown>; seminar?: boolean } = {}) {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob", options.bobAdmin ? "admin" : "member");
  const channelId = server.createChannel("lab", alice.id).id;
  server.join(channelId, bob.id);
  // A second conversation of bob's, there from the start (the fake's join sends no event).
  const seminarId = options.seminar ? server.createChannel("seminar", alice.id).id : null;
  if (seminarId) server.join(seminarId, bob.id);
  if (options.bobOwner) server.roles.set(`${channelId}:${bob.id}`, "owner");
  server.post(channelId, alice.id, "こんにちは");
  const store = new Store();
  const inner = server.apiFor(bob.id);
  const engine = new SyncEngine(
    { api: inner, connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {}, random: () => 0.5, isActive: () => true },
    { reconnectMinMs: 0, canvasSave: { debounceMs: 30, refreshDebounceMs: 10, retryDelaysMs: [20] } },
  );
  const api = new Proxy({ ...inner, baseUrl: "http://server", ...options.api } as unknown as Record<string, unknown>, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await engine.start();
  await engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store, engine, me: store.me, leaving: false };
  render(<Screen controller={controller} store={store} engine={engine} />);
  await settle();
  return { server, alice, bob, channelId, seminarId, store, engine, controller };
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

const settle = (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
const editor = () => screen.queryByRole("textbox", { name: /キャンバスの本文/ }) as HTMLTextAreaElement | null;
const canvasTabSelected = () => screen.getByRole("tab", { name: "キャンバス" }).getAttribute("aria-selected") === "true";
async function openCanvasTab() {
  fireEvent.click(screen.getByRole("tab", { name: "キャンバス" }));
  await settle(20);
}
async function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
  await settle();
}

it("history: the versions, what changed (words of a touched-up line), a name, and restoring an older version", async () => {
  const { server, alice, channelId } = await setup();
  const canvas = server.createCanvas(alice.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body: MINUTES, title: "議事録" });
  server.saveCanvas(alice.id, canvas.id, { base_rev_id: canvas.head_rev_id, body: MINUTES.replace("研究計画", "予稿") + "\n- [ ] 練習", client_save_id: crypto.randomUUID(), on_conflict: "fail" });
  await openCanvasTab();
  fireEvent.click(screen.getByRole("button", { name: "履歴" }));
  await settle(20);
  const dialog = screen.getByRole("dialog", { name: "履歴：議事録" });
  const rows = within(dialog).getAllByRole("button").filter((b) => b.hasAttribute("data-revision"));
  expect(rows).toHaveLength(2);
  expect(rows[0]!.textContent).toContain("現在の版");
  expect(rows[0]!.textContent).toContain("+2");
  expect(rows[0]!.textContent).toContain("−1");
  expect(rows[1]!.textContent).toContain("作成");
  // The newest is selected and compared with the one before: the changed words are marked.
  expect([...dialog.querySelectorAll('[data-diff-line="add"] [data-changed]')].map((m) => m.textContent)).toEqual(["予稿"]);
  expect([...dialog.querySelectorAll('[data-diff-line="del"] [data-changed]')].map((m) => m.textContent)).toEqual(["研究計画"]);
  expect(dialog.querySelectorAll('[data-diff-line="add"]')).toHaveLength(2);
  // A member without the owners' rights sees no 「本文を消去」.
  expect(within(dialog).queryByRole("button", { name: /本文を消去/ })).toBeNull();

  // A name for the older version.
  fireEvent.click(rows[1]!);
  await settle(10);
  fireEvent.click(within(dialog).getByRole("button", { name: /名前を付ける/ }));
  await settle();
  const labelDialog = screen.getByRole("dialog", { name: "版に名前を付ける" });
  fireEvent.change(within(labelDialog).getByRole("textbox", { name: "版の名前" }), { target: { value: "  提出版 " } });
  fireEvent.click(within(labelDialog).getByRole("button", { name: "保存" }));
  await settle(10);
  const history = server.canvases.get(canvas.id)!.history;
  expect(history[0]!.label).toBe("提出版");
  expect(within(dialog).getByText("提出版")).toBeTruthy();

  // 「この版の本文」 shows it as it was; restoring asks first, then makes it a new version.
  fireEvent.click(within(dialog).getByRole("tab", { name: "この版の本文" }));
  await settle(10);
  expect(within(dialog).getByText("来週までに研究計画を提出する。")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: /この版に戻す/ }));
  await settle();
  const confirm = screen.getByRole("dialog", { name: "この版に戻しますか？" });
  fireEvent.click(within(confirm).getByRole("button", { name: "この版に戻す" }));
  await settle(60);
  const record = server.canvases.get(canvas.id)!;
  expect(record.canvas.body).toBe(MINUTES);
  expect(record.history.map((r) => r.kind)).toEqual(["create", "save", "restore"]);
  expect(server.revisionRestores).toHaveLength(1);
  // The list reads again: the restored version is now the current one.
  const after = within(screen.getByRole("dialog", { name: "履歴：議事録" })).getAllByRole("button").filter((b) => b.hasAttribute("data-revision"));
  expect(after).toHaveLength(3);
  expect(after[0]!.textContent).toContain("復元");
  expect(after[0]!.textContent).toContain("現在の版");
  // The editor shows the restored body once it reads the canvas again.
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await settle(40);
  expect(editor()!.value).toBe(MINUTES);
});

it("history: an owner erases an older version's body (asked first); the current one cannot be", async () => {
  const { server, alice, channelId } = await setup({ bobOwner: true });
  const canvas = server.createCanvas(alice.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body: "パスワード: hunter2", title: "メモ" });
  server.saveCanvas(alice.id, canvas.id, { base_rev_id: canvas.head_rev_id, body: "パスワードは消しました", client_save_id: crypto.randomUUID(), on_conflict: "fail" });
  await openCanvasTab();
  fireEvent.click(screen.getByRole("button", { name: "履歴" }));
  await settle(20);
  const dialog = screen.getByRole("dialog", { name: "履歴：メモ" });
  expect(within(dialog).queryByRole("button", { name: /本文を消去/ })).toBeNull(); // the current version is selected
  const rows = within(dialog).getAllByRole("button").filter((b) => b.hasAttribute("data-revision"));
  fireEvent.click(rows[1]!);
  await settle(10);
  fireEvent.click(within(dialog).getByRole("button", { name: /本文を消去/ }));
  await settle();
  const confirm = screen.getByRole("dialog", { name: "この版の本文を消去しますか？" });
  fireEvent.click(within(confirm).getByRole("button", { name: "消去する" }));
  await settle(20);
  expect(server.canvases.get(canvas.id)!.history[0]!.kind).toBe("erased");
  expect(within(dialog).getByText("この版の本文は消去されています。")).toBeTruthy();
  expect(within(dialog).queryByRole("button", { name: /この版に戻す/ })).toBeNull();
});

it("sharing: 「会話に共有」 posts the link; the message shows a card that opens the canvas; 「コメント」 opens its thread", async () => {
  const { server, bob, channelId } = await setup();
  const canvas = server.createCanvas(bob.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body: "- [x] 参加登録\n- [ ] 予稿", title: "学会準備" });
  await openCanvasTab();
  await openMenu("キャンバスの操作");
  fireEvent.click(screen.getByRole("menuitem", { name: /会話に共有/ }));
  await settle(40);
  const shared = server.canvases.get(canvas.id)!.canvas.share_message_id!;
  expect(shared).toBeTruthy();
  expect(server.channelMessages(channelId).at(-1)!.body).toBe(`📄 学会準備\nhttp://server/c/${canvas.id}`);
  // Shared already: no second 「会話に共有」.
  await openMenu("キャンバスの操作");
  expect(screen.queryByRole("menuitem", { name: /会話に共有/ })).toBeNull();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await settle();

  // The card in the conversation: title, conversation, progress; a click opens the canvas.
  fireEvent.click(screen.getByRole("tab", { name: "メッセージ" }));
  await settle(20);
  const card = document.querySelector(`[data-canvas-card="${canvas.id}"]`) as HTMLElement;
  expect(card.textContent).toContain("学会準備");
  expect(card.textContent).toContain("#lab");
  expect(card.textContent).toContain("1/2");
  fireEvent.click(card);
  await settle(20);
  expect(canvasTabSelected()).toBe(true);

  // 「コメント」: the shared message's thread beside the canvas.
  fireEvent.click(screen.getByRole("button", { name: "コメント" }));
  await settle(40);
  const thread = screen.getByLabelText("スレッドのメッセージ一覧");
  expect(thread.textContent).toContain("学会準備");
  expect(server.channelMessages(channelId).filter((m) => m.body.startsWith("📄"))).toHaveLength(1);
});

it("「コメント」 on a canvas never shared shares it first, then opens the thread", async () => {
  const { server, bob, channelId } = await setup();
  const canvas = server.createCanvas(bob.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body: "本文", title: "週報" });
  await openCanvasTab();
  fireEvent.click(screen.getByRole("button", { name: "コメント" }));
  await settle(60);
  expect(server.canvases.get(canvas.id)!.canvas.share_message_id).toBeTruthy();
  expect(screen.getByLabelText("スレッドのメッセージ一覧").textContent).toContain("📄 週報");
});

it("a /c/ link to a canvas of a conversation I am not in: 「メンバーではありません」, nothing of it", async () => {
  const { server, alice, channelId } = await setup();
  const secret = server.createChannel("secret", alice.id).id;
  const canvas = server.createCanvas(alice.id, secret, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body: "秘密の計画", title: "極秘" });
  server.post(channelId, alice.id, `これ見て http://server/c/${canvas.id}`);
  await settle(40);
  const card = document.querySelector(`[data-canvas-card="${canvas.id}"]`) as HTMLElement;
  expect(card.textContent).toContain("メンバーではありません");
  expect(card.textContent).not.toContain("極秘");
});

it("images: a pasted image is uploaded, put in as ![](attachment:…), drawn in the preview and saved; 100 is the limit", async () => {
  const { server, bob, channelId } = await setup();
  const canvas = server.createCanvas(bob.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body: "# 図\n", title: "図" });
  await openCanvasTab();
  const area = editor()!;
  area.focus();
  area.setSelectionRange(area.value.length, area.value.length);
  const file = new File(["png"], "figure.png", { type: "image/png" });
  fireEvent.paste(area, { clipboardData: { files: [file], types: ["Files"] } });
  await settle(80);
  const [upload] = [...server.uploads.values()];
  expect(upload).toMatchObject({ filename: "figure.png", content_type: "image/png" });
  expect(editor()!.value).toBe(`# 図\n![](attachment:${upload!.id})\n`);
  expect(server.canvases.get(canvas.id)!.canvas.body).toBe(`# 図\n![](attachment:${upload!.id})\n`);
  const preview = screen.getByLabelText("キャンバスのプレビュー");
  expect((within(preview).getByRole("img") as HTMLImageElement).src).toBe("blob:canvas-image");

  // At 100 images no more are uploaded; the error text says why.
  const full = Array.from({ length: 100 }, () => `![](attachment:${crypto.randomUUID()})`).join("\n");
  fireEvent.change(editor()!, { target: { value: full } });
  await settle(10);
  fireEvent.paste(editor()!, { clipboardData: { files: [file], types: ["Files"] } });
  await settle(20);
  expect(server.uploads.size).toBe(1);
  expect(screen.getByText("1 つのキャンバスに入れられる画像・ファイルは 100 件までです")).toBeTruthy();
});

it("「キャンバス」 in the sidebar lists the canvases of all my conversations; a row, ⌘K and a search hit open one", async () => {
  const { server, alice, channelId, seminarId } = await setup({ seminar: true });
  const weekly = server.createCanvas(alice.id, seminarId!, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: false, body: "今週は実験の準備をした", title: "週報 第40週" });
  server.createCanvas(alice.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body: "ルール", title: "研究室のしおり" });

  fireEvent.click(screen.getByRole("button", { name: "キャンバス" }));
  await settle(20);
  const list = screen.getByRole("list", { name: "キャンバス" });
  expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual([expect.stringContaining("研究室のしおり"), expect.stringContaining("週報 第40週")]);
  fireEvent.click(within(list).getByRole("button", { name: /週報 第40週/ }));
  await settle(30);
  expect(canvasTabSelected()).toBe(true);
  expect(screen.getByRole("button", { name: "キャンバスの一覧" }).textContent).toContain("週報 第40週");
  expect(document.querySelector("header strong")?.textContent).toBe("seminar");

  // ⌘K: a canvas by its title.
  fireEvent.keyDown(window, { key: "k", metaKey: true });
  await settle(20);
  fireEvent.change(screen.getByPlaceholderText("チャンネル・相手・キャンバスの名前で移動…"), { target: { value: "しおり" } });
  await settle();
  const option = screen.getByRole("option", { name: /研究室のしおり/ });
  fireEvent.click(option);
  await settle(30);
  expect(document.querySelector("header strong")?.textContent).toBe("lab");
  expect(screen.getByRole("button", { name: "キャンバスの一覧" }).textContent).toContain("研究室のしおり");

  // The body searched from the list: the search's 「キャンバス」 tab, a hit with its excerpt, 「検索結果に戻る」.
  fireEvent.click(screen.getByRole("button", { name: "キャンバス" }));
  await settle(20);
  const filter = screen.getByRole("textbox", { name: "題名で絞り込む" });
  fireEvent.change(filter, { target: { value: "実験" } });
  fireEvent.keyDown(filter, { key: "Enter" });
  await settle(30);
  expect(screen.getByRole("tab", { name: "キャンバス", selected: true })).toBeTruthy();
  expect(server.canvasSearches.at(-1)).toMatchObject({ q: "実験" });
  const hit = document.querySelector(`[data-canvas-hit="${weekly.id}"]`) as HTMLElement;
  expect(hit.querySelector("mark")?.textContent).toBe("実験");
  fireEvent.click(hit);
  await settle(30);
  expect(canvasTabSelected()).toBe(true);
  expect(screen.getByRole("button", { name: /検索結果に戻る/ })).toBeTruthy();
});

it("the web tab closing: typed text goes out on a keepalive request (pagehide), and nothing asks to stay", async () => {
  const keepalive = vi.fn();
  const { server, bob, channelId } = await setup({ api: { saveCanvasKeepalive: keepalive } });
  const canvas = server.createCanvas(bob.id, channelId, { client_save_id: crypto.randomUUID(), share_to_channel: false, as_tab: true, body: "本文", title: "メモ" });
  await openCanvasTab();
  fireEvent.change(editor()!, { target: { value: "本文\n閉じる直前" } });
  const before = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(before);
  expect(before.defaultPrevented).toBe(false);
  window.dispatchEvent(new Event("pagehide"));
  expect(keepalive).toHaveBeenCalledTimes(1);
  const [canvasId, body] = keepalive.mock.calls[0]!;
  expect(canvasId).toBe(canvas.id);
  expect(body).toMatchObject({ body: "本文\n閉じる直前", base_rev_id: canvas.head_rev_id, on_conflict: "fail" });
  await settle(60); // the page lived on: the same save, once
  expect(server.canvasSaveRequests.map((r) => r.client_save_id)).toEqual([body.client_save_id]);
});

it("管理 → キャンバス：templates hidden (built-in ones are not deleted), added and deleted", async () => {
  const server = new FakeServer();
  const admin = server.addUser("admin", "admin");
  const setError = vi.fn();
  const controller = { api: server.apiFor(admin.id), setError } as unknown as AppController;
  render(<CanvasTemplatesTab controller={controller} />);
  await settle(10);
  const row = () => document.querySelector('[data-template="minutes"]') as HTMLElement;
  expect(row().textContent).toContain("議事録");
  expect(row().textContent).toContain("組み込み");
  expect(within(row()).queryByRole("button", { name: "削除" })).toBeNull();
  fireEvent.click(within(row()).getByRole("button", { name: "非表示にする" }));
  await settle(10);
  expect(server.canvasTemplates[0]!.hidden).toBe(true);
  expect(row().textContent).toContain("非表示");

  fireEvent.click(screen.getByRole("button", { name: /追加/ }));
  await settle();
  const dialog = screen.getByRole("dialog", { name: "テンプレートを追加" });
  fireEvent.change(within(dialog).getByLabelText("名前"), { target: { value: "ゼミ発表" } });
  fireEvent.change(within(dialog).getByLabelText("キャンバスの題名"), { target: { value: "ゼミ発表 {{date}}" } });
  fireEvent.change(within(dialog).getByRole("textbox", { name: "本文（Markdown）" }), { target: { value: "# 発表者\n" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "追加" }));
  await settle(10);
  const added = server.canvasTemplates.find((t) => t.name === "ゼミ発表")!;
  expect(added).toMatchObject({ title: "ゼミ発表 {{date}}", body: "# 発表者\n", builtin: false });
  const addedRow = document.querySelector(`[data-template="${added.key}"]`) as HTMLElement;
  fireEvent.click(within(addedRow).getByRole("button", { name: "削除" }));
  await settle();
  fireEvent.click(within(screen.getByRole("dialog", { name: "「ゼミ発表」を削除しますか？" })).getByRole("button", { name: "削除する" }));
  await settle(10);
  expect(server.canvasTemplates.some((t) => t.name === "ゼミ発表")).toBe(false);
  expect(setError).not.toHaveBeenCalled();
});
