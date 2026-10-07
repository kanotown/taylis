// @vitest-environment jsdom
/**
 * The formatting toolbars never run out of their pane (2026-10-08): what does not fit goes into 「…」.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fittingTools, OverflowToolbar, type ToolbarTool } from "../src/ui/OverflowToolbar";

describe("fittingTools", () => {
  // Five 28px tools with 2px gaps: they end at 28, 58, 88, 118, 148; 「…」 takes 30 with its gap.
  const ends = [28, 58, 88, 118, 148];
  it("shows all when all fit", () => {
    expect(fittingTools(ends, 30, 148)).toBe(5);
    expect(fittingTools(ends, 30, 500)).toBe(5);
  });
  it("leaves room for 「…」 when some do not", () => {
    expect(fittingTools(ends, 30, 147)).toBe(3); // 88 + 30 = 118 fits, 118 + 30 does not
    expect(fittingTools(ends, 30, 118)).toBe(3);
    expect(fittingTools(ends, 30, 117)).toBe(2);
  });
  it("can fold every tool", () => {
    expect(fittingTools(ends, 30, 40)).toBe(0);
    expect(fittingTools(ends, 30, 0)).toBe(0);
    expect(fittingTools([], 30, 0)).toBe(0);
  });
});

describe("OverflowToolbar", () => {
  const tools = (run = vi.fn()): ToolbarTool[] =>
    ["見出し", "太字", "斜体", "引用", "表"].map((label, i) => ({ icon: <span>{i}</span>, label, run: () => run(label), group: i === 3 }));

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows every tool where nothing is laid out", () => {
    render(<OverflowToolbar tools={tools()} label="書式" buttonClassName="h-7 w-7" />);
    expect(screen.getByRole("toolbar", { name: "書式" })).toBeTruthy();
    expect(screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["見出し", "太字", "斜体", "引用", "表"]);
  });

  it("folds what does not fit into 「…」, reachable from the keyboard", async () => {
    // A 100px row: each measured tool is 28px wide one after the other (2px gaps), 「…」 too.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "toolbar" ? 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const parent = this.parentElement;
      const index = parent && parent.getAttribute("aria-hidden") === "true" ? [...parent.children].indexOf(this) : -1;
      const left = index < 0 ? 0 : index * 30;
      const width = index < 0 ? 0 : 28;
      return { left, right: left + width, width, top: 0, bottom: 28, height: 28, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    const run = vi.fn();
    render(<OverflowToolbar tools={tools(run)} label="書式" buttonClassName="h-7 w-7" />);
    // 28, 58, 88 (+ 「…」 30 = 118 > 100): two tools and 「…」.
    const labels = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["見出し", "太字", "その他の書式"]);
    const more = screen.getByRole("button", { name: "その他の書式" });
    more.focus();
    await act(async () => {
      fireEvent.keyDown(more, { key: "Enter" });
    });
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["2斜体", "3引用", "4表"]);
    await act(async () => {
      fireEvent.click(items[1]!);
    });
    expect(run).toHaveBeenCalledWith("引用");
  });
});
