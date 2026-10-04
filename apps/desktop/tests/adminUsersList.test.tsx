// @vitest-environment jsdom
/**
 * 管理 →「ユーザー」 (2026-10-04): the search, the filter chips with counts, the sort (remembered per device), the ⋯ menu
 * calling the same API as the old row buttons, and a row that keeps a long name readable.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AdminUserOut, LabProfileOut, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { AdminBody } from "../src/ui/AdminDialog";
import { matchesUserSearch, readUsersView, sortUsers, userFilterCounts, USERS_VIEW_KEY, visibleUsers, writeUsersView } from "../src/ui/adminUsers";

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function user(id: string, username: string, display_name: string, extra: Partial<AdminUserOut> = {}): AdminUserOut {
  return {
    id, username, display_name, email: null, role: "member", must_change_password: false, totp_enabled: false,
    deactivated_at: null, created_at: "2026-04-01T00:00:00Z", updated_at: "2026-04-01T00:00:00Z", ...extra,
  };
}

const LONG = "とても長い表示名の人とても長い表示名の人とても長い表示名の人とても長い";
const people = (): AdminUserOut[] => [
  user("u-admin", "admin", "管理 太郎", { role: "admin", created_at: "2026-01-01T00:00:00Z", email: "admin@example.jp" }),
  user("u-bob", "bob", "Bob", { created_at: "2026-05-01T00:00:00Z", email: "bob@lab.example.jp", totp_enabled: true }),
  user("u-carol", "carol", "Carol", { role: "guest", created_at: "2026-03-01T00:00:00Z" }),
  user("u-dave", "dave", "Dave", { must_change_password: true, created_at: "2026-09-01T00:00:00Z" }),
  user("u-eve", "eve", "Eve", { deactivated_at: "2026-09-02T00:00:00Z", created_at: "2026-02-01T00:00:00Z" }),
  user("u-bot", "ci-bot", "CI", { role: "bot", created_at: "2026-06-01T00:00:00Z" }),
  user("u-long", "a-very-long-username-for-testing", LONG, { email: "someone.with.a.very.long.address@graduate-school.example.ac.jp" }),
];

describe("the list's rules", () => {
  it("searches the name, the username and the email (every word, a leading @ ignored, width and case folded)", () => {
    const list = people();
    const hits = (q: string) => list.filter((u) => matchesUserSearch(u, q)).map((u) => u.username);
    expect(hits("")).toHaveLength(7);
    expect(hits("bob")).toEqual(["bob"]);
    expect(hits("@CAROL")).toEqual(["carol"]);
    expect(hits("ＢＯＢ")).toEqual(["bob"]);
    expect(hits("lab.example")).toEqual(["bob"]);
    expect(hits("太郎")).toEqual(["admin"]);
    expect(hits("example jp")).toEqual(["admin", "bob", "a-very-long-username-for-testing"]);
    expect(hits("nobody")).toEqual([]);
  });

  it("counts every chip; 仮パスワード is only for active people", () => {
    const list = people();
    list.push(user("u-off", "off", "Off", { deactivated_at: "2026-09-02T00:00:00Z", must_change_password: true }));
    expect(userFilterCounts(list)).toEqual({ all: 8, active: 6, deactivated: 2, admin: 1, member: 5, guest: 1, bot: 1, temporary: 1 });
  });

  it("sorts by name, username, created date both ways and role", () => {
    const list = people();
    const order = (sort: Parameters<typeof sortUsers>[1]) => sortUsers(list, sort).map((u) => u.username);
    expect(order("username")).toEqual(["a-very-long-username-for-testing", "admin", "bob", "carol", "ci-bot", "dave", "eve"]);
    expect(order("newest").slice(0, 3)).toEqual(["dave", "ci-bot", "bob"]);
    expect(order("oldest").slice(0, 3)).toEqual(["admin", "eve", "carol"]);
    expect(order("role")[0]).toBe("admin");
    expect(order("role").slice(-2)).toEqual(["carol", "ci-bot"]); // guests, then bots
    expect(order("name").slice(0, 4)).toEqual(["bob", "carol", "ci-bot", "dave"]);
    expect(visibleUsers(list, "", "active", "oldest").map((u) => u.username)).not.toContain("eve");
  });

  it("remembers the filter and the sort, ignores what it does not know, and survives storage that throws", () => {
    expect(readUsersView()).toEqual({ filter: "all", sort: "name" });
    writeUsersView({ filter: "bot", sort: "newest" });
    expect(readUsersView()).toEqual({ filter: "bot", sort: "newest" });
    localStorage.setItem(USERS_VIEW_KEY, JSON.stringify({ filter: "nonsense", sort: "role" }));
    expect(readUsersView()).toEqual({ filter: "all", sort: "role" });
    localStorage.setItem(USERS_VIEW_KEY, "{not json");
    expect(readUsersView()).toEqual({ filter: "all", sort: "name" });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(readUsersView()).toEqual({ filter: "all", sort: "name" });
    expect(() => writeUsersView({ filter: "guest", sort: "name" })).not.toThrow();
  });
});

async function setup() {
  const list = people();
  const calls: Array<[string, ...unknown[]]> = [];
  const api = {
    adminListUsers: async () => list.map((u) => ({ ...u })),
    adminUpdateUser: async (id: string, patch: object) => { calls.push(["adminUpdateUser", id, patch]); return { ...list.find((u) => u.id === id)! }; },
    adminResetPassword: async (id: string) => { calls.push(["adminResetPassword", id]); return { temporary_password: "tmp-pass-123" }; },
    adminRevokeSessions: async (id: string) => { calls.push(["adminRevokeSessions", id]); },
    adminResetTotp: async (id: string) => { calls.push(["adminResetTotp", id]); },
    adminAnonymizeUser: async (id: string) => { calls.push(["adminAnonymizeUser", id]); },
  };
  const store = new Store();
  store.setMe({ ...list[0], has_password: true } as never);
  // The shared profile (title) and the roster line of Bob: the row shows 「M2 · 研究室長」.
  store.users.set("u-bob", { ...list[1], title: "研究室長" } as unknown as UserPublic);
  store.roster.set("u-bob", { user_id: "u-bob", affiliation: "student", grade: "M2" } as LabProfileOut);
  const proxy = new Proxy(api as Record<string, unknown>, { get: (t, key: string) => t[key] ?? (async () => []) });
  const controller = { store, api: proxy, engine: { ai: { loadStatus: async () => {} } }, isAdmin: true, version: 0, subscribe: () => () => {}, setError: vi.fn(), setNotice: vi.fn() } as unknown as AppController;
  const view = render(<AdminBody controller={controller} />);
  await settle();
  return { calls, controller, view };
}

const list = () => screen.getByRole("list", { name: "ユーザー" });
const shownNames = () => within(list()).queryAllByRole("listitem").map((li) => li.getAttribute("data-user")).filter(Boolean);
const rowOf = (username: string) => list().querySelector<HTMLElement>(`li[data-user="${username}"]`)!;
const chip = (label: string) => within(screen.getByRole("group", { name: "絞り込み" })).getByRole("button", { name: new RegExp(`^${label}`) });

function openMenu(username: string): HTMLElement {
  fireEvent.keyDown(within(rowOf(username)).getByRole("button", { name: /の操作$/ }), { key: "Enter" });
  return screen.getByRole("menu");
}

const itemLabels = (menu: HTMLElement) => [...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent?.replace("✓", "").trim());

async function choose(username: string, item: RegExp | string, role: "menuitem" | "menuitemradio" = "menuitem") {
  const menu = openMenu(username);
  fireEvent.click(within(menu).getByRole(role, { name: item }));
  await settle();
}

describe("管理 →「ユーザー」", () => {
  it("filters with counted chips, and 「N 人」 follows the filter", async () => {
    await setup();
    expect(screen.getByText("7 人")).toBeTruthy();
    expect(chip("すべて").textContent).toBe("すべて7");
    expect(chip("有効").textContent).toBe("有効6");
    expect(chip("ボット").textContent).toBe("ボット1");
    fireEvent.click(chip("無効"));
    expect(shownNames()).toEqual(["eve"]);
    expect(screen.getByText("1 人 (全 7 人)")).toBeTruthy();
    expect(chip("無効").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(chip("仮パスワード"));
    expect(shownNames()).toEqual(["dave"]);
    fireEvent.click(chip("ゲスト"));
    expect(shownNames()).toEqual(["carol"]);
    fireEvent.click(chip("管理者"));
    expect(shownNames()).toEqual(["admin"]);
  });

  it("searches, and the chips count what the search leaves", async () => {
    await setup();
    fireEvent.change(screen.getByRole("searchbox", { name: "ユーザーを検索" }), { target: { value: "example" } });
    expect(shownNames().sort()).toEqual(["a-very-long-username-for-testing", "admin", "bob"]);
    expect(chip("すべて").textContent).toBe("すべて3");
    expect(chip("管理者").textContent).toBe("管理者1");
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzz" } });
    expect(screen.getByText("該当するユーザーはいません")).toBeTruthy();
  });

  it("sorts, and remembers the filter and the sort when it opens again", async () => {
    const { view } = await setup();
    fireEvent.change(screen.getByRole("combobox", { name: "並び順" }), { target: { value: "newest" } });
    expect(shownNames().slice(0, 3)).toEqual(["dave", "ci-bot", "bob"]);
    fireEvent.click(chip("有効"));
    view.unmount();
    await setup();
    expect((screen.getByRole("combobox", { name: "並び順" }) as HTMLSelectElement).value).toBe("newest");
    expect(chip("有効").getAttribute("aria-pressed")).toBe("true");
    expect(shownNames()[0]).toBe("dave");
    expect(shownNames()).not.toContain("eve");
  });

  it("the ⋯ menu of an active person: role, rename, password, sessions, 2FA, deactivate — the same API as before", async () => {
    const { calls } = await setup();
    const labels = itemLabels(openMenu("bob"));
    expect(labels).toEqual(["メンバー", "管理者", "ゲスト", "ユーザー名を変更", "パスワード再設定 (仮パスワードを発行)", "セッション失効 (全端末からログアウト)", "2FA を解除", "無効化 (ログイン不可、表示は残る)"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await settle();
    await choose("bob", "管理者", "menuitemradio");
    await choose("bob", /パスワード再設定/);
    expect(screen.getByText("@bob の仮パスワード")).toBeTruthy();
    expect(screen.getByText("tmp-pass-123")).toBeTruthy();
    await choose("bob", /セッション失効/);
    await choose("bob", /2FA を解除/);
    await choose("bob", /無効化/);
    expect(calls).toEqual([
      ["adminUpdateUser", "u-bob", { role: "admin" }],
      ["adminResetPassword", "u-bob"],
      ["adminRevokeSessions", "u-bob"],
      ["adminResetTotp", "u-bob"],
      ["adminUpdateUser", "u-bob", { deactivated: true }],
    ]);
  });

  it("a deactivated person: 再有効化, rename, 匿名化 after its confirmation; bots have no role; me only a rename", async () => {
    const { calls } = await setup();
    expect(within(openMenu("eve")).getAllByRole("menuitem").map((item) => item.textContent?.trim())).toEqual(["再有効化", "ユーザー名を変更", "匿名化…"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await settle();
    await choose("eve", "再有効化");
    await choose("eve", /匿名化/);
    const dialog = screen.getByRole("dialog", { name: "ユーザーを匿名化しますか？" });
    expect(dialog.textContent).toContain("@eve の名前・メールを消し、全セッションを終了します。メッセージは「削除されたユーザー」として残ります。元に戻せません。");
    fireEvent.click(within(dialog).getByRole("button", { name: "匿名化する" }));
    await settle();
    expect(calls).toEqual([["adminUpdateUser", "u-eve", { deactivated: false }], ["adminAnonymizeUser", "u-eve"]]);
    expect(within(openMenu("ci-bot")).queryAllByRole("menuitemradio")).toHaveLength(0);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await settle();
    expect(itemLabels(openMenu("admin"))).toEqual(["ユーザー名を変更"]);
  });

  it("a long name wraps instead of being cut; the username keeps its width and the email gives way; full values in tooltips", async () => {
    await setup();
    const row = rowOf("a-very-long-username-for-testing");
    const name = within(row).getByText(LONG);
    expect(name.className).not.toContain("truncate");
    expect(name.className).toContain("[overflow-wrap:anywhere]");
    expect(name.getAttribute("title")).toBe(LONG);
    const username = row.querySelector<HTMLElement>('[data-part="username"]')!;
    const email = row.querySelector<HTMLElement>('[data-part="email"]')!;
    expect(username.className).toMatch(/shrink-0/);
    expect(username.className).toMatch(/max-w-full/);
    expect(username.getAttribute("title")).toBe("@a-very-long-username-for-testing");
    expect(email.className).toMatch(/min-w-0/);
    expect(email.className).toMatch(/truncate/);
    expect(email.getAttribute("title")).toBe("someone.with.a.very.long.address@graduate-school.example.ac.jp");
    // The ⋯ button sits beside the text column, never on top of it.
    const button = within(row).getByRole("button", { name: /の操作$/ });
    expect(button.className).toContain("shrink-0");
    expect(button.parentElement).toBe(row);
    expect(name.closest("div.min-w-0.flex-1")?.parentElement).toBe(row);
  });

  it("shows the roster label with the title (「M2 · 研究室長」) and the created date", async () => {
    await setup();
    expect(rowOf("bob").textContent).toContain("M2 · 研究室長 · 作成");
  });
});
