// @vitest-environment jsdom
/** M37: the phone's home — sections with 「未読をまとめる」, the short DM section, 移動・検索's lists, the picker's, recents. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { UserPublic } from "../src/api/types";
import type { ChannelState } from "../src/sync/types";
import {
  conversationNames, GATHER_UNREAD_KEY, homeSections, jumpConversations, jumpPeople, pickerChannels, pickerPeople, pushRecentConversation,
  readGatherUnread, readRecentConversations, recentConversationsKey, writeGatherUnread,
} from "../src/ui/home";

const ME = "me";
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
const dm = (id: string, others: string[], patch: Partial<ChannelState> = {}) => channel(id, { type: others.length > 1 ? "group_dm" : "dm", name: null, dm_user_ids: [ME, ...others], ...patch });
const user = (id: string, username: string, display_name: string, deactivated = false): UserPublic =>
  ({ id, username, display_name, role: "member", created_at: "", updated_at: "", deactivated_at: deactivated ? "2026-01-01T00:00:00Z" : null }) as UserPublic;

const users = new Map<string, UserPublic>([
  [ME, user(ME, "kano", "加納 透")],
  ["u1", user("u1", "ebi", "海老原")],
  ["u2", user("u2", "gen_minamoto", "源 さん")],
  ["u3", user("u3", "gone", "Gone", true)],
]);
const title = (c: ChannelState) => (c.type === "dm" || c.type === "group_dm" ? (c.dm_user_ids ?? []).filter((id) => id !== ME).map((id) => users.get(id)!.display_name).join(", ") || "加納 透" : c.name ?? "");
const context = { users, meId: ME, title };

describe("names and 移動・検索's lists", () => {
  it("a channel by its name, a DM by the others' display names and usernames, my own DM by mine", () => {
    expect(conversationNames(channel("general"), users, ME)).toEqual(["general"]);
    expect(conversationNames(dm("d", ["u1", "u2"]), users, ME)).toEqual(["海老原", "ebi", "源 さん", "gen_minamoto"]);
    expect(conversationNames(channel("self", { type: "dm", name: null, dm_user_ids: [ME] }), users, ME)).toEqual(["加納 透", "kano"]);
  });

  it("会話: mine and not archived, by the rule, at most 20", () => {
    const list = [
      channel("general"),
      channel("gen-z", { unreadCount: 2 }),
      channel("agenda"),
      channel("gen-old", { archived: true }),
      channel("gen-other", { isMember: false }),
      dm("dm-gen", ["u2"]),
    ];
    expect(jumpConversations("gen", list, context).map((c) => c.id)).toEqual(["gen-z", "general", "dm-gen", "agenda"]);
    const many = Array.from({ length: 30 }, (_, i) => channel(`x${String(i).padStart(2, "0")}`));
    expect(jumpConversations("x", many, context)).toHaveLength(20);
    expect(jumpConversations("", list, context)).toEqual([]);
  });

  it("人: not deactivated, me too, by the rule, at most 10", () => {
    expect(jumpPeople("g", users.values()).map((u) => u.id)).toEqual(["u2"]);
    expect(jumpPeople("kano", users.values()).map((u) => u.id)).toEqual([ME]);
    const many = Array.from({ length: 15 }, (_, i) => user(`p${i}`, `p${String(i).padStart(2, "0")}`, `P ${i}`));
    expect(jumpPeople("p", many)).toHaveLength(10);
  });
});

describe("the new-message picker", () => {
  const list = [channel("zeta"), channel("alpha"), channel("pub", { isMember: false }), channel("priv", { type: "private", isMember: false }), channel("old", { archived: true }), dm("d", ["u1"])];

  it("channels: mine, then the public ones I can join; no DMs, archived or private ones I am not in", () => {
    const empty = pickerChannels("", list, context);
    expect(empty.mine.map((c) => c.id)).toEqual(["alpha", "zeta"]);
    expect(empty.joinable.map((c) => c.id)).toEqual(["pub"]);
    const typed = pickerChannels("pu", list, context);
    expect(typed.mine).toEqual([]);
    expect(typed.joinable.map((c) => c.id)).toEqual(["pub"]);
  });

  it("people: not me, not deactivated; by name, or by the rule", () => {
    expect(pickerPeople("", users.values(), ME).map((u) => u.id)).toEqual(["u1", "u2"]);
    expect(pickerPeople("ebi", users.values(), ME).map((u) => u.id)).toEqual(["u1"]);
  });
});

describe("home sections", () => {
  const at = (minutes: number) => new Date(Date.UTC(2026, 8, 30, 0, minutes)).toISOString();

  it("「未読をまとめる」: unread conversations (DMs too) move into 「未読」, out of their own sections", () => {
    const list = [channel("a"), channel("b", { unreadCount: 1, mentionCount: 1 }), channel("fav", { unreadCount: 3 }), dm("d1", ["u1"], { unreadCount: 1, last_message_at: at(1) }), dm("d2", ["u2"], { last_message_at: at(2) })];
    const off = homeSections(list, title, { meId: ME, favorites: new Set(["fav"]) });
    expect(off.unread).toEqual([]);
    expect(off.channels.map((c) => c.id)).toEqual(["a", "b"]);
    const on = homeSections(list, title, { meId: ME, favorites: new Set(["fav"]), gatherUnread: true });
    expect(on.unread.map((c) => c.id)).toEqual(["d1", "fav", "b"]); // newest first (the channels have no message time here)
    expect(on.favorites).toEqual([]);
    expect(on.channels.map((c) => c.id)).toEqual(["a"]);
    expect(on.dms.map((c) => c.id)).toEqual(["d2"]);
  });

  it("DMs: my own first, then the 5 newest (and an older unread one); 「すべての DM」 when there are more", () => {
    const self = channel("self", { type: "dm", name: null, dm_user_ids: [ME], last_message_at: at(0) });
    const others = Array.from({ length: 7 }, (_, i) => dm(`d${i}`, [`u${i}`], { last_message_at: at(10 + i), unreadCount: i === 0 ? 1 : 0 }));
    const sections = homeSections([self, ...others], title, { meId: ME });
    expect(sections.dms.map((c) => c.id)).toEqual(["self", "d6", "d5", "d4", "d3", "d2", "d0"]);
    expect(sections.moreDms).toBe(true);
    expect(homeSections([self, ...others.slice(0, 5)], title, { meId: ME }).moreDms).toBe(false);
  });
});

describe("per-device storage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("recent conversations: the newest first, once each, at most 10, per account", () => {
    const key = recentConversationsKey("http://server|bob");
    for (let i = 0; i < 12; i++) pushRecentConversation(key, `c${i}`);
    expect(pushRecentConversation(key, "c5")).toEqual(["c5", "c11", "c10", "c9", "c8", "c7", "c6", "c4", "c3", "c2"]);
    expect(readRecentConversations(key)).toHaveLength(10);
    expect(readRecentConversations(recentConversationsKey("http://other|bob"))).toEqual([]);
  });

  it("「未読をまとめる」 is off until turned on", () => {
    expect(readGatherUnread()).toBe(false);
    writeGatherUnread(true);
    expect(localStorage.getItem(GATHER_UNREAD_KEY)).toBe("1");
    expect(readGatherUnread()).toBe(true);
  });

  it("storage that throws (a private window) leaves the defaults", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(readRecentConversations("k")).toEqual([]);
    expect(pushRecentConversation("k", "c1")).toEqual(["c1"]);
    expect(readGatherUnread()).toBe(false);
    expect(() => writeGatherUnread(true)).not.toThrow();
  });
});
