// @vitest-environment jsdom
import { StrictMode, useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Composer } from "../src/ui/Composer";
import { FakeServer } from "./fakeServer";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** jsdom lays nothing out: the buttons named here get a box at the composer's bottom row, everything else none. */
function layout(boxes: Record<string, DOMRect>) {
  const box = (el: Element) => (el.isConnected ? boxes[el.getAttribute("aria-label") ?? ""] : undefined);
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return box(this) ?? new DOMRect();
  });
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(function (this: Element) {
    const rect = box(this);
    return Object.assign(rect ? [rect] : [], { item: (i: number) => (rect && i === 0 ? rect : null) }) as unknown as DOMRectList;
  });
}

function world() {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const channel = server.createChannel("general", me.id);
  const store = new Store();
  store.upsertUser(me);
  store.upsertChannel(channel, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
  const controller = { store, engine: { send: vi.fn(), sendTyping: vi.fn(), status: "online" }, api: { uploadAttachment: vi.fn() }, setError: vi.fn(), sendKey: "shift-enter", isAdmin: false } as unknown as AppController;
  function View() {
    useSyncExternalStore(store.subscribe.bind(store), () => store.version);
    return <Composer controller={controller} channel={store.getChannel(channel.id)!} />;
  }
  // StrictMode as in main.tsx: it attaches every ref twice on mount, which is what left the anchor on a dead button.
  render(<StrictMode><View /></StrictMode>);
}

/** Where floating-ui put the popover (its wrapper's transform). */
function placed(): [number, number] | null {
  const wrapper = document.querySelector<HTMLElement>("[data-radix-popper-content-wrapper]");
  const match = wrapper?.style.transform.match(/translate\((-?[\d.]+)px, (-?[\d.]+)px\)/);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

describe("the composer's popovers open at their button (2026-10-04: the emoji list opened at the window's top-left)", () => {
  it("the emoji list and the priority menu open from their own buttons, a second click closes", async () => {
    layout({ 絵文字: new DOMRect(345, 739, 28, 28), 重要度: new DOMRect(405, 739, 28, 28) });
    world();
    fireEvent.click(screen.getByRole("button", { name: "絵文字" }));
    await waitFor(() => expect(placed()?.[0]).toBe(345));
    fireEvent.click(screen.getByRole("button", { name: "絵文字" }));
    await waitFor(() => expect(placed()).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "重要度" }));
    await waitFor(() => expect(placed()?.[0]).toBe(405));
  });

  it("on a narrow composer the emoji list opens from 「…」", async () => {
    layout({ その他の操作: new DOMRect(85, 739, 28, 28) });
    world();
    // The emoji button is folded away (no box); 「…」 → 絵文字 opens the list once the menu has closed.
    const more = screen.getByRole("button", { name: "その他の操作" });
    fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
    const entry = await screen.findByRole("menuitem", { name: "絵文字" });
    await act(async () => {
      fireEvent.click(entry);
    });
    await waitFor(() => expect(placed()?.[0]).toBe(85));
  });
});
