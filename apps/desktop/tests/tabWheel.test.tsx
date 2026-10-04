// @vitest-environment jsdom
/** 2026-10-04: a mouse wheel's vertical turn scrolls an overflowing tab row (管理, 検索, the conversation tabs) sideways. */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { UnderlineTabRow } from "../src/ui/primitives";

afterEach(cleanup);

function sized(row: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(row, "scrollWidth", { value: scrollWidth, configurable: true });
  Object.defineProperty(row, "clientWidth", { value: clientWidth, configurable: true });
}

function wheel(row: HTMLElement, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init });
  row.dispatchEvent(event);
  return event;
}

it("an overflowing row: deltaY scrolls it sideways and the page does not get the wheel", () => {
  render(<UnderlineTabRow role="tablist" aria-label="管理"><button>ユーザー</button></UnderlineTabRow>);
  const row = screen.getByRole("tablist");
  sized(row, 900, 400);
  const down = wheel(row, { deltaY: 120 });
  expect(row.scrollLeft).toBe(120);
  expect(down.defaultPrevented).toBe(true);
  wheel(row, { deltaY: 3, deltaMode: 1 }); // lines (Firefox): 16 px each
  expect(row.scrollLeft).toBe(168);
  wheel(row, { deltaY: -1000 });
  expect(row.scrollLeft).toBe(0);
  // At the start, a turn back up is the page's.
  expect(wheel(row, { deltaY: -50 }).defaultPrevented).toBe(false);
  // A sideways gesture (trackpad) is left to the browser.
  expect(wheel(row, { deltaX: 40, deltaY: 5 }).defaultPrevented).toBe(false);
  expect(row.scrollLeft).toBe(0);
});

it("a row that fits leaves the wheel alone", () => {
  render(<UnderlineTabRow role="tablist" aria-label="検索の対象"><button>メッセージ</button></UnderlineTabRow>);
  const row = screen.getByRole("tablist");
  sized(row, 400, 400);
  expect(wheel(row, { deltaY: 120 }).defaultPrevented).toBe(false);
  expect(row.scrollLeft).toBe(0);
});
