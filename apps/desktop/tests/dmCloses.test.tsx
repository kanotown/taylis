// @vitest-environment jsdom
/**
 * Closed DMs (M141, 「会話を閉じる」, SYNC_PROTOCOL.md §7.9, DATA_MODEL.md conversation_closes): a closed DM or group DM is
 * in no DM list (the DM section, favorites, my sections, home, the DM tab; my own DM's placeholder stays away too);
 * bootstrap's closed_dms and dm_close.updated keep the set, a new timeline message opens it; closing is optimistic
 * (closed, unpinned, read) and put back when refused; 「元に戻す」 and opening it on purpose reopen it (DELETE).
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { SidebarSectionOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import type { ChannelState } from "../src/sync/types";
import { sectionChannels, showsSelfNotesPlaceholder } from "../src/ui/channels";
import { homeSections } from "../src/ui/home";
import { dmList } from "../src/ui/mobileTabs";
import { ChannelContextMenu } from "../src/ui/SidebarMenus";
import { NoticeToast } from "../src/ui/Toast";
import { FakeServer } from "./fakeServer";

afterEach(cleanup);

const ME = "me";
const channel = (id: string, patch: Partial<ChannelState> = {}): ChannelState =>
  ({
    id, type: "public", name: id, topic: null, purpose: null, archived: false, created_by: null, last_seq: 0, last_message_at: null, created_at: "", updated_at: "",
    membership: null, dm_user_ids: null, posting_policy: "everyone", isMember: true, syncedSeq: null, lastSeq: 0, lastReadSeq: 0, unreadCount: 0, mentionCount: 0,
    firstUnreadAt: null, pendingReadSeq: null, hasOlder: true, oldestLoadedSeq: null, notificationLevel: null, mutedUntil: null, ...patch,
  }) as ChannelState;
const dm = (id: string, others: string[], at: number, patch: Partial<ChannelState> = {}) =>
  channel(id, { type: others.length > 1 ? "group_dm" : "dm", name: null, dm_user_ids: [ME, ...others], last_message_at: `2026-10-0${at}T00:00:00Z`, ...patch });

const self = dm("self", [], 1);
const a = dm("a", ["u1"], 5);
const b = dm("b", ["u2"], 4);
const c = dm("c", ["u3", "u4"], 3);
const d = dm("d", ["u5"], 2);
const general = channel("general");
const all = [general, self, a, b, c, d];
const ids = (rows: ChannelState[]) => rows.map((row) => row.id);
const title = (row: ChannelState) => row.id;

describe("the lists leave closed DMs out", () => {
  it("the sidebar: the DM section, favorites and my sections; channels stay", () => {
    const section: SidebarSectionOut = { id: "s1", name: "Lab", emoji: null, position: 0, sort: "name", collapsed: false, manual_order: [], channel_ids: ["c", "general"] } as SidebarSectionOut;
    const closed = new Set(["a", "b", "c", "general"]);
    const sections = sectionChannels(all, { meId: ME, title, favorites: new Set(["b", "d"]), sections: [section], closedDms: closed });
    expect(ids(sections.dms)).toEqual(["self"]);
    expect(ids(sections.favorites)).toEqual(["d"]);
    expect(ids(sections.custom[0]!.channels)).toEqual([]);
    // Only DMs are ever in the set, but the filter is by id: a channel is never closed by the server.
    const open = sectionChannels(all, { meId: ME, title, favorites: new Set(["b", "d"]), sections: [section] });
    expect(ids(open.dms)).toEqual(["self", "a"]);
    expect(ids(open.favorites)).toEqual(["b", "d"]);
  });

  it("pinned and closed: hidden all the same; an empty set changes nothing", () => {
    expect(ids(sectionChannels(all, { meId: ME, title, dmPins: ["c", "a"], closedDms: new Set(["c"]) }).dms)).toEqual(["a", "self", "b", "d"]);
    expect(ids(sectionChannels(all, { meId: ME, title, dmPins: ["c"], closedDms: new Set() }).dms)).toEqual(["c", "self", "a", "b", "d"]);
    expect(ids(sectionChannels(all, { meId: ME, title, closedDms: null }).dms)).toEqual(["self", "a", "b", "c", "d"]);
  });

  it("home's DM section and the narrow screen's DM tab", () => {
    expect(ids(homeSections(all, { meId: ME, title, closedDms: new Set(["self", "a"]) }).dms)).toEqual(["b", "c", "d"]);
    expect(ids(dmList(all, title, ME, "", null, new Set(["self", "a"])))).toEqual(["b", "c", "d"]);
    expect(ids(dmList(all, title, ME, "", ["d"], new Set(["c"])))).toEqual(["d", "self", "a", "b"]);
  });

  it("my own DM closed: no placeholder row either (it exists)", () => {
    expect(showsSelfNotesPlaceholder(all, ME, "Me")).toBe(false);
    expect(ids(dmList(all, title, ME, "", null, new Set(["self"])))).not.toContain("self");
  });
});

describe("sync (bootstrap closed_dms, dm_close.updated, a new message)", () => {
  async function world(enabled = true) {
    const server = new FakeServer();
    server.dmClosesEnabled = enabled;
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    const carol = server.addUser("carol");
    const withAlice = server.createChannel("", bob.id, "dm");
    server.join(withAlice.id, alice.id);
    const withCarol = server.createChannel("", bob.id, "dm");
    server.join(withCarol.id, carol.id);
    if (enabled) server.setDmClose(bob.id, withCarol.id, true);
    const store = new Store();
    const api = server.apiFor(bob.id);
    const engine = new SyncEngine({ api, connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 50 });
    await engine.start();
    await engine.idle();
    return { server, store, engine, api, alice, bob, carol, withAlice, withCarol };
  }

  it("bootstrap brings the set; another device's close and reopen follow", async () => {
    const { server, store, engine, bob, withAlice, withCarol } = await world();
    expect([...store.closedDms!]).toEqual([withCarol.id]);
    server.setDmClose(bob.id, withAlice.id, true);
    await engine.idle();
    expect(store.isDmClosed(withAlice.id)).toBe(true);
    server.setDmClose(bob.id, withCarol.id, false);
    await engine.idle();
    expect([...store.closedDms!]).toEqual([withAlice.id]);
    engine.stop();
  });

  it("a new timeline message opens it (no request); a thread-only reply does not, one also sent to the channel does", async () => {
    const { server, store, engine, carol, withCarol } = await world();
    const root = server.post(withCarol.id, carol.id, "hi").message;
    await engine.idle();
    expect(store.isDmClosed(withCarol.id)).toBe(false);
    expect(server.isDmClosedFor(store.me!.id, withCarol.id)).toBe(false); // the server reads it the same way

    store.setDmClosed(withCarol.id, true);
    server.setDmClose(store.me!.id, withCarol.id, true);
    await engine.idle();
    server.post(withCarol.id, carol.id, "in the thread", undefined, root.id);
    await engine.idle();
    expect(store.isDmClosed(withCarol.id)).toBe(true);
    server.post(withCarol.id, carol.id, "also in the channel", undefined, root.id, [], { alsoInChannel: true });
    await engine.idle();
    expect(store.isDmClosed(withCarol.id)).toBe(false);
    engine.stop();
  });

  it("a reconnect replaces the set with the server's", async () => {
    const { server, store, engine, bob, withCarol } = await world();
    store.setDmClosed(withCarol.id, false); // e.g. a reopen this device lost
    server.setDmClose(bob.id, withCarol.id, true); // unchanged on the server: no event
    await engine.resync();
    await engine.idle();
    expect(store.isDmClosed(withCarol.id)).toBe(true);
    engine.stop();
  });

  it("a server before M141 sends no closed_dms: null, and nothing is hidden or offered", async () => {
    const { store, engine } = await world(false);
    expect(store.closedDms).toBeNull();
    store.setDmClosed("x", true);
    expect(store.closedDms).toBeNull();
    engine.stop();
  });
});

type Stub = AppController & { setError: ReturnType<typeof vi.fn> };

function controllerWith(store: Store, api: unknown): Stub {
  const controller = {
    store,
    api,
    notice: null,
    noticeAction: null,
    closedChannelRequest: null,
    emit: vi.fn(),
    setError: vi.fn(),
    setNotice: AppController.prototype.setNotice,
    closeDm: AppController.prototype.closeDm,
    undoCloseDm: AppController.prototype.undoCloseDm,
    reopenIfClosed: AppController.prototype.reopenIfClosed,
    toggleDmPin: vi.fn(),
    toggleFavorite: vi.fn(),
    moveToSection: vi.fn(),
    setNotification: vi.fn(),
  };
  return controller as unknown as Stub;
}

describe("「会話を閉じる」", () => {
  function setup(fail = false) {
    const store = new Store();
    store.upsertChannel({ ...dm("a", ["u1"], 5), last_seq: 7 } as never, { isMember: true });
    store.updateChannel("a", { lastSeq: 7, lastReadSeq: 3, unreadCount: 4, mentionCount: 1, firstUnreadAt: "2026-10-05T00:00:00Z" });
    store.upsertChannel(general as never, { isMember: true });
    store.replaceClosedDms([]);
    store.replaceDmPins(["b", "a", "c"]);
    const api = {
      closeDm: vi.fn(async (id: string) => { if (fail) throw new ApiError(500, "internal", "boom"); return { channel_id: id, closed: true, closed_at: "" }; }),
      reopenDm: vi.fn(async (id: string) => ({ channel_id: id, closed: false, closed_at: null })),
      pinDm: vi.fn(async (id: string) => ({ channel_id: id, pinned: true })),
    };
    return { store, api, controller: controllerWith(store, api) };
  }

  it("closes at once (hidden, unpinned, read), asks the main screen to leave it, and offers 元に戻す", async () => {
    const { store, api, controller } = setup();
    const done = controller.closeDm("a");
    expect(store.isDmClosed("a")).toBe(true);
    expect(store.dmPins).toEqual(["b", "c"]);
    expect(store.getChannel("a")).toMatchObject({ unreadCount: 0, mentionCount: 0, firstUnreadAt: null, lastReadSeq: 7 });
    expect(controller.closedChannelRequest).toBe("a");
    expect(await done).toBe(true);
    expect(api.closeDm).toHaveBeenCalledWith("a");
    expect(controller.notice).toBe("会話を閉じました");
    expect(controller.noticeAction?.label).toBe("元に戻す");

    // 元に戻す: opened again (DELETE), pinned again at the end; the read position stays.
    controller.noticeAction!.run();
    await act(async () => {});
    expect(store.isDmClosed("a")).toBe(false);
    expect(api.reopenDm).toHaveBeenCalledWith("a");
    expect(api.pinDm).toHaveBeenCalledWith("a");
    expect(store.dmPins).toEqual(["b", "c", "a"]);
    expect(store.getChannel("a")!.unreadCount).toBe(0);
  });

  it("refused: closed, pins and unread all put back as they were, and the error shows", async () => {
    const { store, controller } = setup(true);
    const done = controller.closeDm("a");
    expect(store.isDmClosed("a")).toBe(true); // optimistic
    expect(await done).toBe(false);
    expect(store.isDmClosed("a")).toBe(false);
    expect(store.dmPins).toEqual(["b", "a", "c"]); // its old place, not the end
    expect(store.getChannel("a")).toMatchObject({ unreadCount: 4, mentionCount: 1, lastReadSeq: 3, firstUnreadAt: "2026-10-05T00:00:00Z" });
    expect(controller.setError).toHaveBeenCalled();
    expect(controller.noticeAction).toBeNull();
  });

  it("not on a channel, nor on a server before M141", async () => {
    const { store, api, controller } = setup();
    expect(await controller.closeDm("general")).toBe(false);
    store.replaceClosedDms(null);
    expect(await controller.closeDm("a")).toBe(false);
    expect(api.closeDm).not.toHaveBeenCalled();
  });

  it("opening a closed DM on purpose reopens it (DELETE); a refused one is only logged", async () => {
    const { store, api, controller } = setup();
    store.setDmClosed("a", true);
    controller.reopenIfClosed("a");
    expect(store.isDmClosed("a")).toBe(false);
    expect(api.reopenDm).toHaveBeenCalledWith("a");
    controller.reopenIfClosed("a"); // already open: no request
    expect(api.reopenDm).toHaveBeenCalledTimes(1);

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    api.reopenDm.mockRejectedValueOnce(new ApiError(500, "internal", "boom"));
    store.setDmClosed("a", true);
    controller.reopenIfClosed("a");
    await act(async () => {});
    expect(store.isDmClosed("a")).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(controller.setError).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("against the fake server: close, then reopen on purpose, and another device of mine follows", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    const withAlice = server.createChannel("", bob.id, "dm");
    server.join(withAlice.id, alice.id);
    server.post(withAlice.id, alice.id, "hello");
    const devices = [new Store(), new Store()];
    const engines = devices.map((store) => new SyncEngine({ api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 50 }));
    for (const engine of engines) await engine.start();
    for (const engine of engines) await engine.idle();
    const [here, other] = devices as [Store, Store];
    expect(here.getChannel(withAlice.id)!.unreadCount).toBe(1);
    const controller = controllerWith(here, server.apiFor(bob.id));
    expect(await controller.closeDm(withAlice.id)).toBe(true);
    for (const engine of engines) await engine.idle();
    expect(server.isDmClosedFor(bob.id, withAlice.id)).toBe(true);
    expect(other.isDmClosed(withAlice.id)).toBe(true);
    expect(other.getChannel(withAlice.id)!.unreadCount).toBe(0); // the server read it too

    controller.reopenIfClosed(withAlice.id);
    await act(async () => {});
    for (const engine of engines) await engine.idle();
    expect(server.isDmClosedFor(bob.id, withAlice.id)).toBe(false);
    expect(other.isDmClosed(withAlice.id)).toBe(false);
    for (const engine of engines) engine.stop();
  });
});

describe("the menus and the toast", () => {
  const menuFor = async (row: ChannelState, closed: string[] | null) => {
    const store = new Store();
    store.replaceClosedDms(closed);
    const api = { closeDm: vi.fn(async (id: string) => ({ channel_id: id, closed: true, closed_at: "" })) };
    const controller = controllerWith(store, api);
    render(
      <ChannelContextMenu controller={controller} channel={row}>
        <button type="button">row</button>
      </ChannelContextMenu>,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "row" }));
    await act(async () => {});
    return { menu: screen.queryByRole("menu"), api, store };
  };

  it("the row's context menu offers it on DMs and group DMs (my own DM too), never on a channel or an older server", async () => {
    const opened = await menuFor(a, []);
    expect(within(opened.menu!).getByRole("menuitem", { name: "会話を閉じる" })).toBeTruthy();
    cleanup();
    expect(within((await menuFor(c, [])).menu!).getByRole("menuitem", { name: "会話を閉じる" })).toBeTruthy();
    cleanup();
    expect(within((await menuFor(self, [])).menu!).getByRole("menuitem", { name: "会話を閉じる" })).toBeTruthy();
    cleanup();
    expect(within((await menuFor(general, [])).menu!).queryByRole("menuitem", { name: "会話を閉じる" })).toBeNull();
    cleanup();
    expect(within((await menuFor(a, null)).menu!).queryByRole("menuitem", { name: "会話を閉じる" })).toBeNull();
  });

  it("the notice shows 元に戻す and runs it once", () => {
    const run = vi.fn();
    const controller = { notice: "会話を閉じました", noticeAction: { label: "元に戻す", run }, setNotice: vi.fn() } as unknown as AppController;
    render(<NoticeToast controller={controller} />);
    fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(controller.setNotice).toHaveBeenCalledWith(null);
  });
});
