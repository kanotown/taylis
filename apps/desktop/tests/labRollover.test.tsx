// @vitest-environment jsdom
/**
 * M32 (L7) on the Web: invite links with a lab preset (the form, the list, the acceptance line), the yearly rollover in
 * Administration → 名簿 → 年度更新 (preview, choices, the body, applied state, history and undo), and a channel I made
 * on another device arriving with me as its owner.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ApiClient } from "../src/api/client";
import { ApiError } from "../src/api/errors";
import { ERROR_MESSAGES } from "../src/api/errorMessages";
import type { InviteCreate, InviteOut, InvitePreviewOut, LabProfileOut, RolloverApply, RolloverOut, RolloverPreviewOut, UserMe, UserPublic } from "../src/api/types";
import { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { InviteScreen } from "../src/ui/InviteScreen";
import { InvitesTab } from "../src/ui/InvitesTab";
import { invitePreset } from "../src/ui/invite";
import { academicYear, type RolloverChoice, rolloverBody } from "../src/ui/rollover";
import { RosterTab } from "../src/ui/RosterTab";
import { inviteLabLine, invitePresetSummary } from "../src/ui/roster";
import { FakeServer } from "./fakeServer";

afterEach(() => cleanup());

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function controllerFor(me: UserPublic, api: Record<string, unknown>): AppController {
  const controller = new AppController();
  controller.api = { baseUrl: "http://server", ...api } as unknown as ApiClient;
  controller.store.setMe({ ...me, email: null, must_change_password: false, notify_keywords: [], presence_hidden: false, notification_default: "mentions", notify_reactions: false, has_password: true } as UserMe);
  controller.store.upsertUser(me);
  return controller;
}

function line(userId: string, patch: Partial<LabProfileOut>): LabProfileOut {
  return { user_id: userId, affiliation: "student", rank: null, grade: null, supervisor_id: null, research_topic: null, reading: null, updated_at: "", ...patch };
}

/** The <select> inside the Field labelled `label` (the label also holds the options' text). */
function selectIn(label: string, scope: HTMLElement = document.body): HTMLSelectElement {
  const span = within(scope).getAllByText(label).find((el) => el.parentElement?.querySelector("select"));
  return span!.parentElement!.querySelector("select")!;
}

describe("invite links with a lab preset (L7)", () => {
  function setup(fail?: Error) {
    const server = new FakeServer();
    const admin = server.addUser("admin", "admin");
    const prof = server.addUser("prof");
    const bodies: InviteCreate[] = [];
    const listed: InviteOut = {
      id: "i1", created_by: admin.id, role: "member", channel_ids: [], note: "2027 年度 B4", max_uses: 10, use_count: 0, used_by: [],
      expires_at: "2026-10-06T00:00:00Z", revoked_at: null, created_at: "2026-09-29T00:00:00Z", status: "active",
      lab: { affiliation: "student", rank: null, grade: "B4", supervisor_id: prof.id, times: true },
    };
    const controller = controllerFor(admin, {
      adminListInvites: async () => [listed],
      adminCreateInvite: async (body: InviteCreate) => {
        if (fail) throw fail;
        bodies.push(body);
        return { token: "t".repeat(32), invite: { ...listed, lab: body.lab ?? null } };
      },
    });
    controller.store.upsertUser(prof);
    controller.store.applyRoster(prof.id, line(prof.id, { affiliation: "faculty", rank: "professor" }));
    render(<InvitesTab controller={controller} />);
    return { bodies, prof };
  }

  const issue = async () => {
    fireEvent.click(screen.getByRole("button", { name: "リンクを発行" }));
    await flush();
  };

  it("shows the preset in the list and sends `lab` only when the section is on", async () => {
    const w = setup();
    expect(await screen.findByText("名簿: 学生 B4 · 指導: Prof · times")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "招待リンクを作成" }));
    await issue();
    expect(w.bodies).toHaveLength(1);
    expect("lab" in w.bodies[0]!).toBe(false); // older servers reject unknown fields

    fireEvent.click(screen.getByRole("button", { name: "招待リンクを作成" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "研究室の名簿に載せる" }));
    fireEvent.change(selectIn("学年"), { target: { value: "B4" } });
    fireEvent.change(selectIn("指導教員"), { target: { value: w.prof.id } });
    expect((screen.getByRole("checkbox", { name: /times を作る/ }) as HTMLInputElement).checked).toBe(true);
    await issue();
    expect(w.bodies[1]!.lab).toEqual({ affiliation: "student", rank: null, grade: "B4", supervisor_id: w.prof.id, times: true });

    // A guest gets no times (400 guest_restricted): the box is off and disabled, and the body says false.
    fireEvent.click(screen.getByRole("button", { name: "招待リンクを作成" }));
    fireEvent.change(selectIn("ロール"), { target: { value: "guest" } });
    const times = screen.getByRole("checkbox", { name: /times を作る/ }) as HTMLInputElement;
    expect(times.disabled).toBe(true);
    expect(times.checked).toBe(false);
    await issue();
    expect(w.bodies[2]!.lab).toMatchObject({ affiliation: "student", grade: "B4", times: false });

    // Faculty: the rank, never a grade.
    fireEvent.click(screen.getByRole("button", { name: "招待リンクを作成" }));
    fireEvent.change(selectIn("ロール"), { target: { value: "member" } });
    fireEvent.change(selectIn("身分"), { target: { value: "faculty" } });
    fireEvent.change(selectIn("職位"), { target: { value: "lecturer" } });
    await issue();
    expect(w.bodies[3]!.lab).toMatchObject({ affiliation: "faculty", rank: "lecturer", grade: null });
  });

  it("says a failed issue inside the form (the toast sits behind the dialog)", async () => {
    setup(new ApiError(422, "invalid_supervisor", "Pick faculty"));
    fireEvent.click(await screen.findByRole("button", { name: "招待リンクを作成" }));
    await issue();
    expect(screen.getByRole("alert").textContent).toBe(ERROR_MESSAGES["invalid_supervisor"]);
  });

  it("builds the preset from the form", () => {
    const form = { on: true, affiliation: "student" as const, rank: "professor" as const, grade: "M1" as const, supervisorId: "", times: true };
    expect(invitePreset({ ...form, on: false }, "member")).toBeUndefined();
    expect(invitePreset(form, "member")).toEqual({ affiliation: "student", rank: null, grade: "M1", supervisor_id: null, times: true });
    expect(invitePreset(form, "guest")?.times).toBe(false);
    expect(invitePresetSummary({ affiliation: "alumni", times: false }, new Map())).toBe("卒業生");
  });
});

describe("the acceptance screen's lab line (L7)", () => {
  it("says the roster line, the supervisor and the times", async () => {
    const preview: InvitePreviewOut = {
      invited_by: "Admin", role: "member", channels: ["general"], expires_at: "2026-10-06T00:00:00Z", password_min_length: 8,
      lab: { affiliation: "student", rank: null, grade: "B4", supervisor_name: "加納", times: true },
    };
    const controller = new AppController();
    (controller as unknown as { previewInvite: () => Promise<InvitePreviewOut> }).previewInvite = async () => preview;
    render(<InviteScreen controller={controller} onBack={() => {}} onDone={() => {}} initialLink={`https://chat.example.com/invite/${"a".repeat(32)}`} />);
    expect(await screen.findByText("研究室の名簿に 学生 (B4)・指導教員 加納 として載ります。times を作ります。")).toBeTruthy();
  });

  it("leaves out what the preset does not give", () => {
    expect(inviteLabLine({ affiliation: "faculty", rank: "professor", grade: null, supervisor_name: null, times: false })).toBe("研究室の名簿に 教員 (教授) として載ります。");
    expect(inviteLabLine({ affiliation: "faculty", rank: null, grade: null, supervisor_name: null, times: false })).toBe("研究室の名簿に 教員 として載ります。");
    expect(inviteLabLine({ affiliation: "student", rank: null, grade: null, supervisor_name: null, times: true })).toBe("研究室の名簿に 学生 として載ります。times を作ります。");
    expect(inviteLabLine({ affiliation: "other", rank: null, grade: null, supervisor_name: "加納", times: false })).toBe("研究室の名簿に その他・指導教員 加納 として載ります。");
  });
});

describe("年度更新 (L7)", () => {
  it("defaults to the Japanese academic year (April to March)", () => {
    expect(academicYear(new Date(2027, 2, 31))).toBe(2026);
    expect(academicYear(new Date(2027, 3, 1))).toBe(2027);
    expect(academicYear(new Date(2026, 8, 29))).toBe(2026);
  });

  function setup() {
    const server = new FakeServer();
    const me = server.addUser("admin", "admin");
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    const carol = server.addUser("carol");
    const lab = server.createChannel("lab", me.id);
    const paper = server.createChannel("paper", me.id, "private");
    const alumni = server.createChannel("alumni", me.id);
    const ch = (c: { id: string; name: string | null; type: string }) => ({ id: c.id, name: c.name, type: c.type });
    let appliedAt: string | null = null;
    const preview = (year: number): RolloverPreviewOut => ({
      academic_year: year,
      applied_at: appliedAt,
      items: [
        { user_id: carol.id, grade: "D3", next_grade: null, action: "graduate", times_channel_id: null, channels: [ch(lab)] },
        { user_id: me.id, grade: "M2", next_grade: "D1", action: "graduate", times_channel_id: null, channels: [ch(lab)] },
        { user_id: bob.id, grade: "M2", next_grade: "D1", action: "graduate", times_channel_id: "t-bob", channels: [ch(lab), ch(paper)] },
        { user_id: alice.id, grade: "B4", next_grade: "M1", action: "advance", times_channel_id: null, channels: [ch(lab)] },
      ],
    });
    const out = (year: number, patch: Partial<RolloverOut> = {}): RolloverOut => ({
      academic_year: year, applied_by: me.id, applied_at: "2026-03-30T01:00:00Z", undone_at: null, advanced: 1, stayed: 1, graduated: 2, ...patch,
    });
    let history: RolloverOut[] = [out(2025), out(2024, { undone_at: "2025-04-02T00:00:00Z" })];
    const calls = { previews: [] as number[], applied: [] as RolloverApply[], undone: [] as number[] };
    let failApply: Error | null = null;
    const controller = controllerFor(me, {
      rolloverPreview: async (year: number) => { calls.previews.push(year); return preview(year); },
      rollovers: async () => history,
      applyRollover: async (body: RolloverApply) => {
        if (failApply) throw failApply;
        calls.applied.push(body);
        appliedAt = "2026-09-29T03:00:00Z";
        history = [out(body.academic_year, { advanced: 1, stayed: 1, graduated: 2 }), ...history];
        return history[0]!;
      },
      undoRollover: async (year: number) => { calls.undone.push(year); history = history.map((r) => (r.academic_year === year ? { ...r, undone_at: "2026-09-29T04:00:00Z" } : r)); return history.find((r) => r.academic_year === year)!; },
    });
    for (const user of [alice, bob, carol]) controller.store.upsertUser(user);
    for (const c of [lab, paper, alumni]) controller.store.upsertChannel(c, { isMember: true });
    render(<RosterTab controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "年度更新" }));
    return { calls, me, alice, bob, carol, lab, paper, alumni, failApply: (e: Error) => { failApply = e; } };
  }

  const actionOf = (name: string) => screen.getByRole("combobox", { name: `${name} の年度更新` }) as HTMLSelectElement;
  const rowOf = (name: string) => screen.getByRole("combobox", { name: `${name} の年度更新` }).closest("li")!;

  it("loads the students with the proposal, builds the body from the choices, then shows the year in force", async () => {
    const w = setup();
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe(String(academicYear(new Date())));
    expect(await screen.findByText("2025 年度")).toBeTruthy(); // the history
    fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "2026" } });
    fireEvent.click(screen.getByRole("button", { name: "読み込む" }));
    await flush();
    expect(w.calls.previews).toEqual([2026]);

    // Defaults per grade: B4 moves up, M2 and D3 finish; D3 has no 進級.
    expect(actionOf("Alice").value).toBe("advance");
    expect(actionOf("Bob").value).toBe("graduate");
    expect(actionOf("Carol").value).toBe("graduate");
    expect([...actionOf("Carol").options].map((o) => o.value)).toEqual(["stay", "graduate"]);
    expect([...actionOf("Alice").options].map((o) => o.textContent)).toEqual(["進級 (→ M1)", "据え置き", "卒業・修了"]);

    // Graduates: guest by default (not me: the server will not change my own account), channels to keep.
    const bobGuest = within(rowOf("Bob")).getByRole("checkbox", { name: "ゲストにする" }) as HTMLInputElement;
    expect(bobGuest.checked).toBe(true);
    const mine = within(rowOf("Admin")).getByRole("checkbox", { name: /ゲストにする/ }) as HTMLInputElement;
    expect(mine.disabled).toBe(true);
    fireEvent.click(within(within(rowOf("Bob")).getByRole("group", { name: "Bob の残すチャンネル" })).getByRole("checkbox", { name: "🔒paper" }));
    fireEvent.change(actionOf("Carol"), { target: { value: "stay" } });
    expect(within(rowOf("Carol")).queryByRole("checkbox", { name: "ゲストにする" })).toBeNull();
    fireEvent.click(within(screen.getByRole("group", { name: /卒業生が入って残るチャンネル/ })).getByRole("checkbox", { name: "#alumni" }));

    fireEvent.click(screen.getByRole("button", { name: "適用…" }));
    const dialog = screen.getByRole("dialog", { name: "2026 年度の年度更新を適用しますか？" });
    expect(within(dialog).getByText("卒業・修了: 2 人 (うちゲストにする 1 人)")).toBeTruthy();
    expect(within(dialog).getByText(/DM は残ります/)).toBeTruthy();
    expect(within(dialog).getByText("卒業生が入って残るチャンネル: #alumni")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "適用する" }));
    await flush();
    await flush();

    expect(w.calls.applied).toEqual([
      {
        academic_year: 2026,
        stay_channel_ids: [w.alumni.id],
        items: [
          { user_id: w.carol.id, action: "stay", guest: false, keep_channel_ids: [] },
          { user_id: w.me.id, action: "graduate", guest: false, keep_channel_ids: [] },
          { user_id: w.bob.id, action: "graduate", guest: true, keep_channel_ids: [w.paper.id] },
          { user_id: w.alice.id, action: "advance", guest: false, keep_channel_ids: [] },
        ],
      },
    ]);
    expect(screen.queryByRole("dialog", { name: /適用しますか/ })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("2026 年度の年度更新を適用しました");
    await waitFor(() => expect(screen.getByText(/2026 年度の年度更新は .* に適用済みです/)).toBeTruthy());
    expect((screen.getByRole("button", { name: "適用…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(actionOf("Alice").disabled).toBe(true);
    expect(screen.getByText("2026 年度")).toBeTruthy();
  });

  it("says a refused apply inside the dialog", async () => {
    const w = setup();
    w.failApply(new ApiError(409, "rollover_applied", "applied"));
    fireEvent.click(screen.getByRole("button", { name: "読み込む" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "適用…" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: /適用しますか/ })).getByRole("button", { name: "適用する" }));
    await flush();
    expect(within(screen.getByRole("dialog", { name: /適用しますか/ })).getByRole("alert").textContent).toBe(ERROR_MESSAGES["rollover_applied"]);
  });

  it("undoes a year from the history after a confirmation; undone years have no button", async () => {
    const w = setup();
    const history = await screen.findByRole("list", { name: "これまでの年度更新" });
    // Wait for both years' rows to be filled in (the list shows before its history arrives on a slow machine; the
    // v0.1.10 release checks failed here).
    await within(history).findByText("取り消し済み");
    const rows = within(history).getAllByRole("listitem");
    expect(within(rows[1]!).getByText("取り消し済み")).toBeTruthy();
    expect(within(rows[1]!).queryByRole("button", { name: "取り消す" })).toBeNull();
    expect(within(rows[0]!).getByText("進級 1 · 据え置き 1 · 卒業・修了 2")).toBeTruthy();
    fireEvent.click(within(rows[0]!).getByRole("button", { name: "取り消す" }));
    const dialog = screen.getByRole("dialog", { name: "2025 年度の年度更新を取り消しますか？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "取り消す" }));
    await waitFor(() => expect(w.calls.undone).toEqual([2025]));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("2025 年度の年度更新を取り消しました"));
    expect(within(screen.getByRole("list", { name: "これまでの年度更新" })).queryByRole("button", { name: "取り消す" })).toBeNull();
  });

  it("sends kept channels only for graduates and only from their own list", () => {
    const item = { user_id: "u", grade: "B4" as const, next_grade: "M1" as const, action: "advance" as const, times_channel_id: null, channels: [{ id: "a", name: "a", type: "public" }] };
    const choices = new Map<string, RolloverChoice>([["u", { action: "advance", guest: true, keep: new Set(["a"]) }]]);
    expect(rolloverBody(2026, [item], choices, []).items[0]).toEqual({ user_id: "u", action: "advance", guest: false, keep_channel_ids: [] });
    choices.set("u", { action: "graduate", guest: true, keep: new Set(["a", "elsewhere"]) });
    expect(rolloverBody(2026, [item], choices, []).items[0]).toEqual({ user_id: "u", action: "graduate", guest: true, keep_channel_ids: ["a"] });
    expect(rolloverBody(2026, [item], choices, ["a"])).toMatchObject({ stay_channel_ids: ["a"], items: [{ keep_channel_ids: [] }] });
  });
});

describe("channel.created for a channel I made elsewhere (L4 gap)", () => {
  it("makes me its owner until bootstrap says otherwise; not for others' channels, DMs or a membership I have", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    server.createChannel("general", alice.id);
    const store = new Store();
    const engine = new SyncEngine({ api: server.apiFor(alice.id), connect: server.connectorFor(alice.id), store, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 50 });
    await engine.start();
    await engine.idle();

    const mine = server.createChannel("made-on-my-phone", alice.id, "private");
    server.emitMembership(mine.id, alice.id);
    await engine.idle();
    expect(store.getChannel(mine.id)?.membership).toEqual({ role: "owner", joined_at: mine.created_at });
    expect(store.getChannel(mine.id)?.isMember).toBe(true);

    const theirs = server.createChannel("bobs", bob.id);
    server.join(theirs.id, alice.id);
    server.emitMembership(theirs.id, alice.id);
    await engine.idle();
    expect(store.getChannel(theirs.id)?.isMember).toBe(true);
    expect(store.getChannel(theirs.id)?.membership).toBeNull();

    const dm = server.createChannel("", alice.id, "dm");
    server.join(dm.id, bob.id);
    server.emitMembership(dm.id, alice.id);
    await engine.idle();
    expect(store.getChannel(dm.id)?.membership).toBeNull();

    // A membership I already know (an owner role taken back) stays as it is.
    store.setMyRole(mine.id, "member");
    server.emitMembership(mine.id, alice.id);
    await engine.idle();
    expect(store.getChannel(mine.id)?.membership?.role).toBe("member");
    engine.stop();
  });
});
