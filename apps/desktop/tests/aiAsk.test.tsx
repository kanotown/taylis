// @vitest-environment jsdom
/**
 * M70 (docs/AI.md §13.6): 「AI に聞く」 on the search screen — the question built from the words and the menu filters, the
 * line saying where it goes, the run followed through ai.run_updated, the answer's [n] as links to the cited messages,
 * the sources list, the private note, the history, and nothing on a server without the route.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type AiAskTargetOut, type AiRunOut, type AiSourceOut, askTargetLine, linkCitations } from "../src/api/ai";
import { ApiError } from "../src/api/errors";
import type { ApiClient } from "../src/api/client";
import type { MessageOut, SearchOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { AiHub } from "../src/sync/ai";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { SearchView, type SearchSnapshot } from "../src/ui/SearchView";
import { askQuery, EMPTY_SEARCH, type SearchParams } from "../src/ui/search";
import { FakeServer } from "./fakeServer";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const settle = (ms = 0) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

const source = (n: number, messageId: string, extra: Partial<AiSourceOut> = {}): AiSourceOut => ({
  n,
  message_id: messageId,
  channel_id: "c1",
  parent_id: null,
  sender_id: "u1",
  created_at: "2026-10-01T03:00:00Z",
  excerpt: `抜粋 ${n}`,
  ...extra,
});

describe("pure parts", () => {
  it("askQuery: the words and the menu filters as modifiers", () => {
    const now = new Date(2026, 9, 2, 15, 0); // 2026-10-02 local
    const params: SearchParams = { ...EMPTY_SEARCH, q: " 発表の順番は? ", fromUserId: "u1", has: ["file"], isThread: true, isTimes: true, date: { preset: "week" } };
    expect(askQuery(params, (id) => (id === "u1" ? "tanaka" : undefined), now)).toBe(
      "発表の順番は? from:@tanaka after:2026-09-25 has:file is:thread is:times",
    );
    expect(askQuery({ ...EMPTY_SEARCH, q: "予算", date: { from: "2026-09-01", to: "2026-09-30" } }, () => undefined, now)).toBe(
      "予算 after:2026-08-31 before:2026-10-01",
    );
    expect(askQuery({ ...EMPTY_SEARCH, q: "x", date: { preset: "yesterday" } }, () => undefined, now)).toBe("x after:2026-09-30 before:2026-10-02");
    expect(askQuery({ ...EMPTY_SEARCH, q: "x", fromUserId: "gone" }, () => undefined, now)).toBe("x");
  });

  it("linkCitations: each cited number becomes a message link; unknown numbers stay text", () => {
    const sources = [source(1, "m-1"), source(3, "m-3")];
    expect(linkCitations("A [1]、B [1][3]、C [1, 3]、D [2] [1, 2]", sources, "http://s/")).toBe(
      "A [1](http://s/m/m-1)、B [1](http://s/m/m-1)[3](http://s/m/m-3)、C [1](http://s/m/m-1) [3](http://s/m/m-3)、D [2] [1, 2]",
    );
  });

  it("askTargetLine: where it goes, or why not", () => {
    expect(askTargetLine({ available: true, provider: "openai", model: "gpt-6.1-sol", agent_name: "ソル", reason: null })).toBe(
      "質問と見つかったメッセージは ソル (OpenAI) に送られます",
    );
    expect(askTargetLine({ available: false, provider: "anthropic", model: "claude-opus-5-5", agent_name: "ちくわ", reason: "ai_private_not_allowed" })).toContain("非公開");
    expect(askTargetLine({ available: false, provider: null, model: null, agent_name: null, reason: "ai_unavailable" })).toBeTruthy();
  });

  it("the hub keeps an event that comes before the POST's answer, and never goes back", async () => {
    let answer!: (run: AiRunOut) => void;
    const pending: AiRunOut = {
      id: "r1", kind: "ask", status: "pending", channel_id: null, thread_id: null, scope: null, days: null, output: null, error: null,
      omitted_count: 0, created_at: "2026-10-02T00:00:00Z", finished_at: null, question: "q", sources: [],
    };
    const hub = new AiHub({
      api: {
        aiStatus: async () => ({ available: true, summary_available: true, agents: [] }),
        createAiSummary: async () => { throw new Error("unused"); },
        getAiRun: async () => pending,
        createAiAsk: () => new Promise<AiRunOut>((resolve) => { answer = resolve; }),
      },
      setStatus: () => {},
    });
    const sent = hub.startAsk("q", null);
    hub.applyEvent({ run: { ...pending, status: "done", output: "答え" } });
    answer(pending);
    await sent;
    expect(hub.ask?.run?.status).toBe("done");
    hub.applyEvent({ run: { ...pending, status: "running" } });
    expect(hub.ask?.run?.status).toBe("done");
    // A summary's event does not touch the question.
    hub.applyEvent({ run: { ...pending, id: "s1", kind: "summary", status: "failed" } });
    expect(hub.ask?.run?.id).toBe("r1");
    hub.closeAsk();
    expect(hub.ask).toBeNull();
  });
});

/** #lab of bob with the AI bot, a real engine against the fake server, and the search screen. */
async function setup(options: { askRoute?: boolean; narrow?: boolean; target?: AiAskTargetOut } = {}) {
  const server = new FakeServer();
  server.aiAskRoute = options.askRoute ?? true;
  server.aiAskTargetAnswer = options.target ?? null;
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channelId = server.createChannel("lab", alice.id).id;
  server.join(channelId, bob.id);
  const agent = server.createAiAgent({ username: "ai-chikuwa", name: "ちくわ", character: "", model: "claude-opus-5-5" });
  const parent = server.post(channelId, alice.id, "来週のゼミ").message;
  const reply = server.post(channelId, alice.id, "発表順は山田、佐藤", undefined, parent.id).message;
  const store = new Store();
  const inner = server.apiFor(bob.id);
  const engine = new SyncEngine(
    { api: inner, connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {}, random: () => 0.5, isActive: () => true },
    { reconnectMinMs: 0 },
  );
  const empty: SearchOut = { hits: [], keywords: [], filters: { text: "", has: [], is_thread: false, is_times: false, unresolved: [] }, limit: 30, offset: 0, has_more: false, total: 0, total_capped: false };
  const target = { ...inner, baseUrl: "http://server", search: async () => empty } as unknown as Record<string, unknown>;
  const api = new Proxy(target, { get: (t, key: string) => t[key] ?? (async () => []) }) as unknown as ApiClient;
  await engine.start();
  await engine.idle();
  await settle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store, engine, me: store.me, leaving: false };
  const onOpen = vi.fn();
  const params: SearchParams = { ...EMPTY_SEARCH, q: "ゼミの発表順", channelId: options.narrow ? channelId : null };
  render(<Screen controller={controller} store={store} engine={engine} params={params} onOpen={onOpen} />);
  await settle();
  return { server, alice, bob, agent, channelId, parent, reply, store, engine, controller, onOpen };
}

function Screen({ controller, store, engine, params, onOpen }: { controller: AppController; store: Store; engine: SyncEngine; params: SearchParams; onOpen: (m: MessageOut) => void }) {
  useSyncExternalStore(
    (listener) => {
      const subs = [controller.subscribe(listener), store.subscribe(listener), engine.subscribe(listener)];
      return () => subs.forEach((unsubscribe) => unsubscribe());
    },
    () => `${controller.version}:${store.version}:${engine.status}`,
  );
  return <SearchView controller={controller} params={params} tab="messages" onTabChange={() => {}} onChange={() => {}} onOpen={onOpen} onClose={() => {}} snapshot={{ current: null as SearchSnapshot | null }} />;
}

const panel = () => screen.getByTestId("ai-ask");

it("asks with the words and filters, follows the run, and links the answer's [n] to the messages", async () => {
  const { server, parent, reply, alice, onOpen } = await setup();
  expect(within(panel()).getByTestId("ai-ask-target").textContent).toBe("質問と見つかったメッセージは ちくわ (Anthropic) に送られます");
  fireEvent.click(within(panel()).getByRole("button", { name: "AI に聞く" }));
  await settle();
  expect(server.aiAsks).toEqual([expect.objectContaining({ q: "ゼミの発表順", channel_id: null })]);
  expect(within(panel()).getByText("「ゼミの発表順」")).toBeTruthy();
  expect(within(panel()).getByText("メッセージを探しています…")).toBeTruthy();
  // While it is answered the button waits too (a second press would ask again).
  const busy = () => within(panel()).getByRole("button", { name: "考えています…" }) as HTMLButtonElement;
  expect(busy().disabled).toBe(true);
  const run = server.lastAiRun()!;
  server.updateAiRun(run.id, { status: "running" });
  await settle();
  expect(within(panel()).getByText("答えを書いています…")).toBeTruthy();
  expect(busy().disabled).toBe(true);
  fireEvent.click(busy());
  await settle();
  expect(server.aiAsks).toHaveLength(1);

  server.updateAiRun(run.id, {
    status: "done",
    output: "発表順は山田さん、佐藤さんです [2]。準備の話は [1] にあります。",
    omitted_count: 2,
    finished_at: new Date().toISOString(),
    sources: [
      { n: 1, message_id: parent.id, channel_id: parent.channel_id, parent_id: null, sender_id: alice.id, created_at: parent.created_at, excerpt: "来週のゼミ" },
      { n: 2, message_id: reply.id, channel_id: reply.channel_id, parent_id: parent.id, sender_id: alice.id, created_at: reply.created_at, excerpt: "発表順は山田、佐藤" },
    ],
  });
  await settle();
  expect(within(panel()).getByText(/発表順は山田さん/)).toBeTruthy();
  expect(within(panel()).getByText("非公開の会話の 2 件は、このボットに送れないため除きました")).toBeTruthy();
  expect(within(panel()).getByTestId("ai-run-caption").textContent).toContain("Anthropic · claude-opus-5-5");
  // [2] in the text: a link that opens the reply (in its thread).
  fireEvent.click(within(panel()).getByRole("button", { name: "2" }));
  await settle();
  expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: reply.id, parent_id: parent.id }));
  // The sources list: sender, conversation, excerpt; a click opens the message.
  const sources = within(panel()).getByRole("list", { name: "出典" });
  const rows = within(sources).getAllByRole("button");
  expect(rows).toHaveLength(2);
  expect(rows[1]!.textContent).toContain("Alice");
  expect(rows[1]!.textContent).toContain("#lab");
  expect(rows[1]!.textContent).toContain("発表順は山田、佐藤");
  fireEvent.click(rows[0]!);
  await settle();
  expect(onOpen).toHaveBeenLastCalledWith(expect.objectContaining({ id: parent.id }));

  // History: past questions; one opens again.
  fireEvent.click(within(panel()).getByRole("button", { name: "AI の答えを閉じる" }));
  await settle();
  expect(within(panel()).queryByText(/発表順は山田さん/)).toBeNull();
  fireEvent.click(within(panel()).getByRole("button", { name: /履歴/ }));
  await settle();
  expect((within(panel()).getByRole("button", { name: "AI に聞く" }) as HTMLButtonElement).disabled).toBe(false); // answered: free again
  const past = within(panel()).getByRole("list", { name: "過去の質問" });
  fireEvent.click(within(past).getByText("ゼミの発表順"));
  await settle();
  expect(within(panel()).getByText(/発表順は山田さん/)).toBeTruthy();
});

it("narrowed to a conversation: channel_id goes with the question (the target is read for it)", async () => {
  const { server, channelId } = await setup({ narrow: true });
  fireEvent.click(within(panel()).getByRole("button", { name: "AI に聞く" }));
  await settle();
  expect(server.aiAsks).toEqual([expect.objectContaining({ q: "ゼミの発表順", channel_id: channelId })]);
  expect(server.lastAiRun()!.channel_id).toBe(channelId);
});

it("a refused question shows the reason and 「もう一度」", async () => {
  const { server } = await setup();
  server.aiRefuseNext = new ApiError(429, "ai_daily_limit", "limit");
  fireEvent.click(within(panel()).getByRole("button", { name: "AI に聞く" }));
  await settle();
  expect(within(panel()).getByRole("alert").textContent).toContain("今日の AI の利用回数の上限");
  fireEvent.click(within(panel()).getByRole("button", { name: /もう一度/ }));
  await settle();
  expect(server.aiAsks).toHaveLength(2);
  expect(within(panel()).getByText("メッセージを探しています…")).toBeTruthy();
});

it("cannot ask now: the button is disabled with the reason", async () => {
  const { server } = await setup({ target: { available: false, provider: "anthropic", model: "claude-opus-5-5", agent_name: "ちくわ", reason: "ai_budget_exceeded" } });
  expect(within(panel()).getByTestId("ai-ask-target").textContent).toBe("今月の AI の利用上限に達しました");
  const button = within(panel()).getByRole("button", { name: "AI に聞く" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  await settle();
  expect(server.aiAsks).toEqual([]);
});

it("a server without 「AI に聞く」 (404) shows nothing", async () => {
  await setup({ askRoute: false });
  expect(screen.queryByTestId("ai-ask")).toBeNull();
});
