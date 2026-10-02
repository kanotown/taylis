import { expect, it } from "vitest";
import { CONVERSATION_MIN, HEADER_FULL_MIN, HEADER_TAB_MENU_MIN, headerFit, paneLayout } from "../src/ui/paneLayout";

it("replaces the centre when three usable columns do not fit", () => {
  expect(paneLayout(800, 260, 400, true)).toEqual({ sidebarWidth: 260, paneWidth: 0, replaceCentre: true });
  expect(paneLayout(800, 440, 760, true)).toEqual({ sidebarWidth: 440, paneWidth: 0, replaceCentre: true });
  expect(paneLayout(736, 440, 760, false)).toEqual({ sidebarWidth: 376, paneWidth: 0, replaceCentre: false });
});

it("clamps panes on window resizing and restores preferences when space returns", () => {
  expect(paneLayout(1000, 260, 760, true)).toEqual({ sidebarWidth: 260, paneWidth: 380, replaceCentre: false });
  expect(paneLayout(1400, 260, 760, true).paneWidth).toBe(760);
  expect(paneLayout(940, 260, 400, true).paneWidth).toBe(320);
  expect(paneLayout(939, 260, 400, true).replaceCentre).toBe(true);
});

it("the conversation header folds its tabs, then some buttons, as it narrows (2026-10-02)", () => {
  expect(headerFit(0)).toBe("full"); // not laid out yet
  expect(headerFit(900)).toBe("full");
  expect(headerFit(HEADER_FULL_MIN)).toBe("full");
  expect(headerFit(HEADER_FULL_MIN - 1)).toBe("tabMenu");
  expect(headerFit(HEADER_TAB_MENU_MIN)).toBe("tabMenu");
  expect(headerFit(HEADER_TAB_MENU_MIN - 1)).toBe("tight");
  expect(headerFit(CONVERSATION_MIN)).toBe("tight");
});
