// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PopoverContent, PopoverRoot, PopoverTrigger } from "../src/ui/primitives";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * jsdom lays nothing out: the conversation (a 400 px scroller at the top of the window) and the button get boxes;
 * `top` is where the button is now, moved by a "scroll".
 */
function layout() {
  const state = { top: 100 };
  const boxes: Record<string, () => DOMRect> = {
    conversation: () => new DOMRect(0, 0, 600, 400),
    open: () => new DOMRect(20, state.top, 28, 24),
  };
  const box = (el: Element) => boxes[el.getAttribute("data-box") ?? ""]?.();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return box(this) ?? new DOMRect();
  });
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    const rect = box(this);
    return Object.assign(rect ? [rect] : [], { item: (i: number) => (rect && i === 0 ? rect : null) }) as unknown as DOMRectList;
  });
  for (const key of ["clientWidth", "clientHeight"] as const) {
    vi.spyOn(HTMLElement.prototype, key, "get").mockImplementation(function (this: HTMLElement) {
      // The window (floating-ui takes the viewport from the root element) as in a browser.
      const rect = this === document.documentElement ? new DOMRect(0, 0, 1280, 800) : box(this);
      return rect ? (key === "clientWidth" ? rect.width : rect.height) : 0;
    });
  }
  return state;
}

function Picker({ closeOnHide }: { closeOnHide: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div data-box="conversation" style={{ overflowY: "auto" }}>
      <PopoverRoot open={open} onOpenChange={setOpen}>
        <PopoverTrigger data-box="open">open</PopoverTrigger>
        <PopoverContent aria-label="picker" onAnchorHidden={closeOnHide ? () => setOpen(false) : undefined}>picker</PopoverContent>
      </PopoverRoot>
    </div>
  );
}

const scroll = async (state: { top: number }, top: number) => {
  state.top = top;
  await act(async () => {
    screen.getByText("open").parentElement!.dispatchEvent(new Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
};

describe("a message's reaction picker closes once its button scrolls out of the conversation (2026-10-05)", () => {
  it("stays while the button is in view, closes when it is scrolled away", async () => {
    const state = layout();
    render(<Picker closeOnHide />);
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => expect(screen.getByLabelText("picker")).toBeTruthy());
    await scroll(state, 300); // still inside the 400 px conversation
    expect(screen.queryByLabelText("picker")).toBeTruthy();
    await scroll(state, 450); // below its bottom edge
    await waitFor(() => expect(screen.queryByLabelText("picker")).toBeNull());
  });

  it("a popover whose anchor does not scroll (the composer's) stays open", async () => {
    const state = layout();
    render(<Picker closeOnHide={false} />);
    fireEvent.click(screen.getByText("open"));
    await waitFor(() => expect(screen.getByLabelText("picker")).toBeTruthy());
    await scroll(state, 450);
    expect(screen.queryByLabelText("picker")).toBeTruthy();
    const wrapper = screen.getByLabelText("picker").parentElement!;
    expect(wrapper.style.visibility).not.toBe("hidden");
  });
});
