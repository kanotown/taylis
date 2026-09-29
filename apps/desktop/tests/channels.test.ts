import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ChannelState } from "../src/sync/types";
import {
  badgeCount, canPostTopLevel, conversationTitle, effectiveNotificationLevel, hasUnread, isMutedChannel, isQuietChannel, isTimedMuted, myName, notificationChoices, overallLevel,
  ownNotification, resolveNotificationLevel, sectionChannels, showsSelfNotesInDmSection, stepChannel, unreadBadgeTotal,
} from "../src/ui/channels";

const now = new Date("2026-09-26T12:00:00Z");
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

describe("sidebar unread rules", () => {
  it("treats muted channels as unread only when mentioned", () => {
    const muted = channel("a", { notificationLevel: "none", unreadCount: 5 });
    expect(isMutedChannel(muted, now)).toBe(true);
    expect(hasUnread(muted, null, now)).toBe(false);
    expect(badgeCount(muted, now)).toBe(0);
    const mentioned = channel("b", { mutedUntil: "2026-09-26T20:00:00Z", unreadCount: 5, mentionCount: 2 });
    expect(hasUnread(mentioned, null, now)).toBe(true);
    expect(badgeCount(mentioned, now)).toBe(2);
    const expired = channel("c", { mutedUntil: "2026-09-26T01:00:00Z", unreadCount: 1 });
    expect(isMutedChannel(expired, now)).toBe(false);
    expect(hasUnread(expired, null, now)).toBe(true);
    const dm = channel("d", { type: "dm", unreadCount: 3 });
    expect(badgeCount(dm, now)).toBe(3);
  });

  it("filters to unread conversations but keeps the open one", () => {
    const all = [
      channel("general", { unreadCount: 0 }),
      channel("random", { unreadCount: 2 }),
      channel("dm", { type: "dm", unreadCount: 0, last_message_at: "2026-09-26T00:00:00Z" }),
      channel("public", { isMember: false }),
    ];
    const sections = sectionChannels(all, (c) => c.name ?? "", { unreadOnly: true, currentId: "general", now });
    expect(sections.channels.map((c) => c.id)).toEqual(["general", "random"]);
    expect(sections.dms).toEqual([]);
    expect(sections.browse).toEqual([]);
    expect(sectionChannels(all, (c) => c.name ?? "", { now }).browse.map((c) => c.id)).toEqual(["public"]);
  });

  it("steps through channels and through unread channels with wrap-around", () => {
    const order = [channel("a"), channel("b", { unreadCount: 1 }), channel("c"), channel("d", { unreadCount: 1 })];
    expect(stepChannel(order, "a", 1)?.id).toBe("b");
    expect(stepChannel(order, "a", -1)?.id).toBe("d");
    expect(stepChannel(order, "b", 1, { unreadOnly: true, now })?.id).toBe("d");
    expect(stepChannel(order, "d", 1, { unreadOnly: true, now })?.id).toBe("b");
    expect(stepChannel(order, null, 1, { unreadOnly: true, now })?.id).toBe("b");
    expect(stepChannel([channel("only")], "only", 1)).toBeUndefined();
  });
});

describe("unread badge total (M13f)", () => {
  it("adds up mentions for channels and every unread for DMs, skipping non-members and archives", () => {
    const base = { name: "x", topic: null, purpose: null, created_by: null, created_at: "", updated_at: "", last_seq: 0, membership: { role: "member", joined_at: "" }, isMember: true, archived: false, lastReadSeq: 0, syncedSeq: 0, lastMessageAt: null, dm_user_ids: null, notificationLevel: null, mutedUntil: null, member_count: 2 } as unknown as Parameters<typeof unreadBadgeTotal>[0] extends Iterable<infer T> ? Omit<T, "id" | "type" | "unreadCount" | "mentionCount"> : never;
    const rows = [
      { ...base, id: "a", type: "public", unreadCount: 5, mentionCount: 2 },
      { ...base, id: "b", type: "dm", unreadCount: 3, mentionCount: 0 },
      { ...base, id: "c", type: "public", unreadCount: 9, mentionCount: 4, isMember: false },
      { ...base, id: "d", type: "public", unreadCount: 9, mentionCount: 4, archived: true },
    ] as unknown as Parameters<typeof unreadBadgeTotal>[0];
    expect(unreadBadgeTotal(rows)).toBe(5);
  });
});

describe("custom sidebar sections (M14f)", () => {
  it("moves placed conversations out of the default sections, favorites first", () => {
    const base = { topic: null, purpose: null, created_by: null, created_at: "", updated_at: "", last_seq: 0, membership: { role: "member", joined_at: "" }, isMember: true, archived: false, lastReadSeq: 0, syncedSeq: 0, unreadCount: 0, mentionCount: 0, dm_user_ids: null, notificationLevel: null, mutedUntil: null, member_count: 2 };
    const make = (id: string, type: string, extra: Record<string, unknown> = {}) => ({ ...base, id, name: id, type, last_message_at: null, ...extra }) as unknown as ChannelState;
    const all = [make("alpha", "public"), make("beta", "public"), make("gamma", "private"), make("d1", "dm", { last_message_at: "2026-09-27T01:00:00Z" }), make("d2", "dm", { last_message_at: "2026-09-27T02:00:00Z" })];
    const sections = [
      { id: "s1", name: "プロジェクト", position: 0, channel_ids: ["gamma", "d1", "beta"], collapsed: false },
      { id: "s2", name: "空", position: 1, channel_ids: [], collapsed: false },
    ];
    const result = sectionChannels(all, (c) => c.name ?? "", { sections, favorites: new Set(["beta"]) });
    expect(result.favorites.map((c) => c.id)).toEqual(["beta"]);
    expect(result.custom.map((g) => [g.section.name, g.channels.map((c) => c.id)])).toEqual([["プロジェクト", ["gamma", "d1"]], ["空", []]]);
    expect(result.channels.map((c) => c.id)).toEqual(["alpha"]);
    expect(result.dms.map((c) => c.id)).toEqual(["d2"]);
  });
});

describe("announcement channels (M15a)", () => {
  it("lets owners and admins start posts and everyone else only reply", () => {
    const open = channel("a");
    const announce = channel("b", { posting_policy: "owners", membership: { role: "member", joined_at: "" } });
    const owned = channel("c", { posting_policy: "owners", membership: { role: "owner", joined_at: "" } });
    expect(canPostTopLevel(open, false)).toBe(true);
    expect(canPostTopLevel(announce, false)).toBe(false);
    expect(canPostTopLevel(announce, true)).toBe(true);
    expect(canPostTopLevel(owned, false)).toBe(true);
  });
});

describe("conversation titles (sidebar and notifications)", () => {
  it("names channels by #name and DMs by the other members", () => {
    const users = new Map([["me", { display_name: "Me" }], ["a", { display_name: "Alice" }], ["b", { display_name: "Bob" }]]) as unknown as Parameters<typeof conversationTitle>[1];
    expect(conversationTitle(channel("c", { name: "general" }), users, "me")).toBe("#general");
    expect(conversationTitle(channel("g", { type: "group_dm", name: null, dm_user_ids: ["me", "a", "b"] }), users, "me")).toBe("Alice, Bob");
    // My own DM (only me): my name (Slack / Mattermost).
    expect(conversationTitle(channel("s", { type: "dm", name: null, dm_user_ids: ["me"] }), users, "me")).toBe("Me");
  });

  it("titles my own DM with my display name, else my username, else 「…」", () => {
    const self = channel("s", { type: "dm", name: null, dm_user_ids: ["me"] });
    const users = (entries: Array<[string, { display_name: string; username: string }]>) => new Map(entries) as unknown as Parameters<typeof conversationTitle>[1];
    expect(conversationTitle(self, users([["me", { display_name: " 山田 花子 ", username: "hanako" }]]), "me")).toBe("山田 花子");
    expect(conversationTitle(self, users([["me", { display_name: "  ", username: "hanako" }]]), "me")).toBe("hanako");
    expect(conversationTitle(self, users([]), "me")).toBe("…");
    // Not among the users yet: the signed-in user stands in.
    expect(conversationTitle(self, users([]), "me", { display_name: "Hanako", username: "hanako" })).toBe("Hanako");
    expect(myName(users([["me", { display_name: "Hanako", username: "hanako" }]]), "me")).toBe("Hanako");
    expect(myName(users([]), null)).toBe("…");
  });
});

describe("my own DM in the home list (a DM with only me)", () => {
  const dm = (id: string, members: string[], patch: Partial<ChannelState> = {}) => channel(id, { type: "dm", name: null, dm_user_ids: members, ...patch });
  const all = [
    dm("alice", ["me", "alice"], { last_message_at: "2026-09-26T10:00:00Z" }),
    dm("notes", ["me"], { last_message_at: "2026-09-20T00:00:00Z" }),
    channel("group", { type: "group_dm", name: null, dm_user_ids: ["me", "a", "b"], last_message_at: "2026-09-26T11:00:00Z", unreadCount: 1 }),
    dm("bob", ["me", "bob"], { last_message_at: null }),
  ];

  it("comes first in 「ダイレクトメッセージ」, then the others by recency", () => {
    expect(sectionChannels(all, (c) => c.id, { meId: "me", now }).dms.map((c) => c.id)).toEqual(["notes", "group", "alice", "bob"]);
    // Nobody signed in: no DM is mine, recency only.
    expect(sectionChannels(all, (c) => c.id, { now }).dms.map((c) => c.id)).toEqual(["group", "alice", "notes", "bob"]);
    // Unread only: it stays out unless unread (or open), like any row.
    expect(sectionChannels(all, (c) => c.id, { meId: "me", now, unreadOnly: true }).dms.map((c) => c.id)).toEqual(["group"]);
    expect(sectionChannels(all, (c) => c.id, { meId: "me", now, unreadOnly: true, currentId: "notes" }).dms.map((c) => c.id)).toEqual(["notes", "group"]);
    // Starred: only among the favorites.
    const starred = sectionChannels(all, (c) => c.id, { meId: "me", now, favorites: new Set(["notes"]) });
    expect(starred.favorites.map((c) => c.id)).toEqual(["notes"]);
    expect(starred.dms.map((c) => c.id)).toEqual(["group", "alice", "bob"]);
  });

  it("before it exists, a placeholder with my name — not while folded, unread only, or filtered away", () => {
    const without = all.filter((c) => c.id !== "notes");
    expect(showsSelfNotesInDmSection(without, "me", "Hanako")).toBe(true);
    expect(showsSelfNotesInDmSection(all, "me", "Hanako")).toBe(false); // it exists
    expect(showsSelfNotesInDmSection([...without, dm("notes", ["me"])], "me", "Hanako", {})).toBe(false); // starred or in a section: still exists
    expect(showsSelfNotesInDmSection(without, "me", "Hanako", { collapsed: true })).toBe(false);
    expect(showsSelfNotesInDmSection(without, "me", "Hanako", { unreadOnly: true })).toBe(false);
    expect(showsSelfNotesInDmSection(without, "me", "Hanako", { query: " hana " })).toBe(true);
    expect(showsSelfNotesInDmSection(without, "me", "Hanako", { query: "alice" })).toBe(false);
    expect(showsSelfNotesInDmSection(without, null, "…")).toBe(false);
  });
});

/** SYNC_PROTOCOL.md §10.5: the vectors the server and the phone apps test against too. */
interface UnreadCase {
  name: string;
  type: "public" | "private" | "dm" | "group_dm";
  times: "mine" | "others" | null;
  level: "all" | "mentions" | "none" | null;
  muted: boolean;
  unread: number;
  mentions: number;
  expect: { has_unread: boolean; badge: number; quiet: boolean };
}
const vectors = JSON.parse(readFileSync(new URL("../../shared/unread-rules.json", import.meta.url), "utf8")) as { cases: UnreadCase[] };

describe("unread rules (§10.5, M24 quiet unread)", () => {
  // "muted" is either mute: a timed one still running, or (M35) muted until unmuted. Both must give the same answers.
  it.each(vectors.cases.flatMap((c) => (c.muted ? (["timed", "until unmuted"] as const) : (["-"] as const)).map((form) => [c.name, form, c] as const)))("%s (%s)", (_name, form, c) => {
    const row = channel("c", {
      type: c.type,
      times_owner_id: c.times === "mine" ? "me" : c.times === "others" ? "someone" : null,
      notificationLevel: c.level,
      mutedUntil: form === "timed" ? "2026-09-27T00:00:00Z" : null,
      muted: form === "until unmuted",
      unreadCount: c.unread,
      mentionCount: c.mentions,
    });
    expect(hasUnread(row, "me", now)).toBe(c.expect.has_unread);
    expect(badgeCount(row, now)).toBe(c.expect.badge);
    expect(isQuietChannel(row, "me", now)).toBe(c.expect.quiet);
  });

  it("puts times channels in their own section, mine first", () => {
    const all = [
      channel("general"),
      channel("times-zed", { name: "times-zed", times_owner_id: "zed" }),
      channel("times-me", { name: "times-me", times_owner_id: "me" }),
      channel("times-amy", { name: "times-amy", times_owner_id: "amy", unreadCount: 3 }),
    ];
    const sections = sectionChannels(all, (c) => c.name ?? "", { meId: "me", now });
    expect(sections.channels.map((c) => c.id)).toEqual(["general"]);
    expect(sections.times.map((c) => c.id)).toEqual(["times-me", "times-amy", "times-zed"]);
    // Quiet unread stays out of the unread filter.
    expect(sectionChannels(all, (c) => c.name ?? "", { meId: "me", now, unreadOnly: true }).times).toEqual([]);
  });
});

describe("notification level (M35, PUSH_NOTIFICATIONS.md §4)", () => {
  const kinds = { channel: { dm: false, othersTimes: false }, dm: { dm: true, othersTimes: false }, othersTimes: { dm: false, othersTimes: true } };

  it.each([
    // overall, channel, DM / group DM, someone else's times — the table in §4
    ["all", "all", "all", "mentions"],
    ["mentions", "mentions", "all", "mentions"],
    ["none", "none", "none", "none"],
  ] as const)("without a level of its own, overall %s → channel %s, DM %s, others' times %s", (overall, forChannel, forDm, forTimes) => {
    expect(resolveNotificationLevel(null, overall, kinds.channel)).toBe(forChannel);
    expect(resolveNotificationLevel(null, overall, kinds.dm)).toBe(forDm);
    expect(resolveNotificationLevel(null, overall, kinds.othersTimes)).toBe(forTimes);
  });

  it("a level of its own wins over the overall setting, whatever the conversation", () => {
    for (const own of ["all", "mentions", "none"] as const) {
      for (const overall of ["all", "mentions", "none"] as const) {
        for (const kind of Object.values(kinds)) expect(resolveNotificationLevel(own, overall, kind)).toBe(own);
      }
    }
  });

  it("resolves a conversation: group DMs as DMs, my own times as a channel; channels following the default change with it", () => {
    expect(effectiveNotificationLevel(channel("g", { type: "group_dm" }), "me", "mentions")).toBe("all");
    expect(effectiveNotificationLevel(channel("t", { times_owner_id: "me" }), "me", "all")).toBe("all");
    expect(effectiveNotificationLevel(channel("t", { times_owner_id: "amy" }), "me", "all")).toBe("mentions");
    const follows = channel("c");
    const own = channel("o", { notificationLevel: "mentions" });
    expect([effectiveNotificationLevel(follows, "me", "mentions"), effectiveNotificationLevel(own, "me", "mentions")]).toEqual(["mentions", "mentions"]);
    expect([effectiveNotificationLevel(follows, "me", "all"), effectiveNotificationLevel(own, "me", "all")]).toEqual(["all", "mentions"]);
    expect(overallLevel(null)).toBe("mentions");
    expect(overallLevel({ notification_default: "none" })).toBe("none");
  });

  it("the overall setting never makes a conversation muted or quiet (the unread rules take the own level only)", () => {
    // isMutedChannel / hasUnread take no overall setting at all: a channel following "none" still counts every unread.
    const follows = channel("c", { unreadCount: 4 });
    expect(isMutedChannel(follows, now)).toBe(false);
    expect(hasUnread(follows, "me", now)).toBe(true);
    const muted = channel("m", { muted: true, unreadCount: 4 });
    expect(isMutedChannel(muted, now)).toBe(true);
    expect(isTimedMuted(muted, now)).toBe(false);
    expect(hasUnread(muted, "me", now)).toBe(false);
  });

  it("reads the server's preference: the resolved level is the own one only when it does not follow the default", () => {
    expect(ownNotification({ level: "mentions", muted_until: null, follows_default: true, muted: false })).toEqual({ notificationLevel: null, mutedUntil: null, muted: false });
    expect(ownNotification({ level: "all", muted_until: "2026-09-27T00:00:00Z", follows_default: false, muted: true })).toEqual({ notificationLevel: "all", mutedUntil: "2026-09-27T00:00:00Z", muted: true });
    expect(ownNotification({ level: "none" })).toEqual({ notificationLevel: null, mutedUntil: null, muted: false }); // an older server
  });

  it("names 「既定 (…)」 after the overall setting", () => {
    expect(notificationChoices("mentions").map((c) => [c.level, c.label])).toEqual([
      [null, "既定 (メンションと DM のみ)"],
      ["all", "すべてのメッセージ"],
      ["mentions", "メンションのみ"],
      ["none", "通知しない"],
    ]);
    expect(notificationChoices("all")[0]!.label).toBe("既定 (すべての新着メッセージ)");
    expect(notificationChoices("none")[0]!.label).toBe("既定 (なし)");
  });
});
