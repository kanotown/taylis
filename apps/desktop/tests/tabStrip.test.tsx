// @vitest-environment jsdom
// 2026-10-28: the wide conversation header's tabs fold into 「その他 ▾」 when they do not fit; the selected one stays.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fittingTabs, stripRoom, TabStrip } from "../src/ui/TabStrip";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("fittingTabs", () => {
  const widths = [80, 70, 50, 60]; // メッセージ キャンバス タスク ドライブ

  it("shows every tab when they fit", () => {
    expect(fittingTabs(widths, 0, 50, 260, 0)).toEqual([0, 1, 2, 3]);
    expect(fittingTabs(widths, 0, 50, 1000, 3)).toEqual([0, 1, 2, 3]);
    expect(fittingTabs([], 0, 50, 0, 0)).toEqual([]);
  });

  it("keeps the first ones that fit beside 「その他」", () => {
    expect(fittingTabs(widths, 0, 50, 259, 0)).toEqual([0, 1, 2]); // 80 + 70 + 50 + 50 (その他) = 250
    expect(fittingTabs(widths, 0, 50, 249, 0)).toEqual([0, 1]);
    expect(fittingTabs(widths, 0, 50, 200, 1)).toEqual([0, 1]);
    expect(fittingTabs(widths, 4, 50, 200, 0)).toEqual([0]); // gaps count: 80 + 4 + 50 + 4 + 70 > 200
  });

  it("always keeps the selected tab, in its place, giving up the last ones before it", () => {
    expect(fittingTabs(widths, 0, 50, 200, 3)).toEqual([0, 3]); // ドライブ selected: 80 + 60 + 50 = 190
    expect(fittingTabs(widths, 0, 50, 150, 2)).toEqual([2]);
    expect(fittingTabs(widths, 0, 50, 10, 1)).toEqual([1]); // too narrow even for it: it still shows
    expect(fittingTabs(widths, 0, 50, 10, 99)).toEqual([0]); // an unknown selection counts as the first
  });
});

describe("TabStrip", () => {
  const tabs = [["messages", "メッセージ"], ["canvas", "キャンバス"], ["tasks", "タスク"], ["drive", "ドライブ"]] as const;

  /**
   * The header's row is `row` px wide: a title whose text is 300 px (counted up to its data-natural-max, 100), a topic
   * (counted as nothing) and the strip. Each measured tab is 80 px, 「その他」 60 px.
   */
  function layout(row: number) {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const width = this.hasAttribute("data-row")
        ? row
        : this.hasAttribute("data-title")
          ? 300
          : this.hasAttribute("data-topic")
            ? 500
            : this.parentElement?.hasAttribute("aria-hidden")
              ? (this.textContent?.includes("その他") ? 60 : 80)
              : 0;
      return { width, height: 24, top: 0, left: 0, right: width, bottom: 24, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
  }
  const header = (value: string, onChange: (value: string) => void) => (
    <div data-row="">
      <strong data-title="" data-natural-max="100">a long channel name</strong>
      <TabStrip tabs={tabs} value={value} onChange={onChange} label="会話の表示" />
      <span data-topic="">a long topic</span>
    </div>
  );
  const shownTabs = () => screen.getAllByRole("tab").map((tab) => tab.textContent);

  it("shows all the tabs in a test's DOM (nothing measured)", () => {
    render(<TabStrip tabs={tabs} value="messages" onChange={() => {}} label="会話の表示" />);
    expect(shownTabs()).toEqual(["メッセージ", "キャンバス", "タスク", "ドライブ"]);
    expect(screen.queryByRole("button", { name: /その他/ })).toBeNull();
  });

  it("measures its room in the row: the topic gives way, the title keeps up to its cap", () => {
    layout(500);
    render(header("messages", () => {}));
    expect(stripRoom(document.querySelector("[data-tab-strip]") as HTMLElement)).toBe(400); // 500 − 100 (title), topic 0
  });

  it("puts what does not fit into 「その他 ▾」, and the selected tab stays", async () => {
    layout(420);
    const onChange = vi.fn();
    render(header("messages", onChange));
    expect(shownTabs()).toEqual(["メッセージ", "キャンバス", "タスク", "ドライブ"]); // 4 × 80 = 320 ≤ 420 − 100

    cleanup();
    vi.restoreAllMocks();
    layout(350);
    const view = render(header("messages", onChange));
    expect(shownTabs()).toEqual(["メッセージ", "キャンバス"]); // 80 + 80 + 60 ≤ 250
    const more = screen.getByRole("button", { name: /その他/ });
    await act(async () => { fireEvent.keyDown(more, { key: "Enter" }); });
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["タスク", "ドライブ"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "ドライブ" }));
    expect(onChange).toHaveBeenCalledWith("drive");

    // Selected from the menu, 「ドライブ」 takes the last place that fitted.
    view.rerender(header("drive", onChange));
    expect(shownTabs()).toEqual(["メッセージ", "ドライブ"]);
    expect(screen.getByRole("tab", { name: "ドライブ" }).getAttribute("aria-selected")).toBe("true");
  });
});
