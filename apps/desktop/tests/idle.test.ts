import { afterEach, describe, expect, it, vi } from "vitest";
import { IdleWatch } from "../src/platform/idle";

afterEach(() => vi.useRealTimers());

describe("the reader leaving the computer (PUSH_NOTIFICATIONS.md §4.1)", () => {
  it("is idle after the quiet time, back at the next input, and says so each time", () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const target = new EventTarget();
    const watch: IdleWatch = new IdleWatch(() => changes.push(watch.isIdle), () => Date.now(), 1000);
    watch.start(target);
    vi.advanceTimersByTime(600);
    target.dispatchEvent(new Event("pointermove")); // input part way: the quiet time starts again
    vi.advanceTimersByTime(600);
    expect(watch.isIdle).toBe(false);
    vi.advanceTimersByTime(400);
    expect(watch.isIdle).toBe(true);
    target.dispatchEvent(new Event("keydown"));
    expect(watch.isIdle).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([true, false, true]);
  });

  it("is back as soon as the window is focused again (⌘-tab), before any key or pointer input (M28b)", () => {
    vi.useFakeTimers();
    const changes: boolean[] = [];
    const target = new EventTarget();
    const watch: IdleWatch = new IdleWatch(() => changes.push(watch.isIdle), () => Date.now(), 1000);
    watch.start(target);
    vi.advanceTimersByTime(1000);
    expect(watch.isIdle).toBe(true);
    target.dispatchEvent(new Event("focus"));
    expect(watch.isIdle).toBe(false);
    expect(changes).toEqual([true, false]);
  });
});
