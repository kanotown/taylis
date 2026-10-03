// @vitest-environment jsdom
/** M93: reordering the workspace rail (drag, Alt+↑/↓, the tile's menu) and keeping the order on this device. */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppController } from "../src/state/app";
import { dropIndex, gapForPointer, hostLabel, loadWorkspaces, moveWorkspace, saveWorkspaces, type WorkspaceEntry } from "../src/state/workspaces";
import { WorkspaceRail } from "../src/ui/WorkspaceRail";

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const entry = (serverUrl: string, name: string): WorkspaceEntry => ({ serverUrl, workspaceId: null, name, username: "alice", userId: null });
const A = entry("https://a.example.com", "Alpha");
const B = entry("https://b.example.com", "Beta");
const C = entry("https://c.example.com", "Gamma");
const urls = (list: WorkspaceEntry[]) => list.map((e) => hostLabel(e.serverUrl)[0]);

describe("the order logic", () => {
  it("moves an entry to an index, clamped, and returns the same array when nothing moves", () => {
    const list = [A, B, C];
    expect(urls(moveWorkspace(list, C.serverUrl, 0))).toEqual(["c", "a", "b"]);
    expect(urls(moveWorkspace(list, A.serverUrl, 2))).toEqual(["b", "c", "a"]);
    expect(urls(moveWorkspace(list, A.serverUrl, 99))).toEqual(["b", "c", "a"]);
    expect(urls(moveWorkspace(list, C.serverUrl, -5))).toEqual(["c", "a", "b"]);
    expect(moveWorkspace(list, B.serverUrl, 1)).toBe(list);
    expect(moveWorkspace(list, "https://unknown.example.com", 0)).toBe(list);
    expect(urls(list)).toEqual(["a", "b", "c"]); // not changed in place
  });

  it("turns a drop slot into the index the dragged tile ends at", () => {
    // Slots: 0 above A, 1 between A and B, 2 between B and C, 3 below C.
    expect(dropIndex(0, 3)).toBe(2); // A to the end
    expect(dropIndex(0, 2)).toBe(1); // A between B and C
    expect(dropIndex(2, 0)).toBe(0); // C to the top
    expect(dropIndex(1, 1)).toBe(1); // B just above itself: no move
    expect(dropIndex(1, 2)).toBe(1); // B just below itself: no move
  });

  it("finds the slot under the pointer from the tiles' middles", () => {
    const mids = [20, 72, 124];
    expect(gapForPointer(0, mids)).toBe(0);
    expect(gapForPointer(50, mids)).toBe(1);
    expect(gapForPointer(100, mids)).toBe(2);
    expect(gapForPointer(500, mids)).toBe(3);
  });
});

describe("persistence", () => {
  it("saves the new order, which the next start reads (and ⌘1 … ⌘9 follow)", () => {
    saveWorkspaces([A, B, C], B.serverUrl);
    const controller = new AppController();
    controller.workspaces = loadWorkspaces().entries;
    controller.activeServer = B.serverUrl;
    const listener = vi.fn();
    controller.subscribe(listener);
    controller.moveWorkspace(C.serverUrl, 0);
    expect(urls(controller.workspaces)).toEqual(["c", "a", "b"]);
    expect(listener).toHaveBeenCalled();
    const reloaded = loadWorkspaces();
    expect(urls(reloaded.entries)).toEqual(["c", "a", "b"]);
    expect(reloaded.active).toBe(B.serverUrl); // the open workspace stays open
    // No move, no save.
    listener.mockClear();
    controller.moveWorkspace(C.serverUrl, 0);
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps each entry's icon version across a save", () => {
    saveWorkspaces([{ ...A, iconVersion: "v1" }, B], A.serverUrl);
    expect(loadWorkspaces().entries.map((e) => e.iconVersion ?? null)).toEqual(["v1", null]);
  });
});

/** A controller with just what the rail reads; `moveWorkspace` really reorders. */
function railController(list: WorkspaceEntry[]) {
  const controller = {
    workspaces: list,
    activeServer: list[0]!.serverUrl,
    addingWorkspace: false,
    isSignedIn: () => true,
    workspaceUnread: () => ({ badge: 0, unread: false }),
    switchWorkspace: vi.fn(async () => {}),
    beginAddWorkspace: vi.fn(),
    signOutWorkspace: vi.fn(async () => {}),
    moveWorkspace: vi.fn((serverUrl: string, to: number) => {
      controller.workspaces = moveWorkspace(controller.workspaces, serverUrl, to);
    }),
  };
  return controller;
}

function renderRail(controller: ReturnType<typeof railController>) {
  const view = render(<WorkspaceRail controller={controller as unknown as AppController} />);
  const rerender = () => view.rerender(<WorkspaceRail controller={controller as unknown as AppController} />);
  return { ...view, rerender };
}

const tileNames = () => within(screen.getByRole("navigation", { name: "ワークスペース" })).getAllByRole("button").map((b) => b.getAttribute("aria-label"));

const rail = () => screen.getByRole("navigation", { name: "ワークスペース" });
/** Each tile's slot, in the order drawn. */
const slots = () => [...document.querySelectorAll<HTMLElement>("[data-workspace]")];
/** How far each tile is drawn from its slot while a drag is under way (px). */
const offsets = () => slots().map((node) => Number(/translateY\((-?\d+(?:\.\d+)?)px\)/.exec(node.style.transform)?.[1] ?? 0));

/** jsdom lays nothing out: each tile is 40 px high with 12 px between them, from y = 0. */
function layOut(): void {
  for (const [index, node] of [...document.querySelectorAll<HTMLElement>("[data-workspace]")].entries()) {
    node.getBoundingClientRect = () => ({ top: index * 52, height: 40, bottom: index * 52 + 40, left: 0, right: 68, width: 68, x: 0, y: index * 52, toJSON: () => ({}) });
  }
}

describe("the rail", () => {
  it("lifts the tile, slides the others apart to open the drop gap, and the click that ends the drag does not switch", () => {
    vi.useFakeTimers();
    try {
      const controller = railController([A, B, C]);
      const view = renderRail(controller);
      layOut();
      const alpha = screen.getByRole("button", { name: "Alpha" });
      fireEvent.pointerDown(alpha, { pointerId: 1, button: 0, clientY: 20 });
      fireEvent.pointerMove(alpha, { pointerId: 1, clientY: 22 }); // under the threshold: still a click
      expect(screen.queryByTestId("workspace-drag-ghost")).toBeNull();
      expect(rail().dataset["dropGap"]).toBeUndefined();
      expect(document.body.classList.contains("workspace-dragging")).toBe(false);

      fireEvent.pointerMove(alpha, { pointerId: 1, clientY: 60 }); // the lifted tile's middle above Beta's: slot 1
      const ghost = screen.getByTestId("workspace-drag-ghost");
      expect(ghost.style.top).toBe("40px"); // follows the pointer, keeping the grip (pressed 20 px into the tile)
      expect(ghost.className).toContain("scale-110");
      expect(rail().dataset["dropGap"]).toBe("1");
      expect(offsets()).toEqual([0, 0, 0]); // slot 1 is right below Alpha itself: nothing moves
      expect(document.body.classList.contains("workspace-dragging")).toBe(true); // the grabbing hand
      // Alpha's own place shows as a dimmed empty slot.
      expect(screen.getByTestId("workspace-drop-gap").closest("[data-workspace]")?.getAttribute("data-workspace")).toBe(A.serverUrl);
      expect(alpha.className).toContain("opacity-0");

      fireEvent.pointerMove(alpha, { pointerId: 1, clientY: 100 }); // past Beta's middle: slot 2
      expect(rail().dataset["dropGap"]).toBe("2");
      expect(offsets()).toEqual([52, -52, 0]); // Beta slides up, the gap opens where Beta was
      expect(slots()[0]!.style.transition).toBe("transform 120ms ease");

      fireEvent.pointerMove(alpha, { pointerId: 1, clientY: 400 }); // far below: kept half a slot under Gamma
      expect(screen.getByTestId("workspace-drag-ghost").style.top).toBe("130px");
      expect(rail().dataset["dropGap"]).toBe("3");
      expect(offsets()).toEqual([104, -52, -52]);

      fireEvent.pointerUp(alpha, { pointerId: 1, clientY: 400 });
      fireEvent.click(alpha);
      expect(controller.moveWorkspace).toHaveBeenCalledWith(A.serverUrl, 2);
      expect(controller.switchWorkspace).not.toHaveBeenCalled();
      view.rerender();
      expect(tileNames()).toEqual(["Beta", "Gamma", "Alpha", "ワークスペースを追加"]);
      expect(screen.getByRole("status").textContent).toBe("Alpha を 3 番目に移動しました");
      // The lifted copy glides into its new slot; the tiles, already in their new order, do not animate.
      expect(screen.getByTestId("workspace-drag-ghost").style.top).toBe("104px");
      expect(screen.getByTestId("workspace-drag-ghost").className).toContain("scale-100");
      expect(offsets()).toEqual([0, 0, 0]);
      for (const slot of slots()) expect(slot.style.transition).toBe("");
      expect(document.body.classList.contains("workspace-dragging")).toBe(false);
      act(() => vi.advanceTimersByTime(200));
      expect(screen.queryByTestId("workspace-drag-ghost")).toBeNull();
      expect(screen.queryByTestId("workspace-drop-gap")).toBeNull();
      // A plain click still switches.
      fireEvent.click(screen.getByRole("button", { name: "Gamma" }));
      expect(controller.switchWorkspace).toHaveBeenCalledWith(C.serverUrl);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a tile above the first one", () => {
    const controller = railController([A, B, C]);
    renderRail(controller);
    layOut();
    const gamma = screen.getByRole("button", { name: "Gamma" });
    fireEvent.pointerDown(gamma, { pointerId: 7, button: 0, clientY: 124 });
    fireEvent.pointerMove(gamma, { pointerId: 7, clientY: 5 });
    expect(rail().dataset["dropGap"]).toBe("0");
    expect(offsets()).toEqual([52, 52, -104]); // Alpha and Beta slide down; Gamma's empty slot takes the top
    fireEvent.pointerUp(gamma, { pointerId: 7, clientY: 5 });
    expect(controller.moveWorkspace).toHaveBeenCalledWith(C.serverUrl, 0);
  });

  it("a press without a drag is a click, and a click after a drag that never fired its own click still switches", () => {
    const controller = railController([A, B, C]);
    renderRail(controller);
    layOut();
    const beta = screen.getByRole("button", { name: "Beta" });
    fireEvent.pointerDown(beta, { pointerId: 1, button: 0, clientY: 72 });
    fireEvent.pointerUp(beta, { pointerId: 1, clientY: 73 });
    fireEvent.click(beta);
    expect(controller.switchWorkspace).toHaveBeenCalledWith(B.serverUrl);
    // A drag whose ending click got lost (the tile moved under the pointer): the next press starts afresh.
    fireEvent.pointerDown(beta, { pointerId: 2, button: 0, clientY: 72 });
    fireEvent.pointerMove(beta, { pointerId: 2, clientY: 90 });
    fireEvent.pointerUp(beta, { pointerId: 2, clientY: 90 });
    const gamma = screen.getByRole("button", { name: "Gamma" });
    fireEvent.pointerDown(gamma, { pointerId: 3, button: 0, clientY: 124 });
    fireEvent.pointerUp(gamma, { pointerId: 3, clientY: 124 });
    fireEvent.click(gamma);
    expect(controller.switchWorkspace).toHaveBeenLastCalledWith(C.serverUrl);
  });

  it("cancels a drag with Esc: the order stays and everything slides back", () => {
    vi.useFakeTimers();
    try {
      const controller = railController([A, B, C]);
      renderRail(controller);
      layOut();
      const alpha = screen.getByRole("button", { name: "Alpha" });
      fireEvent.pointerDown(alpha, { pointerId: 1, button: 0, clientY: 20 });
      fireEvent.pointerMove(alpha, { pointerId: 1, clientY: 140 });
      expect(offsets()).toEqual([104, -52, -52]);
      fireEvent.keyDown(document.body, { key: "Escape" }); // from anywhere, not only the focused tile
      expect(rail().dataset["dropGap"]).toBeUndefined();
      expect(offsets()).toEqual([0, 0, 0]);
      expect(slots()[1]!.style.transition).toBe("transform 120ms ease"); // they animate back
      expect(screen.getByTestId("workspace-drag-ghost").style.top).toBe("0px"); // back to Alpha's slot
      fireEvent.pointerMove(alpha, { pointerId: 1, clientY: 100 }); // the cancelled drag no longer moves anything
      expect(offsets()).toEqual([0, 0, 0]);
      fireEvent.pointerUp(alpha, { pointerId: 1, clientY: 100 });
      expect(controller.moveWorkspace).not.toHaveBeenCalled();
      act(() => vi.advanceTimersByTime(200));
      expect(screen.queryByTestId("workspace-drag-ghost")).toBeNull();
      expect(tileNames().slice(0, 3)).toEqual(["Alpha", "Beta", "Gamma"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("with reduced motion: nothing slides, but the gap opens and the tile is lifted; drop and Esc end at once", () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query === "(prefers-reduced-motion: reduce)", media: query, addEventListener: () => {}, removeEventListener: () => {} }));
    vi.stubGlobal("matchMedia", matchMedia);
    try {
      const controller = railController([A, B, C]);
      const view = renderRail(controller);
      layOut();
      const alpha = screen.getByRole("button", { name: "Alpha" });
      fireEvent.pointerDown(alpha, { pointerId: 1, button: 0, clientY: 20 });
      fireEvent.pointerMove(alpha, { pointerId: 1, clientY: 140 });
      expect(offsets()).toEqual([104, -52, -52]);
      for (const slot of slots()) expect(slot.style.transition).toBe("");
      const ghost = screen.getByTestId("workspace-drag-ghost");
      expect(ghost.className).toContain("scale-110");
      expect(ghost.style.transition).toBe("none");
      fireEvent.keyDown(document.body, { key: "Escape" });
      expect(screen.queryByTestId("workspace-drag-ghost")).toBeNull();
      expect(offsets()).toEqual([0, 0, 0]);
      fireEvent.pointerUp(alpha, { pointerId: 1, clientY: 140 });
      expect(controller.moveWorkspace).not.toHaveBeenCalled();

      fireEvent.pointerDown(alpha, { pointerId: 2, button: 0, clientY: 20 });
      fireEvent.pointerMove(alpha, { pointerId: 2, clientY: 100 });
      fireEvent.pointerUp(alpha, { pointerId: 2, clientY: 100 });
      fireEvent.click(alpha);
      view.rerender();
      expect(screen.queryByTestId("workspace-drag-ghost")).toBeNull();
      expect(tileNames().slice(0, 3)).toEqual(["Beta", "Alpha", "Gamma"]);
      expect(controller.switchWorkspace).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("moves the focused tile with Alt+↑/↓ and keeps the focus on it", async () => {
    const controller = railController([A, B, C]);
    const view = renderRail(controller);
    const beta = screen.getByRole("button", { name: "Beta" });
    expect(beta.getAttribute("aria-keyshortcuts")).toBe("Alt+ArrowUp Alt+ArrowDown");
    beta.focus();
    await act(async () => {
      fireEvent.keyDown(beta, { key: "ArrowUp", altKey: true });
    });
    expect(controller.moveWorkspace).toHaveBeenLastCalledWith(B.serverUrl, 0);
    view.rerender();
    expect(tileNames().slice(0, 3)).toEqual(["Beta", "Alpha", "Gamma"]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Beta");
    // At the top already: nothing to do. Without Alt the arrows are left alone.
    fireEvent.keyDown(screen.getByRole("button", { name: "Beta" }), { key: "ArrowUp", altKey: true });
    fireEvent.keyDown(screen.getByRole("button", { name: "Beta" }), { key: "ArrowDown" });
    expect(controller.moveWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does not offer reordering with a single workspace", () => {
    const controller = railController([A]);
    renderRail(controller);
    const alpha = screen.getByRole("button", { name: "Alpha" });
    expect(alpha.getAttribute("aria-keyshortcuts")).toBeNull();
    fireEvent.pointerDown(alpha, { pointerId: 1, button: 0, clientY: 20 });
    fireEvent.pointerMove(alpha, { pointerId: 1, clientY: 200 });
    expect(screen.queryByTestId("workspace-drop-indicator")).toBeNull();
  });
});
