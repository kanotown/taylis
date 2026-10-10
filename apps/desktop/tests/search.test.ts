// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import type { UserPublic } from "../src/api/types";
import type { ChannelState } from "../src/sync/types";
import { dateLabel, dateRange, EMPTY_SEARCH, isEmptySearch, pushRecent, readRecent, recentKey, removeRecent, searchChannelTag, suggestions, toQuery, totalLabel } from "../src/ui/search";

const NOW = new Date(2026, 8, 27, 15, 30); // 2026-09-27 15:30 local

function user(id: string, username: string, display_name: string, deactivated = false): UserPublic {
  return { id, username, display_name, role: "member", created_at: "", updated_at: "", deactivated_at: deactivated ? "2026-01-01T00:00:00Z" : null } as UserPublic;
}

function channel(id: string, name: string, isMember = true): ChannelState {
  return { id, name, type: "public", isMember } as ChannelState;
}

describe("search conditions", () => {
  it("resolves date presets to local midnights, the end exclusive", () => {
    const local = (iso: string | null) => (iso ? new Date(iso).toLocaleString("sv-SE") : null);
    expect(dateRange({ preset: "today" }, NOW)).toEqual({ after: new Date(2026, 8, 27).toISOString(), before: null });
    const yesterday = dateRange({ preset: "yesterday" }, NOW);
    expect([local(yesterday.after), local(yesterday.before)]).toEqual(["2026-09-26 00:00:00", "2026-09-27 00:00:00"]);
    expect(local(dateRange({ preset: "week" }, NOW).after)).toBe("2026-09-21 00:00:00");
    const custom = dateRange({ from: "2026-09-01", to: "2026-09-10" }, NOW);
    expect([local(custom.after), local(custom.before)]).toEqual(["2026-09-01 00:00:00", "2026-09-11 00:00:00"]);
    expect(dateRange({ from: "nope", to: null }, NOW)).toEqual({ after: null, before: null });
  });

  it("labels dates and totals", () => {
    expect(dateLabel({ preset: "month" })).toBe("過去 30 日間");
    expect(dateLabel({ from: "2026-09-01", to: "2026-09-01" })).toBe("2026/09/01");
    expect(dateLabel({ from: "2026-09-01", to: null })).toBe("2026/09/01 以降");
    expect(totalLabel(1234, false)).toBe("1,234 件");
    expect(totalLabel(1000, true)).toBe("1,000 件以上");
  });

  it("sends filters and sorts filter-only searches newest first", () => {
    const params = { ...EMPTY_SEARCH, q: "  ", fromUserId: "u1", has: ["file" as const], isThread: true, sort: "relevance" as const };
    expect(isEmptySearch(params)).toBe(false);
    expect(isEmptySearch({ ...EMPTY_SEARCH, q: " " })).toBe(true);
    expect(toQuery(params, NOW)).toEqual({ q: "", channel_id: null, from_user_id: "u1", after: null, before: null, has: ["file"], is_thread: true, is_times: false, exclude_archived: false, sort: "newest" });
    expect(toQuery({ ...params, q: "設計" }, NOW).sort).toBe("relevance");
    expect(toQuery({ ...EMPTY_SEARCH, q: "設計", excludeArchived: true }, NOW).exclude_archived).toBe(true);
    // A recent search saved before the filter existed searches the archives too.
    expect(toQuery({ ...params, excludeArchived: undefined }, NOW).exclude_archived).toBe(false);
  });

  it("tags a hit's conversation: not joined, archived, or both", () => {
    expect(searchChannelTag({ archived: false }, false)).toBe("未参加");
    expect(searchChannelTag({ archived: true }, false)).toBe("未参加・アーカイブ済み");
    expect(searchChannelTag({ archived: true }, true)).toBe("アーカイブ済み");
    expect(searchChannelTag({ archived: false }, true)).toBeNull();
    expect(searchChannelTag(undefined, false)).toBeNull();
  });
});

describe("recent searches", () => {
  beforeEach(() => localStorage.clear());

  it("keeps ten, newest first, without duplicates, per account", () => {
    const key = recentKey("http://s|alice");
    for (let i = 0; i < 12; i++) pushRecent(key, { ...EMPTY_SEARCH, q: `word ${i}` });
    pushRecent(key, { ...EMPTY_SEARCH, q: "word 5 ", sort: "newest" });
    const list = readRecent(key);
    expect(list).toHaveLength(10);
    expect(list[0]!.q).toBe("word 5");
    expect(list.filter((p) => p.q === "word 5")).toHaveLength(1);
    expect(readRecent(recentKey("http://s|bob"))).toEqual([]);
    expect(removeRecent(key, list[0]!).map((p) => p.q)).not.toContain("word 5");
    pushRecent(key, EMPTY_SEARCH); // nothing to remember
    expect(readRecent(key)).toHaveLength(9);
  });

  it("survives a corrupt entry", () => {
    localStorage.setItem(recentKey("a"), "{not json");
    expect(readRecent(recentKey("a"))).toEqual([]);
    localStorage.setItem(recentKey("a"), JSON.stringify([{ q: "ok", has: ["file", "bogus"] }, 3, null]));
    expect(readRecent(recentKey("a"))).toEqual([{ ...EMPTY_SEARCH, q: "ok", has: ["file"] }]);
  });
});

describe("suggestions", () => {
  const users = [user("u1", "tanaka", "田中 太郎"), user("u2", "taro.s", "佐藤 太郎"), user("u3", "gone", "田中 退職", true)];
  const channels = [channel("c1", "tanaka-lab"), channel("c2", "general"), channel("c3", "tanaka-secret", false)];
  const context = (recent = [{ ...EMPTY_SEARCH, q: "田中さんの資料" }]) => ({ users, channels, recent, channelTitle: (c: ChannelState) => `#${c.name}` });

  it("offers recent searches and quick filters for an empty box", () => {
    const rows = suggestions("", context());
    expect(rows.map((r) => r.kind)).toEqual(["recent", "has", "has", "has", "thread", "times"]);
  });

  it("offers people, conversations, matching recent searches and last all the results", () => {
    const rows = suggestions("田中", context());
    expect(rows.at(-1)).toEqual({ kind: "search", q: "田中" }); // 「すべての結果を見る」 comes last
    expect(rows.filter((r) => r.kind === "user").map((r) => (r.kind === "user" ? r.user.id : ""))).toEqual(["u1"]); // not the deactivated one
    expect(rows.some((r) => r.kind === "recent")).toBe(true);
    const byName = suggestions("@tanaka", context([]));
    expect(byName.map((r) => (r.kind === "user" ? r.user.id : r.kind === "channel" ? r.channel.id : r.kind))).toEqual(["u1", "c1", "search"]);
  });
});
