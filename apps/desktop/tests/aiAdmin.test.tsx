// @vitest-environment jsdom
/** M65 (docs/AI.md §6): 管理 → 「AI」 — the bots (create, edit, delete) and this month's usage, against the fake server. */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { AdminBody } from "../src/ui/AdminDialog";
import { usernameHint } from "../src/ui/username";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function setup(options: { aiMissing?: boolean } = {}) {
  const server = new FakeServer();
  const admin = server.addUser("admin", "admin");
  const bob = server.addUser("bob");
  const agent = server.createAiAgent({ username: "ai-chikuwa", name: "ちくわ", character: "やさしい先輩", model: "claude-opus-5-5" });
  server.aiUsage = {
    month: "2026-10", budget_usd: 30, total_cost_usd: 1.5, total_runs: 12,
    by_agent: [{ agent_id: agent.id, name: "ちくわ", runs: 12, input_tokens: 120000, output_tokens: 8000, cost_usd: 1.5 }],
    by_user: [{ user_id: bob.id, runs: 7, cost_usd: 0.9 }],
  };
  const store = new Store();
  store.setMe({ ...admin } as never);
  for (const user of server.users.values()) store.upsertUser({ ...user });
  if (!options.aiMissing) store.setAiStatus(server.aiStatusOut());
  const inner = server.apiFor(admin.id) as unknown as Record<string, unknown>;
  const api = new Proxy(inner, { get: (t, key: string) => t[key] ?? (async () => []) });
  const loadStatus = vi.fn(async () => {});
  const setError = vi.fn();
  const controller = { store, api, engine: { ai: { loadStatus } }, isAdmin: true, version: 0, subscribe: () => () => {}, setError, setNotice: vi.fn() } as unknown as AppController;
  render(<AdminBody controller={controller} />);
  await settle();
  return { server, agent, bob, store, loadStatus, setError };
}

async function openTab() {
  fireEvent.click(screen.getByRole("tab", { name: "AI" }));
  await settle();
}

it("lists the bots and this month's usage with names", async () => {
  await setup();
  await openTab();
  const list = screen.getByRole("list", { name: "AI のボット" });
  expect(within(list).getByText("ちくわ")).toBeTruthy();
  expect(within(list).getByText("@ai-chikuwa")).toBeTruthy();
  expect(within(list).getByText(/Claude Opus 5\.5 · 考える量 ふつう/)).toBeTruthy();
  expect(screen.getByTestId("ai-usage-total").textContent).toBe("$1.50 / 予算 $30.00 · 12 回");
  const byUser = screen.getByRole("table", { name: "人ごと" });
  expect(within(byUser).getByText("Bob (@bob)")).toBeTruthy();
  expect(within(screen.getByRole("table", { name: "ボットごと" })).getByText("120,000")).toBeTruthy();
});

it("creates a bot: name, username, character, model, effort, private, enabled", async () => {
  const { server, loadStatus } = await setup();
  await openTab();
  fireEvent.click(screen.getByRole("button", { name: /ボットを作成/ }));
  await settle();
  const dialog = screen.getByRole("dialog");
  // Opus 5.5 is the default model.
  expect((within(dialog).getByLabelText("モデル") as HTMLSelectElement).value).toBe("claude-opus-5-5");
  fireEvent.change(within(dialog).getByLabelText("名前（投稿者として表示されます）"), { target: { value: "はんぺん" } });
  fireEvent.change(within(dialog).getByLabelText(/ユーザー名/), { target: { value: "AI-Hanpen" } });
  fireEvent.change(within(dialog).getByLabelText(/性格/), { target: { value: "簡潔に答える" } });
  fireEvent.change(within(dialog).getByLabelText("モデル"), { target: { value: "claude-haiku-4-5" } });
  fireEvent.change(within(dialog).getByLabelText("考える量"), { target: { value: "low" } });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /非公開チャンネルと DM を許す/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: "作成" }));
  await settle();
  expect(server.aiAgents.at(-1)).toMatchObject({ username: "ai-hanpen", name: "はんぺん", character: "簡潔に答える", model: "claude-haiku-4-5", effort: "low", allow_private: true, enabled: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText("はんぺん")).toBeTruthy();
  expect(loadStatus).toHaveBeenCalled();
});

it("the character is at most 4000 characters", async () => {
  await setup();
  await openTab();
  fireEvent.click(screen.getByRole("button", { name: /ボットを作成/ }));
  await settle();
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText(/性格/), { target: { value: "あ".repeat(4001) } });
  expect(within(dialog).getByText("4001 / 4000 字")).toBeTruthy();
  expect((within(dialog).getByRole("button", { name: "作成" }) as HTMLButtonElement).disabled).toBe(true);
});

it("a taken username is shown in Japanese", async () => {
  const { setError } = await setup();
  await openTab();
  fireEvent.click(screen.getByRole("button", { name: /ボットを作成/ }));
  await settle();
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("名前（投稿者として表示されます）"), { target: { value: "x" } });
  fireEvent.change(within(dialog).getByLabelText(/ユーザー名/), { target: { value: "bob" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "作成" }));
  await settle();
  expect(setError).toHaveBeenCalledWith("このユーザー名はすでに使われています");
  expect(screen.getByRole("dialog")).toBeTruthy(); // stays open
});

it("edits a bot: the username is not edited here (M96: 管理 →「ユーザー」 renames it), only changes are sent", async () => {
  const { server, agent } = await setup();
  await openTab();
  fireEvent.click(screen.getByRole("button", { name: /編集/ }));
  await settle();
  const dialog = screen.getByRole("dialog");
  expect((within(dialog).getByLabelText(/^ユーザー名/) as HTMLInputElement).disabled).toBe(true);
  expect(within(dialog).getByText("管理 →「ユーザー」の「ユーザー名を変更」で変えられます")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("checkbox", { name: "有効" }));
  fireEvent.change(within(dialog).getByLabelText("考える量"), { target: { value: "high" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
  await settle();
  expect(server.aiAgents[0]).toMatchObject({ id: agent.id, enabled: false, effort: "high", name: "ちくわ", username: "ai-chikuwa" });
  expect(screen.getByText("停止中")).toBeTruthy();
});

it("the creation forms say what the username is for and that it can change later (M96; fixed before)", async () => {
  await setup();
  // 「ユーザー」 (the first tab).
  fireEvent.click(screen.getByRole("button", { name: /ユーザーを作成/ }));
  await settle();
  const userField = screen.getByLabelText(/ユーザー名/).closest("label")!;
  expect(within(userField).getByText(usernameHint())).toBeTruthy();
  await openTab();
  fireEvent.click(screen.getByRole("button", { name: /ボットを作成/ }));
  await settle();
  const botField = within(screen.getByRole("dialog")).getByLabelText(/ユーザー名/).closest("label")!;
  expect(within(botField).getByText(usernameHint())).toBeTruthy();
});

it("deletes a bot after asking", async () => {
  const { server } = await setup();
  await openTab();
  fireEvent.click(screen.getByRole("button", { name: /削除/ }));
  await settle();
  expect(screen.getByRole("dialog", { name: "ちくわ を削除しますか？" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
  await settle();
  expect(server.aiAgents).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: /削除/ }));
  await settle();
  fireEvent.click(screen.getByRole("button", { name: "削除する" }));
  await settle();
  expect(server.aiAgents).toHaveLength(0);
  expect(screen.getByText("ボットはまだありません")).toBeTruthy();
});

it("models are grouped by provider and a provider without a key is marked (§12)", async () => {
  const { server } = await setup();
  server.createAiAgent({ username: "ai-sol", name: "ソル", character: "", model: "gpt-6.1-sol" });
  await openTab();
  const list = screen.getByRole("list", { name: "AI のボット" });
  expect(within(within(list).getByText("ソル").closest("li")!).getByText("API キー未設定")).toBeTruthy();
  expect(within(within(list).getByText("ちくわ").closest("li")!).queryByText("API キー未設定")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /ボットを作成/ }));
  await settle();
  const dialog = screen.getByRole("dialog");
  const select = within(dialog).getByLabelText("モデル") as HTMLSelectElement;
  const groups = Array.from(select.querySelectorAll("optgroup")).map((g) => [g.label, Array.from(g.querySelectorAll("option")).map((o) => o.value)]);
  expect(groups).toEqual([
    ["Anthropic", ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5"]],
    ["OpenAI（キー未設定）", ["gpt-6.1-sol", "gpt-6-luna"]],
  ]);
  fireEvent.change(select, { target: { value: "gpt-6-luna" } });
  expect(within(dialog).getByText(/OpenAI の API キーが設定されていません/)).toBeTruthy();
  fireEvent.change(within(dialog).getByLabelText("名前（投稿者として表示されます）"), { target: { value: "ルナ" } });
  fireEvent.change(within(dialog).getByLabelText(/ユーザー名/), { target: { value: "ai-luna" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "作成" }));
  await settle();
  expect(server.aiAgents.at(-1)).toMatchObject({ username: "ai-luna", model: "gpt-6-luna" });
});

it("an older server without /admin/ai/providers: no key marks", async () => {
  const { server } = await setup();
  server.aiProviders = null;
  server.createAiAgent({ username: "ai-sol", name: "ソル", character: "", model: "gpt-6.1-sol" });
  await openTab();
  expect(screen.queryByText("API キー未設定")).toBeNull();
  expect(within(screen.getByRole("list", { name: "AI のボット" })).getByText(/GPT-6\.1 Sol · 考える量/)).toBeTruthy();
});

it("no 「AI」 tab on a server without AI", async () => {
  await setup({ aiMissing: true });
  expect(screen.queryByRole("tab", { name: "AI" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Webhook" })).toBeTruthy();
});
