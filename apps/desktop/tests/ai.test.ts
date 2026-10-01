/** M65 (docs/AI.md §5): the AI rules (pure) and the hub on a real SyncEngine against the fake server. */
import { describe, expect, it } from "vitest";

import { describeAiError, type AiRunOut } from "../src/api/ai";
import { ERROR_MESSAGES } from "../src/api/errorMessages";
import { ApiError, NetworkError } from "../src/api/errors";
import { laterRun, summaryBody, summaryTitle } from "../src/sync/ai";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { agentForm, agentPatch, formatUsd } from "../src/ui/AiTab";
import { aiNoticeText } from "../src/ui/ai";
import { mentionCandidates } from "../src/ui/mentions";
import { FakeServer } from "./fakeServer";

function run(patch: Partial<AiRunOut> = {}): AiRunOut {
  return {
    id: "r1", kind: "summary", status: "pending", channel_id: "c1", thread_id: null, scope: "unread", days: null, output: null, error: null,
    omitted_count: 0, created_at: "2026-10-02T00:00:00Z", finished_at: null, ...patch,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function settle(engine: SyncEngine, done: () => boolean = () => false): Promise<void> {
  for (let i = 0; i < 30 && !done(); i++) {
    await engine.idle();
    await tick();
  }
}

async function setup(options: { agent?: boolean } = {}) {
  const server = new FakeServer();
  const alice = server.addUser("alice", "admin");
  const bob = server.addUser("bob");
  const channel = server.createChannel("general", alice.id);
  server.join(channel.id, bob.id);
  const agent = options.agent === false ? null : server.createAiAgent({ username: "ai-chikuwa", name: "ちくわ", character: "やさしい先輩", model: "claude-opus-5-5" });
  if (agent) server.join(channel.id, agent.bot_user_id);
  const store = new Store();
  const engine = new SyncEngine(
    { api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "token", sleep: async () => {}, random: () => 0.5 },
    { reconnectMinMs: 0 },
  );
  return { server, alice, bob, channel, agent, store, engine };
}

describe("rules", () => {
  it("a run never goes back", () => {
    expect(laterRun(null, run())).toEqual(run());
    expect(laterRun(run({ status: "running" }), run({ status: "pending" })).status).toBe("running");
    expect(laterRun(run({ status: "running" }), run({ status: "done", output: "x" })).output).toBe("x");
    expect(laterRun(run({ status: "done", output: "x" }), run({ status: "running" })).status).toBe("done");
    expect(laterRun(run({ status: "failed" }), run({ status: "pending" })).status).toBe("failed");
    // Another run replaces it.
    expect(laterRun(run({ status: "done" }), run({ id: "r2" })).id).toBe("r2");
  });

  it("the request body and the title", () => {
    expect(summaryBody({ channelId: "c1", scope: "unread" }, 540)).toEqual({ channel_id: "c1", scope: "unread", tz_offset_minutes: 540 });
    expect(summaryBody({ channelId: "c1", scope: "recent", days: 7 }, 540)).toEqual({ channel_id: "c1", scope: "recent", days: 7, tz_offset_minutes: 540 });
    expect(summaryBody({ channelId: "c1", scope: "thread", threadId: "p" }, 0)).toEqual({ channel_id: "c1", scope: "thread", thread_id: "p", tz_offset_minutes: 0 });
    expect(summaryTitle({ scope: "unread" })).toBe("未読の要約");
    expect(summaryTitle({ scope: "recent", days: 7 })).toBe("直近 7 日の要約");
    expect(summaryTitle({ scope: "thread" })).toBe("スレッドの要約");
  });

  it("errors in Japanese", () => {
    // The shared table (apps/shared/errors.json) wins over the local fallback text.
    expect(describeAiError(new ApiError(409, "ai_unavailable", "x"))).toContain(ERROR_MESSAGES.ai_unavailable ?? "AI は今使えません");
    expect(describeAiError(new ApiError(429, "ai_budget_exceeded", "x"))).toContain("今月の AI の利用上限");
    expect(describeAiError(new ApiError(429, "ai_daily_limit", "x"))).toContain("今日の AI の利用回数");
    expect(describeAiError(new ApiError(409, "username_taken", "x"))).toBe("このユーザー名はすでに使われています");
    expect(describeAiError(new NetworkError(new Error("Failed to fetch")))).toMatch(/接続|ネットワーク/);
  });

  it("the channel notice names the AI members (§4)", () => {
    const store = new Store();
    store.setAiStatus({ available: true, summary_available: true, agents: [{ id: "a1", bot_user_id: "b1", name: "ちくわ", model: "claude-opus-5-5" }, { id: "a2", bot_user_id: "b2", name: "はんぺん", model: "claude-haiku-4-5" }] });
    expect(aiNoticeText(store, ["u1", "u2"])).toBeNull();
    expect(aiNoticeText(store, ["u1", "b1"])).toBe("AI (ちくわ) が参加しています。メンションしたときと要約のときに、会話の一部が Anthropic の API に送られます");
    expect(aiNoticeText(store, ["b2", "b1"])).toContain("AI (はんぺん、ちくわ)");
  });

  it("mention candidates mark the AI bots", () => {
    const users = [
      { id: "b1", username: "ai-chikuwa", display_name: "ちくわ", role: "bot" },
      { id: "b9", username: "ci", display_name: "CI", role: "bot" },
      { id: "u1", username: "alice", display_name: "Alice", role: "member" },
    ] as never[];
    const list = mentionCandidates("", users, [], 6, new Set(["b1"]));
    expect(list.find((c) => c.username === "ai-chikuwa")?.ai).toBe(true);
    expect(list.find((c) => c.username === "ci")?.ai).toBeUndefined();
    expect(list.find((c) => c.username === "alice")?.ai).toBeUndefined();
  });

  it("the admin form patches only what changed", () => {
    const row = { id: "a1", bot_user_id: "b1", username: "ai-x", name: "X", character: "c", model: "claude-opus-5-5", effort: "medium", allow_private: false, enabled: true, created_at: "", updated_at: "" } as const;
    expect(agentPatch(row, agentForm(row))).toEqual({});
    expect(agentPatch(row, { ...agentForm(row), name: " Y ", effort: "high", allow_private: true })).toEqual({ name: "Y", effort: "high", allow_private: true });
    expect(agentForm(null)).toMatchObject({ model: "claude-opus-5-5", effort: "medium", allow_private: false, enabled: true });
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(0.0012)).toBe("$0.0012");
  });
});

describe("the hub on the engine", () => {
  it("reads the status on start: the rows' badge and the menus follow it", async () => {
    const { engine, store, agent } = await setup();
    const before = store.rowsVersion;
    await engine.start();
    await settle(engine, () => store.aiStatus !== null);
    expect(store.aiStatus).toEqual({ available: true, summary_available: true, agents: [{ id: agent!.id, bot_user_id: agent!.bot_user_id, name: "ちくわ", model: "claude-opus-5-5" }] });
    expect(store.aiAgentOf(agent!.bot_user_id)?.name).toBe("ちくわ");
    expect(store.rowsVersion).toBeGreaterThan(before);
  });

  it("an older server (404) has no AI; reconnecting reads it again", async () => {
    const { engine, store, server, bob } = await setup();
    server.aiMissing = true;
    await engine.start();
    await settle(engine);
    expect(store.aiStatus).toBeNull();
    server.aiMissing = false;
    server.disconnect(bob.id);
    await settle(engine, () => store.aiStatus !== null);
    expect(store.aiStatus?.available).toBe(true);
  });

  it("a network failure keeps what was known", async () => {
    const { engine, store } = await setup();
    await engine.start();
    await settle(engine, () => store.aiStatus !== null);
    const api = (engine as unknown as { ai: { deps: { api: { aiStatus: () => Promise<unknown> } } } }).ai.deps.api;
    api.aiStatus = async () => { throw new NetworkError(new Error("offline")); };
    await engine.ai.loadStatus();
    expect(store.aiStatus?.available).toBe(true);
  });

  it("without a bot (or a key) nothing is available", async () => {
    const { engine, store } = await setup({ agent: false });
    await engine.start();
    await settle(engine, () => store.aiStatus !== null);
    expect(store.aiStatus).toEqual({ available: false, summary_available: false, agents: [] });
  });

  it("a summary: pending, then running and done from ai.run_updated", async () => {
    const { engine, server, channel } = await setup();
    await engine.start();
    await settle(engine);
    await engine.ai.startSummary({ channelId: channel.id, scope: "recent", days: 7 });
    const session = engine.ai.summary!;
    expect(session.run?.status).toBe("pending");
    expect(session.run?.days).toBe(7);
    const id = session.run!.id;
    server.updateAiRun(id, { status: "running" });
    await settle(engine);
    expect(engine.ai.summary?.run?.status).toBe("running");
    server.updateAiRun(id, { status: "done", output: "- 決まったこと", omitted_count: 3, finished_at: "2026-10-02T00:00:01Z" });
    await settle(engine);
    expect(engine.ai.summary?.run).toMatchObject({ status: "done", output: "- 決まったこと", omitted_count: 3 });
    // A late 'running' (reordered) does not go back.
    engine.ai.applyEvent({ run: { ...engine.ai.summary!.run!, status: "running", output: null } });
    expect(engine.ai.summary?.run?.status).toBe("done");
    engine.ai.closeSummary();
    expect(engine.ai.summary).toBeNull();
  });

  it("a lost event: reconnecting reads the open run again", async () => {
    const { engine, server, channel, bob } = await setup();
    await engine.start();
    await settle(engine);
    await engine.ai.startSummary({ channelId: channel.id, scope: "unread" });
    const id = engine.ai.summary!.run!.id;
    server.updateAiRun(id, { status: "done", output: "要約", finished_at: "2026-10-02T00:00:01Z" }, { emit: false });
    await settle(engine);
    expect(engine.ai.summary?.run?.status).toBe("pending");
    server.disconnect(bob.id);
    await settle(engine, () => engine.ai.summary?.run?.status === "done");
    expect(engine.ai.summary?.run?.output).toBe("要約");
  });

  it("an event that comes before POST answers is kept", async () => {
    const { engine, server, channel } = await setup();
    await engine.start();
    await settle(engine);
    const api = (engine as unknown as { ai: { deps: { api: { createAiSummary: (b: never) => Promise<AiRunOut> } } } }).ai.deps.api;
    const original = api.createAiSummary;
    api.createAiSummary = async (body) => {
      const created = await original(body);
      server.updateAiRun(created.id, { status: "running" });
      await settle(engine);
      return created; // the 202 (pending) arrives after the event
    };
    await engine.ai.startSummary({ channelId: channel.id, scope: "unread" });
    expect(engine.ai.summary?.run?.status).toBe("running");
  });

  it("refusals: the error stays for 「もう一度」", async () => {
    const { engine, server, channel } = await setup();
    await engine.start();
    await settle(engine);
    server.aiRefuseNext = new ApiError(429, "ai_daily_limit", "limit");
    await engine.ai.startSummary({ channelId: channel.id, scope: "unread" });
    expect(engine.ai.summary?.run).toBeNull();
    expect((engine.ai.summary?.error as ApiError).code).toBe("ai_daily_limit");
    await engine.ai.retry();
    expect(engine.ai.summary?.error).toBeNull();
    expect(engine.ai.summary?.run?.status).toBe("pending");

    server.aiBudgetLeft = false;
    await engine.ai.startSummary({ channelId: channel.id, scope: "unread" });
    expect((engine.ai.summary?.error as ApiError).code).toBe("ai_budget_exceeded");
  });

  it("a thread summary of a reply is refused (400); a closed dialog drops a late answer", async () => {
    const { engine, server, channel, alice } = await setup();
    await engine.start();
    await settle(engine);
    const parent = server.post(channel.id, alice.id, "parent").message;
    const reply = server.post(channel.id, alice.id, "reply", undefined, parent.id).message;
    await engine.ai.startSummary({ channelId: channel.id, scope: "thread", threadId: reply.id });
    expect((engine.ai.summary?.error as ApiError).code).toBe("validation_error");
    const pending = engine.ai.startSummary({ channelId: channel.id, scope: "thread", threadId: parent.id });
    engine.ai.closeSummary();
    await pending;
    expect(engine.ai.summary).toBeNull();
    expect(server.lastAiRun()?.thread_id).toBe(parent.id);
  });
});
