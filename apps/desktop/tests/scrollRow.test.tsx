// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { revealInRow, rowMore, UNDERLINE_TAB_ROW, UnderlineTabRow } from "../src/ui/primitives";

afterEach(cleanup);

describe("a sideways row of tabs (管理, 検索, a conversation's tabs)", () => {
  it("has no scrollbar to run over the selected tab's underline", () => {
    expect(UNDERLINE_TAB_ROW).toContain("scroll-row");
    expect(UNDERLINE_TAB_ROW).toContain("overflow-x-auto");
  });

  it("brings a tab into view clear of the edge fades, moving as little as possible", () => {
    const row = { scrollLeft: 0, clientWidth: 500, scrollWidth: 1300 };
    expect(revealInRow(row, 100, 200)).toBe(0); // in view
    expect(revealInRow(row, 450, 540)).toBe(64); // its end plus the 24 px fade
    expect(revealInRow({ ...row, scrollLeft: 600 }, 500, 580)).toBe(476); // to its left, clear of the fade there
    expect(revealInRow(row, 1200, 1300)).toBe(800); // the last tab: the row's end, no fade beyond it
    expect(revealInRow({ ...row, scrollLeft: 800 }, 0, 90)).toBe(0); // the first: the row's start
    expect(revealInRow({ scrollLeft: 0, clientWidth: 400, scrollWidth: 400 }, 300, 390)).toBe(0); // nothing to scroll
  });

  it("knows which edges have more beyond them", () => {
    expect(rowMore({ scrollLeft: 0, clientWidth: 500, scrollWidth: 500 })).toBeNull();
    expect(rowMore({ scrollLeft: 0, clientWidth: 500, scrollWidth: 900 })).toBe("end");
    expect(rowMore({ scrollLeft: 200, clientWidth: 500, scrollWidth: 900 })).toBe("both");
    expect(rowMore({ scrollLeft: 400, clientWidth: 500, scrollWidth: 900 })).toBe("start");
  });

  it("goes from tab to tab with ←, →, Home and End, selecting it", () => {
    function Tabs() {
      const [tab, setTab] = useState("a");
      return (
        <UnderlineTabRow role="tablist" aria-label="tabs">
          {["a", "b", "c"].map((value) => (
            <button key={value} type="button" role="tab" aria-selected={tab === value} onClick={() => setTab(value)}>
              {value}
            </button>
          ))}
        </UnderlineTabRow>
      );
    }
    render(<Tabs />);
    const tab = (name: string) => screen.getByRole("tab", { name });
    act(() => tab("a").focus());
    fireEvent.keyDown(tab("a"), { key: "ArrowRight" });
    expect(tab("b").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("b"));
    fireEvent.keyDown(tab("b"), { key: "End" });
    expect(tab("c").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab("c"), { key: "ArrowRight" }); // wraps round
    expect(tab("a").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab("a"), { key: "ArrowLeft" });
    expect(tab("c").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab("c"), { key: "Home" });
    expect(tab("a").getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(tab("a"), { key: "ArrowRight", metaKey: true }); // not ours
    expect(tab("a").getAttribute("aria-selected")).toBe("true");
  });

  it("leaves a row scrolled away from the selected tab where it is when something other than a tab changes", async () => {
    render(
      <UnderlineTabRow aria-label="row">
        <div role="tablist">
          <button type="button" role="tab" aria-selected>a</button>
          <button type="button" role="tab" aria-selected={false}>b</button>
        </div>
        <div data-testid="chips" />
      </UnderlineTabRow>,
    );
    const row = screen.getByLabelText("row");
    Object.defineProperty(row, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(row, "scrollWidth", { configurable: true, value: 900 });
    // The tabs are 80 px wide at the row's start; the rects follow the scrolling.
    const at = (x: number) => ({ left: x - row.scrollLeft, right: x - row.scrollLeft + 80, width: 80, top: 0, bottom: 36, height: 36, x: x - row.scrollLeft, y: 0, toJSON: () => ({}) });
    const [a, b] = screen.getAllByRole("tab");
    a!.getBoundingClientRect = () => at(0);
    b!.getBoundingClientRect = () => at(80);
    const observed = () => act(async () => { await Promise.resolve(); });
    row.scrollLeft = 300; // scrolled away by hand, to the links beside the tabs
    const chip = document.createElement("a");
    chip.textContent = "link";
    screen.getByTestId("chips").append(chip); // a conversation's link chip appended: not a tab
    await observed();
    expect(row.scrollLeft).toBe(300);
    chip.remove();
    await observed();
    expect(row.scrollLeft).toBe(300);
    // A tab added (permissions loaded): the selected one is brought back into view.
    const tab = document.createElement("button");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "false");
    screen.getByRole("tablist").append(tab);
    await observed();
    expect(row.scrollLeft).toBe(0);
    // The selection moving: the newly selected tab, clear of the fade.
    row.scrollLeft = 300;
    a!.setAttribute("aria-selected", "false");
    b!.setAttribute("aria-selected", "true");
    await observed();
    expect(row.scrollLeft).toBe(80 - 24);
  });

  it("marks the edges that fade as it scrolls", () => {
    render(
      <UnderlineTabRow role="tablist" aria-label="tabs">
        <button type="button" role="tab" aria-selected>
          a
        </button>
      </UnderlineTabRow>,
    );
    const row = screen.getByRole("tablist");
    Object.defineProperty(row, "clientWidth", { configurable: true, value: 300 });
    Object.defineProperty(row, "scrollWidth", { configurable: true, value: 900 });
    row.scrollLeft = 0;
    fireEvent.scroll(row);
    expect(row.dataset.more).toBe("end");
    row.scrollLeft = 300;
    fireEvent.scroll(row);
    expect(row.dataset.more).toBe("both");
    row.scrollLeft = 600;
    fireEvent.scroll(row);
    expect(row.dataset.more).toBe("start");
  });
});
