// @vitest-environment jsdom
/**
 * M40 (MOBILE_UI.md §6.5): the settings as a list of screens — the phone's 「自分」 tab (the list, pushed screens, ← and
 * the browser's Back) and the wide layout's dialog (the same list on the left, one section on the right) — on the real
 * MainScreen with a real SyncEngine and the fake server (PATCH /users/me, GET / DELETE /auth/sessions).
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import { ApiError } from "../src/api/errors";
import type { GeneralReportCreate, UserMe, UserUpdate } from "../src/api/types";
import { AppController } from "../src/state/app";
import { COMPACT_QUERY } from "../src/ui/compact";
import { pauseValue } from "../src/ui/dnd";
import { MainScreen } from "../src/ui/MainScreen";
import { readPalette, readSidebarTone, setThemeWorkspace } from "../src/ui/theme";
import { world, type World } from "./unreadWorld";

let compact = true;

beforeEach(() => {
  compact = true;
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === COMPACT_QUERY ? compact : false, addEventListener: () => {}, removeEventListener: () => {} }));
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  HTMLElement.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete document.documentElement.dataset["theme"];
});

/** Channel C, bob on this device (a browser) and signed in on his iPhone and an old laptop too. */
async function setup(options: { admin?: boolean; title?: string; renameError?: ApiError } = {}) {
  const w = world({ posts: 1, lastRead: 1 });
  const bob = w.server.users.get(w.bob.id)!;
  if (options.admin) bob.role = "admin";
  if (options.title) bob.title = options.title;
  const old = w.server.addSession(w.bob.id, { device_name: "古い MacBook", platform: "desktop" }, { lastUsedAt: "2026-09-01T09:00:00Z" });
  const phone = w.server.addSession(w.bob.id, { device_name: "Bob の iPhone", platform: "ios" });
  const here = w.server.addSession(w.bob.id, { device_name: "ブラウザ", platform: "web" }, { current: true });
  const inner = w.api as unknown as Record<string, unknown>;
  const updates: UserUpdate[] = [];
  const reports: GeneralReportCreate[] = [];
  const extra: Record<string, unknown> = {
    updateMe: async (patch: UserUpdate) => {
      if (patch.username !== undefined && options.renameError) throw options.renameError;
      updates.push(patch);
      return { ...w.store.me!, ...patch } as UserMe;
    },
    totpStatus: async () => ({ enabled: false, recovery_codes_left: 0 }),
    submitReport: async (body: GeneralReportCreate) => { reports.push(body); return { id: "r1", category: body.category, user_id: null, created_at: "" }; },
  };
  // Whatever else the screen asks for on the side (custom emoji, sections, drafts, admin lists …) finds nothing.
  const api = new Proxy({ ...inner, ...extra }, { get: (target, key: string) => target[key] ?? (async () => []) }) as unknown as ApiClient;
  await w.engine.start();
  await w.engine.idle();
  const controller = new AppController();
  (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "bob", api, store: w.store, engine: w.engine, me: w.store.me, leaving: false };
  render(<Screen w={w} controller={controller} />);
  await flush();
  return { w, controller, updates, reports, sessions: { old, phone, here } };
}

function Screen({ w, controller }: { w: World; controller: AppController }) {
  useSyncExternalStore(
    (listener) => {
      const subs = [controller.subscribe(listener), w.store.subscribe(listener), w.engine.subscribe(listener)];
      return () => subs.forEach((unsubscribe) => unsubscribe());
    },
    () => `${controller.version}:${w.store.version}:${w.engine.status}`,
  );
  return <MainScreen controller={controller} />;
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const tap = async (tab: string) => {
  fireEvent.click(document.querySelector<HTMLButtonElement>(`nav[aria-label="タブ"] [data-tab="${tab}"]`)!);
  await flush();
};
const you = () => document.querySelector<HTMLElement>('[data-tab-root="you"]')!;
const rowNames = () => [...you().querySelectorAll<HTMLButtonElement>("button[data-section]")].map((button) => button.getAttribute("aria-label") ?? button.textContent);
const openRow = async (name: string | RegExp) => {
  fireEvent.click(within(you()).getByRole("button", { name }));
  await flush();
};
const back = async () => {
  fireEvent.click(within(you()).getByRole("button", { name: "戻る" }));
  await flush();
};

it("the phone's 「自分」: me on top, 「ステータスを更新」, the pause and the quiet hours with their values, the screens, a red 「ログアウト」; no 管理 for a member", async () => {
  const { w } = await setup({ title: "M2" });
  await tap("you");
  const page = you();
  expect(within(page).getByText("Bob")).toBeTruthy();
  expect(within(page).getByText("@bob · M2")).toBeTruthy();
  expect(rowNames()).toEqual(["ステータスを更新", "通知を一時停止 オフ", "おやすみ時間 オフ", "通知", "表示 端末に合わせる", "入力", "プロフィールを編集", "アカウント", "ワークスペース"]);
  const logout = within(page).getByRole("button", { name: "ログアウト" });
  expect(logout.className).toContain("text-danger");
  expect(within(page).queryByRole("button", { name: "管理" })).toBeNull();
  w.engine.stop();
});

it("「通知を一時停止」: 1 時間 pauses (dnd_until) and returns to the list with 「〜 HH:mm まで」; 「再開」 ends it; 「日時を指定」 takes a time ahead only", async () => {
  const { w, updates } = await setup();
  await tap("you");
  await openRow("通知を一時停止 オフ");
  expect(you().querySelector('[data-you-section="pause"]')).toBeTruthy();
  expect(within(you()).getAllByRole("button").map((b) => b.textContent)).toEqual(expect.arrayContaining(["30 分", "1 時間", "2 時間", "明日 8:00", "止める"]));
  expect(within(you()).queryByRole("button", { name: "再開" })).toBeNull();
  const before = Date.now();
  fireEvent.click(within(you()).getByRole("button", { name: "1 時間" }));
  await flush();
  const until = updates.at(-1)!.dnd_until!;
  expect(Date.parse(until) - before).toBeGreaterThanOrEqual(3_600_000 - 1000);
  expect(Date.parse(until) - before).toBeLessThan(3_600_000 + 5000);
  expect(you().querySelector("[data-you-section]")).toBeNull(); // back on the list
  // The row says what pauseValue says: 「〜 HH:mm まで」, or with the date when the hour crosses midnight (this failed
  // on runs after 23:00).
  expect(rowNames()).toContain(`通知を一時停止 ${pauseValue(until)}`);

  await openRow(/^通知を一時停止 〜/);
  fireEvent.click(within(you()).getByRole("button", { name: "再開" }));
  await flush();
  expect(updates.at(-1)).toEqual({ dnd_until: null });
  expect(rowNames()).toContain("通知を一時停止 オフ");

  await openRow("通知を一時停止 オフ");
  const picker = within(you()).getByLabelText("日時を指定");
  fireEvent.change(picker, { target: { value: "2020-01-01T08:00" } });
  expect((within(you()).getByRole("button", { name: "止める" }) as HTMLButtonElement).disabled).toBe(true);
  expect(within(you()).getByText("今より後の日時を選んでください")).toBeTruthy();
  const later = new Date(Date.now() + 3 * 86_400_000);
  later.setHours(9, 30, 0, 0);
  const local = `${later.getFullYear()}-${String(later.getMonth() + 1).padStart(2, "0")}-${String(later.getDate()).padStart(2, "0")}T09:30`;
  fireEvent.change(picker, { target: { value: local } });
  fireEvent.click(within(you()).getByRole("button", { name: "止める" }));
  await flush();
  expect(updates.at(-1)).toEqual({ dnd_until: later.toISOString() });
  expect(rowNames()).toContain(`通知を一時停止 〜 ${later.getMonth() + 1}/${later.getDate()} 09:30 まで`);
  w.engine.stop();
});

it("「おやすみ時間」: on, 23:00〜07:00 on weekdays is saved as quiet_hours and shows on the row; off saves null", async () => {
  const { w, updates } = await setup();
  await tap("you");
  await openRow("おやすみ時間 オフ");
  const save = () => within(you()).getByRole("button", { name: "保存" }) as HTMLButtonElement;
  expect(save().disabled).toBe(true);
  fireEvent.click(within(you()).getByRole("switch", { name: "毎日この時間帯は通知を止める" }));
  fireEvent.change(within(you()).getByLabelText("開始"), { target: { value: "23:00" } });
  const days = within(within(you()).getByRole("group", { name: "曜日" }));
  fireEvent.click(days.getByRole("button", { name: "土" }));
  fireEvent.click(days.getByRole("button", { name: "日" }));
  fireEvent.click(save());
  await flush();
  expect(updates.at(-1)).toMatchObject({ quiet_hours: { start: "23:00", end: "07:00", days: [0, 1, 2, 3, 4] } });
  expect(rowNames()).toContain("おやすみ時間 23:00〜07:00 (月火水木金)");

  await openRow(/^おやすみ時間 23:00/);
  fireEvent.click(within(you()).getByRole("switch", { name: "毎日この時間帯は通知を止める" }));
  fireEvent.click(save());
  await flush();
  expect(updates.at(-1)).toEqual({ quiet_hours: null });
  expect(rowNames()).toContain("おやすみ時間 オフ");
  w.engine.stop();
});

it("「ステータスを更新」 is the status only (no pause, no quiet hours); saving returns to the list, which shows it", async () => {
  const { w, updates } = await setup();
  await tap("you");
  await openRow("ステータスを更新");
  const view = you().querySelector<HTMLElement>('[data-you-section="status"]')!;
  expect(within(view).queryByText("通知を一時停止")).toBeNull();
  expect(within(view).queryByText("おやすみ時間")).toBeNull();
  // The emoji comes from the picker (a text field only brought up the keyboard).
  fireEvent.click(within(view).getByRole("button", { name: "絵文字を選ぶ" }));
  fireEvent.change(await screen.findByPlaceholderText("検索（例：tada、乾杯）"), { target: { value: "books" } });
  fireEvent.click(await screen.findByTitle(":books:"));
  fireEvent.change(within(view).getByLabelText("ステータス"), { target: { value: "論文執筆中" } });
  fireEvent.click(within(view).getByRole("button", { name: "保存" }));
  await flush();
  expect(updates.at(-1)).toEqual({ status_emoji: "📚", status_text: "論文執筆中", status_expires_at: null });
  expect(you().querySelector("[data-you-section]")).toBeNull();
  expect(within(you()).getByText("論文執筆中")).toBeTruthy();
  w.engine.stop();
});

it("「アカウント」 lists the signed-in devices (this one first, marked 「この端末」); another is signed out after a confirmation", async () => {
  const { w, sessions } = await setup();
  await tap("you");
  await openRow("アカウント");
  expect(within(you()).getByText("パスワードの変更")).toBeTruthy();
  expect(within(you()).getByText("2 要素認証")).toBeTruthy();
  const list = within(you()).getByRole("list", { name: "ログイン中の端末" });
  const rows = within(list).getAllByRole("listitem");
  expect(rows.map((row) => row.getAttribute("data-session"))).toEqual([sessions.here.id, sessions.phone.id, sessions.old.id]);
  expect(within(rows[0]!).getByText("この端末")).toBeTruthy();
  expect(within(rows[0]!).queryByRole("button", { name: "ログアウト" })).toBeNull();
  expect(within(rows[1]!).getByText("Bob の iPhone")).toBeTruthy();
  expect(within(rows[1]!).getByText(/^iPhone \/ iPad · 最後に使った時刻/)).toBeTruthy();

  // Cancel keeps it.
  fireEvent.click(within(rows[2]!).getByRole("button", { name: "ログアウト" }));
  let dialog = screen.getByRole("dialog", { name: "「古い MacBook」をログアウトしますか？" });
  fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
  await flush();
  expect(w.server.sessions.get(w.bob.id)).toHaveLength(3);

  fireEvent.click(within(rows[2]!).getByRole("button", { name: "ログアウト" }));
  dialog = screen.getByRole("dialog", { name: "「古い MacBook」をログアウトしますか？" });
  fireEvent.click(within(dialog).getByRole("button", { name: "ログアウト" }));
  await flush();
  expect(w.server.sessions.get(w.bob.id)!.map((s) => s.id)).toEqual([sessions.here.id, sessions.phone.id]);
  expect(within(within(you()).getByRole("list", { name: "ログイン中の端末" })).getAllByRole("listitem")).toHaveLength(2);
  w.engine.stop();
});

it("「アカウント」 of an account made by Google sign-in (M48) has no password change and no 2FA, only the devices", async () => {
  const { w } = await setup();
  act(() => w.store.setMe({ ...w.store.me!, has_password: false }));
  await tap("you");
  await openRow("アカウント");
  expect(within(you()).queryByText("パスワードの変更")).toBeNull();
  expect(within(you()).queryByText("2 要素認証")).toBeNull();
  expect(within(you()).getByText(/このアカウントは Google でログインします/)).toBeTruthy();
  expect(within(you()).getByRole("list", { name: "ログイン中の端末" })).toBeTruthy();
  w.engine.stop();
});

it("「表示」: ライト / ダーク pin the colours on <html> and are kept on this device; 端末に合わせる lets the OS decide", async () => {
  const { w } = await setup();
  await tap("you");
  await openRow("表示 端末に合わせる");
  fireEvent.click(within(you()).getByRole("radio", { name: "ダーク" }));
  expect(document.documentElement.dataset["theme"]).toBe("dark");
  expect(localStorage.getItem("chikuwa.prefs.theme")).toBe("dark");
  await back();
  expect(rowNames()).toContain("表示 ダーク");
  await openRow("表示 ダーク");
  fireEvent.click(within(you()).getByRole("radio", { name: "端末に合わせる" }));
  expect(document.documentElement.dataset["theme"]).toBeUndefined();
  expect(localStorage.getItem("chikuwa.prefs.theme")).toBeNull();
  w.engine.stop();
});

it("「表示」 → テーマの色: a palette goes on <html> and stays on this device; 文字の大きさ is the desktop app's (a browser zooms itself)", async () => {
  const { w } = await setup();
  await tap("you");
  await openRow("表示 端末に合わせる");
  const colours = within(you()).getByRole("radiogroup", { name: "テーマの色" });
  expect(within(colours).getAllByRole("radio")).toHaveLength(6);
  expect((within(colours).getByRole("radio", { name: "Taylis（栗）" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(within(colours).getByRole("radio", { name: "緑" }));
  expect(document.documentElement.dataset["palette"]).toBe("green");
  expect(localStorage.getItem("chikuwa.prefs.palette")).toBe("green");
  fireEvent.click(within(colours).getByRole("radio", { name: "Taylis（栗）" }));
  expect(document.documentElement.dataset["palette"]).toBeUndefined();
  expect(within(you()).queryByRole("combobox", { name: "文字の大きさ" })).toBeNull();
  w.engine.stop();
});

it("「表示」 with two workspaces: テーマの色 and サイドバー are this workspace's own, 「すべてのワークスペースに使う」 shares them", async () => {
  const { w, controller } = await setup();
  const entry = (serverUrl: string, name: string) => ({ serverUrl, workspaceId: null, name, username: "bob", userId: null });
  controller.workspaces = [entry("http://server", "研究室"), entry("http://other", "別の場所")];
  controller.activeServer = "http://server";
  Object.defineProperty(controller, "showsRail", { get: () => true });
  setThemeWorkspace("http://server");
  await tap("you");
  await openRow("表示 端末に合わせる");
  const box = within(you()).getByTestId("workspace-theme");
  expect(box.textContent).toContain("テーマの色とサイドバーは「研究室」だけに使われます");
  const shareAll = within(box).getByRole("button", { name: "すべてのワークスペースに使う" }) as HTMLButtonElement;
  expect(shareAll.disabled).toBe(true);
  // The swatch cards hold their sr-only radios (`relative`): placed by an outer box, a radio below the pane's first
  // screen stuck out of the settings dialog, and choosing it scrolled the whole dialog up.
  for (const group of ["テーマの色", "サイドバー"]) {
    for (const radio of within(within(you()).getByRole("radiogroup", { name: group })).getAllByRole("radio")) {
      expect(radio.className).toContain("sr-only");
      expect(radio.closest("label")!.className.split(/\s+/)).toContain("relative");
    }
  }
  fireEvent.click(within(you()).getByRole("radio", { name: "紫" }));
  fireEvent.click(within(within(you()).getByRole("radiogroup", { name: "サイドバー" })).getByRole("radio", { name: "明るい色" }));
  expect(document.documentElement.dataset["palette"]).toBe("purple");
  expect(document.documentElement.dataset["sidebar"]).toBe("light");
  expect(localStorage.getItem("chikuwa.prefs.palette")).toBeNull(); // the shared choice is untouched
  expect(readPalette("http://other")).toBe("taylis");
  expect(shareAll.disabled).toBe(false);
  fireEvent.click(shareAll);
  expect(readPalette("http://other")).toBe("purple");
  expect(readSidebarTone("http://other")).toBe("light");
  expect(shareAll.disabled).toBe(true);
  delete document.documentElement.dataset["palette"];
  delete document.documentElement.dataset["sidebar"];
  w.engine.stop();
});

it("every old setting is still there:入力 (送信キー, テンプレート), プロフィール (写真, 表示名, 肩書, 在席を隠す), 通知 (全体, キーワード, 端末の通知), ワークスペース", async () => {
  const { w, updates } = await setup();
  await tap("you");
  await openRow("入力");
  expect(within(you()).getByRole("button", { name: /^Enter で送信/ })).toBeTruthy();
  expect(within(you()).getByText("テンプレート")).toBeTruthy();
  await back();
  await openRow("プロフィールを編集");
  expect(within(you()).getByRole("button", { name: /写真を選ぶ/ })).toBeTruthy();
  expect(within(you()).getByText("表示名")).toBeTruthy();
  expect(within(you()).getByText("肩書（任意）")).toBeTruthy();
  expect(within(you()).getByRole("switch", { name: /在席を隠す/ })).toBeTruthy();
  await back();
  await openRow("通知");
  expect(within(you()).getByRole("radiogroup", { name: "通知" })).toBeTruthy();
  fireEvent.change(within(you()).getByPlaceholderText("例：加納, kano, リリース"), { target: { value: "締切, deadline" } });
  fireEvent.click(within(you()).getByRole("button", { name: "キーワードを保存" }));
  await flush();
  expect(updates.at(-1)).toEqual({ notify_keywords: ["締切", "deadline"] });
  expect(within(you()).getByText("このブラウザの通知")).toBeTruthy();
  await back();
  await openRow("ワークスペース");
  expect(within(you()).getByRole("list", { name: "ワークスペース" })).toBeTruthy();
  w.engine.stop();
});

it("M96 「プロフィールを編集」: the username field checks as I type, renames with its own button, says password sign-in uses the new name", async () => {
  const { w, updates } = await setup();
  await tap("you");
  await openRow("プロフィールを編集");
  const form = within(you()).getByRole("form", { name: "ユーザー名" });
  const field = within(form).getByRole("textbox") as HTMLInputElement;
  const submit = within(form).getByRole("button", { name: "ユーザー名を変更" }) as HTMLButtonElement;
  expect(field.value).toBe("bob");
  expect(submit.disabled).toBe(true); // unchanged
  expect(within(form).getByText(/パスワードでのログインには新しいユーザー名を使います/)).toBeTruthy();
  expect(within(form).getByText(/24 時間に 3 回まで/)).toBeTruthy();
  for (const [typed, problem] of [["ab", "3〜32 文字にしてください"], ["bob smith", "使えるのは a-z、0-9、. _ - だけです"], ["here", "このユーザー名は予約されているため使えません"]] as const) {
    fireEvent.change(field, { target: { value: typed } });
    expect(within(form).getByRole("alert").textContent).toBe(problem);
    expect(submit.disabled).toBe(true);
  }
  fireEvent.change(field, { target: { value: "Bob.K" } });
  expect(field.value).toBe("bob.k"); // lowercase as typed
  expect(within(form).queryByRole("alert")).toBeNull();
  fireEvent.click(submit);
  await flush();
  expect(updates.at(-1)).toEqual({ username: "bob.k" });
  expect(w.store.me?.username).toBe("bob.k");
  expect(within(form).getByText("@bob.k に変更しました。次からはこの名前でログインします")).toBeTruthy();
  w.engine.stop();
});

it("M96: the server's refusal (the daily limit, a taken name) shows under the username field", async () => {
  const { w, updates } = await setup({ renameError: new ApiError(429, "username_change_limited", "limited", { retry_after_seconds: 3600 }) });
  await tap("you");
  await openRow("プロフィールを編集");
  const form = within(you()).getByRole("form", { name: "ユーザー名" });
  fireEvent.change(within(form).getByRole("textbox"), { target: { value: "robert" } });
  fireEvent.click(within(form).getByRole("button", { name: "ユーザー名を変更" }));
  await flush();
  expect(within(form).getByRole("alert").textContent).toBe("ユーザー名を変更できるのは 24 時間に 3 回までです。しばらくしてからお試しください");
  expect(updates).toEqual([]);
  expect(w.store.me?.username).toBe("bob");
  w.engine.stop();
});

it("the browser's Back and a tap on 「自分」 return from a screen to the list", async () => {
  const { w } = await setup();
  await tap("you");
  await openRow("通知");
  expect(you().querySelector('[data-you-section="notifications"]')).toBeTruthy();
  await act(async () => {
    history.back();
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(you().querySelector("[data-you-section]")).toBeNull();
  await openRow("アカウント");
  await tap("you");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  expect(you().querySelector("[data-you-section]")).toBeNull();
  w.engine.stop();
});

it("the red 「ログアウト」 asks first; 管理 is there for an admin with every tab", async () => {
  const { w, controller } = await setup({ admin: true });
  const logout = vi.spyOn(controller, "logout").mockResolvedValue();
  await tap("you");
  expect(rowNames().at(-1)).toBe("管理");
  fireEvent.click(within(you()).getByRole("button", { name: "ログアウト" }));
  let dialog = screen.getByRole("dialog", { name: "ログアウトしますか？" });
  fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
  expect(logout).not.toHaveBeenCalled();
  fireEvent.click(within(you()).getByRole("button", { name: "ログアウト" }));
  dialog = screen.getByRole("dialog", { name: "ログアウトしますか？" });
  fireEvent.click(within(dialog).getByRole("button", { name: "ログアウト" }));
  expect(logout).toHaveBeenCalledOnce();

  await openRow("管理");
  const tabs = within(you()).getByRole("tablist", { name: "管理" });
  expect(within(tabs).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["ユーザー", "アナリティクス", "報告", "名簿", "グループ", "招待", "Webhook", "在室状況", "操作ボタン", "ワークフロー", "AI", "設定", "チャンネル", "絵文字", "キャンバス"]); // M140: 「在室状況」; M143: 「操作ボタン」; M65: 「AI」 (the fake server has the AI routes); M88: 「設定」; M94: 「ワークフロー」; M116: 「アナリティクス」
  w.engine.stop();
});

it("the wide layout: 設定 opens the dialog with the same list on the left and one section on the right", async () => {
  compact = false;
  const { w, sessions } = await setup({ admin: true });
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  await flush();
  const dialog = screen.getByRole("dialog", { name: "設定" });
  const nav = within(dialog).getByRole("navigation", { name: "設定の項目" });
  const names = [...nav.querySelectorAll("button[data-section]")].map((button) => button.getAttribute("aria-label"));
  expect(names).toEqual(["ステータスを更新", "通知を一時停止 オフ", "おやすみ時間 オフ", "通知", "表示 端末に合わせる", "入力", "プロフィールを編集", "アカウント", "ワークスペース", "管理"]);
  expect(within(nav).getByRole("button", { name: "ログアウト" })).toBeTruthy();
  // Opens on 「通知」; one section at a time.
  expect(within(nav).getByRole("button", { name: "通知" }).getAttribute("aria-current")).toBe("page");
  expect(within(dialog).getByRole("radiogroup", { name: "通知" })).toBeTruthy();
  expect(within(dialog).queryByText("パスワードの変更")).toBeNull();
  fireEvent.click(within(nav).getByRole("button", { name: "アカウント" }));
  await flush();
  expect(within(dialog).queryByRole("radiogroup", { name: "通知" })).toBeNull();
  expect(within(dialog).getByText("パスワードの変更")).toBeTruthy();
  expect(within(dialog).getByRole("list", { name: "ログイン中の端末" }).querySelector(`[data-session="${sessions.here.id}"]`)?.textContent).toContain("この端末");
  // The pause stays on its section after a choice (no list to go back to).
  fireEvent.click(within(nav).getByRole("button", { name: "通知を一時停止 オフ" }));
  fireEvent.click(within(dialog).getByRole("button", { name: "30 分" }));
  await flush();
  expect(within(dialog).getByRole("button", { name: "再開" })).toBeTruthy();
  expect(within(nav).getByRole("button", { name: /^通知を一時停止 〜/ })).toBeTruthy();
  // The list's values follow a change made on the right (「表示」).
  fireEvent.click(within(nav).getByRole("button", { name: "表示 端末に合わせる" }));
  fireEvent.click(within(dialog).getByRole("radio", { name: "ライト" }));
  expect(within(nav).getByRole("button", { name: "表示 ライト" })).toBeTruthy();
  expect(document.documentElement.dataset["theme"]).toBe("light");
  fireEvent.click(within(nav).getByRole("button", { name: "管理" }));
  expect(within(dialog).getByRole("tablist", { name: "管理" })).toBeTruthy();
  w.engine.stop();
});

it("M119 「問題を報告・ご意見」 is on the phone's 「自分」 and in the wide dialog's list, and sends POST /reports", async () => {
  const phone = await setup();
  await tap("you");
  fireEvent.click(within(you()).getByRole("button", { name: "問題を報告・ご意見" }));
  const sheet = screen.getByRole("dialog", { name: "問題を報告・ご意見" });
  fireEvent.click(within(sheet).getByRole("button", { name: "キャンセル" }));
  expect(screen.queryByRole("dialog", { name: "問題を報告・ご意見" })).toBeNull();
  expect(phone.reports).toEqual([]);
  phone.w.engine.stop();
  cleanup();

  compact = false;
  const wide = await setup();
  fireEvent.click(screen.getByRole("button", { name: "設定" }));
  await flush();
  const nav = within(screen.getByRole("dialog", { name: "設定" })).getByRole("navigation", { name: "設定の項目" });
  fireEvent.click(within(nav).getByRole("button", { name: "問題を報告・ご意見" }));
  const dialog = screen.getByRole("dialog", { name: "問題を報告・ご意見" });
  fireEvent.click(within(dialog).getByLabelText("その他"));
  fireEvent.change(within(dialog).getByLabelText("内容"), { target: { value: "通知が来ない" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "送信" }));
  await flush();
  expect(wide.reports).toEqual([expect.objectContaining({ category: "other", note: "通知が来ない" })]);
  expect(wide.reports[0]!.client_report_id).toBeTruthy();
  expect(wide.reports[0]!.user_id).toBeUndefined();
  expect(screen.queryByRole("dialog", { name: "問題を報告・ご意見" })).toBeNull();
  expect(wide.controller.notice).toBe("送信しました。管理者が確認します");
  wide.w.engine.stop();
});
