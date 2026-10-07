// @vitest-environment jsdom
/** 管理 →「アナリティクス」 (M116, docs/ANALYTICS.md §6): the pure helpers and the tab against a fake API. */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { analyticsParams } from "../src/api/client";
import type { AnalyticsMemberOut, AnalyticsMembersQuery, AnalyticsOverviewOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { AdminBody } from "../src/ui/AdminDialog";
import { barLayout, barPath, csvFilename, dayLabel, MEMBER_COLUMNS, nextSort, platformLabel, relativeTime } from "../src/ui/analytics";

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("the helpers", () => {
  const now = new Date("2026-10-06T12:00:00Z");

  it("says how long ago in the UI language, nothing for no time", () => {
    expect(relativeTime("2026-10-03T12:00:00Z", now)).toBe("3 日前");
    expect(relativeTime("2026-10-06T10:00:00Z", now)).toBe("2 時間前");
    expect(relativeTime("2026-10-06T11:59:40Z", now)).toBe("今");
    expect(relativeTime("2026-06-06T12:00:00Z", now)).toBe("4 か月前");
    expect(relativeTime(null, now)).toBe("");
    expect(relativeTime("nonsense", now)).toBe("");
  });

  it("lays bars out in slots, the tallest at full height, a quiet day still visible, zero flat", () => {
    const { bars, max } = barLayout([0, 1, 100], 300, 100);
    expect(max).toBe(100);
    expect(bars.map((b) => b.height)).toEqual([0, 1, 100]);
    expect(bars[2]).toMatchObject({ x: 201, width: 98, y: 0 });
    expect(barPath(bars[0]!)).toBe("");
    expect(barPath(bars[2]!)).toBe("M201,100V4Q201,0 205,0H295Q299,0 299,4V100Z");
    expect(barLayout([], 300, 100)).toEqual({ bars: [], max: 0 });
  });

  it("sorts a new column its natural way and flips the same one", () => {
    const lastActive = MEMBER_COLUMNS.find((c) => c.sort === "last_active_at")!;
    const name = MEMBER_COLUMNS.find((c) => c.sort === "name")!;
    expect(nextSort({ sort: "name", order: "asc" }, lastActive)).toEqual({ sort: "last_active_at", order: "desc" });
    expect(nextSort({ sort: "last_active_at", order: "desc" }, lastActive)).toEqual({ sort: "last_active_at", order: "asc" });
    expect(nextSort({ sort: "last_active_at", order: "desc" }, name)).toEqual({ sort: "name", order: "asc" });
    expect(name.label).toBe("名前");
  });

  it("builds the query string without empty values, names the CSV by date and the platforms", () => {
    const query: AnalyticsMembersQuery = { sort: "messages_30d", order: "desc", inactive_days: 30, q: "", limit: 100, offset: 0 };
    expect(analyticsParams(query).toString()).toBe("sort=messages_30d&order=desc&inactive_days=30&limit=100&offset=0");
    expect(csvFilename(new Date(2026, 9, 6, 9))).toBe("members-20261006.csv");
    expect(platformLabel("desktop")).toBe("デスクトップ");
    expect(platformLabel("ios")).toBe("iOS");
    expect(platformLabel("other")).toBe("other");
    expect(dayLabel("2026-10-06")).toContain("10/6");
    expect(dayLabel(undefined)).toBe("");
  });
});

function overview(): AnalyticsOverviewOut {
  const series = Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-0${i + 1}`, messages: i * 2, active_members: i % 3, new_members: 0 }));
  return {
    generated_at: "2026-10-07T03:00:00Z", days: 7, tz: "Asia/Tokyo", start: "2026-10-01", end: "2026-10-07",
    members: { accounts: 12, admins: 2, guests: 1, deactivated: 3, active_1d: 4, active_7d: 9, active_30d: 11, new_in_period: 2, never_signed_in: 1 },
    messages_in_period: 42, series,
    top_channels: [
      { channel_id: "c1", name: "general", type: "public", archived: false, messages: 30, posters: 6 },
      { channel_id: "c2", name: "staff", type: "private", archived: false, messages: 5, posters: 2 },
    ],
    other_private_channels: { conversations: 2, messages: 4 },
    direct_messages: { conversations: 3, messages: 3 },
    top_posters: [{ user_id: "u1", username: "alice", display_name: "Alice", messages: 20 }],
  };
}

function member(username: string, extra: Partial<AnalyticsMemberOut> = {}): AnalyticsMemberOut {
  return {
    id: `u-${username}`, username, display_name: username.toUpperCase(), role: "member", status: "active",
    created_at: "2026-01-01T00:00:00Z", deactivated_at: null, last_login_at: null, last_active_at: null,
    messages_30d: 0, devices: 0, platforms: [], ...extra,
  };
}

async function setup() {
  const calls: Array<[string, unknown]> = [];
  const recent = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const api = {
    adminListUsers: async () => [],
    adminAnalyticsOverview: async (days: number, tz: string) => { calls.push(["overview", { days, tz }]); return overview(); },
    adminAnalyticsMembers: async (query: AnalyticsMembersQuery) => {
      calls.push(["members", query]);
      return {
        items: [member("alice", { last_login_at: recent, last_active_at: recent, messages_30d: 20, devices: 2, platforms: ["desktop", "ios"] }), member("bob")],
        total: 2, limit: 100, offset: 0,
      };
    },
    adminAnalyticsMembersCsv: async (query: AnalyticsMembersQuery) => { calls.push(["csv", query]); return new Blob(["id\r\n"]); },
  };
  const store = new Store();
  store.setMe({ id: "u-root", username: "root", display_name: "Root", role: "admin", has_password: true } as never);
  const proxy = new Proxy(api as Record<string, unknown>, { get: (t, key: string) => t[key] ?? (async () => []) });
  const controller = { store, api: proxy, engine: { ai: { loadStatus: async () => {} } }, isAdmin: true, can: () => true, version: 0, subscribe: () => () => {}, setError: vi.fn(), setNotice: vi.fn() } as unknown as AppController;
  render(<AdminBody controller={controller} />);
  await settle();
  fireEvent.click(screen.getByRole("tab", { name: "アナリティクス" }));
  await settle();
  return { calls, controller };
}

describe("管理 →「アナリティクス」", () => {
  it("shows the cards, both charts, the channels with private totals and the posters", async () => {
    const { calls } = await setup();
    expect(calls.find(([kind]) => kind === "overview")).toEqual(["overview", { days: 30, tz: expect.any(String) }]);
    const cards = screen.getByRole("group", { name: "概要" });
    expect(within(cards).getByText("過去 7 日に利用").nextSibling?.textContent).toBe("9");
    expect(within(cards).getByText("管理者 2・ゲスト 1・無効 3")).toBeTruthy();
    expect(screen.getByRole("img", { name: "1 日のメッセージ数" }).querySelectorAll("path")).toHaveLength(6); // day 1 has 0
    expect(screen.getByRole("img", { name: "1 日の利用メンバー数" })).toBeTruthy();
    const channels = screen.getByRole("table", { name: "よく使われているチャンネル" });
    expect(within(channels).getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("参加していない非公開チャンネル（2 個）")).toBeTruthy();
    expect(screen.getByText("DM・グループ DM（3 件）")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "よく投稿している人" })).getByText("Alice")).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "期間" }), { target: { value: "7" } });
    await settle();
    expect(calls.filter(([kind]) => kind === "overview").at(-1)).toEqual(["overview", { days: 7, tz: expect.any(String) }]);
  });

  it("lists members with relative times (full on hover), sorts by column, filters inactive and exports CSV", async () => {
    const { calls } = await setup();
    const table = screen.getByRole("table", { name: "メンバーの利用状況" });
    const alice = table.querySelector<HTMLElement>('tr[data-user="alice"]')!;
    const times = alice.querySelectorAll("time");
    expect(times[0]!.textContent).toBe("3 日前");
    expect(times[0]!.getAttribute("title")).toMatch(/2026|\d{4}/);
    expect(within(alice).getByText("2 台（デスクトップ, iOS）")).toBeTruthy();
    expect(within(table.querySelector<HTMLElement>('tr[data-user="bob"]')!).getAllByText("記録なし")).toHaveLength(2);
    // Default: the most recently active first.
    expect(calls.find(([kind]) => kind === "members")?.[1]).toMatchObject({ sort: "last_active_at", order: "desc", limit: 100, offset: 0 });

    fireEvent.click(within(table).getByRole("button", { name: "30 日の投稿" }));
    await settle();
    expect(calls.filter(([kind]) => kind === "members").at(-1)?.[1]).toMatchObject({ sort: "messages_30d", order: "desc" });
    expect(within(table).getByRole("columnheader", { name: /30 日の投稿/ }).getAttribute("aria-sort")).toBe("descending");

    fireEvent.change(screen.getByRole("combobox", { name: "利用していない期間" }), { target: { value: "30" } });
    await settle();
    expect(calls.filter(([kind]) => kind === "members").at(-1)?.[1]).toMatchObject({ inactive_days: 30 });

    const createUrl = vi.fn(() => "blob:x");
    Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fireEvent.click(screen.getByRole("button", { name: /CSV を書き出す/ }));
    await settle();
    expect(calls.filter(([kind]) => kind === "csv").at(-1)?.[1]).toMatchObject({ sort: "messages_30d", inactive_days: 30 });
    expect(createUrl).toHaveBeenCalled();
  });
});
