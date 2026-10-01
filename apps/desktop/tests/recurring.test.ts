// L6 (M59, RECURRING.md): the summaries, the dialog's checks and bodies, and the collection chip's states.
process.env.TZ = "Asia/Tokyo";

import { describe, expect, it } from "vitest";

import type { CollectionOut, RecurringPostOut } from "../src/api/types";
import type { ChannelState } from "../src/sync/types";
import {
  canManageRecurring,
  clockLabel,
  collectionChip,
  collectionLists,
  createBody,
  draftFromPost,
  dueSummary,
  emptyDraft,
  placeholderHint,
  type RecurringDraft,
  recurringDraftProblem,
  scheduleSummary,
  shortDateTime,
  targetsSummary,
  updateBody,
} from "../src/ui/recurring";

describe("summaries", () => {
  it("reads a schedule the way people say it", () => {
    expect(clockLabel("09:00")).toBe("9:00");
    expect(clockLabel("18:30")).toBe("18:30");
    expect(scheduleSummary({ kind: "weekly", weekdays: [3, 0], time: "09:00" })).toBe("毎週 月・木 9:00");
    expect(scheduleSummary({ kind: "weekly", weekdays: [0, 1, 2, 3, 4, 5, 6], time: "08:15" })).toBe("毎日 8:15");
    expect(scheduleSummary({ kind: "weekly", weekdays: [6], time: "23:59" })).toBe("毎週 日 23:59");
    expect(scheduleSummary({ kind: "monthly", day: 1, time: "09:00" })).toBe("毎月 1 日 9:00");
    expect(scheduleSummary({ kind: "monthly", day: 30, time: "09:00" })).toBe("毎月 30 日 (ない月は末日) 9:00");
    expect(scheduleSummary({ kind: "monthly", day: 31, time: "18:00" })).toBe("毎月 末日 18:00");
    // Another zone than this device's is named.
    expect(scheduleSummary({ kind: "monthly", day: 1, time: "09:00" }, "America/New_York", "Asia/Tokyo")).toBe("毎月 1 日 9:00 (America/New_York)");
    expect(scheduleSummary({ kind: "monthly", day: 1, time: "09:00" }, "Asia/Tokyo", "Asia/Tokyo")).toBe("毎月 1 日 9:00");
  });

  it("reads the due time, the date and the targets", () => {
    expect(dueSummary({ after_days: 0, time: "18:00" })).toBe("当日 18:00 締切");
    expect(dueSummary({ after_days: 3, time: "09:30" })).toBe("3 日後 9:30 締切");
    expect(shortDateTime("2026-10-09T09:00:00Z")).toBe("10/9 (金) 18:00");
    expect(shortDateTime("2026-10-04T15:05:00Z")).toBe("10/5 (月) 0:05");
    const groups = new Map([["g1", "students"]]);
    const users = new Map([["u1", "ボブ"], ["u2", "キャロル"]]);
    const name = (m: Map<string, string>) => (id: string) => m.get(id);
    const due = { after_days: 1, time: "18:00" };
    expect(targetsSummary({ targets: { all_members: true, group_ids: ["g1"] }, due }, name(groups), name(users))).toBe("チャンネルの全員");
    expect(targetsSummary({ targets: { all_members: false, group_ids: ["g1"], user_ids: ["u1", "u2"] }, due }, name(groups), name(users))).toBe("@students、ボブ、キャロル");
    expect(targetsSummary({ targets: { all_members: false, user_ids: ["u1", "u2", "u1", "u2", "u1", "u2"] }, due }, name(groups), name(users))).toBe("ボブ、キャロル、ボブ、キャロル ほか 2");
  });

  it("explains the placeholders with today's values", () => {
    expect(placeholderHint(new Date(2026, 8, 28))).toBe("{date} → 2026/09/28 (月)、{weekday} → 月、{week} → 週番号 (例 2026-W40)。投稿した日に置き換わります");
    expect(placeholderHint(new Date(2027, 0, 1))).toContain("(例 2026-W53)");
  });
});

describe("who manages", () => {
  const channel = (patch: Partial<ChannelState>) => ({ id: "c", type: "public", isMember: true, membership: { role: "member" }, ...patch }) as unknown as ChannelState;
  it("owners and administrators who are members, in channels only", () => {
    expect(canManageRecurring(channel({ membership: { role: "owner" } as never }), false)).toBe(true);
    expect(canManageRecurring(channel({}), true)).toBe(true);
    expect(canManageRecurring(channel({}), false)).toBe(false);
    expect(canManageRecurring(channel({ isMember: false }), true)).toBe(false);
    expect(canManageRecurring(channel({ type: "dm" } as never), true)).toBe(false);
    expect(canManageRecurring(undefined, true)).toBe(false);
  });
});

describe("the dialog's draft", () => {
  const valid = (patch: Partial<RecurringDraft> = {}): RecurringDraft => ({ ...emptyDraft(new Date(2026, 9, 1)), name: "週報", body: "**週報 {date}**", ...patch });

  it("starts on today's weekday at 9:00, not collecting", () => {
    const draft = emptyDraft(new Date(2026, 9, 1)); // a Thursday
    expect(draft).toMatchObject({ kind: "weekly", weekdays: [3], time: "09:00", collect: false, afterDays: 3, dueTime: "18:00" });
    expect(emptyDraft(new Date(2026, 9, 4)).weekdays).toEqual([6]); // Sunday
  });

  it("names what is missing", () => {
    expect(recurringDraftProblem(valid())).toBeNull();
    expect(recurringDraftProblem(valid({ name: "  " }))).toBe("名前を入力してください");
    expect(recurringDraftProblem(valid({ name: "あ".repeat(41) }))).toBe("名前は 40 文字までです");
    expect(recurringDraftProblem(valid({ name: `  ${"あ".repeat(20)}   ${"い".repeat(19)} ` }))).toBeNull(); // spaces fold, as on the server
    expect(recurringDraftProblem(valid({ body: "\n " }))).toBe("本文を入力してください");
    expect(recurringDraftProblem(valid({ body: "x".repeat(4001) }))).toBe("本文は 4000 文字までです");
    expect(recurringDraftProblem(valid({ weekdays: [] }))).toBe("曜日を 1 つ以上選んでください");
    expect(recurringDraftProblem(valid({ kind: "monthly", weekdays: [], day: 31 }))).toBeNull();
    expect(recurringDraftProblem(valid({ kind: "monthly", day: 0 }))).toBe("日は 1〜31 で選んでください");
    expect(recurringDraftProblem(valid({ time: "" }))).toBe("時刻を選んでください");
    expect(recurringDraftProblem(valid({ time: "24:00" }))).toBe("時刻を選んでください");
    expect(recurringDraftProblem(valid({ collect: true }))).toBe("提出する人を選んでください");
    expect(recurringDraftProblem(valid({ collect: true, allMembers: true }))).toBeNull();
    expect(recurringDraftProblem(valid({ collect: true, groupIds: ["g"] }))).toBeNull();
    expect(recurringDraftProblem(valid({ collect: true, userIds: ["u"], afterDays: 31 }))).toBe("締切は 0〜30 日後で選んでください");
    expect(recurringDraftProblem(valid({ collect: true, userIds: ["u"], dueTime: "" }))).toBe("締切の時刻を選んでください");
    // Collecting off: its fields do not matter.
    expect(recurringDraftProblem(valid({ collect: false, dueTime: "" }))).toBeNull();
  });

  it("makes the request bodies", () => {
    expect(createBody(valid({ weekdays: [4, 0, 4] }), "Asia/Tokyo")).toEqual({
      name: "週報",
      body: "**週報 {date}**",
      schedule: { kind: "weekly", weekdays: [0, 4], time: "09:00" },
      tz: "Asia/Tokyo",
      collect: null,
      enabled: true,
    });
    expect(updateBody(valid({ kind: "monthly", day: 15, collect: true, groupIds: ["g"], userIds: ["u"], afterDays: 0, dueTime: "17:00" }))).toEqual({
      name: "週報",
      body: "**週報 {date}**",
      schedule: { kind: "monthly", day: 15, time: "09:00" },
      collect: { targets: { all_members: false, group_ids: ["g"], user_ids: ["u"] }, due: { after_days: 0, time: "17:00" } },
    });
    // 「チャンネルの全員」 sends no names.
    expect(createBody(valid({ collect: true, allMembers: true, userIds: ["u"] }), "Asia/Tokyo").collect).toEqual({
      targets: { all_members: true, group_ids: [], user_ids: [] },
      due: { after_days: 3, time: "18:00" },
    });
  });

  it("reads a post back", () => {
    const post = {
      id: "p", channel_id: "c", bot_user_id: "b", created_by: "u", name: "日報", body: "{date}", tz: "Asia/Tokyo", enabled: true,
      schedule: { kind: "monthly", day: 31, time: "18:00" },
      collect: { targets: { all_members: false, group_ids: ["g"], user_ids: [] }, due: { after_days: 2, time: "12:00" } },
      next_run_at: "2026-10-31T09:00:00Z", last_run_at: null, created_at: "", updated_at: "",
    } as RecurringPostOut;
    const draft = draftFromPost(post);
    expect(draft).toMatchObject({ name: "日報", kind: "monthly", day: 31, time: "18:00", collect: true, groupIds: ["g"], afterDays: 2, dueTime: "12:00" });
    expect(updateBody(draft).collect).toEqual(post.collect);
  });
});

describe("the collection chip", () => {
  const collection = (submitted: string[], targets = ["a", "b", "c"], due = "2026-10-09T09:00:00Z"): CollectionOut => ({
    due_at: due,
    target_user_ids: targets,
    target_count: targets.length,
    submitted_user_ids: submitted,
    reminded_at: null,
  });
  const before = new Date("2026-10-08T00:00:00Z");
  const after = new Date("2026-10-09T09:00:01Z");

  it("counts and dates", () => {
    expect(collectionChip(collection(["a"]), null, before)).toEqual({ label: "提出 1/3 · 締切 10/9 (金) 18:00", mine: null, overdue: false, complete: false });
    expect(collectionChip(collection(["a", "b", "c"]), "z", after)).toMatchObject({ label: "提出 3/3 · 締切 10/9 (金) 18:00", overdue: true, complete: true });
    expect(collectionChip(collection([], []), "a", before)).toMatchObject({ label: "提出 0/0 · 締切 10/9 (金) 18:00", mine: null, complete: false });
  });

  it("says whether I owe one", () => {
    expect(collectionChip(collection(["a"]), "b", before).mine).toBe("pending");
    expect(collectionChip(collection(["a"]), "a", before).mine).toBe("submitted");
    expect(collectionChip(collection(["a"]), "b", after)).toMatchObject({ mine: "pending", overdue: true });
  });

  it("splits the targets in their order", () => {
    expect(collectionLists(collection(["c", "a"]))).toEqual({ submitted: ["a", "c"], missing: ["b"] });
  });
});
