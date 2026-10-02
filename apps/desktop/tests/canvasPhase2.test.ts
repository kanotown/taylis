/**
 * M72 (CANVAS.md §18): canvas mentions reach the open app, 「編集中」 frames (sent, throttled, received, expired), and
 * 「タスクにする」 on a checklist item (what the task dialog starts with and what POST /tasks gets).
 */
import { describe, expect, it } from "vitest";

import type { CanvasMentioned, GroupOut, UserPublic } from "../src/api/types";
import { SyncEngine } from "../src/sync/engine";
import { CANVAS_PRESENCE_REFRESH_MS, CANVAS_PRESENCE_TTL_MS, CanvasEditors, CanvasPresenceSender, editingLabel } from "../src/sync/canvasPresence";
import { Store } from "../src/sync/store";
import type { ChannelState } from "../src/sync/types";
import { canvasTaskInit, checklistItem } from "../src/ui/canvasTasks";
import { sectionAt } from "../src/ui/canvasText";
import { canvasSourceState, taskCreateBody } from "../src/ui/tasks";
import { FakeServer } from "./fakeServer";

const BOB = "00000000-0000-4000-8000-0000000000b0";
const CAROL = "00000000-0000-4000-8000-0000000000c0";
const GROUP = "00000000-0000-4000-8000-0000000000d0";

function user(id: string, name: string): UserPublic {
  return { id, username: name.toLowerCase(), display_name: name } as UserPublic;
}

function channelOf(type: ChannelState["type"], extra: Partial<ChannelState> = {}): ChannelState {
  return { id: "ch-1", type, name: type === "dm" ? null : "lab", isMember: true, archived: false, posting_policy: "everyone", ...extra } as unknown as ChannelState;
}

describe("canvas_presence (CANVAS.md §18.2)", () => {
  it("sends a start, repeats only every 20 s or on a new heading, and a stop only after a start", () => {
    const sender = new CanvasPresenceSender();
    expect(sender.next("c1", false, null, 0)).toBeNull(); // nothing started
    expect(sender.next("c1", true, "  TODO  ", 0)).toEqual({ type: "canvas_presence", canvas_id: "c1", editing: true, section: "TODO" });
    expect(sender.next("c1", true, "TODO", 1_000)).toBeNull();
    expect(sender.next("c1", true, "決定事項", 2_000)?.section).toBe("決定事項");
    expect(sender.next("c1", true, "決定事項", 2_000 + CANVAS_PRESENCE_REFRESH_MS - 1)).toBeNull();
    expect(sender.next("c1", true, "決定事項", 2_000 + CANVAS_PRESENCE_REFRESH_MS)?.editing).toBe(true);
    expect(sender.next("c1", false, "x", 30_000)).toEqual({ type: "canvas_presence", canvas_id: "c1", editing: false, section: null });
    expect(sender.next("c1", false, null, 31_000)).toBeNull();
    // Another connection: the next start goes out at once.
    sender.next("c2", true, null, 0);
    sender.reset();
    expect(sender.next("c2", true, null, 1)).not.toBeNull();
    expect(sender.next("c3", true, "x".repeat(200), 0)?.section).toHaveLength(120);
  });

  it("keeps an editor for 45 s after the last refresh; a stop ends it at once", () => {
    const editors = new CanvasEditors();
    editors.note("c1", "u1", true, "TODO", 0);
    editors.note("c1", "u2", true, null, 1_000);
    expect(editors.of("c1", 2_000)).toEqual([{ userId: "u1", section: "TODO" }, { userId: "u2", section: null }]);
    expect(editors.of("c1", CANVAS_PRESENCE_TTL_MS)).toEqual([{ userId: "u2", section: null }]);
    editors.note("c1", "u2", true, "決定事項", 40_000); // refreshed
    expect(editors.of("c1", 80_000)).toEqual([{ userId: "u2", section: "決定事項" }]);
    expect(editors.nextExpiry("c1", 80_000)).toBe(40_000 + CANVAS_PRESENCE_TTL_MS);
    editors.note("c1", "u2", false, null, 80_001);
    expect(editors.of("c1", 80_002)).toEqual([]);
    expect(editors.of("other", 0)).toEqual([]);
  });

  it("words who edits", () => {
    expect(editingLabel([])).toBe("");
    expect(editingLabel(["加納"])).toBe("加納 が編集中");
    expect(editingLabel(["加納", "海老"])).toBe("加納、海老 が編集中");
    expect(editingLabel(["加納", "海老", "鈴木"])).toBe("加納 ほか 2 人が編集中");
  });

  it("finds the heading the caret is under", () => {
    const text = "前置き\n# 議事録\n本文\n## TODO\n- [ ] 予稿\n```\n# コード\n```";
    expect(sectionAt(text, 2)).toBeNull();
    expect(sectionAt(text, text.indexOf("本文"))).toBe("議事録");
    expect(sectionAt(text, text.indexOf("予稿"))).toBe("TODO");
    expect(sectionAt(text, text.length)).toBe("TODO"); // a heading in a code block is not one
  });
});

async function engineSetup(onCanvasMention: (m: CanvasMentioned) => void) {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("general", alice.id);
  server.join(channel.id, bob.id);
  const store = new Store();
  const engine = new SyncEngine(
    {
      api: server.apiFor(bob.id),
      connect: server.connectorFor(bob.id),
      store,
      getAccessToken: () => "t",
      sleep: async () => {},
      random: () => 0.5,
      isActive: () => false,
      onCanvasMention: (mention) => onCanvasMention(mention),
    },
    { reconnectMinMs: 0 },
  );
  await engine.start();
  await engine.idle();
  return { server, alice, bob, channel, store, engine };
}

describe("SyncEngine and Canvas Phase 2", () => {
  it("shows others' 「編集中」 frames and sends mine through the throttle", async () => {
    const { server, alice, bob, channel, store, engine } = await engineSetup(() => {});
    const socket = server.socketsOf(bob.id)[0]!;
    const frame = (user: string, editing: boolean, section: string | null) => ({ type: "canvas_presence", canvas_id: "cv1", channel_id: channel.id, user_id: user, editing, section });
    socket.deliver(frame(alice.id, true, "TODO"));
    socket.deliver(frame(bob.id, true, null)); // my own (another device of mine): not shown
    await engine.idle();
    expect(store.canvasEditors("cv1", Date.now())).toEqual([{ userId: alice.id, section: "TODO" }]);
    expect(store.canvasEditors("cv1", Date.now() + CANVAS_PRESENCE_TTL_MS + 1)).toEqual([]);
    socket.deliver(frame(alice.id, false, null));
    await engine.idle();
    expect(store.canvasEditors("cv1", Date.now())).toEqual([]);

    engine.setCanvasEditing("cv1", true, "TODO");
    engine.setCanvasEditing("cv1", true, "TODO");
    engine.setCanvasEditing("cv1", false);
    const sent = socket.sent.map((raw) => JSON.parse(raw) as { type: string }).filter((f) => f.type === "canvas_presence");
    expect(sent).toEqual([
      { type: "canvas_presence", canvas_id: "cv1", editing: true, section: "TODO" },
      { type: "canvas_presence", canvas_id: "cv1", editing: false, section: null },
    ]);
    engine.stop();
  });

  it("passes canvas.mentioned on, except in a muted or silent conversation", async () => {
    const mentions: CanvasMentioned[] = [];
    const { server, alice, bob, channel, engine } = await engineSetup((m) => mentions.push(m));
    const socket = server.socketsOf(bob.id)[0]!;
    let id = 1000;
    const mention = (by: string): void =>
      socket.deliver({ type: "event", id: ++id, event: "canvas.mentioned", ts: new Date().toISOString(), channel_id: channel.id, seq: null, data: { canvas_id: "cv1", channel_id: channel.id, rev_id: "r1", title: "議事録", by_user_id: by } });
    mention(alice.id);
    await engine.idle();
    expect(mentions.map((m) => m.title)).toEqual(["議事録"]);
    server.setNotificationPreference(bob.id, channel.id, { level: null, muted: true });
    await engine.idle();
    mention(alice.id);
    await engine.idle();
    server.setNotificationPreference(bob.id, channel.id, { level: "none", muted: false });
    await engine.idle();
    mention(alice.id);
    await engine.idle();
    expect(mentions).toHaveLength(1);
    server.setNotificationPreference(bob.id, channel.id, { level: "mentions", muted: false });
    await engine.idle();
    mention(alice.id);
    mention(bob.id); // never my own
    await engine.idle();
    expect(mentions).toHaveLength(2);
    engine.stop();
  });
});

describe("「タスクにする」 on a checklist item (CANVAS.md §18.3)", () => {
  const users = new Map([BOB, CAROL].map((id, i) => [id, user(id, i === 0 ? "Bob" : "Carol")]));
  const groups = new Map<string, GroupOut>([[GROUP, { id: GROUP, name: "design" } as GroupOut]]);
  const body = `# TODO\n- [ ] **予稿**を出す <@${BOB}> <@group:${GROUP}> 📅 2030-01-10\n  - [x] 済み\n- 普通の行\n- [ ] 日付が変 📅 2030-02-30`;
  const canvas = { id: "cv1", body };

  it("reads the item: text, box, line", () => {
    expect(checklistItem(body, 2)).toEqual({ line: "  - [x] 済み", text: "済み", done: true });
    expect(checklistItem(body, 3)).toBeNull();
    expect(checklistItem(body, 99)).toBeNull();
  });

  it("starts the dialog with the title, the due date, the mentioned people and the board", () => {
    const init = canvasTaskInit(canvas, 1, channelOf("public"), users, groups, false)!;
    expect(init).toMatchObject({
      channelId: "ch-1",
      title: "予稿を出す @Bob @design",
      dueOn: "2030-01-10",
      assigneeIds: [BOB],
      boardChoices: ["ch-1"],
      shareChannelId: null,
      sourceCanvasId: "cv1",
      sourceCanvasLine: `- [ ] **予稿**を出す <@${BOB}> <@group:${GROUP}> 📅 2030-01-10`,
      sourceCanvasExcerpt: "予稿を出す @Bob @design 📅 2030-01-10",
    });
    // A date that does not exist is not taken.
    expect(canvasTaskInit(canvas, 4, channelOf("public"), users, groups, false)?.dueOn).toBe("");
    // A board I may not add to (archived): my own list, nobody assigned.
    const archived = canvasTaskInit(canvas, 1, channelOf("public", { archived: true }), users, groups, false)!;
    expect(archived).toMatchObject({ channelId: null, assigneeIds: [], boardChoices: [] });
    // A DM's canvas: mine, shared in the DM with the people it mentions.
    const dm = canvasTaskInit(canvas, 1, channelOf("dm"), users, groups, false)!;
    expect(dm).toMatchObject({ channelId: null, shareChannelId: "ch-1", assigneeIds: [BOB] });
    expect(canvasTaskInit(canvas, 3, channelOf("public"), users, groups, false)).toBeNull();
  });

  it("sends the canvas and the line with POST /tasks, and reads the task's link back", () => {
    const init = canvasTaskInit(canvas, 1, channelOf("public"), users, groups, false)!;
    const draft = { title: init.title, notes: "", status: "todo" as const, dueOn: init.dueOn ?? "", assigneeIds: init.assigneeIds ?? [] };
    const sent = taskCreateBody(draft, init, "ch-1", "k1", "Asia/Tokyo");
    expect(sent).toMatchObject({ channel_id: "ch-1", due_on: "2030-01-10", assignee_ids: [BOB], source_canvas_id: "cv1", source_canvas_line: init.sourceCanvasLine });
    expect(sent).not.toHaveProperty("source_message_id");
    expect(canvasSourceState({ canvas_source: null })).toEqual({ kind: "none" });
    expect(canvasSourceState({ canvas_source: { canvas_id: "cv1", excerpt: "予稿" } })).toEqual({ kind: "link", canvasId: "cv1", excerpt: "予稿" });
    expect(canvasSourceState({ canvas_source: { canvas_id: null, excerpt: "予稿" } })).toEqual({ kind: "deleted", excerpt: "予稿" });
  });
});
