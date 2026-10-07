// @vitest-environment jsdom
/**
 * Calls by meeting link (M117, docs/CALLS.md §7): 📞 in the header when the workspace has calls on and I may post, the
 * confirm dialog and its retry-safe id, and the call card in the timeline. M130 retired the administrator's meeting
 * service field (docs/CALLS.md §11): its test checks that the settings screen no longer shows it.
 */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { AdminWorkspaceSettingsOut, LinkPreviewOut, MessageOut, UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { ChannelState } from "../src/sync/types";
import { CallButton, callHidesBody, canStartCall } from "../src/ui/Calls";
import { Timeline } from "../src/ui/Timeline";
import { WorkspaceSettingsTab } from "../src/ui/WorkspaceSettingsTab";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const URL_ = "https://meet.jit.si/taylis-abcdefghijklmnopqrstuvwx";
const BODY = `📞 通話を始めました\n${URL_}`;

const channel = (extra: Partial<ChannelState> = {}) =>
  ({ id: "c1", name: "general", type: "public", archived: false, isMember: true, posting_policy: "everyone", membership: { role: "member" }, ...extra }) as unknown as ChannelState;

describe("📞 (canStartCall)", () => {
  const controllerWith = (settings: Partial<Store["workspaceSettings"]> | null, isAdmin = false) => {
    const store = new Store();
    if (settings) store.setWorkspaceSettings({ show_membership_messages: true, preview_before_join: true, ...settings });
    return { store, isAdmin } as unknown as AppController;
  };

  it("shows only when the server says calls are on (a server before M117 says nothing: hidden)", () => {
    expect(canStartCall(controllerWith(null), channel())).toBe(false);
    expect(canStartCall(controllerWith({}), channel())).toBe(false);
    expect(canStartCall(controllerWith({ calls_enabled: false, meeting_base_url: null }), channel())).toBe(false);
    expect(canStartCall(controllerWith({ calls_enabled: true, meeting_base_url: "https://meet.jit.si/" }), channel())).toBe(true);
  });

  it("not in an archived conversation, nor where I may not post top-level, nor before joining; DMs too", () => {
    const on = controllerWith({ calls_enabled: true });
    expect(canStartCall(on, channel({ archived: true }))).toBe(false);
    expect(canStartCall(on, channel({ isMember: false }))).toBe(false);
    expect(canStartCall(on, channel({ posting_policy: "owners" }))).toBe(false);
    expect(canStartCall(on, channel({ posting_policy: "owners", membership: { role: "owner" } } as Partial<ChannelState>))).toBe(true);
    expect(canStartCall(controllerWith({ calls_enabled: true }, true), channel({ posting_policy: "owners" }))).toBe(true);
    expect(canStartCall(on, channel({ type: "dm" }))).toBe(true);
    expect(canStartCall(on, channel({ type: "group_dm" }))).toBe(true);
  });

  it("follows workspace.settings_updated (the store notices the calls fields change)", () => {
    const store = new Store();
    const seen = vi.fn();
    store.subscribe(seen);
    store.setWorkspaceSettings({ show_membership_messages: true, preview_before_join: true, calls_enabled: true, meeting_base_url: "https://meet.jit.si/" });
    expect(seen).toHaveBeenCalledTimes(1);
    store.setWorkspaceSettings({ show_membership_messages: true, preview_before_join: true, calls_enabled: true, meeting_base_url: "https://jitsi.example.org/" });
    expect(seen).toHaveBeenCalledTimes(2);
    store.setWorkspaceSettings({ show_membership_messages: true, preview_before_join: true, calls_enabled: false, meeting_base_url: null });
    expect(store.workspaceSettings.calls_enabled).toBe(false);
    expect(seen).toHaveBeenCalledTimes(3);
  });
});

describe("starting a call", () => {
  it("asks first, then posts once with an id kept for a retry, and opens the room in a new tab", async () => {
    const tab = { closed: false, opener: {} as unknown, location: { href: "" }, close: vi.fn() };
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    const startCall = vi.fn<(channelId: string, id: string) => Promise<string | null>>().mockResolvedValueOnce(null).mockResolvedValueOnce(URL_);
    const controller = { startCall } as unknown as AppController;
    render(<CallButton controller={controller} channel={channel()} />);

    fireEvent.click(screen.getByRole("button", { name: "通話を始める" }));
    expect(screen.getByRole("dialog", { name: "通話を始めますか？" })).toBeTruthy();
    expect(startCall).not.toHaveBeenCalled(); // nothing before the confirmation

    const confirm = () => screen.getAllByRole("button", { name: /通話を始める/ }).at(-1)!;
    await act(async () => fireEvent.click(confirm()));
    expect(startCall).toHaveBeenCalledTimes(1);
    expect(tab.close).toHaveBeenCalledTimes(1); // refused: the reserved tab goes away, the dialog stays
    expect(screen.getByRole("dialog")).toBeTruthy();

    await act(async () => fireEvent.click(confirm()));
    expect(startCall).toHaveBeenCalledTimes(2);
    const [channelId, first] = startCall.mock.calls[0]!;
    const second = startCall.mock.calls[1]![1];
    expect(channelId).toBe("c1");
    expect(second).toBe(first); // the same client_msg_id: a lost answer never makes a second call
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(tab.location.href).toBe(URL_);
    expect(tab.opener).toBeNull();
    expect(open).toHaveBeenCalledTimes(2); // one tab reserved per click
    expect(screen.queryByRole("dialog")).toBeNull();

    // A new call later is a new id.
    fireEvent.click(screen.getByRole("button", { name: "通話を始める" }));
    await act(async () => fireEvent.click(confirm()));
    expect(startCall.mock.calls[2]?.[1]).not.toBe(first);
  });

  it("cancel posts nothing", () => {
    const startCall = vi.fn();
    render(<CallButton controller={{ startCall } as unknown as AppController} channel={channel()} />);
    fireEvent.click(screen.getByRole("button", { name: "通話を始める" }));
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(startCall).not.toHaveBeenCalled();
  });
});

describe("a call message in the timeline", () => {
  function world(rows: (server: FakeServer, channelId: string, bobId: string) => MessageOut[]) {
    const server = new FakeServer();
    const me = server.addUser("alice");
    const bob = server.addUser("bob");
    const created = server.createChannel("general", me.id);
    server.join(created.id, bob.id);
    const store = new Store();
    store.setMe(me as unknown as UserMe);
    for (const user of [me, bob]) store.upsertUser(user);
    const messages = rows(server, created.id, bob.id);
    for (const message of messages) store.upsertMessage(message);
    store.upsertChannel(server.channels.get(created.id)!.channel, { isMember: true, syncedSeq: messages.length, oldestLoadedSeq: 0, lastReadSeq: messages.length });
    const controller = {
      store, engine: null, api: null, version: 0, setError: vi.fn(), messageFocus: null, editing: null, isAdmin: false, sendKey: "shift-enter",
      linkPreviews: new Map<string, LinkPreviewOut | null>(), linkPreview: vi.fn(),
      subscribe: () => () => {}, subscribeLinkPreviews: () => () => {},
    };
    function View() {
      useSyncExternalStore((listener) => store.subscribe(listener), () => store.version);
      return <Timeline controller={controller as unknown as AppController} channel={store.getChannel(created.id)!} onOpenThread={() => {}} />;
    }
    render(<View />);
    return { controller, bob };
  }
  const call = (server: FakeServer, channelId: string, senderId: string, body = BODY): MessageOut => ({ ...server.post(channelId, senderId, body).message, call: { kind: "link", url: URL_, started_by: senderId } });

  it("shows the card (who, when, 参加する) instead of the server's body, and fetches no preview for the room", () => {
    const { controller } = world((server, id, bob) => [call(server, id, bob)]);
    const card = document.querySelector("[data-call-card]")!;
    expect(card.textContent).toContain("📞 Bob さんが通話を始めました");
    const join = screen.getByRole("link", { name: "参加する" });
    expect(join.getAttribute("href")).toBe(URL_);
    expect(join.getAttribute("target")).toBe("_blank");
    expect(screen.queryByText(URL_)).toBeNull(); // the link is not shown raw again
    expect(controller.linkPreview).not.toHaveBeenCalled();
  });

  it("an edited body still shows under the card; an ordinary message has no card", () => {
    world((server, id, bob) => [call(server, id, bob, "📞 通話を始めました（研究会）"), server.post(id, bob, "ふつうの投稿").message]);
    expect(document.querySelectorAll("[data-call-card]")).toHaveLength(1);
    expect(screen.getByText("📞 通話を始めました（研究会）")).toBeTruthy();
    expect(screen.getByText("ふつうの投稿")).toBeTruthy();
  });

  it("callHidesBody: only the server's own body", () => {
    expect(callHidesBody({ body: BODY, call: { url: URL_, started_by: "u" } })).toBe(true);
    expect(callHidesBody({ body: BODY, call: null })).toBe(false);
    expect(callHidesBody({ body: "edited", call: { url: URL_, started_by: "u" } })).toBe(false);
  });
});

describe("管理 → 設定 (M130: the meeting service field is gone)", () => {
  it("does not show 「通話の会議サービス」 even though the server still sends calls_enabled", async () => {
    const settings = {
      show_membership_messages: true,
      preview_before_join: true,
      calls_enabled: false,
      meeting_base_url: null,
      in_app_calls: { enabled: false, video: false, screen_share: false },
      updated_at: null,
      updated_by: null,
      default_channel_ids: [],
      default_channels: [],
      default_channels_set: true,
      legacy_sso_default_channels: [],
    } as unknown as AdminWorkspaceSettingsOut;
    const store = new Store();
    const controller = { api: { adminWorkspaceSettings: vi.fn(async () => settings), channels: vi.fn(async () => []) }, store, setError: vi.fn() } as unknown as AppController;
    render(<WorkspaceSettingsTab controller={controller} />);
    await waitFor(() => expect(screen.queryAllByRole("checkbox").length + screen.queryAllByRole("switch").length).toBeGreaterThan(0));
    expect(screen.queryByText("通話の会議サービス")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "会議サービスの URL" })).toBeNull();
  });
});
