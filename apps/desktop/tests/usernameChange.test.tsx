// @vitest-environment jsdom
/** M96: usernames can change — the local checks, the saved workspace's sign-in name, and 管理 →「ユーザー名を変更」. */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { AdminUserOut, AdminUserUpdate } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { signInName } from "../src/state/workspaces";
import { Store } from "../src/sync/store";
import { AdminBody } from "../src/ui/AdminDialog";
import { normalizeUsername, renameHint, usernameProblem } from "../src/ui/username";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

it("checks a username as the server does (pattern, length, reserved words); uniqueness is the server's", () => {
  expect(usernameProblem("alice.k")).toBeNull();
  expect(usernameProblem("a_b-c.9")).toBeNull();
  expect(usernameProblem("")).toBe("ユーザー名を入力してください");
  expect(usernameProblem("ab")).toBe("3〜32 文字にしてください");
  expect(usernameProblem("x".repeat(33))).toBe("3〜32 文字にしてください");
  expect(usernameProblem("has space")).toBe("使えるのは a-z、0-9、. _ - だけです");
  expect(usernameProblem("かのうさん")).toBe("使えるのは a-z、0-9、. _ - だけです");
  for (const reserved of ["here", "channel", "everyone", "all", "group", "deleted-0123abcd"]) {
    expect(usernameProblem(reserved)).toBe("このユーザー名は予約されているため使えません");
  }
  expect(normalizeUsername("  Alice.K ")).toBe("alice.k");
  expect(usernameProblem(" Alice ")).toBeNull(); // sent as "alice"
  expect(renameHint(true)).toContain("パスワードでのログインには新しいユーザー名を使います");
  expect(renameHint(false)).not.toContain("パスワード");
});

it("a saved workspace shows and signs in with the current name; the old one keeps naming the credential", () => {
  expect(signInName({ username: "alice" })).toBe("alice");
  expect(signInName({ username: "alice", loginName: "alice.k" })).toBe("alice.k");
});

function adminUser(id: string, username: string, role = "member"): AdminUserOut {
  return {
    id, username, display_name: username === "admin" ? "Admin" : "Bob", email: null, role, must_change_password: false, totp_enabled: false,
    deactivated_at: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
  };
}

async function setupAdmin(fail?: ApiError) {
  const users = [adminUser("u-admin", "admin", "admin"), adminUser("u-bob", "bob"), adminUser("u-bot", "ci-bot", "bot")];
  const updates: Array<[string, AdminUserUpdate]> = [];
  const api = {
    adminListUsers: async () => users.map((u) => ({ ...u })),
    adminUpdateUser: async (id: string, patch: AdminUserUpdate) => {
      if (fail) throw fail;
      updates.push([id, patch]);
      const user = users.find((u) => u.id === id)!;
      Object.assign(user, patch);
      return { ...user };
    },
  };
  const store = new Store();
  store.setMe({ ...users[0], has_password: true } as never);
  const proxy = new Proxy(api as Record<string, unknown>, { get: (t, key: string) => t[key] ?? (async () => []) });
  const controller = { store, api: proxy, engine: { ai: { loadStatus: async () => {} } }, isAdmin: true, version: 0, subscribe: () => () => {}, setError: vi.fn(), setNotice: vi.fn() } as unknown as AppController;
  render(<AdminBody controller={controller} />);
  await settle();
  return { updates, controller };
}

const rowOf = (username: string) => screen.getByText(new RegExp(`^@${username.replace(".", "\\.")}`)).closest("li")!;

it("管理 →「ユーザー」: 「ユーザー名を変更」 on every row (me and bots too) renames with the same checks", async () => {
  const { updates } = await setupAdmin();
  for (const name of ["admin", "bob", "ci-bot"]) expect(within(rowOf(name)).getByRole("button", { name: /ユーザー名を変更/ })).toBeTruthy();
  fireEvent.click(within(rowOf("bob")).getByRole("button", { name: /ユーザー名を変更/ }));
  await settle();
  const dialog = screen.getByRole("dialog");
  expect(dialog.textContent).toContain("Bob のユーザー名を変更");
  expect(within(dialog).getByText(/パスワードでのログインには新しいユーザー名を使います/)).toBeTruthy();
  expect(within(dialog).queryByText(/24 時間に 3 回/)).toBeNull(); // administrators are not limited
  const field = within(dialog).getByRole("textbox");
  fireEvent.change(field, { target: { value: "everyone" } });
  expect(within(dialog).getByRole("alert").textContent).toBe("このユーザー名は予約されているため使えません");
  fireEvent.change(field, { target: { value: "robert" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "ユーザー名を変更" }));
  await settle();
  expect(updates).toEqual([["u-bob", { username: "robert" }]]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText(/^@robert/)).toBeTruthy(); // the list reloaded
});

it("管理: a refusal from the server stays in the dialog under the field", async () => {
  await setupAdmin(new ApiError(409, "username_taken", "taken"));
  fireEvent.click(within(rowOf("bob")).getByRole("button", { name: /ユーザー名を変更/ }));
  await settle();
  const dialog = screen.getByRole("dialog");
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "admin2" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "ユーザー名を変更" }));
  await settle();
  expect(within(dialog).getByRole("alert").textContent).toBe("このユーザー名はすでに使われています");
  expect(screen.getByRole("dialog")).toBeTruthy();
});
