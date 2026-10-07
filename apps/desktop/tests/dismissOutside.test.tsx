// @vitest-environment jsdom
// 2026-10-08: the top bar's menus close on a press anywhere outside them, the title bar (a Tauri drag region) included,
// on the window's blur, on Esc and when the window moves.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppController } from "../src/state/app";
import { watchOutside } from "../src/ui/dismissOutside";
import { WorkspaceMenu } from "../src/ui/WorkspaceRail";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

/** The title bar as the desktop app has it, with Tauri's script: it takes a press on the bare region for a window
 * drag and stops the mousedown there (preventDefault + stopImmediatePropagation), on the document. */
function titleBar(): { bar: HTMLElement; remove: () => void } {
  const bar = document.createElement("div");
  bar.setAttribute("data-tauri-drag-region", "");
  document.body.append(bar);
  const tauri = (event: MouseEvent) => {
    if ((event.target as HTMLElement).hasAttribute("data-tauri-drag-region")) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  document.addEventListener("mousedown", tauri);
  return { bar, remove: () => document.removeEventListener("mousedown", tauri) };
}

describe("watchOutside", () => {
  const setup = (moves?: (handler: () => void) => Promise<() => void>) => {
    const menu = document.createElement("div");
    const item = document.createElement("button");
    menu.append(item);
    document.body.append(menu);
    const dismiss = vi.fn();
    const stop = watchOutside(window, (node) => menu.contains(node), dismiss, moves);
    return { menu, item, dismiss, stop };
  };

  it("a pointerdown, or a mousedown alone, on the title bar dismisses, though Tauri's script stops the mousedown", () => {
    const { bar, remove } = titleBar();
    const { dismiss, stop } = setup();
    fireEvent.pointerDown(bar, { button: 0 });
    expect(dismiss).toHaveBeenCalledTimes(1);
    // A WebView that lost the last mouseup to the window drag sends the next press without its pointerdown.
    fireEvent.mouseDown(bar, { button: 0 });
    expect(dismiss).toHaveBeenCalledTimes(2);
    stop();
    remove();
  });

  it("a press inside does not dismiss; anywhere else does", () => {
    const { item, dismiss, stop } = setup();
    fireEvent.pointerDown(item);
    fireEvent.mouseDown(item);
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(dismiss).toHaveBeenCalledTimes(1);
    stop();
  });

  it("the window's blur and Esc dismiss; focus moving between elements does not", () => {
    const { item, dismiss, stop } = setup();
    const field = document.createElement("input");
    document.body.append(field);
    item.focus();
    field.focus();
    expect(dismiss).not.toHaveBeenCalled();
    fireEvent.blur(window);
    expect(dismiss).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(item, { key: "Escape" });
    expect(dismiss).toHaveBeenCalledTimes(2);
    // Esc that ends an IME composition is the IME's.
    fireEvent.keyDown(item, { key: "Escape", isComposing: true });
    expect(dismiss).toHaveBeenCalledTimes(2);
    stop();
  });

  it("the window moving dismisses; nothing after stop", async () => {
    let moved: (() => void) | null = null;
    const unlisten = vi.fn();
    const { dismiss, stop } = setup(async (handler) => {
      moved = handler;
      return unlisten;
    });
    await Promise.resolve();
    moved!();
    expect(dismiss).toHaveBeenCalledTimes(1);
    stop();
    expect(unlisten).toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    fireEvent.blur(window);
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});

describe("the workspace menu", () => {
  const controller = {
    activeEntry: null,
    workspaceName: "研究室",
    showsRail: true,
    multiWorkspace: false,
    workspaces: [],
    logout: vi.fn(),
  } as unknown as AppController;

  it("closes on a press on the title bar, and on the window's blur", async () => {
    const { bar, remove } = titleBar();
    render(<WorkspaceMenu controller={controller} />);
    const trigger = screen.getByRole("button", { name: /研究室/ });
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findByRole("menu")).toBeTruthy();
    act(() => {
      fireEvent.mouseDown(bar, { button: 0 });
    });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findByRole("menu")).toBeTruthy();
    act(() => {
      fireEvent.blur(window);
    });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    remove();
  });
});
