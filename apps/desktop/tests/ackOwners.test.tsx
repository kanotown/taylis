// @vitest-environment jsdom
/**
 * M31 (L4) on the Web: who has not acknowledged and reminding them, 「確認のお願い」 in the reminders, channel owners made
 * and taken back (and channel.member_updated for me), 「在席を隠す」 and who may make a private channel public.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import { ApiError } from "../src/api/errors";
import { ERROR_MESSAGES } from "../src/api/errorMessages";
import type { ChannelOut, MemberOut, ReminderOut, UserMe, UserPublic } from "../src/api/types";
import { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import type { ChannelState, MessageState } from "../src/sync/types";
import { ChannelDetails } from "../src/ui/ChannelDetails";
import { canMakePublic } from "../src/ui/channels";
import { MembersDialog } from "../src/ui/Dialogs";
import { SettingsDialog } from "../src/ui/Settings";
import { RemindersView } from "../src/ui/RemindersView";
import { AcksDialog } from "../src/ui/WhoDialogs";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** A controller on a stub API (only what the test names), me signed in with the given role. */
function controllerFor(me: UserPublic, api: Record<string, unknown>, store?: Store): AppController {
  const controller = new AppController();
  controller.api = { baseUrl: "http://server", ...api } as unknown as ApiClient;
  if (store) (controller as unknown as { active: { store: Store } }).active.store = store;
  controller.store.setMe({ ...me, email: null, must_change_password: false, notify_keywords: [], presence_hidden: false, notification_default: "mentions", notify_reactions: false, has_password: true } as UserMe);
  controller.store.upsertUser(me);
  return controller;
}

describe("未確認の人 (L4)", () => {
  function setup(meName: "bob" | "carol" | "admin") {
    const server = new FakeServer();
    const bob = server.addUser("bob");
    const carol = server.addUser("carol");
    const dave = server.addUser("dave");
    const admin = server.addUser("admin", "admin");
    const channel = server.createChannel("general", bob.id);
    for (const user of [carol, dave, admin]) server.join(channel.id, user.id);
    const message = server.post(channel.id, bob.id, "明日の件です", undefined, null, [], { ackRequested: true }).message as unknown as MessageState;
    const acked = { ...message, acks: [{ user_id: carol.id, acked_at: "2026-09-29T01:00:00Z" }] } as MessageState;
    let pending = [dave.id, admin.id];
    const calls = { pending: 0, remind: 0 };
    let remindResult: () => Promise<{ reminded: number }> = async () => ({ reminded: pending.length });
    const me = { bob, carol, admin }[meName];
    const controller = controllerFor(me, {
      ackPending: async (id: string) => { expect(id).toBe(message.id); calls.pending += 1; return { user_ids: pending }; },
      ackRemind: async (id: string) => { expect(id).toBe(message.id); calls.remind += 1; return remindResult(); },
    });
    for (const user of [bob, carol, dave, admin]) controller.store.upsertUser(user);
    render(<AcksDialog controller={controller} message={acked} onClose={() => {}} />);
    return {
      controller, calls, dave,
      setPending: (ids: string[]) => { pending = ids; },
      failRemind: (error: Error) => { remindResult = async () => { throw error; }; },
      section: () => within(screen.getByRole("region", { name: "未確認" })),
    };
  }

  it("lists who has not confirmed; the author reminds them and hears how many", async () => {
    const w = setup("bob");
    expect(await w.section().findByText("未確認 2 人")).toBeTruthy();
    expect(w.section().getByText("Dave")).toBeTruthy();
    expect(w.section().getByText("Admin")).toBeTruthy();
    expect(within(screen.getByRole("dialog", { name: "確認した人" })).getByText("Carol")).toBeTruthy(); // the acks above
    expect(w.calls.pending).toBe(1);

    w.setPending([w.dave.id]);
    fireEvent.click(w.section().getByRole("button", { name: "未確認の人にリマインド" }));
    await flush();
    expect(w.calls.remind).toBe(1);
    // In the list itself (the app's toast would sit behind the dialog).
    expect(w.section().getByRole("status").textContent).toBe("1 人にリマインドしました");
    expect(w.controller.notice).toBeNull();
    // The list loads again after the reminder.
    expect(w.calls.pending).toBe(2);
    expect(await w.section().findByText("未確認 1 人")).toBeTruthy();

    w.setPending([]);
    fireEvent.click(w.section().getByRole("button", { name: "未確認の人にリマインド" }));
    await flush();
    expect(w.section().getByRole("status").textContent).toBe("リマインド済みの人だけです"); // 0 reminded
    // Nobody left: no button.
    expect(await w.section().findByText("全員が確認しました")).toBeTruthy();
    expect(w.section().queryByRole("button", { name: "未確認の人にリマインド" })).toBeNull();
  });

  it("an admin may remind; another member only sees the list", async () => {
    const admin = setup("admin");
    expect(await admin.section().findByText("未確認 2 人")).toBeTruthy();
    expect(admin.section().getByRole("button", { name: "未確認の人にリマインド" })).toBeTruthy();
    cleanup();
    const carol = setup("carol");
    expect(await carol.section().findByText("未確認 2 人")).toBeTruthy();
    expect(carol.section().queryByRole("button", { name: "未確認の人にリマインド" })).toBeNull();
  });

  it("once an hour: the server's 429 shows in red under the button", async () => {
    const w = setup("bob");
    await w.section().findByText("未確認 2 人");
    w.failRemind(new ApiError(429, "ack_remind_too_soon", "too soon", { retry_after_seconds: 1200 }));
    fireEvent.click(w.section().getByRole("button", { name: "未確認の人にリマインド" }));
    await flush();
    const alert = w.section().getByRole("alert");
    expect(alert.textContent).toBe(ERROR_MESSAGES.ack_remind_too_soon);
    expect(alert.className).toContain("text-danger");
    expect(w.calls.pending).toBe(1); // nothing to load again
  });
});

describe("確認のお願い in the reminders (L4)", () => {
  it("marks the reminders someone asked for, not my own", () => {
    const server = new FakeServer();
    const bob = server.addUser("bob");
    const channel = server.createChannel("general", bob.id);
    const store = new Store();
    store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true });
    const controller = controllerFor(bob, {}, store);
    const base = { message_id: "m1", channel_id: channel.id, preview: "本文", remind_at: "2026-09-29T01:00:00Z", fired_at: "2026-09-29T01:00:00Z", status: "fired", created_at: "2026-09-29T00:00:00Z" } as const;
    store.replaceReminders([
      { ...base, id: "r1", kind: "ack", note: "Alice さんから確認のお願い" },
      { ...base, id: "r2", kind: "personal", note: "自分のメモ" },
    ] as ReminderOut[]);
    render(<RemindersView controller={controller} onOpen={() => {}} />);
    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    const ask = rows.find((r) => r.textContent?.includes("Alice さんから確認のお願い"))!;
    const mine = rows.find((r) => r.textContent?.includes("自分のメモ"))!;
    expect(within(ask).getByText("確認のお願い")).toBeTruthy();
    expect(within(mine).queryByText("確認のお願い")).toBeNull();
  });
});

describe("channel owners (L4)", () => {
  it("an owner makes a member an owner (PATCH) and takes it back; not for guests and bots, nothing in a DM", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    const guest = { ...server.addUser("gina"), role: "guest" } as UserPublic;
    const bot = { ...server.addUser("robo"), role: "bot" } as UserPublic;
    const channel = server.createChannel("lab", alice.id);
    for (const user of [bob, guest, bot]) server.join(channel.id, user.id);
    const patches: Array<[string, string, string]> = [];
    const controller = controllerFor(alice, {
      members: async () => server.memberList(channel.id),
      setMemberRole: async (channelId: string, userId: string, role: "owner" | "member") => { patches.push([channelId, userId, role]); return { user_id: userId, role, joined_at: "" } satisfies MemberOut; },
    });
    for (const user of [bob, guest, bot]) controller.store.upsertUser(user);
    const lab = controller.store.upsertChannel({ ...server.channels.get(channel.id)!.channel, membership: { role: "owner", joined_at: "" } } as ChannelOut, { isMember: true });
    render(<MembersDialog controller={controller} channel={lab} onClose={() => {}} onAdd={() => {}} />);
    const row = async (name: string) => (await screen.findByText(name)).closest("li")!;
    expect(within(await row("Alice")).getByRole("button", { name: "オーナーから外す" })).toBeTruthy(); // me, the owner
    expect(within(await row("Gina")).queryByRole("button", { name: "オーナーにする" })).toBeNull();
    expect(within(await row("Robo")).queryByRole("button", { name: "オーナーにする" })).toBeNull();

    fireEvent.click(within(await row("Bob")).getByRole("button", { name: "オーナーにする" }));
    await flush();
    expect(patches).toEqual([[channel.id, bob.id, "owner"]]);
    expect(within(await row("Bob")).getByText("オーナー")).toBeTruthy();
    fireEvent.click(within(await row("Bob")).getByRole("button", { name: "オーナーから外す" }));
    await flush();
    expect(patches.at(-1)).toEqual([channel.id, bob.id, "member"]);
    expect(within(await row("Bob")).getByRole("button", { name: "オーナーにする" })).toBeTruthy();
    cleanup();

    // A member who is not an owner (nor an admin) gets no buttons; neither does anyone in a DM.
    controller.store.updateChannel(channel.id, { membership: { role: "member", joined_at: "" } });
    render(<MembersDialog controller={controller} channel={controller.store.getChannel(channel.id)!} onClose={() => {}} onAdd={() => {}} />);
    await screen.findByText("Bob");
    expect(screen.queryByRole("button", { name: /オーナー/ })).toBeNull();
    cleanup();
    const dm = { ...lab, id: "dm1", type: "dm", name: null, membership: { role: "owner", joined_at: "" } } as ChannelState;
    render(<MembersDialog controller={controller} channel={dm} onClose={() => {}} onAdd={() => {}} />);
    await screen.findByText("Bob");
    expect(screen.queryByRole("button", { name: /オーナー/ })).toBeNull();
  });

  it("channel.member_updated for me moves the owner-only settings at once and reloads the open member list", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    const channel = server.createChannel("lab", alice.id);
    server.join(channel.id, bob.id);
    const store = new Store();
    const engine = new SyncEngine({ api: server.apiFor(alice.id), connect: server.connectorFor(alice.id), store, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 3 });
    await engine.start();
    await engine.idle();
    let memberLoads = 0;
    const controller = controllerFor(alice, { members: async () => { memberLoads += 1; return server.memberList(channel.id); } }, store);
    for (const user of [alice, bob]) store.upsertUser(user);
    function View() {
      useSyncExternalStore((l) => store.subscribe(l), () => store.version);
      return <ChannelDetails controller={controller} channel={store.getChannel(channel.id)!} onClose={() => {}} onDialog={() => {}} membersVersion={0} />;
    }
    render(<View />);
    await screen.findByText("Bob");
    expect(memberLoads).toBe(1);
    expect(screen.getByRole("button", { name: "アーカイブ…" })).toBeTruthy(); // I am the owner

    // Someone (another owner, an admin) takes my owner role back; bob became one before.
    await act(async () => {
      server.setMemberRole(channel.id, bob.id, "owner");
      server.setMemberRole(channel.id, alice.id, "member");
      await engine.idle();
    });
    await flush();
    expect(store.getChannel(channel.id)?.membership?.role).toBe("member");
    expect(screen.queryByRole("button", { name: "アーカイブ…" })).toBeNull();
    expect(screen.queryByRole("button", { name: "オーナーにする" })).toBeNull();
    await waitFor(() => expect(memberLoads).toBeGreaterThanOrEqual(2));
    const bobRow = (await screen.findByText("Bob")).closest("li")!;
    await waitFor(() => expect(within(bobRow).getByText("オーナー")).toBeTruthy());

    // Made an owner again.
    await act(async () => {
      server.setMemberRole(channel.id, alice.id, "owner");
      await engine.idle();
    });
    expect(screen.getByRole("button", { name: "アーカイブ…" })).toBeTruthy();
    engine.stop();
  });
});

describe("在席を隠す (L4)", () => {
  it("PATCHes presence_hidden and shows what the server says", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const patches: unknown[] = [];
    const controller = controllerFor(alice, {
      totpStatus: async () => ({ enabled: false, recovery_codes_left: 0 }),
      updateMe: async (patch: { presence_hidden?: boolean }) => { patches.push(patch); return { ...controller.store.me!, ...patch }; },
    });
    function View() {
      useSyncExternalStore((l) => controller.store.subscribe(l), () => controller.store.version);
      return <SettingsDialog controller={controller} onClose={() => {}} />;
    }
    render(<View />);
    // M40: under 「プロフィールを編集」 in the settings' list.
    fireEvent.click(within(screen.getByRole("navigation", { name: "設定の項目" })).getByRole("button", { name: /^プロフィールを編集/ }));
    const toggle = screen.getByRole("switch", { name: /在席を隠す/ }) as HTMLInputElement;
    expect(screen.getByText("ほかの人からは常にオフラインに見えます")).toBeTruthy();
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    await flush();
    expect(patches).toEqual([{ presence_hidden: true }]);
    expect(controller.store.me?.presence_hidden).toBe(true);
    expect((screen.getByRole("switch", { name: /在席を隠す/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("switch", { name: /在席を隠す/ }));
    await flush();
    expect(patches.at(-1)).toEqual({ presence_hidden: false });
    expect((screen.getByRole("switch", { name: /在席を隠す/ }) as HTMLInputElement).checked).toBe(false);
  });
});

describe("private → public (L4)", () => {
  const channel = (patch: Partial<ChannelState>) => ({ type: "private", isMember: true, ...patch }) as ChannelState;

  it("only an admin who is a member of the channel", () => {
    expect(canMakePublic(channel({}), true)).toBe(true);
    expect(canMakePublic(channel({ isMember: false }), true)).toBe(false); // 403 admin_not_member
    expect(canMakePublic(channel({}), false)).toBe(false);
    expect(canMakePublic(channel({ type: "public" }), true)).toBe(false);
  });

  it("the details page offers it to a member admin and not to an owner who is not an admin", async () => {
    vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }));
    const server = new FakeServer();
    const admin = server.addUser("admin", "admin");
    const owner = server.addUser("olive");
    const lab = { ...server.createChannel("lab", owner.id), type: "private" } as ChannelOut;
    for (const [me, role] of [[admin, "member"], [owner, "owner"]] as const) {
      const controller = controllerFor(me, { members: async () => [] });
      const state = controller.store.upsertChannel({ ...lab, membership: { role, joined_at: "" } }, { isMember: true });
      render(<ChannelDetails controller={controller} channel={state} onClose={() => {}} onDialog={() => {}} membersVersion={0} />);
      await flush();
      expect(!!screen.queryByRole("button", { name: "公開チャンネルに変換…" })).toBe(me === admin);
      cleanup();
    }
  });
});
