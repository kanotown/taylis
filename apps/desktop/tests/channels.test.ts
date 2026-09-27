import { describe, expect, it } from "vitest";

import type { ChannelState } from "../src/sync/types";
import { badgeCount, hasUnread, isMutedChannel, sectionChannels, stepChannel, unreadBadgeTotal } from "../src/ui/channels";

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
  isMember: true,
  syncedSeq: null,
  lastSeq: 0,
  lastReadSeq: 0,
  unreadCount: 0,
  mentionCount: 0,
  hasOlder: true,
  notificationLevel: null,
  mutedUntil: null,
  ...patch,
});

describe("sidebar unread rules", () => {
  it("treats muted channels as unread only when mentioned", () => {
    const muted = channel("a", { notificationLevel: "none", unreadCount: 5 });
    expect(isMutedChannel(muted, now)).toBe(true);
    expect(hasUnread(muted, now)).toBe(false);
    expect(badgeCount(muted, now)).toBe(0);
    const mentioned = channel("b", { mutedUntil: "2026-09-26T20:00:00Z", unreadCount: 5, mentionCount: 2 });
    expect(hasUnread(mentioned, now)).toBe(true);
    expect(badgeCount(mentioned, now)).toBe(2);
    const expired = channel("c", { mutedUntil: "2026-09-26T01:00:00Z", unreadCount: 1 });
    expect(isMutedChannel(expired, now)).toBe(false);
    expect(hasUnread(expired, now)).toBe(true);
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
