// @vitest-environment jsdom
// M94 (docs/WORKFLOWS.md §7): the form (defaults, checks, one key per form, the server's field errors), the 「⚡ name」
// label on a posted message, the composer's `/name`, and the editor (from a template, live preview, saving).
process.env.TZ = "Asia/Tokyo";

import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { ChannelOut, MessageOut, UserMe, UserPublic, WorkflowOut, WorkflowTemplateOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { ChannelState, MessageState } from "../src/sync/types";
import { Composer } from "../src/ui/Composer";
import { MessageRow } from "../src/ui/Timeline";
import { ChannelWorkflowsDialog, invalidateWorkflowLists, WorkflowManager, WorkflowRunDialog } from "../src/ui/WorkflowViews";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
beforeEach(() => invalidateWorkflowLists());

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const ME = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const people: UserPublic[] = [
  { id: ME, username: "me", display_name: "わたし", role: "member", deactivated_at: null } as UserPublic,
  { id: BOB, username: "bob", display_name: "ボブ", role: "member", deactivated_at: null } as UserPublic,
];

const FIELDS: WorkflowOut["fields"] = [
  { key: "報告者", label: "報告者", type: "user", required: true, help: "", multiple: false, options: [], default: { kind: "me" } },
  { key: "日付", label: "日付", type: "date", required: true, help: "", multiple: false, options: [], default: { kind: "today" } },
  { key: "内容", label: "報告の内容", type: "select", required: true, help: "", multiple: false, options: ["欠席", "遅刻", "早退"], default: null },
  { key: "理由", label: "理由", type: "textarea", required: false, help: "任意", multiple: false, options: [], default: null },
];
const WORKFLOW: WorkflowOut = {
  id: "w1",
  name: "ゼミ欠席報告",
  emoji: "🙇",
  description: "欠席を報告します",
  channel_id: "c-report",
  offered_channel_ids: ["c-report", "c-lab"],
  fields: FIELDS,
  template: "*【報告者】* {{報告者}}\n*【報告の内容】* ゼミの{{内容}}\n*【日付】* {{日付}}\n*【理由】* {{理由}}",
  enabled: true,
  confirm: true,
  created_by: ME,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  can_manage: true,
  can_run: true,
  run_blocked: null,
};
/** No fields and 「確認」 off: posts as soon as it is chosen (WORKFLOWS.md §11). */
const QUICK: WorkflowOut = { ...WORKFLOW, id: "w-quick", name: "出勤", emoji: "🏢", description: "", fields: [], template: "出勤しました", confirm: false };

function makeStore(): { store: Store; channel: ChannelState } {
  const store = new Store();
  store.setMe({ ...people[0]! } as unknown as UserMe);
  for (const user of people) store.upsertUser(user);
  const base = { topic: null, purpose: null, archived: false, created_at: "2026-01-01T00:00:00Z", last_seq: 0, posting_policy: "everyone" };
  const channel = store.upsertChannel({ id: "c-lab", type: "public", name: "lab", ...base } as unknown as ChannelOut, { isMember: true, membership: { role: "owner" } as never });
  store.upsertChannel({ id: "c-report", type: "public", name: "報告-ゼミ欠席", ...base } as unknown as ChannelOut, { isMember: true, membership: { role: "owner" } as never });
  return { store, channel: channel as ChannelState };
}

function controllerFor(store: Store, api: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    store, api, isAdmin: false, version: 0, subscribe: () => () => {}, setError: vi.fn(), setNotice: vi.fn(),
    submitWorkflow: vi.fn(async () => ({ ok: true, message: { id: "m1", channel_id: "c-report" } })),
    ...extra,
  } as unknown as AppController & { submitWorkflow: ReturnType<typeof vi.fn>; setNotice: ReturnType<typeof vi.fn> };
}

describe("the form", () => {
  it("starts with the defaults, checks before posting, and posts the cleaned values once per form", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-04T10:00:00+09:00"));
    const { store } = makeStore();
    const controller = controllerFor(store, {});
    const onClose = vi.fn();
    render(<WorkflowRunDialog controller={controller} workflow={WORKFLOW} here="c-lab" onClose={onClose} />);
    const dialog = within(screen.getByRole("dialog", { name: "🙇 ゼミ欠席報告" }));
    // 報告者 = me, 日付 = today.
    expect(dialog.getByLabelText("わたし を外す")).toBeTruthy();
    expect((dialog.getByLabelText(/^日付/) as HTMLInputElement).value).toBe("2026-10-04");
    // The preview renders as the server will: the mention, the Japanese date; the empty 理由 line is left out.
    const preview = within(dialog.getByRole("region", { name: "プレビュー" }));
    expect(preview.getByText(/2026年10月4日 \(日\)/)).toBeTruthy();
    expect(preview.queryByText(/理由/)).toBeNull();
    // 内容 is required.
    fireEvent.click(dialog.getByRole("button", { name: "投稿" }));
    expect(dialog.getAllByText("入力してください")).toHaveLength(1); // 内容
    expect(controller.submitWorkflow).not.toHaveBeenCalled();
    fireEvent.change(dialog.getByLabelText(/^報告の内容/), { target: { value: "遅刻" } });
    fireEvent.change(dialog.getByLabelText(/^理由/), { target: { value: "電車の遅延" } });
    expect(preview.getByText(/電車の遅延/)).toBeTruthy();

    // The server refuses a field: shown under it; the second try keeps the same key.
    controller.submitWorkflow.mockResolvedValueOnce({ ok: false, error: new ApiError(400, "workflow_values_invalid", "x", { fields: { 報告者: "user_not_found" } }) });
    fireEvent.click(dialog.getByRole("button", { name: "投稿" }));
    await flush();
    expect(dialog.getByText("選べない人が含まれています")).toBeTruthy();
    expect(dialog.getByText("入力に誤りがあります。各項目を確認してください")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "投稿" }));
    await flush();
    expect(controller.submitWorkflow).toHaveBeenCalledTimes(2);
    const [first, second] = controller.submitWorkflow.mock.calls;
    expect(first![0]).toBe("w1");
    expect(first![1]).toEqual({ 報告者: [ME], 日付: "2026-10-04", 内容: "遅刻", 理由: "電車の遅延" });
    expect(second![2]).toBe(first![2]);
    // Posted to another channel than this one: it says where.
    expect(controller.setNotice).toHaveBeenCalledWith("#報告-ゼミ欠席 に投稿しました");
    expect(onClose).toHaveBeenCalled();
  });

  it("the channel's menu lists what it offers and greys out what I cannot run", async () => {
    const { store, channel } = makeStore();
    const blocked = { ...WORKFLOW, id: "w2", name: "お知らせ", run_blocked: "posting_restricted" as const, can_run: false };
    const api = { channelWorkflows: vi.fn(async () => [WORKFLOW, blocked]) };
    const controller = controllerFor(store, api);
    render(<ChannelWorkflowsDialog controller={controller} channel={channel} onClose={() => {}} />);
    await flush();
    expect(api.channelWorkflows).toHaveBeenCalledWith("c-lab");
    const list = within(screen.getByRole("list", { name: "ワークフロー" }));
    expect(list.getAllByText("→ #報告-ゼミ欠席 に投稿")).toHaveLength(2);
    const restricted = list.getByText("お知らせ").closest("button")!;
    expect(restricted.disabled).toBe(true);
    expect(within(restricted).getByText("#報告-ゼミ欠席 はオーナーと管理者だけが投稿できます")).toBeTruthy();
    fireEvent.click(list.getByText("ゼミ欠席報告"));
    expect(screen.getByRole("dialog", { name: "🙇 ゼミ欠席報告" })).toBeTruthy();
  });
});

describe("「確認を求める」 (confirm, WORKFLOWS.md §11)", () => {
  it("a workflow that does not ask posts as soon as it is chosen, with no dialog", async () => {
    const { store } = makeStore();
    const controller = controllerFor(store, {});
    const onClose = vi.fn();
    render(<WorkflowRunDialog controller={controller} workflow={QUICK} here="c-lab" onClose={onClose} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    await flush();
    expect(controller.submitWorkflow).toHaveBeenCalledTimes(1);
    expect(controller.submitWorkflow.mock.calls[0]!.slice(0, 2)).toEqual(["w-quick", {}]);
    expect(controller.setNotice).toHaveBeenCalledWith("#報告-ゼミ欠席 に投稿しました");
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("when that post fails the dialog appears with the reason, and 投稿 retries with the same key", async () => {
    const { store } = makeStore();
    const controller = controllerFor(store, {});
    controller.submitWorkflow.mockResolvedValueOnce({ ok: false, error: new ApiError(409, "workflow_disabled", "x") });
    const onClose = vi.fn();
    render(<WorkflowRunDialog controller={controller} workflow={QUICK} onClose={onClose} />);
    await flush();
    const dialog = within(screen.getByRole("dialog", { name: "🏢 出勤" }));
    expect(dialog.getByRole("alert")).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog.getByRole("button", { name: "投稿" }));
    await flush();
    expect(controller.submitWorkflow).toHaveBeenCalledTimes(2);
    const [first, second] = controller.submitWorkflow.mock.calls;
    expect(second![2]).toBe(first![2]);
    expect(onClose).toHaveBeenCalled();
  });

  it("asks as before when 「確認」 is on, when it has fields, and when an older server leaves the field out", () => {
    const { store } = makeStore();
    const controller = controllerFor(store, {});
    const { confirm: _, ...old } = QUICK;
    const cases: Array<[WorkflowOut, string]> = [
      [{ ...QUICK, confirm: true }, "🏢 出勤"],
      [{ ...WORKFLOW, confirm: false }, "🙇 ゼミ欠席報告"],
      [old as WorkflowOut, "🏢 出勤"],
    ];
    for (const [workflow, name] of cases) {
      const view = render(<WorkflowRunDialog controller={controller} workflow={workflow} onClose={() => {}} />);
      expect(screen.getByRole("dialog", { name })).toBeTruthy();
      view.unmount();
    }
    expect(controller.submitWorkflow).not.toHaveBeenCalled();
  });

  it("from the channel's menu it posts and closes the menu", async () => {
    const { store, channel } = makeStore();
    const api = { channelWorkflows: vi.fn(async () => [{ ...QUICK, channel_id: "c-lab" }]) };
    const controller = controllerFor(store, api);
    controller.submitWorkflow.mockResolvedValueOnce({ ok: true, message: { id: "m1", channel_id: "c-lab" } });
    const onClose = vi.fn();
    render(<ChannelWorkflowsDialog controller={controller} channel={channel} onClose={onClose} />);
    await flush();
    fireEvent.click(within(screen.getByRole("list", { name: "ワークフロー" })).getByText("出勤"));
    await flush();
    expect(controller.submitWorkflow).toHaveBeenCalledTimes(1);
    expect(controller.setNotice).not.toHaveBeenCalled(); // posted here: the message shows up in the timeline
    expect(onClose).toHaveBeenCalled();
  });
});

describe("the label on a posted message", () => {
  const rowExtras = { messageFocus: null, editing: null, sendKey: "shift-enter", linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {} };
  /** A message in #報告-ゼミ欠席, posted by `workflow` (none for an ordinary one). */
  function posted(store: Store, id: string, workflow: { id: string; name: string } | null): MessageState {
    const message = {
      id, channel_id: "c-report", sender_id: ME, parent_id: null, seq: 1, updated_seq: 1, client_msg_id: null, type: "user",
      body: "*【報告者】* <@" + ME + ">", mentioned_user_ids: [ME], mention_all: false, reactions: [], attachments: [], reply_count: 0,
      last_reply_at: null, reply_user_ids: [], created_at: "2026-10-04T01:00:00Z", edited_at: null, deleted: false, poll: null, priority: null,
      ack_requested: false, acks: [], workflow,
    } as unknown as MessageOut;
    store.upsertMessage(message);
    return store.getMessage("c-report", id)!;
  }

  it("shows 「⚡ name」 and opens the form", async () => {
    const { store } = makeStore();
    const message = posted(store, "m1", { id: "w1", name: "ゼミ欠席報告" });
    const api = { baseUrl: "http://server", getWorkflow: vi.fn(async () => WORKFLOW) };
    const controller = controllerFor(store, api, rowExtras);
    render(<MessageRow controller={controller} message={message} />);
    const label = screen.getByRole("button", { name: "ゼミ欠席報告" });
    fireEvent.click(label);
    await flush();
    expect(api.getWorkflow).toHaveBeenCalledWith("w1");
    expect(screen.getByRole("dialog", { name: "🙇 ゼミ欠席報告" })).toBeTruthy();
  });

  it("opens the form even for a workflow that does not ask: a look at an old message is not a re-post (§11.3)", async () => {
    const { store } = makeStore();
    const message = posted(store, "m1", { id: QUICK.id, name: QUICK.name });
    const api = { baseUrl: "http://server", getWorkflow: vi.fn(async () => QUICK) };
    const controller = controllerFor(store, api, rowExtras);
    render(<MessageRow controller={controller} message={message} />);
    fireEvent.click(screen.getByRole("button", { name: "出勤" }));
    await flush();
    const dialog = within(screen.getByRole("dialog", { name: "🏢 出勤" }));
    expect(dialog.getByRole("button", { name: "投稿" })).toBeTruthy();
    expect(controller.submitWorkflow).not.toHaveBeenCalled();
    expect(controller.setNotice).not.toHaveBeenCalled();
  });

  it("an ordinary message has no label", () => {
    const { store } = makeStore();
    const message = posted(store, "m2", null);
    const controller = controllerFor(store, { baseUrl: "http://server" }, rowExtras);
    const { container } = render(<MessageRow controller={controller} message={message} />);
    expect(container.querySelector("[data-workflow-label]")).toBeNull();
  });
});

describe("the editor", () => {
  const SEED: WorkflowTemplateOut = {
    key: "seminar_absence",
    name: "ゼミ欠席報告",
    emoji: "🙇",
    description: "ゼミの欠席・遅刻・早退を報告します",
    fields: FIELDS,
    template: WORKFLOW.template,
  };

  it("starts from a template, previews, and creates", async () => {
    const { store } = makeStore();
    const api = {
      workflows: vi.fn(async () => [] as WorkflowOut[]),
      workflowTemplates: vi.fn(async () => [SEED]),
      createWorkflow: vi.fn(async (body: Record<string, unknown>) => ({ ...WORKFLOW, ...body, id: "w9" })),
    };
    const controller = controllerFor(store, api);
    render(<WorkflowManager controller={controller} channelId="c-report" />);
    await flush();
    expect(screen.getByText(/ワークフローはありません/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /ワークフローを作成/ }));
    await flush();
    const dialog = within(screen.getByRole("dialog", { name: "ワークフローを作成" }));
    fireEvent.click(dialog.getByRole("button", { name: "🙇 ゼミ欠席報告" }));
    expect((dialog.getByLabelText(/^名前/) as HTMLInputElement).value).toBe("ゼミ欠席報告");
    expect((dialog.getByLabelText("送り先") as HTMLSelectElement).value).toBe("c-report");
    expect(dialog.getAllByRole("listitem").filter((li) => li.hasAttribute("data-field-editor"))).toHaveLength(4);
    // The preview fills the defaults and examples: me, a date, the first option.
    const preview = within(dialog.getByLabelText("雛形のプレビュー"));
    expect(preview.getByText(/ゼミの欠席/)).toBeTruthy();
    // A placeholder naming no field stops the save.
    fireEvent.change(dialog.getByLabelText("雛形"), { target: { value: WORKFLOW.template + "\n{{場所}}" } });
    fireEvent.click(dialog.getByRole("button", { name: "作成" }));
    expect(dialog.getByRole("alert").textContent).toContain("{{場所}}");
    expect(api.createWorkflow).not.toHaveBeenCalled();
    fireEvent.change(dialog.getByLabelText("雛形"), { target: { value: WORKFLOW.template } });
    // Renaming a field's label renames its key and the template's placeholder with it.
    fireEvent.change(dialog.getByLabelText("項目 4 の名前"), { target: { value: "欠席の理由" } });
    expect((dialog.getByLabelText("項目 4 のキー") as HTMLInputElement).value).toBe("欠席の理由");
    expect((dialog.getByLabelText("雛形") as HTMLTextAreaElement).value).toContain("{{欠席の理由}}");
    fireEvent.click(dialog.getByRole("button", { name: "作成" }));
    await flush();
    expect(api.createWorkflow).toHaveBeenCalledTimes(1);
    const body = api.createWorkflow.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({ name: "ゼミ欠席報告", emoji: "🙇", channel_id: "c-report", offered_channel_ids: [] });
    expect((body.fields as Array<{ key: string }>).map((f) => f.key)).toEqual(["報告者", "日付", "内容", "欠席の理由"]);
    expect(screen.getByRole("status").textContent).toBe("保存しました");
  });

  it("chooses the emoji with the app's picker (custom emoji too) and saves 「確認を求める」", async () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    const { store } = makeStore();
    store.replaceCustomEmoji([
      { id: "e1", name: "parrot", content_type: "image/png", width: 64, height: 64, keywords: [], position: 0, created_by: ME, created_at: "", kind: "image", pack_id: null },
    ] as never);
    const api = {
      fetchBlob: vi.fn(async () => new Blob(["x"])),
      workflows: vi.fn(async () => [{ ...WORKFLOW, fields: [], template: "出勤しました" }]),
      workflowTemplates: vi.fn(async () => []),
      updateWorkflow: vi.fn(async (_id: string, body: Record<string, unknown>) => ({ ...WORKFLOW, ...body })),
    };
    const controller = controllerFor(store, api);
    render(<WorkflowManager controller={controller} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /編集/ }));
    const dialog = within(screen.getByRole("dialog", { name: "ワークフローを編集" }));
    // No text box for the emoji any more: the picker.
    fireEvent.click(dialog.getByRole("button", { name: "絵文字を変更" }));
    fireEvent.change(await screen.findByPlaceholderText("検索（例：tada、乾杯）"), { target: { value: "books" } });
    fireEvent.click(await screen.findByTitle(":books:"));
    fireEvent.click(dialog.getByRole("button", { name: "絵文字を変更" }));
    fireEvent.click(screen.getAllByTitle(":parrot:").find((el) => el.tagName === "BUTTON")!);
    // 「確認」 is on (as every workflow so far); off, it says what happens.
    const confirm = dialog.getByRole("switch", { name: /実行するときに確認する/ }) as HTMLInputElement;
    expect(confirm.checked).toBe(true);
    fireEvent.click(confirm);
    expect(dialog.getByText("オフにすると、メニューや /名前 で選んだらすぐに投稿します")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await flush();
    expect(api.updateWorkflow).toHaveBeenCalledWith("w1", expect.objectContaining({ emoji: ":parrot:", confirm: false }));
  });

  it("with fields, turning 「確認」 off says the form still opens; removing the emoji goes back to ⚡", async () => {
    const { store } = makeStore();
    const api = { workflows: vi.fn(async () => [WORKFLOW]), workflowTemplates: vi.fn(async () => []), updateWorkflow: vi.fn(async () => WORKFLOW) };
    const controller = controllerFor(store, api);
    render(<WorkflowManager controller={controller} />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /編集/ }));
    const dialog = within(screen.getByRole("dialog", { name: "ワークフローを編集" }));
    fireEvent.click(dialog.getByRole("switch", { name: /実行するときに確認する/ }));
    expect(dialog.getByText("項目があるので、オフでも入力のフォームは出ます")).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "絵文字を変更" }));
    fireEvent.click(await screen.findByRole("button", { name: "絵文字を外す" }));
    expect(dialog.getByRole("button", { name: "絵文字を選ぶ" })).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await flush();
    expect(api.updateWorkflow).toHaveBeenCalledWith("w1", expect.objectContaining({ emoji: null, confirm: false }));
  });

  it("adds, moves and removes fields", async () => {
    const { store } = makeStore();
    const api = { workflows: vi.fn(async () => [WORKFLOW]), workflowTemplates: vi.fn(async () => []), updateWorkflow: vi.fn(async () => WORKFLOW) };
    const controller = controllerFor(store, api);
    render(<WorkflowManager controller={controller} />);
    await flush();
    expect(screen.getByText(/#報告-ゼミ欠席 に投稿 · 項目 4 個 · ほか 1 チャンネルに表示/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /編集/ }));
    const dialog = within(screen.getByRole("dialog", { name: "ワークフローを編集" }));
    fireEvent.change(dialog.getByLabelText("項目を追加"), { target: { value: "checkbox" } });
    expect((dialog.getByLabelText("項目 5 の名前") as HTMLInputElement).value).toBe("チェック");
    fireEvent.click(dialog.getAllByRole("button", { name: "上へ" })[4]!);
    expect((dialog.getByLabelText("項目 4 の名前") as HTMLInputElement).value).toBe("チェック");
    fireEvent.click(dialog.getByRole("button", { name: "項目「チェック」を削除" }));
    expect(dialog.queryByLabelText("項目 5 の名前")).toBeNull();
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await flush();
    expect(api.updateWorkflow).toHaveBeenCalledWith("w1", expect.objectContaining({ channel_id: "c-report", offered_channel_ids: ["c-lab"] }));
  });
});

describe("the composer (`/name`, `/wf name`)", () => {
  async function world(extraTemplates: Array<{ id: string; name: string; body: string }> = [], extraWorkflows: WorkflowOut[] = []) {
    const server = new FakeServer();
    const me = server.addUser("alice");
    const channel = server.createChannel("general", me.id);
    const store = new Store();
    store.upsertUser(me);
    store.upsertChannel(channel, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
    store.replaceTemplates(extraTemplates.map((t) => ({ scope: "workspace", owner_id: null, suggest_in: "any", position: 0, created_at: "", updated_at: "", ...t })) as never);
    const spaced = { ...WORKFLOW, id: "w3", name: "学部 ゼミ案内", channel_id: channel.id };
    const api = { channelWorkflows: vi.fn(async () => [{ ...WORKFLOW, channel_id: channel.id }, spaced, ...extraWorkflows.map((w) => ({ ...w, channel_id: channel.id }))]) };
    const setError = vi.fn();
    const submitWorkflow = vi.fn(async () => ({ ok: true, message: { id: "m1", channel_id: channel.id } }));
    const controller = {
      store, api, setError, setNotice: vi.fn(), submitWorkflow, messageFocus: null, sendKey: "shift-enter", isAdmin: false, subscribe: () => () => {},
      engine: { send: vi.fn(), sendTyping: vi.fn(), status: "online", unreadHold: new Map(), reloadCount: () => 0 },
    } as unknown as AppController;
    function View() {
      useSyncExternalStore(store.subscribe.bind(store), () => store.version);
      return <Composer controller={controller} channel={store.getChannel(channel.id)!} parentId={null} />;
    }
    render(<View />);
    await flush();
    const area = screen.getByRole("textbox") as HTMLTextAreaElement; // the form adds its own boxes later
    const box = () => area;
    const type = (value: string) => fireEvent.change(box(), { target: { value } });
    const sendKey = async () => { await act(async () => { fireEvent.keyDown(box(), { key: "Escape" }); fireEvent.keyDown(box(), { key: "Enter", shiftKey: true }); }); };
    return { api, box, type, sendKey, setError, channel, submitWorkflow };
  }

  it("offers workflows among the `/` candidates and opens the form", async () => {
    const { api, box, type, sendKey, channel } = await world();
    expect(api.channelWorkflows).toHaveBeenCalledWith(channel.id);
    type("/ゼミ");
    const list = within(screen.getByRole("list", { name: "コマンドの候補" }));
    expect(list.getByText("/ゼミ欠席報告")).toBeTruthy();
    type("/ゼミ欠席報告");
    await sendKey();
    expect(screen.getByRole("dialog", { name: "🙇 ゼミ欠席報告" })).toBeTruthy();
    expect(box().value).toBe("");
  });

  it("`/name` of a workflow that does not ask posts at once", async () => {
    const { type, sendKey, channel, submitWorkflow } = await world([], [QUICK]);
    type("/出勤");
    await sendKey();
    await flush();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    expect(submitWorkflow.mock.calls[0]!.slice(0, 2)).toEqual(["w-quick", {}]);
    expect(channel.id).toBeTruthy();
  });

  it("`/b` while `/a` (posting at once) is still under way: B's own form and key, which A's answer does not close", async () => {
    const asks: WorkflowOut = { ...WORKFLOW, id: "w-asks", name: "退勤", fields: [], template: "退勤しました" };
    const { type, sendKey, channel, submitWorkflow } = await world([], [QUICK, asks]);
    type Answer = Awaited<ReturnType<typeof submitWorkflow>>;
    let answerA: (value: Answer) => void = () => {};
    submitWorkflow.mockImplementationOnce(() => new Promise<Answer>((resolve) => { answerA = resolve; }));
    type("/出勤");
    await sendKey();
    await flush();
    expect(submitWorkflow).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    type("/退勤");
    await sendKey();
    const dialog = within(screen.getByRole("dialog", { name: "🙇 退勤" }));
    // A's post answers now: B's form stays open.
    await act(async () => answerA({ ok: true, message: { id: "m1", channel_id: channel.id } }));
    await flush();
    expect(screen.getByRole("dialog", { name: "🙇 退勤" })).toBeTruthy();
    fireEvent.click(dialog.getByRole("button", { name: "投稿" }));
    await flush();
    expect(submitWorkflow).toHaveBeenCalledTimes(2);
    const [a, b] = submitWorkflow.mock.calls as unknown as Array<[string, Record<string, unknown>, string]>;
    expect(a![0]).toBe("w-quick");
    expect(b![0]).toBe("w-asks");
    expect(b![2]).not.toBe(a![2]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("`/wf name` opens a name with spaces", async () => {
    const { type, sendKey } = await world();
    type("/wf 学部 ゼミ案内");
    await sendKey();
    expect(screen.getByRole("dialog", { name: "🙇 学部 ゼミ案内" })).toBeTruthy();
  });

  it("an unknown `/wf` name says so", async () => {
    const { type, sendKey, setError } = await world();
    type("/wf ない");
    await sendKey();
    expect(setError).toHaveBeenCalledWith("「ない」というワークフローはこのチャンネルにありません");
  });

  it("a template of the same name comes first", async () => {
    const { box, type, sendKey } = await world([{ id: "t1", name: "ゼミ欠席報告", body: "テンプレートの本文" }]);
    type("/ゼミ欠席報告");
    await sendKey();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(box().value).toBe("テンプレートの本文");
  });
});
