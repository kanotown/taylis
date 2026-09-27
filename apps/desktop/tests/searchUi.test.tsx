// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageOut, SearchOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { SearchBar } from "../src/ui/SearchBar";
import { SearchView, type SearchSnapshot } from "../src/ui/SearchView";
import { EMPTY_SEARCH, type SearchParams } from "../src/ui/search";
import { FakeServer } from "./fakeServer";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => localStorage.clear());

function world() {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const tanaka = server.addUser("tanaka");
  const general = server.createChannel("general", me.id);
  const design = server.createChannel("design", me.id);
  server.join(general.id, tanaka.id);
  const store = new Store();
  for (const user of [me, tanaka]) store.upsertUser(user);
  store.upsertChannel(general, { isMember: true });
  store.upsertChannel(design, { isMember: true });
  const hit = (body: string, extra: Partial<MessageOut> = {}): MessageOut => ({ ...server.post(general.id, tanaka.id, body).message, ...extra });
  const search = vi.fn(async (): Promise<SearchOut> => ({
    hits: [{ message: hit("設計レビューの資料です"), score: 2 }, { message: hit("設計の続き", { parent_id: "p1" }), score: 1 }],
    keywords: ["設計"],
    filters: { text: "設計", has: [], is_thread: false, unresolved: ["from:@nobody"] },
    limit: 30,
    offset: 0,
    has_more: false,
    total: 2,
    total_capped: false,
  }));
  const controller = { store, api: { search, listFiles: vi.fn() }, setError: vi.fn() } as unknown as AppController;
  return { server, me, tanaka, general, design, store, controller, search };
}

describe("search box", () => {
  it("suggests people and conversations while typing and runs the highlighted row", () => {
    const w = world();
    const onSearch = vi.fn();
    render(<SearchBar controller={w.controller} current={null} open onOpenChange={() => {}} onSearch={onSearch} recent={[]} onRecentChange={() => {}} recentKey="k" placeholder="ChikuwaChat を検索" />);
    const box = screen.getByLabelText("検索語");
    fireEvent.change(box, { target: { value: "tana" } });
    expect(screen.getByText("人 (この人の投稿)")).toBeTruthy();
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options).toHaveLength(2);
    expect(options[0]).toBe("「tana」を検索");
    expect(options[1]).toContain("@tanaka");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSearch).toHaveBeenCalledWith({ ...EMPTY_SEARCH, fromUserId: w.tanaka.id, sort: "newest" });

    fireEvent.change(box, { target: { value: "設計" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSearch).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, q: "設計" });
  });

  it("shows recent searches and quick filters when empty", () => {
    const w = world();
    const onSearch = vi.fn();
    const recent: SearchParams[] = [{ ...EMPTY_SEARCH, q: "議事録", channelId: w.design.id }];
    render(<SearchBar controller={w.controller} current={null} open onOpenChange={() => {}} onSearch={onSearch} recent={recent} onRecentChange={() => {}} recentKey="k" placeholder="" />);
    expect(screen.getByText("議事録 · #design")).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText("検索語"), { key: "Enter" });
    expect(onSearch).not.toHaveBeenCalled(); // nothing highlighted in an empty box
    fireEvent.keyDown(screen.getByLabelText("検索語"), { key: "ArrowDown" });
    fireEvent.keyDown(screen.getByLabelText("検索語"), { key: "Enter" });
    expect(onSearch).toHaveBeenCalledWith(recent[0]);
    fireEvent.click(screen.getByText("スレッド内のメッセージ"));
    expect(onSearch).toHaveBeenCalledWith({ ...EMPTY_SEARCH, isThread: true, sort: "newest" });
  });
});

describe("search results", () => {
  it("shows the count, highlights the words, warns about unknown modifiers and edits the filters", async () => {
    const w = world();
    const onChange = vi.fn();
    const onOpen = vi.fn();
    const params = { ...EMPTY_SEARCH, q: "設計" };
    render(<SearchView controller={w.controller} params={params} tab="messages" onTabChange={() => {}} onChange={onChange} onOpen={onOpen} onClose={() => {}} snapshot={{ current: null as SearchSnapshot | null }} />);
    await waitFor(() => expect(screen.getByText("2 件")).toBeTruthy());
    expect(w.search).toHaveBeenCalledWith(expect.objectContaining({ q: "設計", sort: "relevance", limit: 30, offset: 0 }));
    expect(screen.getAllByText("設計", { selector: "mark" })).toHaveLength(2);
    expect(screen.getByText("スレッドの返信")).toBeTruthy();
    expect(screen.getByText(/見つからない条件は無視しました: from:@nobody/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /スレッド内/ }));
    expect(onChange).toHaveBeenCalledWith({ ...params, isThread: true });
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent?.includes("設計レビューの資料です"))!);
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ body: "設計レビューの資料です" }));
  });

  it("offers to drop the filters when nothing matches, and reuses kept results", async () => {
    const w = world();
    w.search.mockResolvedValueOnce({ hits: [], keywords: [], filters: { text: "", has: ["poll"], is_thread: false, unresolved: [] }, limit: 30, offset: 0, has_more: false, total: 0, total_capped: false });
    const onChange = vi.fn();
    const params: SearchParams = { ...EMPTY_SEARCH, q: "予算", has: ["poll"] };
    const snapshot = { current: null as SearchSnapshot | null };
    const view = render(<SearchView controller={w.controller} params={params} tab="messages" onTabChange={() => {}} onChange={onChange} onOpen={() => {}} onClose={() => {}} snapshot={snapshot} />);
    await waitFor(() => expect(screen.getByText("見つかりませんでした")).toBeTruthy());
    fireEvent.click(screen.getByText("条件をクリアして検索"));
    expect(onChange).toHaveBeenCalledWith({ ...EMPTY_SEARCH, q: "予算" });
    view.unmount();
    await act(async () => {
      render(<SearchView controller={w.controller} params={params} tab="messages" onTabChange={() => {}} onChange={onChange} onOpen={() => {}} onClose={() => {}} snapshot={snapshot} />);
    });
    expect(w.search).toHaveBeenCalledTimes(1); // 「検索結果に戻る」 shows the kept page
  });
});
