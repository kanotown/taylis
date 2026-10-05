import { act, fireEvent, screen } from "@testing-library/react";

/**
 * What a HoverList trigger shows (the names over a reaction chip, a poll option, the thread line …): focus opens it at
 * once (the pointer waits for the delay), and the tooltip's text is read; blurred again after. Null when it has none.
 */
export function hoverListText(trigger: HTMLElement): string | null {
  open(trigger);
  const text = screen.queryByRole("tooltip")?.textContent ?? null;
  act(() => { fireEvent.blur(trigger); });
  return text;
}

/** The open hover list's content element (side, offset and the rest are its attributes). */
export function openHoverList(trigger: HTMLElement): HTMLElement | null {
  open(trigger);
  return document.querySelector<HTMLElement>("[data-hover-list]");
}

function open(trigger: HTMLElement): void {
  // The popper measures its arrow; jsdom has no ResizeObserver.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  act(() => { fireEvent.focus(trigger); });
}
