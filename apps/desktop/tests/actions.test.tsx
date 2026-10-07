// @vitest-environment jsdom
// M143 (docs/ACTIONS.md §9.1): 操作ボタン — grouping, the texts after a press, one press per id (a network retry keeps it),
// the page (confirm → spinner → toast), the sidebar item, the 在室状況 placement switch, the engine and the admin tab.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, NetworkError } from "../src/api/errors";
import type { ActionAdminOut, ActionInvokeOut, ActionListOut, ActionOut, ActionStatusOut, AttendanceBoardOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { actionTitle, checkedLabel, confirmText, groupActions, invokeOnce, onAttendance, pressable, refusalText, resultText, statusFailureText, statusKey } from "../src/ui/actions";
import { STATUS_POLL_MS } from "../src/ui/ActionButtons";
import { ActionsAdminTab } from "../src/ui/ActionsAdminTab";
import { ActionsView } from "../src/ui/ActionsView";
import { AttendancePill } from "../src/ui/AttendancePill";
import { AttendanceView } from "../src/ui/AttendanceView";
import { desktopNavKeys, NAV_CATALOGUE, NAV_ORDER, sidebarNavKeys } from "../src/ui/navItems";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const ME = "11111111-1111-4111-8111-111111111111";
const PROF = "22222222-2222-4222-8222-222222222222";
const people: UserPublic[] = [
  { id: ME, username: "me", display_name: "わたし", role: "member", deactivated_at: null } as UserPublic,
  { id: PROF, username: "prof", display_name: "教授", role: "member", deactivated_at: null } as UserPublic,
];

function action(id: string, name: string, over: Partial<ActionOut> = {}): ActionOut {
  return { id, name, group_label: null, icon: null, emoji: null, confirm: true, confirm_text: null, provides_status: false, position: 0, ...over };
}

const UNLOCK = action("a-unlock", "開ける", { group_label: "研究室の鍵", emoji: "🔓", position: 0 });
const LOCK = action("a-lock", "閉める", { group_label: "研究室の鍵", emoji: "🔒", position: 1 });
const LIGHT = action("a-light", "照明", { confirm: false, icon: "lab", position: 2 });
const ROOM = action("a-room", "教授室を開ける", { group_label: "教授室", position: 3 });

function list(over: Partial<ActionListOut> = {}): ActionListOut {
  return { enabled: true, show_on_attendance: false, actions: [UNLOCK, LOCK, LIGHT, ROOM], ...over };
}

function out(over: Partial<ActionInvokeOut> = {}): ActionInvokeOut {
  return { invoke_id: "i1", action_id: UNLOCK.id, ok: true, status: "succeeded", status_code: 200, error: null, message: null, at: "2026-10-07T00:00:00Z", repeated: false, ...over };
}

function storeWith(actions: ActionListOut | null, attendance: AttendanceBoardOut | null = null): Store {
  const store = new Store();
  store.setMe({ ...people[0]! } as unknown as UserMe);
  for (const user of people) store.upsertUser(user);
  store.setAttendance(attendance);
  store.setActions(actions);
  return store;
}

function controllerFor(store: Store, api: Record<string, unknown>, admin = false) {
  return {
    store,
    api,
    isAdmin: admin,
    can: () => admin,
    isGuest: false,
    error: null,
    version: 0,
    subscribe: () => () => {},
    setError: vi.fn(),
    setNotice: vi.fn(),
    engine: { loadAttendance: vi.fn(async () => {}), loadActions: vi.fn(async () => {}) },
  } as unknown as AppController;
}

describe("the rules", () => {
  it("groups by group_label in order, the ungrouped ones last", () => {
    const groups = groupActions([ROOM, LIGHT, LOCK, UNLOCK]);
    expect(groups.map((g) => [g.label, g.actions.map((a) => a.name)])).toEqual([
      ["研究室の鍵", ["開ける", "閉める"]],
      ["教授室", ["教授室を開ける"]],
      [null, ["照明"]],
    ]);
  });

  it("titles and the default confirmation", () => {
    expect(actionTitle(UNLOCK)).toBe("研究室の鍵：開ける");
    expect(actionTitle(LIGHT)).toBe("照明");
    expect(confirmText(UNLOCK)).toBe("研究室の鍵：開ける を実行しますか？");
    expect(confirmText({ ...UNLOCK, confirm_text: "本当に開けますか？" })).toBe("本当に開けますか？");
  });

  it("what is pressable: nothing while off; the attendance placement only when the workspace says so", () => {
    expect(pressable(null)).toEqual([]);
    expect(pressable({ enabled: false, show_on_attendance: true, actions: [UNLOCK] })).toEqual([]);
    expect(pressable(list())).toHaveLength(4);
    expect(onAttendance(list())).toEqual([]);
    expect(onAttendance(list({ show_on_attendance: true }))).toHaveLength(4);
  });

  it("says the relay's message, else a sentence for the outcome (the hub may be offline)", () => {
    expect(resultText(out({ message: "解錠しました" }), UNLOCK)).toEqual({ ok: true, text: "解錠しました" });
    expect(resultText(out(), UNLOCK)).toEqual({ ok: true, text: "研究室の鍵：開ける を実行しました" });
    expect(resultText(out({ ok: false, status: "failed", status_code: 503, error: "relay_error", message: "電池が切れています" }), UNLOCK).text).toBe("電池が切れています");
    expect(resultText(out({ ok: false, status: "failed", status_code: 503, error: "relay_error" }), UNLOCK).text).toBe("実行できませんでした（HTTP 503）");
    expect(resultText(out({ ok: false, status: "failed", status_code: null, error: "timeout" }), UNLOCK).text).toContain("機器（またはハブ）から応答がありませんでした");
    expect(resultText(out({ ok: false, status: "failed", status_code: null, error: "network" }), UNLOCK).text).toBe("機器（またはハブ）に接続できませんでした。オフラインかもしれません");
    expect(refusalText(new ApiError(429, "rate_limited", "x"))).toBe("少し待ってからもう一度押してください");
    expect(refusalText(new ApiError(403, "action_not_allowed", "x"))).toBe("このボタンを押す権限がありません");
  });

  it("a network failure is sent again with the same id; other failures are not", async () => {
    const ids: string[] = [];
    let calls = 0;
    const invoke = vi.fn(async (_: string, id: string) => {
      ids.push(id);
      calls += 1;
      if (calls < 3) throw new NetworkError(new TypeError("Failed to fetch"));
      return out();
    });
    await expect(invokeOnce(invoke, UNLOCK.id, { wait: async () => {} })).resolves.toMatchObject({ ok: true });
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(1);
    // A refusal from the server is not retried.
    const refused = vi.fn(async () => { throw new ApiError(429, "rate_limited", "x"); });
    await expect(invokeOnce(refused, UNLOCK.id, { wait: async () => {} })).rejects.toBeInstanceOf(ApiError);
    expect(refused).toHaveBeenCalledTimes(1);
    // A new press is a new id.
    const second: string[] = [];
    await invokeOnce(async (_: string, id: string) => { second.push(id); return out(); }, UNLOCK.id);
    expect(second[0]).not.toBe(ids[0]);
  });
});

describe("the page", () => {
  it("draws the groups; a press asks first, spins, then toasts the relay's message", async () => {
    let finish: (value: ActionInvokeOut) => void = () => {};
    const invokeAction = vi.fn(() => new Promise<ActionInvokeOut>((resolve) => { finish = resolve; }));
    const controller = controllerFor(storeWith(list()), { invokeAction });
    render(<ActionsView controller={controller} />);
    const group = screen.getByRole("region", { name: "研究室の鍵" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["🔓開ける", "🔒閉める"]);
    fireEvent.click(within(group).getByRole("button", { name: /開ける/ }));
    expect(invokeAction).not.toHaveBeenCalled();
    expect(screen.getByText("研究室の鍵：開ける を実行しますか？")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "実行" }));
    await waitFor(() => expect(invokeAction).toHaveBeenCalledWith(UNLOCK.id, expect.stringMatching(/^[0-9a-f-]{36}$/)));
    const sending = document.querySelector(`[data-action="${UNLOCK.id}"]`) as HTMLButtonElement;
    expect(sending.disabled).toBe(true);
    expect(sending.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish(out({ message: "解錠しました" })));
    await waitFor(() => expect(controller.setNotice).toHaveBeenCalledWith("解錠しました"));
    expect((document.querySelector(`[data-action="${UNLOCK.id}"]`) as HTMLButtonElement).disabled).toBe(false);
  });

  it("cancelling sends nothing; a button without confirm runs at once; failures go to the banner", async () => {
    const invokeAction = vi.fn(async () => out({ ok: false, status: "failed", status_code: null, error: "network" }));
    const controller = controllerFor(storeWith(list()), { invokeAction });
    render(<ActionsView controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: /閉める/ }));
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(invokeAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /照明/ }));
    await waitFor(() => expect(controller.setError).toHaveBeenCalledWith("機器（またはハブ）に接続できませんでした。オフラインかもしれません"));
    expect(invokeAction).toHaveBeenCalledTimes(1);
    expect(document.querySelector("svg[data-action-icon='lab']")).toBeTruthy();
  });

  it("says when there is nothing to press", () => {
    render(<ActionsView controller={controllerFor(storeWith(null), {})} />);
    expect(screen.getByText("押せるボタンはありません")).toBeTruthy();
  });
});

describe("the sidebar item", () => {
  it("is in the shared catalogue (desktop only for now) and implemented only while I may press a button", () => {
    expect(NAV_CATALOGUE.find((item) => item.key === "actions")).toEqual({ key: "actions", label: "操作", visible: true, platforms: ["desktop", "mobile"] });
    expect(NAV_ORDER.desktop.at(-1)).toBe("actions");
    expect(sidebarNavKeys(null, desktopNavKeys(false, false))).not.toContain("actions");
    expect(sidebarNavKeys(null, desktopNavKeys(false, true))).toContain("actions");
    expect(sidebarNavKeys([{ key: "actions", visible: false }], desktopNavKeys(true, true))).not.toContain("actions");
  });
});

describe("on the 在室状況 page", () => {
  const board: AttendanceBoardOut = { enabled: true, states: [], entries: [], can_personalize: false };

  it("shows the buttons on top only when the workspace says so", () => {
    const { unmount } = render(<AttendanceView controller={controllerFor(storeWith(list()), {})} />);
    expect(document.querySelector("[data-attendance-actions]")).toBeNull();
    unmount();
    render(<AttendanceView controller={controllerFor(storeWith(list({ show_on_attendance: true }), board), {})} />);
    const section = document.querySelector("[data-attendance-actions]") as HTMLElement;
    expect(within(section).getByRole("region", { name: "研究室の鍵" })).toBeTruthy();
  });

  it("and in the pill's menu", async () => {
    const invokeAction = vi.fn(async () => out({ message: "点けました", action_id: LIGHT.id }));
    const controller = controllerFor(storeWith(list({ show_on_attendance: true }), board), { invokeAction });
    render(<AttendancePill controller={controller} placement="sidebar" />);
    fireEvent.click(screen.getByRole("button", { name: "在室状況を変える" }));
    const menu = await waitFor(() => { const el = document.querySelector("[data-attendance-menu-actions]"); expect(el).toBeTruthy(); return el as HTMLElement; });
    expect(within(menu).getAllByRole("button").map((b) => b.textContent)).toEqual(["🔓研究室の鍵：開ける", "🔒研究室の鍵：閉める", "照明", "教授室：教授室を開ける"]);
    fireEvent.click(within(menu).getByRole("button", { name: /照明/ }));
    await waitFor(() => expect(controller.setNotice).toHaveBeenCalledWith("点けました"));
  });

  it("not in the pill's menu when the workspace keeps them on their own page", async () => {
    render(<AttendancePill controller={controllerFor(storeWith(list(), board), {})} placement="sidebar" />);
    fireEvent.click(screen.getByRole("button", { name: "在室状況を変える" }));
    await waitFor(() => expect(document.querySelector("[data-attendance-menu]")).toBeTruthy());
    expect(document.querySelector("[data-attendance-menu-actions]")).toBeNull();
  });
});

describe("the engine", () => {
  it("takes the buttons from the bootstrap and reads them again on actions.updated", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    server.createChannel("general", alice.id);
    server.actions = list({ actions: [UNLOCK] });
    const store = new Store();
    const engine = new SyncEngine({ api: server.apiFor(alice.id), connect: server.connectorFor(alice.id), store, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 50 });
    await engine.start();
    await engine.idle();
    expect(store.actions?.actions.map((a) => a.id)).toEqual([UNLOCK.id]);
    server.actions = null; // turned off
    server.emitActionsUpdated();
    await engine.idle();
    await waitFor(() => expect(store.actions).toBeNull(), { timeout: 2000 });
    engine.stop();
  });
});

describe("the admin tab", () => {
  const row: ActionAdminOut = {
    ...UNLOCK,
    action_key: "lab-door.unlock",
    url: "https://lab.example.ac.jp/taylis",
    secret_name: "lab-relay",
    secret_present: false,
    allowed_roles: ["member"],
    allowed_group_ids: [],
    allowed_user_ids: [PROF],
    notice_channel_id: null,
    enabled: true,
    created_at: "2026-10-07T00:00:00Z",
    updated_at: "2026-10-07T00:00:00Z",
    last_invoked_at: null,
  };

  function adminApi(over: Record<string, unknown> = {}) {
    return {
      adminActionSettings: vi.fn(async () => ({ enabled: true, show_on_attendance: false, log_retention_days: 365 })),
      adminUpdateActionSettings: vi.fn(async () => ({ enabled: true, show_on_attendance: true, log_retention_days: 365 })),
      adminActions: vi.fn(async () => [row]),
      adminCreateAction: vi.fn(async () => row),
      adminUpdateAction: vi.fn(async () => row),
      adminTestAction: vi.fn(async () => out({ message: "テスト OK", status_code: 204 })),
      adminActionInvocations: vi.fn(async () => []),
      adminCheckActionStatus: vi.fn(async () => status()),
      ...over,
    };
  }

  it("lists the buttons with who may press them and a missing key; the placement switch; a test send", async () => {
    const api = adminApi();
    render(<ActionsAdminTab controller={controllerFor(storeWith(null), api, true)} />);
    const item = await waitFor(() => { const el = document.querySelector(`[data-admin-action="${UNLOCK.id}"]`); expect(el).toBeTruthy(); return el as HTMLElement; });
    expect(item.textContent).toContain("研究室の鍵：開ける");
    expect(item.textContent).toContain("押せる人：メンバー、教授");
    expect(item.textContent).toContain("鍵のファイルがありません");
    expect(item.textContent).not.toContain("secret-value");
    fireEvent.click(screen.getByRole("checkbox", { name: "在室状況のページにも表示する" }));
    await waitFor(() => expect(api.adminUpdateActionSettings).toHaveBeenCalledWith({ show_on_attendance: true }));
    fireEvent.click(within(item).getByRole("button", { name: /テスト送信/ }));
    await waitFor(() => expect(api.adminTestAction).toHaveBeenCalledWith(UNLOCK.id));
    await screen.findByText("テスト：テスト OK（HTTP 204）");
  });

  it("the form sends what it shows, with the people who may press", async () => {
    const api = adminApi({ adminActions: vi.fn(async () => []) });
    render(<ActionsAdminTab controller={controllerFor(storeWith(null), api, true)} />);
    fireEvent.click(await screen.findByRole("button", { name: /ボタンを追加/ }));
    const form = document.querySelector("[data-action-form]") as HTMLFormElement;
    const field = (label: string) => within(form).getByLabelText(label, { exact: false }) as HTMLInputElement;
    expect(within(form).getByText("まだ誰も押せません（ロール・グループ・人を選んでください）")).toBeTruthy();
    fireEvent.change(field("まとまり"), { target: { value: "研究室の鍵" } });
    fireEvent.change(field("ボタンの名前"), { target: { value: "開ける" } });
    fireEvent.change(field("中継の URL"), { target: { value: "https://lab.example.ac.jp/taylis" } });
    fireEvent.change(field("操作のキー"), { target: { value: "lab-door.unlock" } });
    fireEvent.change(field("署名の鍵のファイル名"), { target: { value: "lab-relay" } });
    fireEvent.change(field("絵文字"), { target: { value: "🔓" } });
    fireEvent.click(form.querySelector("[data-role='member']")!);
    fireEvent.change(within(form).getByRole("textbox", { name: "人を名前で探して追加" }), { target: { value: "教授" } });
    fireEvent.click(form.querySelector("[data-person='prof']")!);
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.adminCreateAction).toHaveBeenCalledWith({
        name: "開ける",
        group_label: "研究室の鍵",
        icon: null,
        emoji: "🔓",
        url: "https://lab.example.ac.jp/taylis",
        action_key: "lab-door.unlock",
        secret_name: "lab-relay",
        confirm: true,
        confirm_text: null,
        allowed_roles: ["member"],
        allowed_group_ids: [],
        allowed_user_ids: [PROF],
        notice_channel_id: null,
        enabled: true,
        provides_status: false,
      }),
    );
  });

  it("the 「状態の取得に使う」 toggle and 「状態を確認」", async () => {
    const api = adminApi({
      adminActions: vi.fn(async () => [{ ...row, provides_status: true }]),
      adminCheckActionStatus: vi.fn(async () => status({ action_id: UNLOCK.id })),
    });
    render(<ActionsAdminTab controller={controllerFor(storeWith(null), api, true)} />);
    const item = await waitFor(() => { const el = document.querySelector(`[data-admin-action="${UNLOCK.id}"]`); expect(el).toBeTruthy(); return el as HTMLElement; });
    expect(within(item).getByText("状態")).toBeTruthy();
    fireEvent.click(within(item).getByRole("button", { name: /状態を確認/ }));
    await waitFor(() => expect(api.adminCheckActionStatus).toHaveBeenCalledWith(UNLOCK.id));
    expect((await screen.findByText(/^状態：施錠中・ドア閉/)).textContent).toBe("状態：施錠中・ドア閉 · 電池 85%（ok、locked）");
    fireEvent.click(within(item).getByRole("button", { name: "「開ける」を編集" }));
    const form = document.querySelector("[data-action-form]") as HTMLFormElement;
    const toggle = form.querySelector("[data-provides-status]") as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    fireEvent.click(within(form).getByRole("button", { name: "保存" }));
    await waitFor(() => expect(api.adminUpdateAction).toHaveBeenCalledWith(UNLOCK.id, expect.objectContaining({ provides_status: false })));
  });
});

function status(over: Partial<ActionStatusOut> = {}): ActionStatusOut {
  return {
    action_id: UNLOCK.id,
    group_label: "研究室の鍵",
    ok: true,
    status: { text: "施錠中・ドア閉", tone: "ok", state: "locked", details: [{ label: "電池", value: "85%" }] },
    error: null,
    message: null,
    fetched_at: new Date().toISOString(),
    ...over,
  };
}

describe("the state (§12)", () => {
  const LOCKED_LIST = list({ actions: [{ ...UNLOCK, provides_status: true }, LOCK, LIGHT, ROOM] });

  it("the rules: keys, failures and 「◯分前に確認」", () => {
    expect(statusKey("研究室の鍵", "x")).toBe("g:研究室の鍵");
    expect(statusKey(null, "x")).toBe("a:x");
    expect(statusFailureText({ error: "timeout", message: null })).toBe("状態を取得できませんでした：中継から応答がありませんでした");
    expect(statusFailureText({ error: "relay_error", message: "ハブがオフラインです" })).toBe("状態を取得できませんでした：ハブがオフラインです");
    const now = new Date("2026-10-08T10:00:00Z");
    expect(checkedLabel("2026-10-08T09:59:40Z", now)).toBe("たった今確認");
    expect(checkedLabel("2026-10-08T09:57:00Z", now)).toBe("3 分前に確認");
    expect(checkedLabel("2026-10-08T08:00:00Z", now)).toMatch(/に確認$/);
  });

  it("the page reads the state on open and shows it under the group, with a refresh", async () => {
    const actionStatuses = vi.fn(async (refresh?: boolean) => ({
      enabled: true,
      statuses: [refresh ? status({ status: { text: "解錠中", tone: "warn", state: "unlocked", details: [] } }) : status()],
    }));
    const controller = controllerFor(storeWith(LOCKED_LIST), { actionStatuses });
    render(<ActionsView controller={controller} />);
    expect(actionStatuses).toHaveBeenCalledWith(false);
    const group = screen.getByRole("region", { name: "研究室の鍵" });
    await waitFor(() => expect(within(group).getByText("施錠中・ドア閉")).toBeTruthy());
    const line = group.querySelector("[data-action-status]") as HTMLElement;
    expect(line.getAttribute("data-tone")).toBe("ok");
    expect(line.textContent).toContain("電池 85%");
    expect(line.textContent).toContain("たった今確認");
    // Other groups have no state.
    expect(screen.getByRole("region", { name: "教授室" }).querySelector("[data-action-status]")).toBeNull();
    fireEvent.click(within(group).getByRole("button", { name: "状態を更新" }));
    await waitFor(() => expect(within(group).getByText("解錠中")).toBeTruthy());
    expect(actionStatuses).toHaveBeenLastCalledWith(true);
    expect((group.querySelector("[data-action-status]") as HTMLElement).getAttribute("data-tone")).toBe("warn");
  });

  it("loading, a relay failure, and a failed read", async () => {
    let answer: (value: { enabled: boolean; statuses: ActionStatusOut[] }) => void = () => {};
    const actionStatuses = vi.fn(() => new Promise<{ enabled: boolean; statuses: ActionStatusOut[] }>((resolve) => { answer = resolve; }));
    render(<ActionsView controller={controllerFor(storeWith(LOCKED_LIST), { actionStatuses })} />);
    expect(screen.getByText("状態を確認中…")).toBeTruthy();
    await act(async () => answer({ enabled: true, statuses: [status({ ok: false, status: null, error: "timeout" })] }));
    expect(screen.getByText("状態を取得できませんでした：中継から応答がありませんでした")).toBeTruthy();
    cleanup();
    const failing = vi.fn(async () => { throw new ApiError(429, "rate_limited", "x"); });
    render(<ActionsView controller={controllerFor(storeWith(LOCKED_LIST), { actionStatuses: failing })} />);
    await screen.findByText("状態を取得できませんでした：少し待ってからもう一度押してください");
  });

  it("reads again every minute while visible", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const actionStatuses = vi.fn(async () => ({ enabled: true, statuses: [status()] }));
    render(<ActionsView controller={controllerFor(storeWith(LOCKED_LIST), { actionStatuses })} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(STATUS_POLL_MS + 10); });
    expect(actionStatuses).toHaveBeenCalledTimes(2);
  });

  it("the store keeps the newest answer per group; actions.status_updated reaches it through the engine", async () => {
    const store = storeWith(LOCKED_LIST);
    store.setActionStatuses({ enabled: true, statuses: [status({ fetched_at: "2026-10-08T10:00:00Z" })] });
    store.applyActionStatus(status({ fetched_at: "2026-10-08T09:00:00Z", status: { text: "古い", tone: "neutral", state: null, details: [] } }));
    expect(store.actionStatuses.get("g:研究室の鍵")?.status?.text).toBe("施錠中・ドア閉");
    store.setActions(null);
    expect(store.actionStatuses.size).toBe(0);

    const server = new FakeServer();
    const alice = server.addUser("alice");
    server.createChannel("general", alice.id);
    server.actions = LOCKED_LIST;
    const synced = new Store();
    const engine = new SyncEngine({ api: server.apiFor(alice.id), connect: server.connectorFor(alice.id), store: synced, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 50 });
    await engine.start();
    await engine.idle();
    server.emitActionStatus(status({ status: { text: "解錠中", tone: "warn", state: "unlocked", details: [] } }));
    await waitFor(() => expect(synced.actionStatuses.get("g:研究室の鍵")?.status?.state).toBe("unlocked"));
    engine.stop();
  });

  it("on the 在室状況 page too", async () => {
    const board: AttendanceBoardOut = { enabled: true, states: [], entries: [], can_personalize: false };
    const actionStatuses = vi.fn(async () => ({ enabled: true, statuses: [status()] }));
    render(<AttendanceView controller={controllerFor(storeWith({ ...LOCKED_LIST, show_on_attendance: true }, board), { actionStatuses })} />);
    const section = document.querySelector("[data-attendance-actions]") as HTMLElement;
    await waitFor(() => expect(within(section).getByText("施錠中・ドア閉")).toBeTruthy());
  });
});
