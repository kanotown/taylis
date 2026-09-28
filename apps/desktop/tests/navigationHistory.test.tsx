// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useNavigationHistory } from "../src/ui/navigationHistory";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("restores channel/thread/search snapshots without creating new entries on Back or Forward", () => {
  const push = vi.spyOn(history, "pushState");
  let navigate!: (route: { page: string; query: string }) => void;
  function Screen() {
    const [route, setRoute] = useState({ page: "channel", query: "" });
    navigate = setRoute;
    useNavigationHistory(JSON.stringify(route), route, setRoute, true);
    return <p>{route.page}:{route.query}</p>;
  }
  render(<Screen />);
  const channel = history.state;
  act(() => navigate({ page: "thread", query: "" }));
  const thread = history.state;
  act(() => navigate({ page: "search", query: "実験" }));
  const search = history.state;
  expect(push).toHaveBeenCalledTimes(2);
  for (const [state, label] of [[thread, "thread:"], [channel, "channel:"], [search, "search:実験"]] as const) {
    act(() => window.dispatchEvent(new PopStateEvent("popstate", { state })));
    expect(screen.getByText(label)).toBeTruthy();
  }
  expect(push).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(search)).not.toContain("実験");
});

it("does not touch Tauri history or restore a previous workspace's snapshot", () => {
  const push = vi.spyOn(history, "pushState");
  const replace = vi.spyOn(history, "replaceState");
  const restore = vi.fn();
  function Screen({ enabled }: { enabled: boolean }) {
    useNavigationHistory("channel", { channel: "private" }, restore, enabled);
    return null;
  }
  const view = render(<Screen enabled={false} />);
  expect(replace).not.toHaveBeenCalled();
  expect(push).not.toHaveBeenCalled();
  view.rerender(<Screen enabled />);
  const old = history.state;
  view.unmount();
  render(<Screen enabled />);
  act(() => window.dispatchEvent(new PopStateEvent("popstate", { state: old })));
  expect(restore).not.toHaveBeenCalled();
});
