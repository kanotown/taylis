// @vitest-environment jsdom
/**
 * WIKI.md §29.2–§29.3: the Docs sidebar's search box (live page results from GET /search/pages, IME-safe keys, Enter
 * opens the first, arrows choose, 「すべて見る」) and ⌘F inside an open page (matches across inline marks but never
 * across blocks, count, next / previous wrapping, the highlight API, the keys kept from the app's message search).
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PageSearchHit } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { DocsSidebarSearch } from "../src/ui/DocsSidebarSearch";
import { findRanges, revealDelta, revealRange, stepIndex, visibleBand } from "../src/ui/findInPage";
import { PageFindBar, type PageFindHandle, usePageFindKeys } from "../src/ui/PageFind";
import { item } from "./wikiFixtures";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Lets `ms` of the clock pass (the box's debounce, the recount's wait) after what is queued already (an observer's callback) has run. */
const settle = (ms = 0) => act(async () => {
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(ms);
});

describe("findRanges", () => {
  const dom = (html: string) => {
    const root = document.createElement("div");
    root.innerHTML = html;
    document.body.append(root);
    return root;
  };

  it("finds the words across inline marks, ignoring case, never across blocks or in skipped parts", () => {
    const root = dom("<p>Hello <b>Wor</b>ld and world</p><p>ab<i>c</i></p><p>def</p><div data-find-skip>world</div><script>world</script>");
    const ranges = findRanges(root, "WORLD");
    expect(ranges.map((r) => r.toString())).toEqual(["World", "world"]);
    expect(ranges[0]!.startContainer).not.toBe(ranges[0]!.endContainer); // spans <b>Wor</b> and "ld"
    expect(findRanges(root, "cd")).toHaveLength(0); // "abc" then "def": two blocks
    expect(findRanges(root, "abc")).toHaveLength(1);
    expect(findRanges(root, "  ")).toHaveLength(0);
    root.remove();
  });

  it("Japanese, and overlapping words counted one after another", () => {
    const root = dom("<h2>設計の会議</h2><ul><li>設計設計</li><li>ああああ</li></ul>");
    expect(findRanges(root, "設計")).toHaveLength(3);
    expect(findRanges(root, "ああ")).toHaveLength(2);
    root.remove();
  });

  it("a hard break (<br>) is a break too: the words on either side of it do not join", () => {
    const root = dom("<p>設計<br>会議</p><p>設計会議</p><p>a<br><br>b</p>");
    expect(findRanges(root, "設計会議")).toHaveLength(1);
    expect(findRanges(root, "設計").map((r) => r.toString())).toEqual(["設計", "設計"]);
    expect(findRanges(root, "会議")).toHaveLength(2);
    expect(findRanges(root, "ab")).toHaveLength(0);
    expect(findRanges(root, "b")).toHaveLength(1);
    root.remove();
  });

  it("steps wrap at both ends", () => {
    expect(stepIndex(-1, 3, 1)).toBe(0);
    expect(stepIndex(-1, 3, -1)).toBe(2);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
    expect(stepIndex(0, 0, 1)).toBe(-1);
  });
});

describe("revealing the current match", () => {
  const rect = (top: number, bottom: number, left = 0, right = 800): DOMRect => ({ top, bottom, left, right, height: bottom - top, width: right - left, x: left, y: top, toJSON: () => ({}) });

  it("takes what floats over the box (the find bar) off the edge it sits at", () => {
    const box = { top: 44, bottom: 644 };
    expect(visibleBand(box, [{ top: 48, bottom: 84 }])).toEqual({ top: 84, bottom: 644 });
    expect(visibleBand(box, [{ top: 600, bottom: 660 }])).toEqual({ top: 44, bottom: 600 });
    expect(visibleBand(box, [{ top: 0, bottom: 40 }])).toEqual(box); // not over it
  });

  it("scrolls nothing while the match is in view clear of the edges, else to the middle; a tall match to the top", () => {
    const view = { top: 84, bottom: 644 }; // its middle: 364
    expect(revealDelta({ top: 200, bottom: 220 }, view)).toBe(0);
    expect(revealDelta({ top: 60, bottom: 80 }, view)).toBe(70 - 364); // under the bar: up
    expect(revealDelta({ top: 86, bottom: 100 }, view)).toBe(93 - 364); // at the edge
    expect(revealDelta({ top: 700, bottom: 720 }, view)).toBe(710 - 364); // below: down
    expect(revealDelta({ top: 700, bottom: 1400 }, view)).toBe(700 - 84 - 8); // taller than the view
  });

  it("scrolls the box (data-find-root) by the match's own rectangle, from under the bar, and a box inside it first", () => {
    const root = document.createElement("div");
    root.innerHTML = "<section><div role='search' data-find-skip>bar</div><div data-find-root><p>設計の話</p><div data-inner style='overflow-y: auto'><p>中の設計</p></div></div></section>";
    document.body.append(root);
    const bar = root.querySelector("[role='search']") as HTMLElement;
    const box = root.querySelector("[data-find-root]") as HTMLElement;
    const inner = root.querySelector("[data-inner]") as HTMLElement;
    bar.getBoundingClientRect = () => rect(48, 84, 500, 780);
    box.getBoundingClientRect = () => rect(44, 644);
    inner.getBoundingClientRect = () => rect(200, 400);
    Object.defineProperty(inner, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(inner, "clientHeight", { configurable: true, value: 200 });
    const proto = Range.prototype as { getBoundingClientRect?: () => DOMRect };
    const original = proto.getBoundingClientRect;
    let match = rect(60, 80, 600, 640);
    proto.getBoundingClientRect = () => match;
    const rangeIn = (p: Element) => {
      const range = document.createRange();
      range.selectNodeContents(p.firstChild!);
      return range;
    };
    try {
      const outer = rangeIn(box.querySelector("p")!);
      box.scrollTop = 500;
      revealRange(outer, [bar]); // under the bar, at the box's top right: brought to the middle
      expect(box.scrollTop).toBe(500 + (70 - 364));
      box.scrollTop = 500;
      match = rect(60, 80, 10, 50); // the same height at the left, where the bar is not: in view
      revealRange(outer, [bar]);
      expect(box.scrollTop).toBe(500);
      match = rect(700, 720, 10, 50); // clipped below the box, though inside the window
      revealRange(outer, [bar]);
      expect(box.scrollTop).toBe(500 + (710 - 344));
      // A match in a box scrolling inside the page (a database's table): that box first, then the page's.
      box.scrollTop = 500;
      inner.scrollTop = 0;
      match = rect(450, 470, 10, 50);
      revealRange(rangeIn(inner.querySelector("p")!), [bar]);
      expect(inner.scrollTop).toBe(460 - 300);
      expect(box.scrollTop).toBe(500); // in the page's view already
    } finally {
      if (original) proto.getBoundingClientRect = original;
      else delete proto.getBoundingClientRect;
      root.remove();
    }
  });
});

describe("⌘F in a page", () => {
  let painted: Map<string, { ranges: Range[] }>;
  beforeEach(() => {
    painted = new Map();
    vi.stubGlobal("CSS", { highlights: { set: (name: string, value: { ranges: Range[] }) => painted.set(name, value), delete: (name: string) => painted.delete(name) } });
    vi.stubGlobal("Highlight", class { ranges: Range[]; constructor(...ranges: Range[]) { this.ranges = ranges; } });
  });

  function Page({ embedded = false, children }: { embedded?: boolean; children?: React.ReactNode }) {
    const section = useRef<HTMLElement>(null);
    const [finding, setFinding] = useState(false);
    const handle = useRef<PageFindHandle | null>(null);
    usePageFindKeys(section, embedded, finding, () => (finding ? handle.current?.focus() : setFinding(true)), (step) => handle.current?.step(step));
    return (
      <section ref={section} data-doc-page={embedded ? "inner" : "outer"}>
        {finding && <PageFindBar section={section} handle={handle} onClose={() => setFinding(false)} />}
        <div data-find-root="">
          <p>設計の話。設計を決める。</p>
          <p>次の設計</p>
          {children}
        </div>
      </section>
    );
  }
  const count = () => document.querySelector("[data-find-count]")?.textContent;

  it("opens with ⌘F (not the app's search), counts, steps with Enter / Shift+Enter, marks the current one, Esc closes", async () => {
    const appSearch = vi.fn();
    window.addEventListener("keydown", appSearch);
    render(<Page />);
    const event = fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    expect(event).toBe(false);
    expect(appSearch).not.toHaveBeenCalled();
    const input = screen.getByRole("textbox", { name: "ページ内を検索" }) as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "設計" } });
    await settle();
    expect(count()).toBe("1 / 3");
    expect(painted.get("doc-find-current")?.ranges[0]?.toString()).toBe("設計");
    expect(painted.get("doc-find")?.ranges).toHaveLength(2);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(count()).toBe("2 / 3");
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(count()).toBe("1 / 3");
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(count()).toBe("3 / 3");
    // ⌘G steps too; the Enter confirming an IME conversion does not.
    fireEvent.keyDown(document.body, { key: "g", metaKey: true });
    expect(count()).toBe("1 / 3");
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(count()).toBe("1 / 3");
    fireEvent.change(input, { target: { value: "無い言葉" } });
    await settle();
    expect(count()).toBe("0 件");
    const esc = fireEvent.keyDown(input, { key: "Escape" });
    expect(esc).toBe(false);
    expect(screen.queryByRole("textbox", { name: "ページ内を検索" })).toBeNull();
    expect(painted.size).toBe(0);
    window.removeEventListener("keydown", appSearch);
  });

  it("counts again when the page changes under the bar", async () => {
    render(<Page />);
    fireEvent.keyDown(document.body, { key: "f", ctrlKey: true });
    fireEvent.change(screen.getByRole("textbox", { name: "ページ内を検索" }), { target: { value: "設計" } });
    await settle();
    expect(count()).toBe("1 / 3");
    const p = document.createElement("p");
    p.textContent = "設計の追加";
    document.querySelector("[data-find-root]")!.append(p);
    await settle(250);
    expect(count()).toBe("1 / 4");
  });

  it("a row's page beside its table takes ⌘F while the focus is in it; the outer page otherwise", async () => {
    render(<Page><Page embedded /></Page>);
    const inner = document.querySelector("[data-doc-page='inner']") as HTMLElement;
    const button = document.createElement("button");
    inner.querySelector("[data-find-root]")!.append(button);
    button.focus();
    fireEvent.keyDown(button, { key: "f", metaKey: true });
    expect(inner.querySelector("[role='search']")).toBeTruthy();
    expect(document.querySelectorAll("[role='search']")).toHaveLength(1);
    (document.activeElement as HTMLElement).blur(); // the inner bar had the focus
    fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    expect(document.querySelectorAll("[role='search']")).toHaveLength(2);
  });

  it("does nothing under a modal dialog (the page hidden from it)", () => {
    render(<div aria-hidden="true"><Page /></div>);
    const event = fireEvent.keyDown(document.body, { key: "f", metaKey: true });
    expect(event).toBe(true);
    expect(screen.queryByRole("search", { hidden: true })).toBeNull();
  });
});

describe("the Docs sidebar's search box", () => {
  const hit = (id: string, title: string, snippet: string, kind: "page" | "row" = "page"): PageSearchHit => ({ page: item(id, { title, kind }), snippet, score: 1 });
  const HITS = [hit("p1", "設計メモ", "研究の設計について"), hit("p2", "会議", "メモ ## 決定 次の設計を決める")];

  function setup(searchWikiPages = vi.fn(async (_q: { q: string }) => ({ hits: HITS, keywords: ["設計"], filters: {}, has_more: false, limit: 8, offset: 0 }))) {
    const controller = { store: new Store(), api: { searchWikiPages }, engine: null } as unknown as AppController;
    const onOpen = vi.fn();
    const onSearchAll = vi.fn();
    function Box() {
      const [text, setText] = useState("");
      return (
        <DocsSidebarSearch controller={controller} text={text} onText={setText} selectedId={null} onOpen={onOpen} onSearchAll={onSearchAll}>
          <div data-testid="tree">tree</div>
        </DocsSidebarSearch>
      );
    }
    render(<Box />);
    return { searchWikiPages, onOpen, onSearchAll, input: screen.getByLabelText("ドキュメントを検索") as HTMLInputElement };
  }

  it("shows the tree while empty; typing lists the pages found (words marked) once typing pauses", async () => {
    const { searchWikiPages, input } = setup();
    expect(screen.getByTestId("tree")).toBeTruthy();
    fireEvent.change(input, { target: { value: "設" } });
    fireEvent.change(input, { target: { value: "設計" } });
    expect(screen.queryByTestId("tree")).toBeNull();
    await settle(300);
    expect(searchWikiPages).toHaveBeenCalledTimes(1);
    expect(searchWikiPages).toHaveBeenCalledWith({ q: "設計", limit: 8, offset: 0 });
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3); // two pages and 「すべて見る」
    expect(options[0]!.querySelector("mark")?.textContent).toBe("設計");
    expect(options[1]!.textContent).toContain("メモ 決定 次の設計を決める"); // no heading marks
  });

  it("Enter opens the first page; arrows choose another; the last line opens all results", async () => {
    const { input, onOpen, onSearchAll } = setup();
    fireEvent.change(input, { target: { value: "設計" } });
    await settle(300);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("p1");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpen).toHaveBeenLastCalledWith("p2");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSearchAll).toHaveBeenCalledWith("設計");
    // The Enter confirming an IME conversion opens nothing.
    onOpen.mockClear();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onOpen).not.toHaveBeenCalled();
    // Esc empties the box (handled: the screen's Esc waits) and the tree comes back.
    expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(false);
    expect(input.value).toBe("");
    expect(screen.getByTestId("tree")).toBeTruthy();
  });

  it("asks nothing while an IME composition is open", async () => {
    const { input, searchWikiPages } = setup();
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "せっけい" } });
    await settle(300);
    expect(searchWikiPages).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "設計" } });
    fireEvent.compositionEnd(input);
    await settle(300);
    expect(searchWikiPages).toHaveBeenCalledTimes(1);
    expect(searchWikiPages).toHaveBeenCalledWith(expect.objectContaining({ q: "設計" }));
  });

  it("nothing found, and a failed request, are said in the list", async () => {
    const empty = vi.fn(async () => ({ hits: [], keywords: [], filters: {}, has_more: false, limit: 8, offset: 0 }));
    const { input } = setup(empty);
    fireEvent.change(input, { target: { value: "無い" } });
    await settle(300);
    expect(screen.getByRole("status").textContent).toBe("一致するページはありません");
    cleanup();
    const { input: again } = setup(vi.fn(async () => { throw new Error("offline"); }));
    fireEvent.change(again, { target: { value: "設計" } });
    await settle(300);
    expect(screen.getByRole("status").textContent).toBe("結果を読み込めませんでした");
  });
});
