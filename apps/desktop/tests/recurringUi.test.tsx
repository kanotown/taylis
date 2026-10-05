// @vitest-environment jsdom
// L6 (M59, RECURRING.md §5): the channel's 「定期投稿」 list (members read, managers act), the create / edit dialog, and the
// collection chip under a post, which follows message.updated.
process.env.TZ = "Asia/Tokyo";

import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { ChannelOut, GroupOut, MessageOut, RecurringPostOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { ChannelState } from "../src/sync/types";
import { RecurringPostList } from "../src/ui/RecurringPosts";
import { MessageRow } from "../src/ui/Timeline";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

const ME = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";
const CAROL = "33333333-3333-4333-8333-333333333333";
const BOT = "44444444-4444-4444-8444-444444444444";
const people: UserPublic[] = [
  { id: ME, username: "me", display_name: "わたし", role: "member" } as UserPublic,
  { id: BOB, username: "bob", display_name: "ボブ", role: "member" } as UserPublic,
  { id: CAROL, username: "carol", display_name: "キャロル", role: "member" } as UserPublic,
  { id: BOT, username: "recurring-1", display_name: "週報", role: "bot" } as UserPublic,
];

const POST: RecurringPostOut = {
  id: "p1",
  channel_id: "c-lab",
  bot_user_id: BOT,
  created_by: ME,
  name: "週報",
  body: "**週報 {date}**",
  schedule: { kind: "weekly", weekdays: [0, 3], time: "09:00" },
  tz: "Asia/Tokyo",
  collect: { targets: { all_members: false, group_ids: ["g1"], user_ids: [CAROL] }, due: { after_days: 3, time: "18:00" } },
  enabled: true,
  next_run_at: "2026-10-05T00:00:00Z",
  last_run_at: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
};

function setup({ role = "owner", admin = false, rows = [POST] }: { role?: "owner" | "member"; admin?: boolean; rows?: RecurringPostOut[] } = {}) {
  const store = new Store();
  store.setMe({ ...people[0]! } as unknown as UserMe);
  for (const user of people) store.upsertUser(user);
  store.replaceGroups([{ id: "g1", name: "students", member_ids: [BOB] } as unknown as GroupOut]);
  const channel = store.upsertChannel(
    { id: "c-lab", type: "public", name: "lab", topic: null, purpose: null, archived: false, created_at: "2026-01-01T00:00:00Z", last_seq: 0, posting_policy: "everyone" } as unknown as ChannelOut,
    { isMember: true, membership: { role } as never },
  );
  let list = rows;
  const api = {
    recurringPosts: vi.fn(async () => list),
    createRecurringPost: vi.fn(async (_c: string, body: Record<string, unknown>) => ({ ...POST, ...body, id: "p2" })),
    updateRecurringPost: vi.fn(async (id: string, body: Record<string, unknown>) => {
      list = list.map((p) => (p.id === id ? { ...p, ...body } as RecurringPostOut : p));
      return list.find((p) => p.id === id);
    }),
    deleteRecurringPost: vi.fn(async (id: string) => { list = list.filter((p) => p.id !== id); }),
    runRecurringPost: vi.fn(async () => ({ message_id: "m9" })),
    members: vi.fn(async () => [ME, BOB, CAROL, BOT].map((user_id) => ({ user_id, role: "member", joined_at: "2026-01-01T00:00:00Z" }))),
  };
  const controller = {
    store, api, isAdmin: admin, version: 0, subscribe: () => () => {}, setError: vi.fn(), setNotice: vi.fn(),
  } as unknown as AppController;
  render(<RecurringPostList controller={controller} channel={channel as ChannelState} />);
  return { api, controller, store };
}

describe("the list", () => {
  it("members read it without the actions", async () => {
    const { api } = setup({ role: "member" });
    await flush();
    expect(api.recurringPosts).toHaveBeenCalledWith("c-lab");
    const row = screen.getByText("週報").closest("li")!;
    expect(within(row).getByText(/毎週 月・木 9:00 · 次回 10\/5 \(月\) 9:00/)).toBeTruthy();
    expect(within(row).getByText("回収：@students、キャロル · 3 日後 18:00 締切")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /今すぐ投稿/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /定期投稿を追加/ })).toBeNull();
  });

  it("an administrator who is a member manages it: 今すぐ投稿, 止める, 再開", async () => {
    const { api } = setup({ role: "member", admin: true });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /今すぐ投稿/ }));
    await flush();
    expect(api.runRecurringPost).toHaveBeenCalledWith("p1");
    expect(screen.getByRole("status").textContent).toBe("投稿しました");
    fireEvent.click(screen.getByRole("button", { name: /止める/ }));
    await flush();
    expect(api.updateRecurringPost).toHaveBeenCalledWith("p1", { enabled: false });
    expect(screen.getByText("停止中")).toBeTruthy();
    expect(screen.queryByText(/次回/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /再開/ }));
    await flush();
    expect(api.updateRecurringPost).toHaveBeenLastCalledWith("p1", { enabled: true });
  });

  it("deletes after asking", async () => {
    const { api } = setup();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /削除/ }));
    expect(screen.getByText(/「週報」を削除しますか/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(api.deleteRecurringPost).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /削除/ }));
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await flush();
    expect(api.deleteRecurringPost).toHaveBeenCalledWith("p1");
    expect(screen.getByText(/定期投稿はありません/)).toBeTruthy();
  });

  it("says why an action failed", async () => {
    const { api } = setup();
    await flush();
    api.runRecurringPost.mockRejectedValueOnce(new ApiError(409, "channel_archived", "Channel is archived"));
    fireEvent.click(screen.getByRole("button", { name: /今すぐ投稿/ }));
    await flush();
    expect(screen.getByRole("alert").textContent).toBe("アーカイブされたチャンネルです");
  });
});

describe("the dialog", () => {
  it("checks the draft, then creates with this device's zone", async () => {
    const { api } = setup({ rows: [] });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /定期投稿を追加/ }));
    const dialog = within(screen.getByRole("dialog", { name: "定期投稿を追加" }));
    expect(dialog.getByText(/\{date\} → \d{4}\/\d{2}\/\d{2}/)).toBeTruthy(); // the placeholders' hint
    fireEvent.click(dialog.getByRole("button", { name: "追加" }));
    expect(dialog.getByRole("alert").textContent).toBe("名前を入力してください");
    fireEvent.change(dialog.getByPlaceholderText("週報"), { target: { value: "週報" } });
    fireEvent.change(dialog.getByRole("textbox", { name: /本文/ }), { target: { value: "今週の進捗 {date}" } });
    // Only Thursday (today's weekday in the draft may differ: clear them all, then pick).
    for (const label of ["月", "火", "水", "木", "金", "土", "日"]) {
      const day = dialog.getByRole("button", { name: `${label}曜日` });
      if (day.getAttribute("aria-pressed") === "true") fireEvent.click(day);
    }
    fireEvent.click(dialog.getByRole("button", { name: "追加" }));
    expect(dialog.getByRole("alert").textContent).toBe("曜日を 1 つ以上選んでください");
    fireEvent.click(dialog.getByRole("button", { name: "木曜日" }));
    fireEvent.change(dialog.getByLabelText("時刻"), { target: { value: "10:30" } });
    fireEvent.click(dialog.getByRole("switch"));
    await flush();
    fireEvent.click(dialog.getByRole("button", { name: "追加" }));
    expect(dialog.getByRole("alert").textContent).toBe("提出する人を選んでください");
    // The members to pick from leave the bot out; a group is a chip.
    const people = within(dialog.getByRole("group", { name: "メンバー" }));
    expect(people.queryByText("週報")).toBeNull();
    fireEvent.click(people.getByLabelText("ボブ"));
    fireEvent.click(dialog.getByRole("button", { name: "@students" }));
    fireEvent.change(dialog.getByLabelText("締切の日"), { target: { value: "2" } });
    fireEvent.click(dialog.getByRole("button", { name: "追加" }));
    await flush();
    expect(api.createRecurringPost).toHaveBeenCalledWith("c-lab", {
      name: "週報",
      body: "今週の進捗 {date}",
      schedule: { kind: "weekly", weekdays: [3], time: "10:30" },
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
      collect: { targets: { all_members: false, group_ids: ["g1"], user_ids: [BOB] }, due: { after_days: 2, time: "18:00" } },
      enabled: true,
    });
    expect(screen.queryByRole("dialog", { name: "定期投稿を追加" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("保存しました");
  });

  it("edits monthly, and shows the server's refusal", async () => {
    const { api } = setup();
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /編集/ }));
    const dialog = within(screen.getByRole("dialog", { name: "定期投稿を編集" }));
    expect((dialog.getByPlaceholderText("週報") as HTMLInputElement).value).toBe("週報");
    fireEvent.click(dialog.getByRole("radio", { name: "毎月" }));
    fireEvent.change(dialog.getByLabelText("日"), { target: { value: "31" } });
    api.updateRecurringPost.mockRejectedValueOnce(new ApiError(403, "recurring_manage_restricted", "no"));
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await flush();
    expect(dialog.getByRole("alert").textContent).toBe("定期投稿を管理できるのは、チャンネルのオーナーと管理者だけです");
    fireEvent.click(dialog.getByRole("button", { name: "保存" }));
    await flush();
    expect(api.updateRecurringPost).toHaveBeenLastCalledWith("p1", {
      name: "週報",
      body: "**週報 {date}**",
      schedule: { kind: "monthly", day: 31, time: "09:00" },
      collect: POST.collect,
    });
  });
});

describe("the collection chip", () => {
  function timeline(submitted: string[], due = "2099-10-09T09:00:00Z") {
    const store = new Store();
    store.setMe({ ...people[0]! } as unknown as UserMe);
    for (const user of people) store.upsertUser(user);
    store.upsertChannel(
      { id: "c-lab", type: "public", name: "lab", topic: null, purpose: null, archived: false, created_at: "2026-01-01T00:00:00Z", last_seq: 1, posting_policy: "everyone" } as unknown as ChannelOut,
      { isMember: true, syncedSeq: 1, oldestLoadedSeq: 0, lastReadSeq: 1, membership: { role: "member" } as never },
    );
    const message = {
      id: "m1", channel_id: "c-lab", sender_id: BOT, parent_id: null, seq: 1, updated_seq: 2, client_msg_id: null, type: "user", body: "**週報 2026/10/05 (月)**",
      mentioned_user_ids: [], mention_all: false, reactions: [], attachments: [], reply_count: 0, last_reply_at: null, reply_user_ids: [],
      created_at: "2026-10-05T00:00:00Z", edited_at: null, deleted: false, poll: null, priority: null, ack_requested: false, acks: [],
      collection: { due_at: due, target_user_ids: [ME, BOB, CAROL], target_count: 3, submitted_user_ids: submitted, reminded_at: null },
    } as unknown as MessageOut;
    store.upsertMessage(message);
    const controller = {
      store, api: { baseUrl: "http://server" }, version: 0, setError: vi.fn(), setNotice: vi.fn(), messageFocus: null, editing: null, isAdmin: false, sendKey: "shift-enter",
      linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {},
    };
    function View() {
      useSyncExternalStore((l) => store.subscribe(l), () => store.version);
      return <MessageRow controller={controller as unknown as AppController} message={store.getMessage("c-lab", "m1")!} />;
    }
    render(<View />);
    return { store, message };
  }

  it("stands out while I owe one, and follows message.updated", async () => {
    const { store, message } = timeline([BOB]);
    const chip = screen.getByRole("button", { name: /提出 1\/3 · 締切 10\/9 \(金\) 18:00 \(未提出\)/ });
    expect(within(chip).getByText("未提出").className).toContain("bg-warning");
    // My reply arrives elsewhere: the parent's message.updated (change collection) carries the new count.
    act(() => {
      store.upsertMessage({ ...message, updated_seq: 4, reply_count: 1, collection: { ...message.collection!, submitted_user_ids: [ME, BOB] } } as MessageOut);
    });
    expect(screen.getByRole("button", { name: /提出 2\/3 .* \(提出済み\)/ })).toBeTruthy();
    expect(screen.queryByText("未提出")).toBeNull();
  });

  it("past the due time, still owing one, is red; the lists open from the chip", async () => {
    timeline([BOB], "2020-10-09T09:00:00Z");
    const chip = screen.getByRole("button", { name: /\(未提出\)/ });
    expect(within(chip).getByText("未提出").className).toContain("bg-danger");
    fireEvent.click(chip);
    const dialog = within(screen.getByRole("dialog", { name: "提出状況" }));
    expect(dialog.getByText("提出 1/3 · 締切 10/9 (金) 18:00（締切を過ぎました）")).toBeTruthy();
    const done = within(screen.getByRole("region", { name: "提出済み" }));
    expect(done.getByText("提出済み 1 人")).toBeTruthy();
    expect(done.getByText("ボブ")).toBeTruthy();
    const missing = within(screen.getByRole("region", { name: "未提出" }));
    expect(missing.getByText("未提出 2 人")).toBeTruthy();
    expect(missing.getByText("わたし")).toBeTruthy();
    expect(missing.getByText("キャロル")).toBeTruthy();
  });

  it("someone who is not a target sees the count only", () => {
    const { store, message } = timeline([]);
    act(() => {
      store.upsertMessage({ ...message, updated_seq: 3, collection: { ...message.collection!, target_user_ids: [BOB], target_count: 1 } } as MessageOut);
    });
    const chip = screen.getByRole("button", { name: "提出 0/1 · 締切 10/9 (金) 18:00" });
    expect(within(chip).queryByText("未提出")).toBeNull();
  });
});
