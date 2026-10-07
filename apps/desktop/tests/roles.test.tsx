// @vitest-environment jsdom
/**
 * M142 (docs/ROLES.md): 「運営」 (manager). The administration screens are gated by `me.capabilities`, not by the role
 * name: a manager sees the day-to-day tabs and, in 「ユーザー」, only 「表示名・肩書きを変更」 for members and guests;
 * an invite of theirs offers member and guest only.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminUserOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { AdminBody } from "../src/ui/AdminDialog";
import { InvitesTab } from "../src/ui/InvitesTab";
import { ADMIN_TABS, adminTabAllowed, assignableRoles, canAdminister, type Capability, canManageChannelByRight, capabilitiesOf, hasCapability, roleLabelKey } from "../src/ui/roles";

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** What the server sends a manager (app/core/roles.py MANAGER_CAPABILITIES). */
const MANAGER = ["attendance.manage", "channels.manage", "emoji.manage", "invites.manage", "reports.manage", "reservations.manage", "roster.manage", "templates.manage", "users.edit_profile", "users.view"];

const me = (role: string, capabilities?: string[]) => ({ role, capabilities });

describe("the capability rules", () => {
  it("reads the server's list; a server before M142 (no list) gives an admin everything and anyone else nothing", () => {
    expect(hasCapability(me("manager", MANAGER), "invites.manage")).toBe(true);
    expect(hasCapability(me("manager", MANAGER), "users.manage")).toBe(false);
    expect(hasCapability(me("admin"), "users.manage")).toBe(true);
    expect(hasCapability(me("admin"), "docs.admin")).toBe(true);
    expect(hasCapability(me("manager"), "invites.manage")).toBe(false);
    expect(hasCapability(me("member", []), "users.view")).toBe(false);
    expect(capabilitiesOf(null).size).toBe(0);
    // A role this build does not know is gated by its list alone.
    expect(hasCapability(me("steward", ["reports.manage"]), "reports.manage")).toBe(true);
  });

  it("opens the tabs a manager's capabilities reach, and none for a member", () => {
    const manager = (capability: Capability) => MANAGER.includes(capability);
    expect(ADMIN_TABS.filter((tab) => adminTabAllowed(tab, manager))).toEqual(["users", "reports", "roster", "invites", "attendance", "workspace", "channels", "emoji", "canvas-templates"]);
    expect(ADMIN_TABS.filter((tab) => adminTabAllowed(tab, () => true))).toEqual(ADMIN_TABS);
    expect(canAdminister(manager)).toBe(true);
    expect(canAdminister(() => false)).toBe(false);
  });

  it("lets managers give member and guest only", () => {
    expect(assignableRoles((c) => MANAGER.includes(c))).toEqual(["member", "guest"]);
    expect(assignableRoles(() => true)).toEqual(["member", "manager", "admin", "guest"]);
  });

  it("manages public channels and joined private ones; others' private ones only with channels.manage_any; never a DM", () => {
    const manager = (c: Capability) => MANAGER.includes(c);
    expect(canManageChannelByRight({ type: "public", isMember: false }, manager)).toBe(true);
    expect(canManageChannelByRight({ type: "private", isMember: true }, manager)).toBe(true);
    expect(canManageChannelByRight({ type: "private", isMember: false }, manager)).toBe(false);
    expect(canManageChannelByRight({ type: "private", isMember: false }, () => true)).toBe(true);
    expect(canManageChannelByRight({ type: "dm", isMember: true }, () => true)).toBe(false);
    expect(canManageChannelByRight({ type: "public", isMember: true }, () => false)).toBe(false);
  });

  it("labels the roles", () => {
    expect(roleLabelKey("manager")).toBe("admin.users.role.manager");
    expect(roleLabelKey("member")).toBeNull();
    expect(roleLabelKey("someday")).toBeNull();
  });
});

function adminUser(id: string, username: string, role: string, extra: Partial<AdminUserOut> = {}): AdminUserOut {
  return {
    id, username, display_name: username.toUpperCase(), email: null, role, must_change_password: false, totp_enabled: false,
    deactivated_at: null, created_at: "2026-04-01T00:00:00Z", updated_at: "2026-04-01T00:00:00Z", ...extra,
  };
}

function managerController(api: Record<string, unknown>) {
  const store = new Store();
  store.setMe({ id: "u-mgr", username: "mgr", display_name: "MGR", role: "manager", capabilities: MANAGER, created_at: "", updated_at: "", deactivated_at: null } as never);
  const proxy = new Proxy(api, { get: (t, key: string) => t[key] ?? (async () => []) });
  const controller = {
    store, api: proxy, engine: { ai: { loadStatus: async () => {} } }, isAdmin: false, version: 0, subscribe: () => () => {}, setError: vi.fn(), setNotice: vi.fn(),
    can: (capability: Capability) => hasCapability(store.me, capability),
  } as unknown as AppController;
  return { store, controller };
}

describe("管理 as a manager", () => {
  it("shows only the tabs a manager can use", async () => {
    const { controller } = managerController({ adminListUsers: async () => [] });
    render(<AdminBody controller={controller} />);
    await settle();
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["ユーザー", "報告", "名簿", "招待", "在室状況", "設定", "チャンネル", "絵文字", "キャンバス"]);
    for (const hidden of ["アナリティクス", "グループ", "Webhook", "ワークフロー", "AI", "ドキュメント"]) expect(tabs).not.toContain(hidden);
  });

  it("「ユーザー」: no account creation; 「表示名・肩書きを変更」 for members and guests only", async () => {
    const calls: Array<[string, unknown]> = [];
    const people = [
      adminUser("u-adm", "boss", "admin"),
      adminUser("u-mgr", "mgr", "manager"),
      adminUser("u-other", "peer", "manager"),
      adminUser("u-bob", "bob", "member"),
      adminUser("u-guest", "visitor", "guest"),
      adminUser("u-bot", "ci", "bot"),
    ];
    const { controller } = managerController({
      adminListUsers: async () => people,
      adminUpdateUser: async (id: string, patch: unknown) => { calls.push([id, patch]); return people.find((u) => u.id === id); },
    });
    render(<AdminBody controller={controller} />);
    await settle();
    expect(screen.queryByRole("button", { name: /ユーザーを作成/ })).toBeNull();
    const list = screen.getByRole("list", { name: "ユーザー" });
    const row = (username: string) => list.querySelector<HTMLElement>(`li[data-user="${username}"]`)!;
    // The manager badge.
    expect(within(row("peer")).getByText("運営")).toBeTruthy();
    // No menu for administrators, other managers, bots or me.
    for (const username of ["boss", "peer", "ci", "mgr"]) expect(within(row(username)).queryByRole("button", { name: /の操作$/ })).toBeNull();
    for (const username of ["bob", "visitor"]) {
      fireEvent.keyDown(within(row(username)).getByRole("button", { name: /の操作$/ }), { key: "Enter" });
      const menu = screen.getByRole("menu");
      expect([...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent?.trim())).toEqual(["表示名・肩書きを変更…"]);
      fireEvent.keyDown(menu, { key: "Escape" });
      await settle();
    }
    fireEvent.keyDown(within(row("bob")).getByRole("button", { name: /の操作$/ }), { key: "Enter" });
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "表示名・肩書きを変更…" }));
    const dialog = await screen.findByRole("dialog", { name: "BOB の表示名・肩書き" });
    fireEvent.change(within(dialog).getByLabelText("表示名"), { target: { value: " 山田 太郎 " } });
    fireEvent.change(within(dialog).getByLabelText("肩書（任意）"), { target: { value: "M2" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "保存" }));
    await settle();
    expect(calls).toEqual([["u-bob", { display_name: "山田 太郎", title: "M2" }]]);
  });

  it("「招待」 offers member and guest only", async () => {
    const { controller } = managerController({ adminListInvites: async () => [] });
    render(<InvitesTab controller={controller} />);
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /招待リンクを作成|リンクを作成|作成/ }));
    const select = screen.getByLabelText("ロール") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["member", "guest"]);
  });
});
