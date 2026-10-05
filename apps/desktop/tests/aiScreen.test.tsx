// @vitest-environment jsdom
/**
 * M65 (docs/AI.md §6, Desktop / Web): the AI entry points on the real MainScreen, a real SyncEngine and the fake server —
 * the channel ⋯ 「要約」 and the thread ⋯ 「このスレッドを要約」 with the dialog following the run, the errors in
 * Japanese, the 「AI」 badge on a bot's posts and in the mention list, the members notice (§4), and nothing of it on a
 * server without AI (404).
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import { ApiError } from "../src/api/errors";
import { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { COMPACT_QUERY } from "../src/ui/compact";
import { MainScreen } from "../src/ui/MainScreen";
import { FakeServer } from "./fakeServer";

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

/** #lab of alice with bob (on this device) and the AI bot ちくわ in it, plus a webhook bot's post. */
async function setup(options: { aiMissing?: boolean } = {}) {
  const server = new FakeServer();
  server.aiMissing = !!options.aiMissing;
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channelId = server.createChannel("lab", alice.id).id;
  server.join(channelId, bob.id);
  const agent = server.createAiAgent({ username: "ai-chikuwa", name: "ちくわ", character: "先輩", model: "claude-opus-5-5" });
  server.join(channelId, agent.bot_user_id);
  const hook = server.addUser("ci-hook");
  hook.role = "bot";
  hook.display_name = "CI";
  server.join(channelId, hook.id);
  server.post(channelId, alice.id, "質問です");
  server.post(channelId, agent.bot_user_id, "AI の返事");
  server.post(channelId, hook.id, "ビルド成功");
  const store = new Store();
  const inner = server.apiFor(bob.id);
  const engine = new SyncEngine(
    { api: inner, connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {}, random: () => 0.5, isActive: () => true },
    { reconnectMinMs: 0 },
  );
  const target = {
    ...inner,
    baseUrl: "http://server",
    members: async (id: string) => [...server.channels.get(id)!.members].map((user_id) => ({ user_id, role: "member", joined_at: "2026-01-01T00:00:00Z" })),
  } as unknown as Record<string, unknown>;
  const api = new Proxy(target, { get: (t, key: string) => t[key] ?? (async () => []) }) as unknown as ApiClient;
  await engine.start();
  await engine.idle();
  await settle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store, engine, me: store.me, leaving: false };
  render(<Screen controller={controller} store={store} engine={engine} />);
  await settle();
  return { server, alice, bob, agent, channelId, store, engine, controller };
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

async function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
  await settle();
}

const dialog = () => screen.getByRole("dialog");

it("channel ⋯ 「要約」: the dialog shows the progress, then the Markdown and the omitted note", async () => {
  const { server } = await setup();
  await openMenu("チャンネルの操作");
  const items = screen.getAllByRole("menuitem").map((item) => item.textContent);
  expect(items).toEqual(expect.arrayContaining(["未読を要約", "直近 1 日を要約", "直近 7 日を要約"]));
  fireEvent.click(screen.getByRole("menuitem", { name: "直近 7 日を要約" }));
  await settle();
  expect(within(dialog()).getByText("直近 7 日の要約")).toBeTruthy();
  expect(within(dialog()).getByText("要約を準備しています…")).toBeTruthy();
  const run = server.lastAiRun()!;
  expect(run).toMatchObject({ scope: "recent", days: 7, thread_id: null });

  server.updateAiRun(run.id, { status: "running" });
  await settle();
  expect(within(dialog()).getByText("要約を書いています…")).toBeTruthy();

  server.updateAiRun(run.id, { status: "done", output: "**決まったこと**: 来週に発表\n- 資料は金曜まで", omitted_count: 2, finished_at: new Date().toISOString() });
  await settle();
  expect(within(dialog()).getByText("決まったこと").tagName).toBe("STRONG");
  expect(within(dialog()).getByText("資料は金曜まで")).toBeTruthy();
  expect(within(dialog()).getByText("長すぎるため、古い 2 件は省きました")).toBeTruthy();

  fireEvent.click(within(dialog()).getAllByRole("button", { name: "閉じる" }).at(-1)!);
  await settle();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("errors in Japanese, and 「もう一度」", async () => {
  const { server } = await setup();
  server.aiRefuseNext = new ApiError(429, "ai_daily_limit", "limit");
  await openMenu("チャンネルの操作");
  fireEvent.click(screen.getByRole("menuitem", { name: "未読を要約" }));
  await settle();
  expect(within(dialog()).getByRole("alert").textContent).toContain("今日の AI の利用回数の上限に達しました");
  fireEvent.click(within(dialog()).getByRole("button", { name: /もう一度/ }));
  await settle();
  expect(within(dialog()).getByText("要約を準備しています…")).toBeTruthy();
  const run = server.lastAiRun()!;
  server.updateAiRun(run.id, { status: "failed", error: "API のエラー" });
  await settle();
  expect(within(dialog()).getByRole("alert").textContent).toBe("要約できませんでした: API のエラー");
});

it("thread ⋯ 「このスレッドを要約」", async () => {
  const { server, alice, channelId } = await setup();
  const parent = server.post(channelId, alice.id, "スレッドの親").message;
  server.post(channelId, alice.id, "返信", undefined, parent.id);
  await settle();
  fireEvent.click(screen.getAllByTestId("thread-summary").at(-1)!);
  await settle();
  await openMenu("スレッドの操作");
  fireEvent.click(screen.getByRole("menuitem", { name: "このスレッドを要約" }));
  await settle();
  expect(within(dialog()).getByText("スレッドの要約")).toBeTruthy();
  expect(server.lastAiRun()).toMatchObject({ scope: "thread", thread_id: parent.id });
});

it("the 「AI」 badge on the AI bot's posts (BOT for the others) and in the mention list", async () => {
  await setup();
  const aiRow = screen.getByText("AI の返事").closest("article")!;
  expect(within(aiRow).getByText("AI")).toBeTruthy();
  expect(within(aiRow).queryByText("BOT")).toBeNull();
  const hookRow = screen.getByText("ビルド成功").closest("article")!;
  expect(within(hookRow).getByText("BOT")).toBeTruthy();

  const box = screen.getAllByRole("textbox").find((el) => el.tagName === "TEXTAREA") as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: "@ai-", selectionStart: 4, selectionEnd: 4 } });
  box.setSelectionRange(4, 4);
  fireEvent.select(box);
  await settle();
  const option = screen.getByText("@ai-chikuwa").closest("li")!;
  expect(within(option).getByText("AI")).toBeTruthy();
});

it("the members dialog says an AI bot is in the conversation (§4)", async () => {
  await setup();
  fireEvent.click(screen.getByRole("button", { name: "メンバー" }));
  await settle();
  expect(within(dialog()).getByRole("note").textContent).toBe("AI（ちくわ）が参加しています。メンションしたときと要約のときに、会話の一部が Anthropic の API に送られます");
});

it("a server without AI (404): no 「要約」, no badge, no notice", async () => {
  await setup({ aiMissing: true });
  await openMenu("チャンネルの操作");
  expect(screen.queryByRole("menuitem", { name: "未読を要約" })).toBeNull();
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await settle();
  const aiRow = screen.getByText("AI の返事").closest("article")!;
  expect(within(aiRow).getByText("BOT")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "メンバー" }));
  await settle();
  expect(within(dialog()).queryByRole("note")).toBeNull();
});

it("no summaries when the budget is used up (summary_available false)", async () => {
  const { server, engine } = await setup();
  server.aiBudgetLeft = false;
  await act(async () => { await engine.ai.loadStatus(); });
  await openMenu("チャンネルの操作");
  expect(screen.queryByRole("menuitem", { name: "未読を要約" })).toBeNull();
});

// Review v0.1.18 #2: where the summary goes, told before asking, and the run's provider / model in the dialog.

const targetLine = () => screen.queryByTestId("ai-summary-target")?.textContent ?? null;

it("channel ⋯ tells where the summary goes (Anthropic), and the dialog the run's provider and model", async () => {
  const { server } = await setup();
  await openMenu("チャンネルの操作");
  expect(targetLine()).toBe("要約は ちくわ（Anthropic）に送られます");
  expect(screen.getByRole("menuitem", { name: "未読を要約" }).getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "未読を要約" }));
  await settle();
  expect(within(dialog()).getByTestId("ai-run-caption").textContent).toBe("Anthropic · claude-opus-5-5");
  const run = server.lastAiRun()!;
  server.updateAiRun(run.id, { status: "done", output: "まとめ", provider: "openai", model: "gpt-6.1-sol", finished_at: new Date().toISOString() });
  await settle();
  expect(within(dialog()).getByTestId("ai-run-caption").textContent).toBe("OpenAI · gpt-6.1-sol");
});

it("an OpenAI target reads 「要約は …（OpenAI）に送られます」, on the thread ⋯ too", async () => {
  const { server, alice, channelId } = await setup();
  server.aiSummaryTargetAnswer = { available: true, provider: "openai", model: "gpt-6.1-sol", agent_name: "ソル", reason: null };
  await openMenu("チャンネルの操作");
  expect(targetLine()).toBe("要約は ソル（OpenAI）に送られます");
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  await settle();
  const parent = server.post(channelId, alice.id, "スレッドの親").message;
  server.post(channelId, alice.id, "返信", undefined, parent.id);
  await settle();
  fireEvent.click(screen.getAllByTestId("thread-summary").at(-1)!);
  await settle();
  await openMenu("スレッドの操作");
  expect(targetLine()).toBe("要約は ソル（OpenAI）に送られます");
});

it.each([
  ["ai_unavailable", "このサーバーでは AI を使えません"],
  ["ai_budget_exceeded", "今月の AI の利用上限に達しました"],
  ["ai_private_not_allowed", "この AI のボットは公開チャンネルでだけ使えます（非公開チャンネルと DM には参加・要約できません）"],
])("target unavailable (%s): the choices are disabled and the reason is shown", async (reason, text) => {
  const { server } = await setup();
  server.aiSummaryTargetAnswer = { available: false, provider: reason === "ai_unavailable" ? null : "anthropic", model: null, agent_name: null, reason };
  await openMenu("チャンネルの操作");
  expect(targetLine()).toBe(text);
  for (const name of ["未読を要約", "直近 1 日を要約", "直近 7 日を要約"]) {
    expect(screen.getByRole("menuitem", { name }).getAttribute("aria-disabled")).toBe("true");
  }
  fireEvent.click(screen.getByRole("menuitem", { name: "未読を要約" }));
  await settle();
  expect(server.lastAiRun()).toBeUndefined();
});

it("a server without the target route (404): no line, the choices as before", async () => {
  const { server } = await setup();
  server.aiSummaryTargetRoute = false;
  await openMenu("チャンネルの操作");
  expect(targetLine()).toBeNull();
  expect(screen.getByRole("menuitem", { name: "直近 1 日を要約" }).getAttribute("aria-disabled")).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: "直近 1 日を要約" }));
  await settle();
  expect(server.lastAiRun()).toMatchObject({ scope: "recent", days: 1 });
});
