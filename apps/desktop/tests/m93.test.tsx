// @vitest-environment jsdom
/**
 * M93: my profile card from the sidebar header, the lab title hint, the admin tab row that scrolls only sideways, the
 * full-screen inset on the rail, and the workspace icon (admin upload, the tiles, the controller following changes).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminWorkspaceSettingsOut, UserMe } from "../src/api/types";
import { RAIL_WIDTH, TITLE_ROW_INSET_AFTER_RAIL, TRAFFIC_LIGHTS_INSET } from "../src/platform/env";
import { resetWindowState, watchFullscreen } from "../src/platform/windowState";
import { AppController } from "../src/state/app";
import { loadWorkspaces, saveWorkspaces, type WorkspaceEntry } from "../src/state/workspaces";
import { Store } from "../src/sync/store";
import { AdminBody } from "../src/ui/AdminDialog";
import { UNDERLINE_TAB, UNDERLINE_TAB_ROW } from "../src/ui/primitives";
import { SettingsSectionBody } from "../src/ui/Settings";
import { Sidebar } from "../src/ui/Sidebar";
import { configureWorkspaceIcons, WorkspaceIcon } from "../src/ui/workspaceIcons";
import { WorkspaceRail } from "../src/ui/WorkspaceRail";
import { WorkspaceSettingsTab } from "../src/ui/WorkspaceSettingsTab";
import { FakeServer } from "./fakeServer";

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

let objectUrls = 0;
beforeEach(() => {
  objectUrls = 0;
  URL.createObjectURL = vi.fn(() => `blob:icon-${++objectUrls}`);
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  configureWorkspaceIcons(null);
  resetWindowState();
  vi.restoreAllMocks();
});

function signedIn() {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const store = new Store();
  store.setMe({ ...me, title: "M2" } as unknown as UserMe);
  store.upsertUser({ ...me, title: "M2", status_text: "論文執筆中", status_emoji: "📝" } as never);
  return { me, store };
}

describe("my profile from my avatar (sidebar header)", () => {
  it("is a button that opens my own card with my status and title, and 「プロフィールを編集」", async () => {
    const { me, store } = signedIn();
    const controller = { store, engine: null, me, isGuest: false, isAdmin: false, version: 0, subscribe: () => () => {} } as unknown as AppController;
    render(<Sidebar controller={controller} channels={[]} currentId={null} unreadOnly={false} onToggleUnreadOnly={() => {}} onOpen={() => {}} onNewDm={() => {}} onNewChannel={() => {}} />);
    const header = screen.getByTestId("sidebar-header");
    const trigger = within(header).getByRole("button", { name: `自分のプロフィール（${me.display_name}）` });
    expect(trigger.tagName).toBe("BUTTON");
    fireEvent.click(trigger);
    const card = await screen.findByRole("dialog");
    expect(within(card).getByText(/· M2/)).toBeTruthy();
    expect(within(card).getByText(/論文執筆中/)).toBeTruthy();
    expect(within(card).getByRole("button", { name: /ステータスを設定/ })).toBeTruthy();
    const opened = vi.fn();
    window.addEventListener("chikuwa:open-profile", opened);
    fireEvent.click(within(card).getByRole("button", { name: /プロフィールを編集/ }));
    window.removeEventListener("chikuwa:open-profile", opened);
    expect(opened).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull(); // the card closes
  });
});

describe("the title hint", () => {
  it("suggests titles beyond the roster in 「プロフィールを編集」 (the roster's grade and rank show by themselves)", () => {
    const { me, store } = signedIn();
    const controller = { store, me, isAdmin: false, workspaces: [], activeServer: null } as unknown as AppController;
    render(<SettingsSectionBody controller={controller} section="profile" />);
    expect(screen.getByPlaceholderText("例：研究室長 / TA / 秘書（名簿の学年・職位は自動で表示されます）")).toBeTruthy();
  });
});

describe("the admin tab row", () => {
  it("scrolls sideways only, and the selected tab's underline is drawn inside the row", async () => {
    expect(UNDERLINE_TAB_ROW).toContain("overflow-x-auto");
    expect(UNDERLINE_TAB_ROW).toContain("overflow-y-hidden");
    expect(UNDERLINE_TAB).not.toContain("-mb-px");
    const store = new Store();
    const api = new Proxy({}, { get: () => async () => [] });
    const controller = { store, api, engine: null, isAdmin: true, version: 0, subscribe: () => () => {}, setError: vi.fn(), setNotice: vi.fn() } as unknown as AppController;
    render(<AdminBody controller={controller} />);
    await settle();
    const row = screen.getByRole("tablist", { name: "管理" });
    expect(row.className).toContain("overflow-y-hidden");
    expect(row.className).not.toContain("border-b");
    for (const tab of within(row).getAllByRole("tab")) expect(tab.className).not.toContain("-mb-px");
    expect(within(row).getByRole("tab", { selected: true }).className).toContain("border-accent");
  });
});

/** The rail as the macOS app draws it (overlay title bar). */
function macApp(): () => void {
  const internals = window as unknown as Record<string, unknown>;
  internals["__TAURI_INTERNALS__"] = {};
  const platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  return () => {
    delete internals["__TAURI_INTERNALS__"];
    platform.mockRestore();
  };
}

function railController(list: WorkspaceEntry[]) {
  return {
    workspaces: list,
    activeServer: list[0]!.serverUrl,
    addingWorkspace: false,
    isSignedIn: () => true,
    workspaceUnread: () => ({ badge: 0, unread: false }),
    switchWorkspace: vi.fn(async () => {}),
    beginAddWorkspace: vi.fn(),
    moveWorkspace: vi.fn(),
  } as unknown as AppController;
}

const A: WorkspaceEntry = { serverUrl: "https://a.example.com", workspaceId: "wa", name: "Alpha", username: "alice", userId: null };
const B: WorkspaceEntry = { serverUrl: "https://b.example.com", workspaceId: "wb", name: "研究室", username: "alice", userId: null, iconVersion: "v1" };

describe("the rail under the macOS window buttons", () => {
  it("stays 68 px and starts below the title row that holds them in a window (and when zoomed), not in full screen", async () => {
    const restore = macApp();
    try {
      let full = false;
      let resized: (() => void) | null = null;
      await watchFullscreen(async () => ({ isFullscreen: async () => full, onResized: async (handler) => { resized = handler; return () => {}; } }));
      render(<WorkspaceRail controller={{ ...railController([A, B]), screen: "main" } as AppController} />);
      const rail = screen.getByRole("navigation", { name: "ワークスペース" });
      // Slack: the window buttons sit in the title row across the window; the rail is not widened for them.
      expect(rail.className).toContain("w-[68px]");
      expect(rail.style.width).toBe("");
      const cell = screen.getByTestId("rail-title-cell");
      expect(cell.style.height).toBe("max(40px, calc(40px / var(--ui-zoom, 1)))"); // the top bar's height (points at least)
      expect(cell.className).toContain("bg-sidebar"); // one row with the top bar on the main screen
      expect(cell.className).not.toContain("border-r");
      expect(screen.getByTestId("rail-tiles").style.paddingTop).toBe("");
      full = true;
      await act(async () => {
        resized?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.queryByTestId("rail-title-cell")).toBeNull(); // full screen: no buttons, the tiles go up
      full = false;
      await act(async () => {
        resized?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(screen.getByTestId("rail-title-cell")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("gives the cell over the rail the rail's colour on screens without the top bar", () => {
    const restore = macApp();
    try {
      render(<WorkspaceRail controller={{ ...railController([A, B]), screen: "login" } as AppController} />);
      expect(screen.getByTestId("rail-title-cell").className).toContain("bg-sidebar-rail");
    } finally {
      restore();
    }
  });

  it("reserves nothing outside the macOS app (Windows keeps its own title bar)", () => {
    render(<WorkspaceRail controller={railController([A, B])} />);
    expect(screen.queryByTestId("rail-title-cell")).toBeNull();
    expect(screen.getByRole("navigation", { name: "ワークスペース" }).className).toContain("w-[68px]");
  });
});

describe("the title row's inset after the rail", () => {
  it("keeps what the rail leaves of the 84 points for the window buttons, and at least 8 px", () => {
    expect(TITLE_ROW_INSET_AFTER_RAIL).toBe("max(8px, calc(84px / var(--ui-zoom, 1) - 68px))");
    // 80 %: 105 - 68 = 37 px; 100 %: 16 px; 125 % and up: the rail alone (85 points and more) clears them -> 8 px.
    const inset = (zoom: number) => Math.max(8, TRAFFIC_LIGHTS_INSET / zoom - RAIL_WIDTH);
    expect(inset(0.8)).toBeCloseTo(37);
    expect(inset(1)).toBe(16);
    expect(inset(1.25)).toBe(8);
    for (const zoom of [0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]) expect((RAIL_WIDTH + inset(zoom)) * zoom).toBeGreaterThanOrEqual(TRAFFIC_LIGHTS_INSET - 1e-9);
  });
});

describe("the workspace icon", () => {
  it("shows the admin's icon on a tile, else the letter on its colour", async () => {
    const fetch = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
    configureWorkspaceIcons(fetch);
    render(<WorkspaceRail controller={railController([A, B])} />);
    expect(screen.getByRole("button", { name: "Alpha" }).textContent).toContain("A");
    await waitFor(() => expect(within(screen.getByRole("button", { name: "研究室" })).getByTestId("workspace-icon")).toBeTruthy());
    expect(fetch).toHaveBeenCalledWith(B.serverUrl, "v1");
    expect(within(screen.getByRole("button", { name: "Alpha" })).queryByTestId("workspace-icon")).toBeNull();
  });

  it("falls back to the letter when the picture cannot be fetched, and asks once per version", async () => {
    const fetch = vi.fn(async () => { throw new Error("offline"); });
    configureWorkspaceIcons(fetch);
    const view = render(<WorkspaceIcon serverUrl={B.serverUrl} version="v1" name="研究室" colorKey="wb" className="h-10 w-10" />);
    await settle();
    view.rerender(<WorkspaceIcon serverUrl={B.serverUrl} version="v1" name="研究室" colorKey="wb" className="h-10 w-10" />);
    expect(screen.queryByTestId("workspace-icon")).toBeNull();
    expect(view.container.textContent).toBe("研");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("is uploaded and removed in 管理 → 設定", async () => {
    configureWorkspaceIcons(async () => new Blob(["png"], { type: "image/png" }));
    const base: AdminWorkspaceSettingsOut = { show_membership_messages: true, preview_before_join: true, icon_version: null, updated_at: null, updated_by: null, default_channel_ids: [], default_channels: [], default_channels_set: true, legacy_sso_default_channels: [] };
    const api = {
      adminWorkspaceSettings: vi.fn(async () => base),
      adminUploadWorkspaceIcon: vi.fn(async () => ({ ...base, icon_version: "v2" })),
      adminDeleteWorkspaceIcon: vi.fn(async () => ({ ...base, icon_version: null })),
      channels: vi.fn(async () => []),
    };
    const store = new Store();
    const controller = { api, store, setError: vi.fn(), activeEntry: A, workspaceName: "Alpha", serverUrl: A.serverUrl } as unknown as AppController;
    render(<WorkspaceSettingsTab controller={controller} />);
    const section = await screen.findByTestId("workspace-icon-section");
    expect(within(section).queryByRole("button", { name: /削除/ })).toBeNull();
    const file = new File(["png"], "logo.png", { type: "image/png" });
    const input = within(section).getByLabelText("アイコンの画像を選ぶ") as HTMLInputElement;
    expect(input.accept).toBe("image/png,image/jpeg,image/webp");
    await act(async () => { fireEvent.change(input, { target: { files: [file] } }); });
    expect(api.adminUploadWorkspaceIcon).toHaveBeenCalledWith(file, "logo.png");
    expect(store.workspaceSettings.icon_version).toBe("v2"); // this device follows at once
    await waitFor(() => expect(within(section).getByTestId("workspace-icon")).toBeTruthy());
    await act(async () => { fireEvent.click(within(section).getByRole("button", { name: /削除/ })); });
    expect(api.adminDeleteWorkspaceIcon).toHaveBeenCalled();
    expect(store.workspaceSettings.icon_version).toBeNull();
    expect(within(section).queryByTestId("workspace-icon")).toBeNull();
  });

  it("is not offered by a server before M93", async () => {
    const base = { show_membership_messages: true, preview_before_join: true, updated_at: null, updated_by: null, default_channel_ids: [], default_channels: [], default_channels_set: true, legacy_sso_default_channels: [] } as AdminWorkspaceSettingsOut;
    const api = { adminWorkspaceSettings: vi.fn(async () => base), channels: vi.fn(async () => []) };
    render(<WorkspaceSettingsTab controller={{ api, store: new Store(), setError: vi.fn() } as unknown as AppController} />);
    await screen.findByText("参加・退出の表示");
    expect(screen.queryByTestId("workspace-icon-section")).toBeNull();
  });

  it("reaches the saved workspace when the server announces a new icon, and survives a restart", () => {
    saveWorkspaces([A, B], A.serverUrl);
    const controller = new AppController();
    controller.workspaces = loadWorkspaces().entries;
    controller.activeServer = A.serverUrl;
    const store = new Store();
    const session = { serverUrl: A.serverUrl };
    const follow = (controller as unknown as { followIcon: (s: unknown, st: Store) => void }).followIcon.bind(controller);
    follow(session, store); // bootstrap not in yet (or a server before M93): nothing changes
    expect(controller.workspaceIconVersion(A.serverUrl)).toBeNull();
    store.setWorkspaceSettings({ show_membership_messages: true, preview_before_join: true, icon_version: "v9" });
    follow(session, store);
    expect(controller.workspaceIconVersion(A.serverUrl)).toBe("v9");
    expect(loadWorkspaces().entries.find((e) => e.serverUrl === A.serverUrl)?.iconVersion).toBe("v9");
    store.setWorkspaceSettings({ show_membership_messages: true, preview_before_join: true, icon_version: null });
    follow(session, store);
    expect(controller.workspaceIconVersion(A.serverUrl)).toBeNull();
    expect(controller.workspaceIconVersion(B.serverUrl)).toBe("v1"); // the other workspace keeps its own
  });
});
