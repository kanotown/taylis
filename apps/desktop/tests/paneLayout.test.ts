import { expect, it } from "vitest";
import { paneLayout } from "../src/ui/paneLayout";

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
