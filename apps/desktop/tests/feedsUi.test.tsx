// @vitest-environment jsdom
// M97 (docs/FEEDS.md §5): the channel's 「フィード」 list (everyone reads, members add, the one who added it and managers
// pause / resume / delete), the add form's validation and the server's feed_invalid reason, and the pure helpers.
process.env.TZ = "Asia/Tokyo";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { ChannelOut, FeedBotOut, FeedOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { ChannelState } from "../src/sync/types";
import { FeedList } from "../src/ui/ChannelFeeds";
import { canAddFeed, feedErrorText, feedState, feedStatusLine, feedUrlProblem } from "../src/ui/feeds";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const ME = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const BOT = "44444444-4444-4444-8444-444444444444";
const people: UserPublic[] = [
  { id: ME, username: "me", display_name: "わたし", role: "member" } as UserPublic,
  { id: BOB, username: "bob", display_name: "ボブ", role: "member" } as UserPublic,
  { id: BOT, username: "feed-1", display_name: "RSS", role: "bot" } as UserPublic,
];

const FEED: FeedOut = {
  id: "f1",
  channel_id: "c-lab",
  owner_id: BOB,
  bot_user_id: BOT,
  url: "https://bob.example.com/feed.xml",
  title: "ボブの週報",
  site_url: "https://bob.example.com/",
  enabled: true,
  owner_active: true,
  can_manage: false,
  last_fetched_at: "2026-10-04T00:30:00Z",
  last_success_at: "2026-10-04T00:30:00Z",
  last_error_code: null,
  last_error: null,
  consecutive_failures: 0,
  post_count: 3,
  last_post_at: "2026-10-03T00:00:00Z",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

function setup({ rows = [FEED], archived = false, guest = false, member = true, bot }: { rows?: FeedOut[]; archived?: boolean; guest?: boolean; member?: boolean; bot?: FeedBotOut } = {}) {
  const store = new Store();
  store.setMe({ ...people[0]! } as unknown as UserMe);
  for (const user of people) store.upsertUser(user);
  const channel = store.upsertChannel(
    { id: "c-lab", type: "public", name: "週報", topic: null, purpose: null, archived, created_at: "2026-01-01T00:00:00Z", last_seq: 0, posting_policy: "everyone" } as unknown as ChannelOut,
    { isMember: member, membership: member ? ({ role: "member" } as never) : null },
  );
  let list = rows;
  const api = {
    channelFeeds: vi.fn(async () => list),
    createFeed: vi.fn(async (_c: string, body: { url: string }) => {
      const made = { ...FEED, id: "f2", url: body.url, title: "わたしのブログ", owner_id: ME, can_manage: true };
      list = [...list, made];
      return made;
    }),
    updateFeed: vi.fn(async (id: string, body: { enabled?: boolean }) => {
      list = list.map((f) => (f.id === id ? { ...f, ...body } : f));
      return list.find((f) => f.id === id);
    }),
    deleteFeed: vi.fn(async (id: string) => { list = list.filter((f) => f.id !== id); }),
    channelFeedBot: vi.fn(async () => {
      if (!bot) throw new Error("no such call");
      return bot;
    }),
    updateChannelFeedBot: vi.fn(async (_c: string, body: { display_name?: string; bot_user_id?: string }) => {
      const picked = bot!.candidates?.find((c) => c.id === body.bot_user_id);
      bot = {
        ...bot!,
        ...(picked ? { bot_user_id: picked.id, display_name: picked.display_name, adopted: true, candidates: [] } : {}),
        ...(body.display_name ? { display_name: body.display_name } : {}),
      };
      return bot;
    }),
  };
  const controller = {
    store, api, isAdmin: false, isGuest: guest, version: 0, subscribe: () => () => {}, setError: vi.fn(), setNotice: vi.fn(),
  } as unknown as AppController;
  render(<FeedList controller={controller} channel={channel as ChannelState} />);
  return { api };
}

describe("the list", () => {
  it("shows title, URL, who added it and the last fetch, without actions for others", async () => {
    const { api } = setup();
    await flush();
    expect(api.channelFeeds).toHaveBeenCalledWith("c-lab");
    const row = screen.getByText("ボブの週報").closest("li")!;
    expect(within(row).getByRole("link").getAttribute("href")).toBe("https://bob.example.com/feed.xml");
    expect(within(row).getByText("追加: ボブ")).toBeTruthy();
    expect(within(row).getByText("最終取得 10/4 (日) 9:30 · 投稿 3 件")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /止める/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /削除/ })).toBeNull();
    // Any member may add one.
    expect(screen.getByRole("form", { name: "フィードを追加" })).toBeTruthy();
  });

  it("shows the error, the paused and the owner-absent states", async () => {
    setup({
      rows: [
        { ...FEED, id: "a", title: "壊れた", last_error_code: "http_error", last_error: "HTTP 500", consecutive_failures: 6 },
        { ...FEED, id: "b", title: "止めた", enabled: false },
        { ...FEED, id: "c", title: "いない", owner_active: false },
      ],
    });
    await flush();
    const broken = screen.getByText("壊れた").closest("li")!;
    expect(within(broken).getByText("エラー")).toBeTruthy();
    expect(within(broken).getByText("取得に失敗: サイトがエラーを返しました (HTTP 500) · 6 回続けて失敗")).toBeTruthy();
    expect(within(screen.getByText("止めた").closest("li")!).getByText("停止中")).toBeTruthy();
    expect(within(screen.getByText("いない").closest("li")!).getByText("取得を休止中")).toBeTruthy();
  });

  it("the one who may manage pauses, resumes and deletes after asking", async () => {
    const { api } = setup({ rows: [{ ...FEED, can_manage: true }] });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /止める/ }));
    await flush();
    expect(api.updateFeed).toHaveBeenCalledWith("f1", { enabled: false });
    expect(screen.getByRole("status").textContent).toBe("止めました");
    expect(screen.getByText("停止中")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /再開/ }));
    await flush();
    expect(api.updateFeed).toHaveBeenLastCalledWith("f1", { enabled: true });
    fireEvent.click(screen.getByRole("button", { name: /削除/ }));
    expect(screen.getByText(/「ボブの週報」を削除しますか/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await flush();
    expect(api.deleteFeed).toHaveBeenCalledWith("f1");
    expect(screen.queryByText("ボブの週報")).toBeNull();
  });
});

describe("adding", () => {
  it("checks the URL, sends it trimmed, and lists the new feed", async () => {
    const { api } = setup({ rows: [] });
    await flush();
    const input = screen.getByRole("textbox", { name: "フィードの URL" });
    fireEvent.click(screen.getByRole("button", { name: /追加/ }));
    expect(screen.getByRole("alert").textContent).toBe("URL を入力してください");
    fireEvent.change(input, { target: { value: "blog.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /追加/ }));
    expect(screen.getByRole("alert").textContent).toMatch(/https:\/\//);
    expect(api.createFeed).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "  https://me.example.com/  " } });
    fireEvent.click(screen.getByRole("button", { name: /追加/ }));
    await flush();
    expect(api.createFeed).toHaveBeenCalledWith("c-lab", { url: "https://me.example.com/" });
    expect(screen.getByRole("status").textContent).toMatch(/「わたしのブログ」を追加しました/);
    expect(screen.getByText("わたしのブログ")).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("");
  });

  it("shows the server's reason when it is not a feed", async () => {
    const { api } = setup({ rows: [] });
    api.createFeed.mockRejectedValueOnce(new ApiError(422, "feed_invalid", "no", { reason: "not_a_feed" }));
    await flush();
    fireEvent.change(screen.getByRole("textbox", { name: "フィードの URL" }), { target: { value: "https://x.example.com/" } });
    fireEvent.click(screen.getByRole("button", { name: /追加/ }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe(
      "フィードを読み込めませんでした。RSS または Atom の URL か確かめてください (RSS / Atom のフィードではありません)",
    );
  });

  it("is not offered to guests, non-members or in an archived channel", async () => {
    setup({ guest: true });
    await flush();
    expect(screen.queryByRole("form", { name: "フィードを追加" })).toBeNull();
    cleanup();
    setup({ archived: true });
    await flush();
    expect(screen.queryByRole("form", { name: "フィードを追加" })).toBeNull();
    cleanup();
    setup({ member: false });
    await flush();
    expect(screen.queryByRole("form", { name: "フィードを追加" })).toBeNull();
    expect(screen.getByText("ボブの週報")).toBeTruthy(); // a public channel's feeds are readable
  });
});

describe("helpers", () => {
  it("feedState, feedStatusLine, feedUrlProblem, feedErrorText, canAddFeed", () => {
    expect(feedState({ ...FEED, enabled: false, last_error_code: "timeout" })).toBe("paused");
    expect(feedState({ ...FEED, owner_active: false })).toBe("owner_absent");
    expect(feedState({ ...FEED, last_error_code: "timeout" })).toBe("failing");
    expect(feedState({ ...FEED, last_success_at: null })).toBe("new");
    expect(feedStatusLine({ ...FEED, last_error_code: "timeout", last_error: "timeout", consecutive_failures: 1 }, () => "")).toBe("取得に失敗: サイトが応答しません");
    expect(feedStatusLine({ ...FEED, last_fetched_at: null, post_count: 0 }, () => "")).toBe("まだ取得していません");
    expect(feedUrlProblem("http://a.example/rss")).toBeNull();
    expect(feedUrlProblem("ftp://a.example/rss")).not.toBeNull();
    expect(feedErrorText(new ApiError(409, "feed_exists", "x"))).toBe("このフィードはすでにこのチャンネルに追加されています");
    expect(feedErrorText(new ApiError(422, "feed_invalid", "x", { reason: "weird" }))).toBe("フィードを読み込めませんでした。RSS または Atom の URL か確かめてください");
    const dm = { type: "dm", isMember: true, archived: false } as unknown as ChannelState;
    expect(canAddFeed(dm, false)).toBe(false);
  });
});

const BOT_OUT: FeedBotOut = { bot_user_id: BOT, display_name: "RSS", adopted: false, can_rename: false, can_adopt: false, candidates: [] };
const IMPORTED = { id: "55555555-5555-4555-8555-555555555555", username: "slack-bot", display_name: "週報 - 中村の週報", active: true };

describe("the feed bot (M98)", () => {
  it("shows the bot's name; nothing to change for a member", async () => {
    setup({ bot: BOT_OUT });
    await flush();
    expect(screen.getByText("RSS").closest("[data-feed-bot]")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /名前を変更/ })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "既存のボットを使う" })).toBeNull();
  });

  it("an owner renames it", async () => {
    const { api } = setup({ bot: { ...BOT_OUT, can_rename: true } });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /名前を変更/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "ボットの名前" }), { target: { value: " 週報RSS " } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await flush();
    expect(api.updateChannelFeedBot).toHaveBeenCalledWith("c-lab", { display_name: "週報RSS" });
    expect(screen.getByRole("status").textContent).toBe("ボットの名前を「週報RSS」にしました");
    expect(screen.getByText("週報RSS")).toBeTruthy();
  });

  it("an administrator adopts an imported bot after confirming, then the list reloads", async () => {
    const { api } = setup({ bot: { ...BOT_OUT, can_rename: true, can_adopt: true, candidates: [IMPORTED] } });
    await flush();
    const loads = api.channelFeeds.mock.calls.length;
    fireEvent.change(screen.getByRole("combobox", { name: "既存のボットを使う" }), { target: { value: IMPORTED.id } });
    fireEvent.click(screen.getByRole("button", { name: "選ぶ" }));
    expect(screen.getByText(/今の「RSS」ボットは無効になります/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "このボットにする" }));
    await flush();
    expect(api.updateChannelFeedBot).toHaveBeenCalledWith("c-lab", { bot_user_id: IMPORTED.id });
    expect(screen.getByText("週報 - 中村の週報")).toBeTruthy();
    expect(screen.getByText("(既存のボットを使用)")).toBeTruthy();
    expect(api.channelFeeds.mock.calls.length).toBeGreaterThan(loads);
  });

  it("before the first feed only an administrator sees the panel", async () => {
    setup({ rows: [], bot: { ...BOT_OUT, bot_user_id: null, display_name: null } });
    await flush();
    expect(document.querySelector("[data-feed-bot]")).toBeNull();
    cleanup();
    setup({ rows: [], bot: { ...BOT_OUT, bot_user_id: null, display_name: null, can_adopt: true, candidates: [IMPORTED] } });
    await flush();
    expect(screen.getByText(/最初のフィードを追加すると/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "既存のボットを使う" })).toBeTruthy();
  });
});
