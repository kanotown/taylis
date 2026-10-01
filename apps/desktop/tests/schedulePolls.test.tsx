// @vitest-environment jsdom
// M53 (docs/SCHEDULING.md): scheduling polls on the Web — the form's candidates, the card, the table, deciding.
process.env.TZ = "Asia/Tokyo";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { CalendarEventOut, PollOut, UserMe, UserPublic } from "../src/api/types";
import { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import type { MessageState } from "../src/sync/types";
import { PollCard } from "../src/ui/PollCard";
import { ScheduleCard, ScheduleTableDialog } from "../src/ui/ScheduleCard";
import { ScheduleDialog } from "../src/ui/ScheduleDialog";
import {
  answersBody,
  bestSlots,
  durationLabel,
  myAnswers,
  myComment,
  pressAnswer,
  scheduleProblem,
  type SlotDraft,
  slotLabel,
  slotsFromEntries,
  slotToIn,
  sortSlots,
} from "../src/ui/scheduling";
import { readSchedule } from "../src/ui/templates";
import { fakeSlotLabel, FakeServer, MemoryPersistence } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const timed = (day: string, start: string, minutes = 60): SlotDraft => ({ day, allDay: false, start, minutes });
const allDay = (day: string): SlotDraft => ({ day, allDay: true, start: "10:00", minutes: 60 });

describe("the candidates (scheduling.ts)", () => {
  it("labels them as the server does: 「10/3 (土) 14:00〜15:00」, 終日, 24:00 and 翌", () => {
    expect(slotLabel(timed("2026-10-03", "14:00"))).toBe("10/3 (土) 14:00〜15:00");
    expect(slotLabel(timed("2026-10-03", "09:05", 90))).toBe("10/3 (土) 9:05〜10:35");
    expect(slotLabel(allDay("2026-10-05"))).toBe("10/5 (月) 終日");
    expect(slotLabel(timed("2026-10-06", "22:00", 120))).toBe("10/6 (火) 22:00〜24:00");
    expect(slotLabel(timed("2026-10-07", "23:00", 150))).toBe("10/7 (水) 23:00〜翌1:30");
    // The fake server's labels (the server's rule, in the poll's zone) agree.
    for (const slot of [timed("2026-10-03", "14:00"), timed("2026-10-06", "22:00", 120), timed("2026-10-07", "23:00", 150), allDay("2026-10-05")]) {
      expect(fakeSlotLabel(slotToIn(slot), "Asia/Tokyo")).toBe(slotLabel(slot));
    }
  });

  it("sends local times as UTC instants and all-day candidates as dates", () => {
    expect(slotToIn(timed("2026-10-03", "14:00"))).toEqual({ starts_at: "2026-10-03T05:00:00.000Z", ends_at: "2026-10-03T06:00:00.000Z" });
    expect(slotToIn(allDay("2026-10-05"))).toEqual({ date: "2026-10-05" });
  });

  it("checks the form before sending (the server's limits)", () => {
    const two = [timed("2026-10-03", "14:00"), allDay("2026-10-05")];
    expect(scheduleProblem("", two)).toBe("題名を入れてください");
    expect(scheduleProblem("ゼミ", two.slice(0, 1))).toBe("候補を 2 つ以上選んでください");
    expect(scheduleProblem("ゼミ", Array.from({ length: 21 }, (_, i) => allDay(`2026-11-${String(i + 1).padStart(2, "0")}`)))).toBe("候補は 20 個までです");
    expect(scheduleProblem("ゼミ", [timed("2026-10-03", "14:00", 10), allDay("2026-10-05")])).toBe("時間の長さは 15 分〜12 時間にしてください");
    expect(scheduleProblem("ゼミ", [timed("2026-10-03", "14:00", 721), allDay("2026-10-05")])).toBe("時間の長さは 15 分〜12 時間にしてください");
    expect(scheduleProblem("ゼミ", [timed("2026-10-03", ""), allDay("2026-10-05")])).toBe("時刻を入れてください");
    expect(scheduleProblem("ゼミ", [allDay("2026-10-05"), allDay("2026-10-05")])).toBe("同じ候補が複数あります");
    expect(scheduleProblem("ゼミ", [timed("2026-10-05", "10:00"), allDay("2026-10-05")])).toBeNull();
    expect(scheduleProblem("ゼミ", [timed("2026-10-03", "14:00", 15), timed("2026-10-03", "14:00", 720)])).toBeNull();
  });

  it("orders them, and reads `/日程` arguments as candidates (a time without an end lasts an hour)", () => {
    expect(sortSlots([timed("2026-10-05", "13:00"), allDay("2026-10-05"), timed("2026-10-03", "9:00")]).map(slotLabel)).toEqual(["10/3 (土) 9:00〜10:00", "10/5 (月) 終日", "10/5 (月) 13:00〜14:00"]);
    const read = readSchedule("ゼミ 10/3-10/4 13:00 10/6 9:30-12:00 10/3", new Date(2026, 8, 29, 10))!;
    expect(read.question).toBe("ゼミ");
    expect(slotsFromEntries(read.entries).map(slotLabel)).toEqual(["10/3 (土) 終日", "10/3 (土) 13:00〜14:00", "10/4 (日) 13:00〜14:00", "10/6 (火) 9:30〜12:00"]);
    expect(durationLabel(30)).toBe("30 分");
    expect(durationLabel(60)).toBe("1 時間");
    expect(durationLabel(90)).toBe("1 時間半");
    expect(durationLabel(135)).toBe("2 時間 15 分");
  });
});

/** A scheduling poll as the server sends it; `answers` per slot as [yes, maybe, no] user ids. */
function schedulePoll(answers: [string[], string[], string[]][], extra: Partial<PollOut> = {}): PollOut {
  const options = ["10/3 (土) 14:00〜15:00", "10/5 (月) 終日", "10/6 (火) 22:00〜24:00"].slice(0, answers.length);
  const anonymous = extra.anonymous ?? false;
  return {
    question: "M2 中間発表の練習",
    options,
    multiple: true,
    anonymous,
    closed_at: null,
    votes: answers.map(([yes]) => (anonymous ? [] : yes)),
    counts: answers.map(([yes]) => yes.length),
    mine: null,
    kind: "schedule",
    slots: [],
    tz: "Asia/Tokyo",
    decided: null,
    answers: answers.map(([yes, maybe, no]) => ({ yes: anonymous ? [] : yes, maybe: anonymous ? [] : maybe, no: anonymous ? [] : no, yes_count: yes.length, maybe_count: maybe.length, no_count: no.length })),
    respondents: anonymous ? [] : [...new Set(answers.flatMap(([a, b, c]) => [...a, ...b, ...c]))],
    comments: [],
    my_answers: null,
    my_comment: null,
    ...extra,
  };
}

describe("reading the answers", () => {
  it("takes mine from a named poll's lists, and from my_answers in an anonymous one", () => {
    const named = schedulePoll([[["me", "u2"], [], []], [[], ["me"], []], [[], [], ["u2"]]], { comments: [{ user_id: "me", text: "午後なら" }] });
    expect(myAnswers(named, "me")).toEqual(["yes", "maybe", null]);
    expect(myComment(named, "me")).toBe("午後なら");
    expect(bestSlots(named)).toEqual([0]);
    const anonymous = schedulePoll([[["a", "b"], [], []], [["c", "d"], [], []]], { anonymous: true, my_answers: [null, "yes"], my_comment: "どちらでも" });
    expect(myAnswers(anonymous, "me")).toEqual([null, "yes"]);
    expect(myComment(anonymous, "me")).toBe("どちらでも");
    expect(bestSlots(anonymous)).toEqual([0, 1]); // a tie stars both
    expect(myAnswers({ ...anonymous, my_answers: null }, "me")).toEqual([null, null]); // an event's copy says nothing
    expect(bestSlots(schedulePoll([[[], ["x"], []], [[], [], []]]))).toEqual([]); // no ○ yet: no star
  });

  it("pressing an answer sets it; pressing it again takes it back", () => {
    expect(pressAnswer(["yes", null, "no"], 1, "maybe")).toEqual(["yes", "maybe", "no"]);
    expect(pressAnswer(["yes", null, "no"], 0, "yes")).toEqual([null, null, "no"]);
    expect(answersBody(["yes", null, "no"])).toEqual([{ index: 0, answer: "yes" }, { index: 2, answer: "no" }]);
  });
});

describe("the form (日程調整を作成)", () => {
  function open(initial?: { question?: string; slots?: SlotDraft[] }) {
    const createSchedulePoll = vi.fn(async () => true);
    const onClose = vi.fn();
    const controller = { createSchedulePoll } as unknown as AppController;
    render(<ScheduleDialog controller={controller} channelId="c1" parentId={null} onClose={onClose} initial={initial} now={new Date(2026, 8, 29, 10)} />);
    const rows = () => [...document.querySelectorAll("[data-slot-row]")].map((li) => li.querySelector("span")?.textContent);
    const day = (key: string) => document.querySelector(`[data-pick-day="${key}"]`) as HTMLButtonElement;
    return { createSchedulePoll, onClose, rows, day };
  }

  it("makes a candidate of each day picked, with the time chosen for all; sends UTC instants and the zone", async () => {
    const w = open();
    expect(document.querySelectorAll("[data-pick-day]")).toHaveLength(35); // Sunday 9/27 – Saturday 10/31
    expect(w.day("2026-09-28").disabled).toBe(true); // before today
    fireEvent.click(w.day("2026-10-03"));
    fireEvent.click(w.day("2026-09-30"));
    expect(w.day("2026-10-03").getAttribute("aria-pressed")).toBe("true");
    expect(w.rows()).toEqual(["9/30 (水) 10:00〜11:00", "10/3 (土) 10:00〜11:00"]);
    // The time above goes to every candidate.
    fireEvent.change(screen.getByLabelText("開始時刻"), { target: { value: "14:00" } });
    fireEvent.change(screen.getByLabelText("長さ"), { target: { value: "90" } });
    expect(w.rows()).toEqual(["9/30 (水) 14:00〜15:30", "10/3 (土) 14:00〜15:30"]);
    // One candidate changed on its own; another time added on the same day; picking a day again removes it.
    fireEvent.change(screen.getByLabelText("10/3 (土) 14:00〜15:30 の開始時刻"), { target: { value: "13:00" } });
    fireEvent.click(screen.getByLabelText("10/3 (土) 13:00〜14:30 の後に同じ日の候補を追加"));
    expect(w.rows()).toEqual(["9/30 (水) 14:00〜15:30", "10/3 (土) 13:00〜14:30", "10/3 (土) 14:30〜16:00"]);
    fireEvent.click(w.day("2026-09-30"));
    expect(w.rows()).toEqual(["10/3 (土) 13:00〜14:30", "10/3 (土) 14:30〜16:00"]);
    // Nothing goes without a title.
    await act(async () => { fireEvent.click(screen.getByText("作成")); });
    expect(screen.getByText("題名を入れてください")).toBeTruthy();
    expect(w.createSchedulePoll).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText(/M2 中間発表/), { target: { value: " 発表練習 " } });
    await act(async () => { fireEvent.click(screen.getByText("作成")); });
    expect(w.createSchedulePoll).toHaveBeenCalledWith("c1", null, "発表練習", [
      { starts_at: "2026-10-03T04:00:00.000Z", ends_at: "2026-10-03T05:30:00.000Z" },
      { starts_at: "2026-10-03T05:30:00.000Z", ends_at: "2026-10-03T07:00:00.000Z" },
    ], "Asia/Tokyo", false);
    expect(w.onClose).toHaveBeenCalled();
  });

  it("終日 makes every candidate a whole day (one per day); fewer than two is refused; the next month too", async () => {
    const w = open({ question: "ゼミ", slots: [timed("2026-10-03", "13:00"), timed("2026-10-03", "15:00")] });
    expect(w.rows()).toEqual(["10/3 (土) 13:00〜14:00", "10/3 (土) 15:00〜16:00"]);
    fireEvent.click(screen.getByRole("radio", { name: "終日" }));
    expect(w.rows()).toEqual(["10/3 (土) 終日"]);
    expect(screen.queryByLabelText("開始時刻")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByText("作成")); });
    expect(screen.getByText("候補を 2 つ以上選んでください")).toBeTruthy();
    fireEvent.click(screen.getByLabelText("次の月"));
    expect(screen.getByText("2026年11月")).toBeTruthy();
    fireEvent.click(w.day("2026-11-02"));
    fireEvent.click(screen.getByLabelText("匿名にする (誰が答えたか表示しない)"));
    await act(async () => { fireEvent.click(screen.getByText("作成")); });
    expect(w.createSchedulePoll).toHaveBeenCalledWith("c1", null, "ゼミ", [{ date: "2026-10-03" }, { date: "2026-11-02" }], "Asia/Tokyo", true);
  });
});

describe("the card", () => {
  const people = ["alice", "bob", "carol"].map((name, i) => ({ id: `u-${name}`, username: name, display_name: name[0]!.toUpperCase() + name.slice(1), role: i === 0 ? "member" : "member" }) as UserPublic);
  const [alice, bob, carol] = people as [UserPublic, UserPublic, UserPublic];

  function card(poll: PollOut, { me = bob, author = alice, role = "member", admin = false }: { me?: UserPublic; author?: UserPublic; role?: "owner" | "member"; admin?: boolean } = {}) {
    const store = new Store();
    for (const user of people) store.upsertUser(user);
    store.setMe({ ...me, role: admin ? "admin" : "member" } as unknown as UserMe);
    store.upsertChannel({ id: "c1", type: "public", name: "lab", membership: { role, joined_at: "" } } as never, { isMember: true });
    const controller = {
      store,
      isAdmin: admin,
      answerSchedule: vi.fn(async () => true),
      decideSchedule: vi.fn(async () => true),
      undecideSchedule: vi.fn(async () => true),
      loadCalendarEvent: vi.fn(async () => null),
    };
    const message = { id: "m1", channel_id: "c1", sender_id: author.id, seq: 1, updated_seq: 1, client_msg_id: null, body: "📊 M2 中間発表の練習", created_at: "", edited_at: null, deleted: false, poll } satisfies MessageState;
    render(<PollCard poll={poll} message={message} controller={controller as unknown as AppController} />);
    return { controller, message };
  }

  it("shows the counts, stars the most ○, and my buttons answer (pressing mine again takes it back)", () => {
    const w = card(schedulePoll([[[alice.id, carol.id], [], []], [[alice.id], [bob.id], [carol.id]], [[], [], []]]));
    const first = document.querySelector('[data-slot="0"]') as HTMLElement;
    expect(within(first).getByText("10/3 (土) 14:00〜15:00")).toBeTruthy();
    expect(within(first).getByLabelText("○ がいちばん多い")).toBeTruthy();
    expect(within(first).getByLabelText("○ 2 人、△ 0 人、× 0 人")).toBeTruthy();
    expect(within(document.querySelector('[data-slot="1"]') as HTMLElement).queryByLabelText("○ がいちばん多い")).toBeNull();
    const maybe = screen.getByLabelText("10/5 (月) 終日: 未定");
    expect(maybe.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByLabelText("10/3 (土) 14:00〜15:00: 参加できる"));
    expect(w.controller.answerSchedule).toHaveBeenLastCalledWith(w.message, ["yes", "maybe", null]);
    fireEvent.click(maybe);
    expect(w.controller.answerSchedule).toHaveBeenLastCalledWith(w.message, [null, null, null]);
    fireEvent.click(screen.getByLabelText("10/6 (火) 22:00〜24:00: 参加できない"));
    expect(w.controller.answerSchedule).toHaveBeenLastCalledWith(w.message, [null, "maybe", "no"]);
    expect(screen.getByText("3 人が回答")).toBeTruthy();
    // A member who is neither the author nor an owner cannot decide.
    expect(screen.queryByText("決める")).toBeNull();
  });

  it("saves my comment with my answers", async () => {
    const w = card(schedulePoll([[[bob.id], [], []], [[], [], []]]));
    fireEvent.change(screen.getByLabelText("ひとこと"), { target: { value: " 午後なら " } });
    await act(async () => { fireEvent.click(screen.getByText("保存")); });
    expect(w.controller.answerSchedule).toHaveBeenCalledWith(w.message, ["yes", null], "午後なら");
  });

  it("lets the author, an owner or an admin decide, after asking", async () => {
    for (const who of [{ me: alice }, { role: "owner" as const }, { admin: true }]) {
      const w = card(schedulePoll([[[bob.id], [], []], [[], [], []]]), who);
      fireEvent.click(screen.getByLabelText("10/5 (月) 終日 に決める"));
      const dialog = screen.getByRole("dialog", { name: "この日に決めますか？" });
      expect(within(dialog).getByText(/チャンネルのカレンダーに予定を作り/)).toBeTruthy();
      await act(async () => { fireEvent.click(within(dialog).getByText("決定")); });
      expect(w.controller.decideSchedule).toHaveBeenCalledWith(w.message, 1);
      cleanup();
    }
  });

  it("shows a decided poll's slot first, opens its event, and lets the decider take it back", async () => {
    const decided = { index: 0, event_id: "e1", by: alice.id, at: "2026-10-01T00:00:00Z" };
    const w = card(schedulePoll([[[bob.id, carol.id], [alice.id], []], [[], [], []]], { decided, closed_at: "2026-10-01T00:00:00Z" }), { me: alice });
    const block = document.querySelector("[data-decided]") as HTMLElement;
    expect(within(block).getByText("10/3 (土) 14:00〜15:00")).toBeTruthy();
    expect(within(block).getByLabelText("○ 2 人、△ 1 人、× 0 人")).toBeTruthy();
    expect((screen.getByLabelText("10/5 (月) 終日: 参加できる") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("決める")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByText("予定を開く")); });
    expect(w.controller.loadCalendarEvent).toHaveBeenCalledWith("e1");
    fireEvent.click(screen.getByText("決定を取り消す"));
    expect(w.controller.undecideSchedule).toHaveBeenCalledWith(w.message);
    expect(screen.getByText("決定済み · 3 人が回答")).toBeTruthy();
  });

  it("opens the decided event in the event dialog", async () => {
    const event = { id: "e1", channel_id: "c1", channel_name: "lab", owner_id: alice.id, title: "M2 中間発表の練習", all_day: false, starts_at: "2026-10-03T05:00:00Z", ends_at: "2026-10-03T06:00:00Z", start_date: null, end_date: null, location: null, description: "日程調整で決定", created_at: "", updated_at: "", can_edit: false, alarm: null } as CalendarEventOut;
    const decided = { index: 0, event_id: "e1", by: alice.id, at: "2026-10-01T00:00:00Z" };
    const w = card(schedulePoll([[[bob.id], [], []], [[], [], []]], { decided, closed_at: "2026-10-01T00:00:00Z" }));
    w.controller.loadCalendarEvent.mockResolvedValue(event as never);
    await act(async () => { fireEvent.click(screen.getByText("予定を開く")); });
    const dialog = screen.getByRole("dialog", { name: "予定" }); // read-only: not mine
    expect(within(dialog).getByText("M2 中間発表の練習")).toBeTruthy();
    expect(within(dialog).getByText("日程調整で決定")).toBeTruthy();
    expect(screen.queryByText("決定を取り消す")).toBeNull(); // bob did not decide and is no owner
  });
});

describe("the table (表で見る)", () => {
  const users = ["alice", "bob", "carol"].map((name) => ({ id: `u-${name}`, username: name, display_name: name[0]!.toUpperCase() + name.slice(1), role: "member" }) as UserPublic);
  const [alice, bob, carol] = users as [UserPublic, UserPublic, UserPublic];

  function table(poll: PollOut, me = bob) {
    const store = new Store();
    for (const user of users) store.upsertUser(user);
    store.setMe(me as unknown as UserMe);
    const controller = { store, answerSchedule: vi.fn(async () => true) };
    const message = { id: "m1", channel_id: "c1", sender_id: alice.id, seq: 1, updated_seq: 1, client_msg_id: null, body: "", created_at: "", edited_at: null, deleted: false, poll } satisfies MessageState;
    render(<ScheduleTableDialog poll={poll} message={message} controller={controller as unknown as AppController} readOnly={false} onClose={() => {}} />);
    const row = (key: string) => [...(document.querySelector(`[data-row="${key}"]`) as HTMLElement).querySelectorAll("th, td")].map((c) => c.textContent?.trim());
    return { controller, message, row };
  }

  it("lists the people by their first answer with their marks and comments; my row changes by clicking", () => {
    const w = table(schedulePoll([[[alice.id], [bob.id], [carol.id]], [[carol.id, bob.id], [], [alice.id]]], { comments: [{ user_id: carol.id, text: "遅れます" }, { user_id: bob.id, text: "午後なら" }] }));
    expect(w.row("counts")).toEqual(["集計", "○1 △1 ×1", "○2 △0 ×1", ""]);
    expect(w.row(alice.id)).toEqual(["Alice", "○", "×", ""]);
    expect(w.row(carol.id)).toEqual(["Carol", "×", "○", "遅れます"]);
    expect(w.row("me")[0]).toBe("Bob (自分)");
    // ○ → △ → × → unanswered.
    fireEvent.click(screen.getByLabelText("自分の 10/3 (土) 14:00〜15:00: 未定 (押すと変わります)"));
    expect(w.controller.answerSchedule).toHaveBeenLastCalledWith(w.message, ["no", "yes"]);
    fireEvent.click(screen.getByLabelText("自分の 10/5 (月) 終日: 参加できる (押すと変わります)"));
    expect(w.controller.answerSchedule).toHaveBeenLastCalledWith(w.message, ["maybe", "maybe"]);
    expect((screen.getByLabelText("ひとこと") as HTMLInputElement).value).toBe("午後なら");
  });

  it("an anonymous poll has the counts, my row and unnamed comments only", () => {
    const poll = schedulePoll([[["x", "y"], [], []], [[], ["z"], []]], { anonymous: true, my_answers: ["yes", null], my_comment: "", comments: [{ user_id: null, text: "どちらでも" }] });
    table(poll);
    expect(document.querySelectorAll("tbody tr")).toHaveLength(2); // the counts and me
    expect(screen.getByText("どちらでも")).toBeTruthy();
    expect(screen.queryByText("Alice")).toBeNull();
  });
});

describe("deciding against the fake server", () => {
  async function world() {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    const carol = server.addUser("carol");
    const channel = server.createChannel("lab", alice.id);
    server.join(channel.id, bob.id);
    server.join(channel.id, carol.id);
    const store = new Store(new MemoryPersistence());
    const engine = new SyncEngine({ api: server.apiFor(alice.id), connect: server.connectorFor(alice.id), store, getAccessToken: () => "token", sleep: async () => {} });
    await engine.start();
    await engine.idle();
    await engine.openChannel(channel.id);
    await engine.idle();
    const controller = new AppController();
    controller.api = {
      baseUrl: "http://server",
      postPoll: async (channelId: string, parentId: string | null, poll: { question: string; slots: never[]; tz: string; anonymous?: boolean }) => server.postSchedule(channelId, alice.id, poll, parentId),
      answerPoll: async (id: string, body: { answers: { index: number; answer: "yes" | "maybe" | "no" }[]; comment?: string | null }) => server.answer(channel.id, alice.id, id, body.answers, body.comment),
      decidePoll: async (id: string, index: number, createEvent: boolean) => server.decide(channel.id, alice.id, id, index, createEvent),
      undecidePoll: async (id: string) => server.undecide(channel.id, alice.id, id),
    } as unknown as ApiClient;
    const session = (controller as unknown as { active: { store: Store; engine: SyncEngine } }).active;
    session.store = store;
    session.engine = engine;
    store.setMe({ ...alice, email: null } as unknown as UserMe);
    return { server, alice, bob, carol, channel, store, engine, controller };
  }

  it("creates, gathers answers, decides (event and thread reply), takes it back", async () => {
    const w = await world();
    const slots = [timed("2026-10-03", "14:00"), allDay("2026-10-05")];
    expect(await w.controller.createSchedulePoll(w.channel.id, null, "発表練習", slots.map(slotToIn), "Asia/Tokyo")).toBe(true);
    await w.engine.idle();
    const id = w.server.messageByBody(w.channel.id, "📊 発表練習").id;
    const poll = () => w.store.message(w.channel.id, id)!.poll!;
    expect(poll().options).toEqual(["10/3 (土) 14:00〜15:00", "10/5 (月) 終日"]);
    expect(poll().my_answers).toEqual([null, null]);

    w.server.answer(w.channel.id, w.bob.id, id, [{ index: 0, answer: "yes" }, { index: 1, answer: "no" }], "午後なら");
    w.server.answer(w.channel.id, w.carol.id, id, [{ index: 0, answer: "maybe" }]);
    await w.controller.answerSchedule(w.store.message(w.channel.id, id)!, ["yes", "maybe"]);
    await w.engine.idle();
    expect(poll().answers?.[0]).toMatchObject({ yes: [w.bob.id, w.alice.id], maybe: [w.carol.id], yes_count: 2 });
    expect(myAnswers(poll(), w.alice.id)).toEqual(["yes", "maybe"]);
    expect(poll().comments).toEqual([{ user_id: w.bob.id, text: "午後なら" }]);

    expect(await w.controller.decideSchedule(w.store.message(w.channel.id, id)!, 0)).toBe(true);
    await w.engine.idle();
    expect(poll().decided?.index).toBe(0);
    expect(poll().closed_at).not.toBeNull();
    const eventId = poll().decided!.event_id!;
    expect(w.server.decidedEvents.get(eventId)).toMatchObject({ channelId: w.channel.id, title: "発表練習" });
    const [reply] = await w.server.apiFor(w.alice.id).replies(id);
    expect(reply!.body).toBe(`📅 日程が決まりました: 10/3 (土) 14:00〜15:00 (○ 2 · △ 1)\n<@${w.bob.id}> <@${w.carol.id}>`);
    expect(w.store.message(w.channel.id, id)!.reply_count).toBe(1);

    // The card shows it decided; answering is closed.
    render(<ScheduleCard poll={poll()} message={w.store.message(w.channel.id, id)!} controller={w.controller} />);
    expect(within(document.querySelector("[data-decided]") as HTMLElement).getByText("10/3 (土) 14:00〜15:00")).toBeTruthy();
    expect((screen.getByLabelText("10/5 (月) 終日: 参加できる") as HTMLButtonElement).disabled).toBe(true);
    cleanup();

    expect(await w.controller.undecideSchedule(w.store.message(w.channel.id, id)!)).toBe(true);
    await w.engine.idle();
    expect(poll().decided).toBeNull();
    expect(poll().closed_at).toBeNull();
    expect(w.server.decidedEvents.has(eventId)).toBe(true); // the event stays
  });

  it("keeps my answers to an anonymous poll across the events (which carry none)", async () => {
    const w = await world();
    await w.controller.createSchedulePoll(w.channel.id, null, "匿名で", [allDay("2026-10-05"), allDay("2026-10-06")].map(slotToIn), "Asia/Tokyo", true);
    await w.engine.idle();
    const id = w.server.messageByBody(w.channel.id, "📊 匿名で").id;
    await w.controller.answerSchedule(w.store.message(w.channel.id, id)!, [null, "yes"], "どちらでも");
    await w.engine.idle();
    w.server.answer(w.channel.id, w.bob.id, id, [{ index: 0, answer: "yes" }]); // bob's change: an event with my_answers null
    await w.engine.idle();
    const poll = w.store.message(w.channel.id, id)!.poll!;
    expect(poll.answers?.map((a) => a.yes_count)).toEqual([1, 1]);
    expect(poll.my_answers).toEqual([null, "yes"]);
    expect(poll.my_comment).toBe("どちらでも");
    expect(myAnswers(poll, w.alice.id)).toEqual([null, "yes"]);
  });

  it("a refused decision shows the server's reason", async () => {
    const w = await world();
    const message = w.server.postSchedule(w.channel.id, w.bob.id, { question: "bob の調整", slots: [allDay("2026-10-05"), allDay("2026-10-06")].map(slotToIn), tz: "Asia/Tokyo" });
    w.server.roles.set(`${w.channel.id}:${w.alice.id}`, "member"); // alice is no longer an owner
    const setError = vi.spyOn(w.controller, "setError");
    await w.engine.idle();
    expect(await w.controller.decideSchedule(w.store.message(w.channel.id, message.id)!, 0)).toBe(false);
    expect(setError).toHaveBeenCalled();
  });
});
