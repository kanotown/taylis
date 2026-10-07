// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { EmojiPicker } from "../src/ui/EmojiPicker";
import { Modal, PopoverContent, PopoverRoot, PopoverTrigger } from "../src/ui/primitives";

afterEach(cleanup);

/** A wheel turn over `el`, as the browser sends it (cancelable, bubbling); returns whether something cancelled it. */
function wheel(el: Element): boolean {
  const event = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event.defaultPrevented;
}

describe("a popover over a dialog keeps the wheel (2026-10-04: the section icon's emoji list did not scroll)", () => {
  it("the dialog's scroll lock does not cancel a wheel turn inside a popover opened from it", () => {
    render(
      <Modal title="セクション" onClose={() => {}}>
        <PopoverRoot open>
          <PopoverTrigger>アイコン</PopoverTrigger>
          <PopoverContent>
            <EmojiPicker onPick={() => {}} />
          </PopoverContent>
        </PopoverRoot>
      </Modal>,
    );
    const grid = screen.getByTitle(":grinning:").closest(".overflow-y-auto")!;
    expect(grid.className).toContain("overflow-y-auto");
    expect(wheel(grid)).toBe(false);
    // The lock still holds for the page behind the dialog.
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    expect(wheel(outside)).toBe(true);
    outside.remove();
  });
});
