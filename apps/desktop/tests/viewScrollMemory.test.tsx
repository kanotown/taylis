// @vitest-environment jsdom
/**
 * M75: a centre view's list position (useViewScrollMemory). jsdom has no layout: rows (`data-row-key`, 50 px each) sit
 * at index × 50 − scrollTop below the top of the list, which shows 10 of them.
 */
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { clearScrollMemories, ScrollMemory } from "../src/ui/scrollMemory";
import { capturePosition, useViewScrollMemory } from "../src/ui/viewScrollMemory";

const ROW = 50;
const VIEW = 500;
let scrollTop = 0;

beforeEach(() => {
  clearScrollMemories();
  scrollTop = 0;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const index = this.dataset["index"];
    const top = index === undefined ? 0 : Number(index) * ROW - scrollTop;
    const height = index === undefined ? VIEW : ROW;
    return { top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => VIEW });
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.querySelectorAll("[data-row-key]").length * ROW;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set(this: HTMLElement, value: number) {
      scrollTop = Math.max(0, Math.min(value, this.scrollHeight - VIEW));
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const key of ["clientHeight", "scrollTop", "scrollHeight"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
});

const memory = new ScrollMemory();
const control = { load: () => {}, restore: false };

/** A view whose list arrives after it mounts (as the views fetch theirs). */
function View({ placeKey }: { placeKey: string | null }) {
  const root = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<string[]>([]);
  control.load = () => setRows(Array.from({ length: 40 }, (_, i) => `r${i}`));
  useViewScrollMemory(root, memory, placeKey, () => control.restore);
  return (
    <div ref={root} className="contents">
      <div data-scroll-memory>
        <ul>
          {rows.map((key, index) => (
            <li key={key} data-row-key={key} data-index={index}>
              {key}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const list = (container: HTMLElement) => container.querySelector<HTMLElement>("[data-scroll-memory]")!;

it("records the topmost row and its offset on every scroll", async () => {
  const view = render(<View placeKey="view:saved" />);
  await act(async () => control.load());
  scrollTop = 520; // r10 is 20 px above the top
  fireEvent.scroll(list(view.container));
  expect(memory.get("view:saved")).toMatchObject({ rowKey: "r10", offset: -20, atBottom: false });
  expect(capturePosition(list(view.container)).rowKey).toBe("r10");
});

it("comes back at that row once the list has loaded, when back / forward asks for it", async () => {
  memory.save("view:threads", { rowKey: "r12", offset: -10, scrollTop: 0, atBottom: false });
  control.restore = true;
  const view = render(<View placeKey="view:threads" />);
  expect(scrollTop).toBe(0); // nothing loaded yet
  await act(async () => control.load());
  expect(scrollTop).toBe(610);
  // The reader scrolls on: recorded again from there.
  fireEvent.wheel(list(view.container));
  scrollTop = 100;
  fireEvent.scroll(list(view.container));
  expect(memory.get("view:threads")?.rowKey).toBe("r2");
});

it("starts at the top when opened from the sidebar (no restore asked for)", async () => {
  memory.save("view:activity", { rowKey: "r12", offset: 0, scrollTop: 0, atBottom: false });
  control.restore = false;
  render(<View placeKey="view:activity" />);
  await act(async () => control.load());
  expect(scrollTop).toBe(0);
});

it("does not move a list the reader has already scrolled while it loaded", async () => {
  memory.save("view:files:", { rowKey: "r20", offset: 0, scrollTop: 0, atBottom: false });
  control.restore = true;
  const view = render(<View placeKey="view:files:" />);
  fireEvent.pointerDown(list(view.container));
  await act(async () => control.load());
  expect(scrollTop).toBe(0);
});

it("records nothing while a conversation is on screen (no key)", async () => {
  const before = memory.keys();
  const view = render(<View placeKey={null} />);
  await act(async () => control.load());
  scrollTop = 300;
  fireEvent.scroll(list(view.container));
  expect(memory.keys()).toEqual(before);
});
