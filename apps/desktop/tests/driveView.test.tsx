// @vitest-environment jsdom
/**
 * docs/DRIVE.md §27: the locations column gives its room to the listing once a location is chosen (remembered on this
 * device); the toolbar's button brings it back, and the root crumb's ▾ opens another location meanwhile.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { DriveLocationOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { DriveView, readLocationsHidden } from "../src/ui/DriveView";

const location = (id: string, kind: "workspace" | "user", name: string): DriveLocationOut => ({
  id, kind, channel_id: null, user_id: null, root_id: `${id}-root`, name, can_write: true, can_manage: false, can_share: false, external_links: true, quota_bytes: null, used_bytes: 0, item_count: 0,
});
const LAB = location("lab", "workspace", "研究室ドライブ");
const MINE = location("mine", "user", "マイドライブ");

function controller(): AppController {
  const children = vi.fn(async (id: string) => ({ folder: null, path: [{ id, name: "" }], items: [], next_cursor: null, shared_above: 0 }));
  return {
    api: { driveLocations: async () => ({ locations: [LAB, MINE] }), resolveDriveLocation: async () => MINE, driveChildren: children, searchDrive: vi.fn() },
    engine: null,
    accountKey: "test",
    isGuest: false,
    store: { users: new Map(), channels: new Map() },
    setError: vi.fn(),
    setNotice: vi.fn(),
  } as unknown as AppController;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("choosing a location puts the column away; the toggle and the root crumb's ▾ bring the others back", async () => {
  render(<DriveView controller={controller()} />);
  await waitFor(() => expect(document.querySelector('[data-drive-location="user"]')).toBeTruthy());
  const toggle = () => document.querySelector("[data-drive-locations-toggle]") as HTMLButtonElement;
  await waitFor(() => expect(toggle()).toBeTruthy());
  expect(toggle().getAttribute("aria-expanded")).toBe("true");

  fireEvent.click(document.querySelector('[data-drive-location="user"]')!);
  await waitFor(() => expect(document.querySelector("#drive-locations")).toBeNull());
  expect(readLocationsHidden()).toBe(true);
  expect(toggle().getAttribute("aria-expanded")).toBe("false");
  expect(toggle().getAttribute("aria-label")).toBe("場所の一覧を表示");
  await screen.findByText("このフォルダは空です");

  // The root crumb's ▾: the other location, without the column.
  const switcher = document.querySelector("[data-drive-switch-location]") as HTMLElement;
  fireEvent.pointerDown(switcher, { button: 0, pointerType: "mouse" });
  fireEvent.click(await screen.findByRole("menuitem", { name: /研究室ドライブ/ }));
  await waitFor(() => expect(document.querySelector('[data-drive-crumb="lab-root"]')).toBeTruthy());
  expect(document.querySelector("#drive-locations")).toBeNull();

  // The toggle shows it again, and that is remembered too.
  fireEvent.click(toggle());
  expect(document.querySelector("#drive-locations")).toBeTruthy();
  expect(readLocationsHidden()).toBe(false);
});
