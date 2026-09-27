// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EngineStatus } from "../src/sync/engine";
import { useConnectionBanner } from "../src/ui/hooks";

describe("useConnectionBanner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const render = (initial: EngineStatus) => renderHook(({ status }) => useConnectionBanner(status, 2000), { initialProps: { status: initial } });

  it("shows nothing for a reconnect that finishes within the grace period", () => {
    const hook = render("connecting");
    expect(hook.result.current).toBeNull();
    act(() => vi.advanceTimersByTime(1500));
    hook.rerender({ status: "online" });
    act(() => vi.advanceTimersByTime(5000));
    expect(hook.result.current).toBeNull();
  });

  it("shows the strip once the socket stays down, follows it, and hides it when live again", () => {
    const hook = render("connecting");
    act(() => vi.advanceTimersByTime(2000));
    expect(hook.result.current).toBe("connecting");
    hook.rerender({ status: "offline" });
    expect(hook.result.current).toBe("offline");
    hook.rerender({ status: "online" });
    expect(hook.result.current).toBeNull();
  });

  it("restarts the grace period after going live", () => {
    const hook = render("offline");
    act(() => vi.advanceTimersByTime(2000));
    hook.rerender({ status: "online" });
    hook.rerender({ status: "connecting" });
    act(() => vi.advanceTimersByTime(1000));
    expect(hook.result.current).toBeNull();
    act(() => vi.advanceTimersByTime(1000));
    expect(hook.result.current).toBe("connecting");
  });
});
