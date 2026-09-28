import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ChannelState } from "../src/sync/types";
import { badgeCount, canPostTopLevel, conversationTitle, hasUnread, isMutedChannel, isQuietChannel, sectionChannels, stepChannel, unreadBadgeTotal } from "../src/ui/channels";

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
    expect(conversationTitle(channel("s", { type: "dm", name: null, dm_user_ids: ["me"] }), users, "me")).toBe("自分へのメモ");
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
  it.each(vectors.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const row = channel("c", {
      type: c.type,
      times_owner_id: c.times === "mine" ? "me" : c.times === "others" ? "someone" : null,
      notificationLevel: c.level,
      mutedUntil: c.muted ? "2026-09-27T00:00:00Z" : null,
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
