// @vitest-environment jsdom
/**
 * M119 (docs/MODERATION.md §3.1): 「問題を報告・ご意見」 and a profile's 「報告する」 — a category and a required text
 * (4,000 at most), the same client_report_id on a retry until a send succeeds, the request POST /reports — and the
 * administrators' 「報告」 list showing message, user and general reports each in their own way.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminReportOut, UserMe, UserPublic } from "../src/api/types";
import { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { ReportsTab } from "../src/ui/AdminReportsTab";
import { ProblemReportDialog, REPORT_REASONS } from "../src/ui/ModerationDialogs";
import { UserPopover } from "../src/ui/UserPopover";

afterEach(cleanup);

const ALICE = "00000000-0000-7000-8000-000000000001";
const BOB = "00000000-0000-7000-8000-000000000002";
const CAROL = "00000000-0000-7000-8000-000000000003";

const person = (id: string, username: string, display_name: string): UserPublic =>
  ({ id, username, display_name, role: "member", deactivated_at: null, created_at: "", updated_at: "" }) as UserPublic;

function people() {
  const store = new Store();
  const alice = person(ALICE, "alice", "Alice");
  store.setMe(alice as unknown as UserMe);
  store.upsertUser(alice);
  store.upsertUser(person(BOB, "bob", "Bob"));
  store.upsertUser(person(CAROL, "carol", "Carol"));
  return store;
}

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("the report dialog", () => {
  function open(userId: string | null = null, results: boolean[] = [true]) {
    const store = people();
    const submitReport = vi.fn(async () => results.shift() ?? true);
    const controller = { store, submitReport } as unknown as AppController;
    const onClose = vi.fn();
    render(<ProblemReportDialog controller={controller} userId={userId} onClose={onClose} />);
    return { submitReport, onClose };
  }

  it("needs a category and some text; counts to 4000; shows the child safety contact", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: "問題を報告・ご意見" });
    const options = within(dialog).getAllByRole("radio").map((radio) => radio.parentElement!.textContent);
    expect(options).toEqual(["子どもの安全", "嫌がらせ", "不適切な内容", "迷惑・スパム", "ご意見・要望", "その他"]);
    const send = within(dialog).getByRole("button", { name: "送信" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.click(within(dialog).getByLabelText("ご意見・要望"));
    expect(send.disabled).toBe(true); // the text is required
    const note = within(dialog).getByLabelText("内容") as HTMLTextAreaElement;
    expect(note.maxLength).toBe(4000);
    fireEvent.change(note, { target: { value: "   " } });
    expect(send.disabled).toBe(true); // blank does not count
    fireEvent.change(note, { target: { value: "ダークモードがほしい" } });
    expect(send.disabled).toBe(false);
    expect(within(dialog).getByTestId("report-note-count").textContent).toBe("10 / 4000");
    expect(within(dialog).getByTestId("child-safety-contact").textContent).toContain("kanotown[at]gmail.com");
    expect(dialog.textContent).toContain("このワークスペースの管理者に届きます");
  });

  it("keeps the client_report_id across a failed send and closes after the one that succeeds", async () => {
    const { submitReport, onClose } = open(null, [false, true]);
    const dialog = screen.getByRole("dialog", { name: "問題を報告・ご意見" });
    fireEvent.click(within(dialog).getByLabelText("子どもの安全"));
    fireEvent.change(within(dialog).getByLabelText("内容"), { target: { value: "気になるやりとり" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "送信" }));
    await flush();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "送信" }));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    const [first, second] = submitReport.mock.calls.map((call) => (call as unknown as [{ clientReportId: string }])[0]);
    expect(first).toMatchObject({ category: "child_safety", note: "気になるやりとり", userId: null });
    expect(first!.clientReportId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second!.clientReportId).toBe(first!.clientReportId);
  });

  it("about a person: 「〇〇 さんを報告」 with their id", async () => {
    const { submitReport } = open(BOB);
    const dialog = screen.getByRole("dialog", { name: "Bob さんを報告" });
    fireEvent.click(within(dialog).getByLabelText("嫌がらせ"));
    fireEvent.change(within(dialog).getByLabelText("内容"), { target: { value: "しつこい DM" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "送信" }));
    await flush();
    expect(submitReport).toHaveBeenCalledWith(expect.objectContaining({ category: "harassment", userId: BOB }));
  });
});

describe("AppController.submitReport", () => {
  it("POSTs the trimmed text with the client_report_id (user_id only when given) and says 送信しました", async () => {
    const api = { submitReport: vi.fn(async () => ({})) };
    const self = { api, setNotice: vi.fn(), setError: vi.fn() };
    const submit = AppController.prototype.submitReport;
    expect(await submit.call(self as unknown as AppController, { category: "feedback", note: "  ほしい機能  ", clientReportId: "k1" })).toBe(true);
    expect(api.submitReport).toHaveBeenLastCalledWith({ category: "feedback", note: "ほしい機能", client_report_id: "k1" });
    expect(self.setNotice).toHaveBeenCalledWith("送信しました。管理者が確認します");
    await submit.call(self as unknown as AppController, { category: "spam", note: "x", userId: BOB, clientReportId: "k2" });
    expect(api.submitReport).toHaveBeenLastCalledWith({ category: "spam", note: "x", client_report_id: "k2", user_id: BOB });

    const failure = new Error("offline");
    api.submitReport.mockRejectedValueOnce(failure);
    expect(await submit.call(self as unknown as AppController, { category: "other", note: "y", clientReportId: "k3" })).toBe(false);
    expect(self.setError).toHaveBeenCalledWith(failure);
  });
});

describe("a profile card's 「報告する」", () => {
  it("is offered for someone else (not on my own card) and opens the dialog about them", () => {
    const store = people();
    const controller = { store, subscribe: () => () => {}, openDmWith: vi.fn(), setUserBlocked: vi.fn(), submitReport: vi.fn() } as unknown as AppController;
    render(<UserPopover controller={controller} userId={ALICE}>me</UserPopover>);
    fireEvent.click(screen.getByRole("button", { name: "自分のプロフィール（Alice）" }));
    expect(screen.getByRole("dialog").textContent).toContain("プロフィールを編集");
    expect(screen.queryByRole("button", { name: "報告する" })).toBeNull();
    cleanup();
    render(<UserPopover controller={controller} userId={BOB}>bob</UserPopover>);
    fireEvent.click(screen.getByRole("button", { name: "Bob のプロフィール" }));
    fireEvent.click(screen.getByRole("button", { name: "報告する" }));
    expect(screen.getByRole("dialog", { name: "Bob さんを報告" })).toBeTruthy();
  });
});

describe("the message report reasons", () => {
  it("start with 子どもの安全", () => {
    expect(REPORT_REASONS.map((item) => item.value)).toEqual(["child_safety", "spam", "harassment", "inappropriate", "other"]);
  });
});

describe("管理 → 報告", () => {
  const base = { status: "open", resolved_at: null, resolved_by: null, reporter_id: ALICE, created_at: "2026-10-06T12:00:00Z", message_deleted: false } as const;
  const rows: AdminReportOut[] = [
    { ...base, id: "r1", kind: "message", reason: "spam", message_id: "m1", channel_id: "c1", channel_name: "general", channel_type: "public", reported_user_id: BOB, body_snapshot: "買って！", note: "宣伝" },
    { ...base, id: "r2", kind: "user", reason: "child_safety", message_id: null, channel_id: null, channel_name: null, channel_type: "none", reported_user_id: CAROL, body_snapshot: "", note: "未成年に連絡している" },
    { ...base, id: "r3", kind: "general", reason: "feedback", message_id: null, channel_id: null, channel_name: null, channel_type: "none", reported_user_id: null, body_snapshot: "", note: "検索を速くしてほしい" },
  ];

  async function show() {
    const api = { adminListReports: vi.fn(async () => rows) };
    const controller = { store: people(), api, setError: vi.fn(), copyPermalink: vi.fn() } as unknown as AppController;
    render(<ReportsTab controller={controller} />);
    await flush();
    const row = (id: string) => document.querySelector<HTMLElement>(`[data-report="${id}"]`)!;
    return { row };
  }

  it("shows each kind with its badge, a message's place and body, a person's target, and the text as the content", async () => {
    const { row } = await show();
    const message = row("r1");
    expect(message.textContent).toContain("メッセージ");
    expect(message.textContent).toContain("#general");
    expect(message.textContent).toContain("投稿者：Bob");
    expect(message.querySelector("blockquote")!.textContent).toContain("買って！");
    expect(message.textContent).toContain("補足：宣伝");
    expect(within(message).getByRole("button", { name: /リンクをコピー/ })).toBeTruthy();

    const user = row("r2");
    expect(user.textContent).toContain("ユーザー");
    expect(user.textContent).toContain("⚠️ 子どもの安全");
    expect(user.textContent).toContain("対象のユーザー：Carol");
    expect(user.textContent).toContain("報告者：Alice");
    expect(user.textContent).not.toContain("DM");
    expect(user.querySelector("blockquote")).toBeNull();
    expect(within(user).getByTestId("report-note").textContent).toBe("未成年に連絡している");
    expect(within(user).queryByRole("button", { name: /リンクをコピー/ })).toBeNull();

    const general = row("r3");
    expect(general.textContent).toContain("全般");
    expect(general.textContent).toContain("ご意見・要望");
    expect(general.textContent).not.toContain("対象のユーザー");
    expect(general.textContent).not.toContain("投稿者");
    expect(within(general).getByTestId("report-note").textContent).toBe("検索を速くしてほしい");
    expect(within(general).queryByRole("button", { name: /リンクをコピー/ })).toBeNull();
  });

  it("filters by kind", async () => {
    await show();
    const kinds = screen.getByRole("radiogroup", { name: "報告の種類" });
    fireEvent.click(within(kinds).getByRole("radio", { name: "ユーザー" }));
    expect([...document.querySelectorAll("[data-report]")].map((li) => li.getAttribute("data-report"))).toEqual(["r2"]);
    fireEvent.click(within(kinds).getByRole("radio", { name: "全般" }));
    expect([...document.querySelectorAll("[data-report]")].map((li) => li.getAttribute("data-report"))).toEqual(["r3"]);
  });
});
