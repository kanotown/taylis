/** M34: the phone's bottom tabs — badges, the DM list, where things land and the per-tab stacks (pure rules). */
import { describe, expect, it } from "vitest";

import type { ChannelState } from "../src/sync/types";
import { activityBadge, dmBadge, dmList, dmTimeLabel, homeDot, isSelfNotes, landingTab, landOn, tapTab, type TabStacks } from "../src/ui/mobileTabs";

const ME = "me";
const now = new Date(2026, 8, 29, 15, 0); // Tuesday 2026-09-29 15:00, local time
const channel = (id: string, patch: Partial<ChannelState> = {}): ChannelState => ({
  id,
  type: "public",
  name: id,
  topic: null,
  purpose: null,
  archived: false,
  created_by: null,
  last_seq: 0,
  last_message_at: null,
  created_at: "",
  updated_at: "",
  membership: null,
  dm_user_ids: null,
  posting_policy: "everyone",
  isMember: true,
  syncedSeq: null,
  lastSeq: 0,
  lastReadSeq: 0,
  unreadCount: 0,
  mentionCount: 0,
  firstUnreadAt: null,
  pendingReadSeq: null,
  hasOlder: true,
  oldestLoadedSeq: null,
  notificationLevel: null,
  mutedUntil: null,
  ...patch,
});
const dm = (id: string, users: string[], patch: Partial<ChannelState> = {}) => channel(id, { type: users.length > 2 ? "group_dm" : "dm", name: null, dm_user_ids: users, ...patch });

describe("tab badges (§8, on the unread rules of channels.ts)", () => {
  it("DM: the DMs and group DMs of mine that are unread; a muted one only with a mention, channels never", () => {
    const channels = [
      dm("a", [ME, "x"], { unreadCount: 3 }),
      dm("b", [ME, "x", "y"], { unreadCount: 1 }),
      dm("c", [ME, "y"], { unreadCount: 5, notificationLevel: "none" }), // muted, no mention
      dm("d", [ME, "z"], { unreadCount: 2, mentionCount: 1, mutedUntil: new Date(now.getTime() + 3600_000).toISOString() }), // muted, mention
      dm("e", [ME, "w"], { unreadCount: 4, isMember: false }),
      dm("f", [ME, "v"]),
      channel("g", { unreadCount: 9, mentionCount: 2 }),
    ];
    expect(dmBadge(channels, ME, now)).toBe(3); // a, b, d
  });

  it("activity: unread followed threads + channels (not DMs) with a mention; red with any mention", () => {
    const channels = [
      channel("a", { unreadCount: 4, mentionCount: 1 }),
      channel("b", { unreadCount: 4, mentionCount: 0 }),
      channel("c", { unreadCount: 2, mentionCount: 2, notificationLevel: "none" }),
      dm("d", [ME, "x"], { unreadCount: 1, mentionCount: 1 }),
      channel("e", { mentionCount: 1, isMember: false }),
    ];
    expect(activityBadge(channels, { unread_count: 3, mention_count: 0 })).toEqual({ count: 5, mention: true }); // 3 + a, c
    expect(activityBadge([channel("b", { unreadCount: 4 })], { unread_count: 3, mention_count: 0 })).toEqual({ count: 3, mention: false });
    expect(activityBadge([], { unread_count: 2, mention_count: 1 })).toEqual({ count: 2, mention: true });
    expect(activityBadge([], { unread_count: 0, mention_count: 0 })).toEqual({ count: 0, mention: false });
  });

  it("home: a dot for an unread channel (not a DM), by the sidebar's rule (muted and quiet times need a mention)", () => {
    expect(homeDot([channel("a", { unreadCount: 1 })], ME, now)).toBe(true);
    expect(homeDot([dm("b", [ME, "x"], { unreadCount: 3 })], ME, now)).toBe(false);
    expect(homeDot([channel("c", { unreadCount: 3, notificationLevel: "none" })], ME, now)).toBe(false);
    expect(homeDot([channel("d", { unreadCount: 3, times_owner_id: "x" })], ME, now)).toBe(false); // someone else's times
    expect(homeDot([channel("e", { unreadCount: 3, times_owner_id: "x", mentionCount: 1 })], ME, now)).toBe(true);
    expect(homeDot([channel("f", { unreadCount: 3, isMember: false })], ME, now)).toBe(false);
  });
});

describe("the DM list (§6.3)", () => {
  const title = (c: ChannelState) => ({ notes: "自分へのメモ", a: "Alice", b: "Bob, Carol", c: "Dave" })[c.id] ?? c.id;
  const rows = [
    dm("a", [ME, "alice"], { last_message_at: "2026-09-29T01:00:00Z" }),
    dm("b", [ME, "bob", "carol"], { last_message_at: "2026-09-29T05:00:00Z" }),
    dm("notes", [ME], { last_message_at: null }),
    dm("c", [ME, "dave"], { last_message_at: null }),
    channel("general", { last_message_at: "2026-09-29T09:00:00Z" }),
    dm("gone", [ME, "eve"], { isMember: false, last_message_at: "2026-09-29T09:00:00Z" }),
  ];

  it("「自分へのメモ」 first, then the newest last message; only my DMs and group DMs", () => {
    expect(dmList(rows, title, ME).map((c) => c.id)).toEqual(["notes", "b", "a", "c"]);
    expect(isSelfNotes(rows[2]!, ME)).toBe(true);
    expect(isSelfNotes(rows[0]!, ME)).toBe(false);
  });

  it("filters by name, ignoring case", () => {
    expect(dmList(rows, title, ME, "  bOb ").map((c) => c.id)).toEqual(["b"]);
    expect(dmList(rows, title, ME, "メモ").map((c) => c.id)).toEqual(["notes"]);
    expect(dmList(rows, title, ME, "zzz")).toEqual([]);
  });

  it("time labels: today H:mm, 昨日, the weekday within 7 days, M/d, yyyy/M/d another year, nothing without a message", () => {
    const at = (y: number, m: number, d: number, h = 9, min = 5) => new Date(y, m - 1, d, h, min).toISOString();
    expect(dmTimeLabel(at(2026, 9, 29, 9, 5), now)).toBe("9:05");
    expect(dmTimeLabel(at(2026, 9, 29, 0, 0), now)).toBe("0:00");
    expect(dmTimeLabel(at(2026, 9, 29, 14, 32), now)).toBe("14:32");
    expect(dmTimeLabel(at(2026, 9, 28, 23, 59), now)).toBe("昨日");
    expect(dmTimeLabel(at(2026, 9, 27), now)).toBe("日曜日");
    expect(dmTimeLabel(at(2026, 9, 23), now)).toBe("水曜日"); // 6 days before
    expect(dmTimeLabel(at(2026, 9, 22), now)).toBe("9/22"); // 7 days before
    expect(dmTimeLabel(at(2026, 9, 3), now)).toBe("9/3");
    expect(dmTimeLabel(at(2025, 12, 31), now)).toBe("2025/12/31");
    expect(dmTimeLabel(at(2025, 12, 31), new Date(2026, 0, 1, 8))).toBe("昨日"); // the day before, across the year
    expect(dmTimeLabel(null, now)).toBe("");
    expect(dmTimeLabel("not a date", now)).toBe("");
  });
});

describe("where things land and the tab stacks (§5, M34 (7))", () => {
  type S = { screens: string[] };
  const root = (s: S): S => ({ screens: s.screens.slice(0, 1) });
  const isRoot = (s: S) => s.screens.length === 1;
  const home: TabStacks<S> = { tab: "home", saved: {} };

  it("a DM lands on the DM tab, a channel (a preview, an unknown one) on home", () => {
    expect(landingTab(dm("a", [ME, "x"]))).toBe("dm");
    expect(landingTab(dm("b", [ME, "x", "y"]))).toBe("dm");
    expect(landingTab(channel("c"))).toBe("home");
    expect(landingTab(channel("d", { type: "private" }))).toBe("home");
    expect(landingTab(undefined)).toBe("home");
  });

  it("switching tabs keeps each tab's screens; a second tap pops to the root, a third scrolls it up", () => {
    const live: S = { screens: ["home", "#general", "thread"] };
    const toDm = tapTab(home, live, "dm", root, isRoot);
    expect(toDm.stacks).toEqual({ tab: "dm", saved: { home: live } });
    expect(toDm.live).toEqual({ screens: ["home"] }); // the DM tab's root the first time
    const dmLive: S = { screens: ["dm", "@alice"] };
    const back = tapTab(toDm.stacks, dmLive, "home", root, isRoot);
    expect(back.live).toBe(live); // as it was left
    expect(back.stacks).toEqual({ tab: "home", saved: { dm: dmLive } });
    expect(back.scrollTop).toBe(false);

    const again = tapTab(back.stacks, live, "home", root, isRoot);
    expect(again.live).toEqual({ screens: ["home"] });
    expect(again.stacks).toBe(back.stacks);
    expect(again.scrollTop).toBe(false);
    const third = tapTab(again.stacks, again.live, "home", root, isRoot);
    expect(third.scrollTop).toBe(true);
    expect(third.live).toBe(again.live);
  });

  it("landing replaces the target tab's screens and selects it; the tab left keeps its own", () => {
    const live: S = { screens: ["activity", "#general"] };
    const stacks: TabStacks<S> = { tab: "activity", saved: { dm: { screens: ["dm", "@bob", "thread"] } } };
    const landed = landOn(stacks, live, "dm", { screens: ["dm", "@alice"] });
    expect(landed.stacks).toEqual({ tab: "dm", saved: { activity: live } });
    expect(landed.live).toEqual({ screens: ["dm", "@alice"] });
    // On the selected tab: its screens are replaced, nothing else moves.
    const same = landOn(landed.stacks, landed.live, "dm", { screens: ["dm", "@carol"] });
    expect(same.stacks).toBe(landed.stacks);
    expect(same.live).toEqual({ screens: ["dm", "@carol"] });
  });
});
