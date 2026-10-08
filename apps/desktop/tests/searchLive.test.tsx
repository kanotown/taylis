// @vitest-environment jsdom
/**
 * The search box's live results and the IME: the Enter that confirms a Japanese conversion never opens the results
 * page (Chromium: keydown with isComposing before compositionend; WebKit / WKWebView: compositionend, then a keydown
 * that no longer says so), typing shows the best few messages in the box, and only a plain Enter or
 * 「「…」のすべての結果を見る」 opens the results page.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageOut, SearchOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { leadToFirstHit } from "../src/ui/highlight";
import { isImeKeyEvent, IME_CONFIRM_GRACE_MS } from "../src/ui/ime";
import { JumpView } from "../src/ui/JumpView";
import { QuickSwitcher } from "../src/ui/QuickSwitcher";
import { LIVE_DEBOUNCE_MS, LIVE_LIMIT } from "../src/ui/LiveSearch";
import { SearchBar } from "../src/ui/SearchBar";
import { EMPTY_SEARCH } from "../src/ui/search";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
beforeEach(() => localStorage.clear());

function out(hits: MessageOut[], keywords: string[]): SearchOut {
  return {
    hits: hits.map((message, i) => ({ message, score: hits.length - i })),
    keywords,
    filters: { text: keywords.join(" "), has: [], is_thread: false, is_times: false, unresolved: [] },
    limit: LIVE_LIMIT,
    offset: 0,
    has_more: false,
    total: hits.length,
    total_capped: false,
  };
}

function world() {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const tanaka = server.addUser("tanaka");
  const general = server.createChannel("general", me.id);
  server.join(general.id, tanaka.id);
  const store = new Store();
  for (const user of [me, tanaka]) store.upsertUser(user);
  store.upsertChannel(general, { isMember: true });
  const post = (body: string, extra: Partial<MessageOut> = {}): MessageOut => ({ ...server.post(general.id, tanaka.id, body).message, ...extra });
  const review = post("設計レビューの資料です");
  const reply = post("設計の続き", { parent_id: "p1" });
  const search = vi.fn(async (query: { q: string }): Promise<SearchOut> => out(query.q.includes("設計") ? [review, reply] : [], [query.q]));
  const controller = { store, api: { search }, setError: vi.fn() } as unknown as AppController;
  return { store, controller, search, review, reply, tanaka };
}

function renderBox(w: ReturnType<typeof world>) {
  const onSearch = vi.fn();
  const onOpenMessage = vi.fn();
  const onOpenChange = vi.fn();
  render(
    <SearchBar controller={w.controller} current={null} open onOpenChange={onOpenChange} onSearch={onSearch} onOpenMessage={onOpenMessage} recent={[]} onRecentChange={() => {}} recentKey="k" placeholder="" />,
  );
  return { box: screen.getByLabelText("検索語") as HTMLInputElement, onSearch, onOpenMessage, onOpenChange };
}

/** Types `value` through an IME: composition start, the composing text, then its conversion. */
function compose(box: HTMLInputElement, value: string) {
  fireEvent.compositionStart(box);
  fireEvent.change(box, { target: { value } });
}

describe("search box and the IME", () => {
  it("Chromium order: the confirming Enter (isComposing, keyCode 229) does not open the results", () => {
    const w = world();
    const { box, onSearch } = renderBox(w);
    compose(box, "せっけい");
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229, isComposing: true });
    fireEvent.compositionEnd(box, { data: "設計" });
    fireEvent.change(box, { target: { value: "設計" } });
    fireEvent.keyUp(box, { key: "Enter" });
    expect(onSearch).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Enter", keyCode: 13 });
    expect(onSearch).toHaveBeenCalledWith({ ...EMPTY_SEARCH, q: "設計" });
  });

  it("WebKit order: compositionend, then a keydown Enter without isComposing (even keyCode 13), does not open the results", () => {
    const w = world();
    const { box, onSearch } = renderBox(w);
    compose(box, "設計");
    fireEvent.compositionEnd(box, { data: "設計" });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 13 });
    expect(onSearch).not.toHaveBeenCalled();
    fireEvent.keyUp(box, { key: "Enter" });
    // keyCode 229 alone (WebKit's usual marking) is the IME's too.
    fireEvent.keyDown(box, { key: "Enter", keyCode: 229 });
    expect(onSearch).not.toHaveBeenCalled();
    fireEvent.keyUp(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 13 });
    expect(onSearch).toHaveBeenCalledTimes(1);
    expect(onSearch).toHaveBeenCalledWith({ ...EMPTY_SEARCH, q: "設計" });
  });

  it("Esc while converting cancels the conversion only: the box stays open", () => {
    const w = world();
    const { box, onOpenChange } = renderBox(w);
    compose(box, "せっけい");
    fireEvent.keyDown(box, { key: "Escape", keyCode: 229, isComposing: true });
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.compositionEnd(box, { data: "" });
    fireEvent.keyUp(box, { key: "Escape" });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("the flag after compositionend clears on keyup, or after a short grace when no keyup comes", () => {
    vi.useFakeTimers();
    document.dispatchEvent(new CompositionEvent("compositionend"));
    expect(isImeKeyEvent({ isComposing: false, keyCode: 13 })).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keyup"));
    expect(isImeKeyEvent({ isComposing: false, keyCode: 13 })).toBe(false);
    document.dispatchEvent(new CompositionEvent("compositionend")); // ended by a click: no keyup
    vi.advanceTimersByTime(IME_CONFIRM_GRACE_MS + 1);
    expect(isImeKeyEvent({ isComposing: false, keyCode: 13 })).toBe(false);
    expect(isImeKeyEvent({ isComposing: true })).toBe(true);
    expect(isImeKeyEvent({ keyCode: 229 })).toBe(true);
  });
});

describe("search box live results", () => {
  it("shows the best messages with the words marked, once typing pauses and never mid-conversion", async () => {
    const w = world();
    const { box } = renderBox(w);
    compose(box, "せっけい");
    await act(() => new Promise((resolve) => setTimeout(resolve, LIVE_DEBOUNCE_MS + 100)));
    expect(w.search).not.toHaveBeenCalled(); // nothing while the IME is open
    fireEvent.compositionEnd(box, { data: "設計" });
    fireEvent.change(box, { target: { value: "設計" } });
    await waitFor(() => expect(document.body.textContent).toContain("設計レビューの資料です"));
    expect(w.search).toHaveBeenCalledTimes(1);
    expect(w.search).toHaveBeenCalledWith(expect.objectContaining({ q: "設計", limit: LIVE_LIMIT, offset: 0 }));
    expect(screen.getByText("メッセージ")).toBeTruthy();
    expect(screen.getAllByText("設計", { selector: "mark" })).toHaveLength(2);
    // The messages come before 「すべての結果を見る」, the last row.
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options.at(-1)).toBe("「設計」のすべての結果を見る");
    expect(options.findIndex((o) => o.includes("設計レビュー"))).toBeLessThan(options.length - 1);
  });

  it("drops a response that arrives after newer words were typed", async () => {
    const w = world();
    const pending: Array<{ q: string; resolve: (value: SearchOut) => void }> = [];
    w.search.mockImplementation((query: { q: string }) => new Promise<SearchOut>((resolve) => pending.push({ q: query.q, resolve })));
    const { box } = renderBox(w);
    fireEvent.change(box, { target: { value: "設" } });
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.change(box, { target: { value: "設計" } });
    await waitFor(() => expect(pending).toHaveLength(2));
    await act(async () => pending[1]!.resolve(out([w.review], ["設計"])));
    await waitFor(() => expect(screen.getByText("レビューの資料です", { exact: false })).toBeTruthy());
    // The older answer comes last: it must not replace the newer one.
    await act(async () => pending[0]!.resolve(out([w.reply], ["設"])));
    expect(screen.queryByText("の続き", { exact: false })).toBeNull();
    expect(screen.getByText("レビューの資料です", { exact: false })).toBeTruthy();
  });

  it("says when nothing matches or the search failed, without a toast", async () => {
    const w = world();
    const { box } = renderBox(w);
    fireEvent.change(box, { target: { value: "zzz" } });
    await waitFor(() => expect(screen.getByText("一致するメッセージはありません")).toBeTruthy());
    w.search.mockRejectedValueOnce(new Error("offline"));
    fireEvent.change(box, { target: { value: "zzzz" } });
    await waitFor(() => expect(screen.getByText("結果を読み込めませんでした")).toBeTruthy());
    expect(w.controller.setError).not.toHaveBeenCalled();
  });

  it("opens all the results from the last row or a plain Enter, and a message with ↓ and Enter", async () => {
    const w = world();
    const { box, onSearch, onOpenMessage, onOpenChange } = renderBox(w);
    fireEvent.change(box, { target: { value: "設計" } });
    await waitFor(() => expect(document.body.textContent).toContain("設計レビューの資料です"));
    fireEvent.click(screen.getByText("のすべての結果を見る", { exact: false }));
    expect(onSearch).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, q: "設計" });

    // ↓ highlights the first row (a message: no people or channels match), Enter opens it in its conversation.
    fireEvent.keyDown(box, { key: "ArrowDown" });
    const options = screen.getAllByRole("option");
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    expect(box.getAttribute("aria-activedescendant")).toBe(options[0]!.id);
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onOpenMessage).toHaveBeenCalledWith(expect.objectContaining({ id: w.review.id }), undefined, "設計");
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // ↓ twice more reaches 「すべての結果を見る」; ↑ from nothing goes there too.
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSearch).toHaveBeenCalledTimes(2);
    expect(onSearch).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, q: "設計" });

    // Typing again highlights nothing: Enter opens all the results for the new words.
    fireEvent.change(box, { target: { value: "設計書" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onSearch).toHaveBeenLastCalledWith({ ...EMPTY_SEARCH, q: "設計書" });
    expect(onOpenMessage).toHaveBeenCalledTimes(1);
  });

  it("a long message's preview starts near its first match", () => {
    const long = `${"前置きの長い文章です。".repeat(8)}最後に設計の要点をまとめます`;
    const shown = leadToFirstHit(long, ["設計"]);
    expect(shown.startsWith("…")).toBe(true);
    expect(shown).toContain("設計の要点");
    expect(shown.length).toBeLessThan(long.length);
    expect(leadToFirstHit("設計の続き", ["設計"])).toBe("設計の続き");
    expect(leadToFirstHit("We talked a lot about lunch plans and then the design review came up", ["design"])).toBe("…plans and then the design review came up"); // at a word
  });

  it("an empty box asks nothing", async () => {
    const w = world();
    const { box } = renderBox(w);
    fireEvent.change(box, { target: { value: "   " } });
    await act(() => new Promise((resolve) => setTimeout(resolve, LIVE_DEBOUNCE_MS + 100)));
    expect(w.search).not.toHaveBeenCalled();
  });
});

describe("phone 「移動・検索」", () => {
  it("the WebKit confirming Enter opens nothing; live messages open in their conversation", async () => {
    const w = world();
    const onOpen = vi.fn();
    const onSearch = vi.fn();
    const onOpenMessage = vi.fn();
    render(<JumpView controller={w.controller} recentIds={[]} recentSearches={[]} onOpen={onOpen} onOpenPerson={() => {}} onSearch={onSearch} onOpenMessage={onOpenMessage} onRemoveRecentSearch={() => {}} onClose={() => {}} />);
    const box = screen.getByRole("textbox", { name: "移動・検索" }) as HTMLInputElement;
    compose(box, "設計");
    fireEvent.compositionEnd(box, { data: "設計" });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 13 });
    expect(onSearch).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyUp(box, { key: "Enter" });
    await waitFor(() => expect(document.body.textContent).toContain("設計レビューの資料です"));
    // No conversation matches, so the messages come first; Enter (Go) still searches until ↓ picks one.
    fireEvent.keyDown(box, { key: "Enter", keyCode: 13 });
    expect(onSearch).toHaveBeenCalledWith({ ...EMPTY_SEARCH, q: "設計" });
    expect(onOpenMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button").find((b) => b.textContent?.includes("設計レビューの資料です"))!);
    expect(onOpenMessage).toHaveBeenCalledWith(expect.objectContaining({ id: w.review.id }), undefined, "設計");
  });
});

describe("other boxes that act on Enter", () => {
  it("⌘K: the WebKit confirming Enter does not open the highlighted conversation; a plain Enter does", () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    Element.prototype.scrollIntoView ??= () => {};
    const w = world();
    const onOpen = vi.fn();
    render(<QuickSwitcher controller={w.controller} onOpen={onOpen} onClose={() => {}} />);
    const box = screen.getByRole("combobox") as HTMLInputElement;
    compose(box, "gen");
    fireEvent.compositionEnd(box, { data: "gen" });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 13 });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.keyUp(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "Enter", keyCode: 13 });
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
