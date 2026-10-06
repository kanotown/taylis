// @vitest-environment jsdom
/**
 * Pinned DMs (M118, DATA_MODEL.md conversation_pins and sidebar_sections 「DM の固定」): pinned DMs first in pin order in
 * every DM list, then my own DM, then the section's sort; bootstrap's dm_pins and dm_pin.updated; 「上に固定」/「固定を外す」
 * with an optimistic order put back when refused.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { SidebarSectionOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import type { ChannelState } from "../src/sync/types";
import { pinnedFirst, sectionChannels } from "../src/ui/channels";
import { HOME_DM_LIMIT, homeSections } from "../src/ui/home";
import { dmList } from "../src/ui/mobileTabs";
import { ChannelContextMenu } from "../src/ui/SidebarMenus";
import { FakeServer } from "./fakeServer";

afterEach(cleanup);

const ME = "me";
const channel = (id: string, patch: Partial<ChannelState> = {}): ChannelState =>
  ({
    id, type: "public", name: id, topic: null, purpose: null, archived: false, created_by: null, last_seq: 0, last_message_at: null, created_at: "", updated_at: "",
    membership: null, dm_user_ids: null, posting_policy: "everyone", isMember: true, syncedSeq: null, lastSeq: 0, lastReadSeq: 0, unreadCount: 0, mentionCount: 0,
    firstUnreadAt: null, pendingReadSeq: null, hasOlder: true, oldestLoadedSeq: null, notificationLevel: null, mutedUntil: null, ...patch,
  }) as ChannelState;
/** A DM with `others`; `at` its last message (newer = larger). */
const dm = (id: string, others: string[], at: number, patch: Partial<ChannelState> = {}) =>
  channel(id, { type: others.length > 1 ? "group_dm" : others.length === 0 ? "dm" : "dm", name: null, dm_user_ids: [ME, ...others], last_message_at: `2026-10-0${at}T00:00:00Z`, ...patch });

const self = dm("self", [], 1);
const a = dm("a", ["u1"], 5);
const b = dm("b", ["u2"], 4);
const c = dm("c", ["u3", "u4"], 3);
const d = dm("d", ["u5"], 2);
const general = channel("general");
const all = [general, self, a, b, c, d];
const ids = (rows: ChannelState[]) => rows.map((row) => row.id);
const title = (row: ChannelState) => row.id;

describe("the order (DATA_MODEL.md sidebar_sections 「DM の固定」)", () => {
  it("pinned DMs first in pin order, then my own DM, then newest first", () => {
    expect(ids(sectionChannels(all, { meId: ME, title }).dms)).toEqual(["self", "a", "b", "c", "d"]);
    expect(ids(sectionChannels(all, { meId: ME, title, dmPins: ["d", "b"] }).dms)).toEqual(["d", "b", "self", "a", "c"]);
    // My own DM pinned: in its pin place, not twice.
    expect(ids(sectionChannels(all, { meId: ME, title, dmPins: ["c", "self"] }).dms)).toEqual(["c", "self", "a", "b", "d"]);
    // A pin of a conversation I left (not in the list) changes nothing.
    expect(ids(sectionChannels(all, { meId: ME, title, dmPins: ["gone", "b"] }).dms)).toEqual(["b", "self", "a", "c", "d"]);
  });

  it("by name and by hand too: the pins stay first (by hand: manual_order orders the others, my own DM included)", () => {
    const byName = sectionChannels(all, { meId: ME, title, dmPins: ["d"], defaults: [{ key: "dms", sort: "name", manual_order: [] }] });
    expect(ids(byName.dms)).toEqual(["d", "self", "a", "b", "c"]);
    const byHand = sectionChannels(all, { meId: ME, title, dmPins: ["d"], defaults: [{ key: "dms", sort: "manual", manual_order: ["c", "d", "a", "self"] }] });
    expect(ids(byHand.dms)).toEqual(["d", "c", "a", "self", "b"]);
  });

  it("in a favorites or my own section the pinned DMs come first; channels never move", () => {
    const section = { id: "s1", name: "研究", emoji: null, position: 0, channel_ids: ["general", "a", "c"], sort: "name", manual_order: [] } as unknown as SidebarSectionOut;
    const sections = sectionChannels(all, { meId: ME, title, dmPins: ["c", "b"], favorites: new Set(["b", "d"]), sections: [section] });
    expect(ids(sections.favorites)).toEqual(["b", "d"]);
    expect(ids(sections.custom[0]!.channels)).toEqual(["c", "general", "a"]);
    expect(ids(sections.dms)).toEqual(["self"]);
  });

  it("「未読だけ」 still hides a pinned DM with nothing unread", () => {
    const unread = { ...b, unreadCount: 2 };
    const rows = sectionChannels([general, self, a, unread, c], { meId: ME, title, dmPins: ["c", "b"], unreadOnly: true }).dms;
    expect(ids(rows)).toEqual(["b"]);
  });

  it("home keeps every pinned DM and counts its limit of 5 on the others", () => {
    const many = Array.from({ length: HOME_DM_LIMIT + 2 }, (_, i) => dm(`x${i}`, [`v${i}`], 9 - i));
    const home = homeSections([self, ...many], { meId: ME, title, dmPins: ["x6"] });
    expect(ids(home.dms)).toEqual(["x6", "self", "x0", "x1", "x2", "x3", "x4"]);
    expect(home.moreDms).toBe(true);
  });

  it("the narrow screen's DM list and pinnedFirst", () => {
    expect(ids(dmList(all, title, ME, "", ["c"]))).toEqual(["c", "self", "a", "b", "d"]);
    expect(ids(dmList(all, title, ME))).toEqual(["self", "a", "b", "c", "d"]);
    expect(ids(pinnedFirst([a, b, c], null))).toEqual(["a", "b", "c"]);
  });
});

describe("sync (bootstrap dm_pins, dm_pin.updated)", () => {
  async function world(dmPinsEnabled = true) {
    const server = new FakeServer();
    server.dmPinsEnabled = dmPinsEnabled;
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    const carol = server.addUser("carol");
    const withAlice = server.createChannel("", bob.id, "dm");
    server.join(withAlice.id, alice.id);
    const withCarol = server.createChannel("", bob.id, "dm");
    server.join(withCarol.id, carol.id);
    server.setDmPin(bob.id, withCarol.id, true);
    const store = new Store();
    const engine = new SyncEngine({ api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 50 });
    await engine.start();
    await engine.idle();
    return { server, store, engine, bob, withAlice, withCarol };
  }

  it("bootstrap brings the pins; another device's pin goes last, an unpin leaves the others in order", async () => {
    const { server, store, engine, bob, withAlice, withCarol } = await world();
    expect(store.dmPins).toEqual([withCarol.id]);
    server.setDmPin(bob.id, withAlice.id, true);
    await engine.idle();
    expect(store.dmPins).toEqual([withCarol.id, withAlice.id]);
    server.setDmPin(bob.id, withCarol.id, false);
    await engine.idle();
    expect(store.dmPins).toEqual([withAlice.id]);
    engine.stop();
  });

  it("a server before M118 sends no dm_pins: null, and the menu offers no pin", async () => {
    const { store, engine } = await world(false);
    expect(store.dmPins).toBeNull();
    engine.stop();
  });
});

describe("「上に固定」/「固定を外す」", () => {
  function setup(pins: string[] | null, fail = false) {
    const store = new Store();
    store.replaceDmPins(pins);
    const api = {
      pinDm: vi.fn(async (id: string) => { if (fail) throw new ApiError(403, "not_a_member", "Not a member"); return { channel_id: id, pinned: true }; }),
      unpinDm: vi.fn(async (id: string) => { if (fail) throw new ApiError(500, "internal", "boom"); return { channel_id: id, pinned: false }; }),
    };
    const controller = { store, api, setError: vi.fn(), toggleDmPin: AppController.prototype.toggleDmPin, toggleFavorite: vi.fn(), moveToSection: vi.fn(), setNotification: vi.fn() };
    return { store, api, controller: controller as unknown as AppController & { setError: ReturnType<typeof vi.fn> } };
  }

  it("pins at once and unpins; refused, the order is put back as it was", async () => {
    const ok = setup(["c"]);
    await ok.controller.toggleDmPin("a");
    expect(ok.api.pinDm).toHaveBeenCalledWith("a");
    expect(ok.store.dmPins).toEqual(["c", "a"]);
    await ok.controller.toggleDmPin("c");
    expect(ok.api.unpinDm).toHaveBeenCalledWith("c");
    expect(ok.store.dmPins).toEqual(["a"]);

    const refused = setup(["c", "b"], true);
    const done = refused.controller.toggleDmPin("c");
    expect(refused.store.dmPins).toEqual(["b"]); // optimistic
    await done;
    expect(refused.store.dmPins).toEqual(["c", "b"]); // back in its old place, not at the end
    expect(refused.controller.setError).toHaveBeenCalled();
  });

  const menuFor = async (row: ChannelState, pins: string[] | null) => {
    const { controller, api } = setup(pins);
    render(
      <ChannelContextMenu controller={controller} channel={row}>
        <button type="button">row</button>
      </ChannelContextMenu>,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "row" }));
    await act(async () => {});
    return { menu: screen.queryByRole("menu"), api };
  };

  it("the row's context menu offers it on DMs and group DMs (my own DM too), never on a channel or an older server", async () => {
    const { menu, api } = await menuFor(c, []);
    fireEvent.click(within(menu!).getByRole("menuitem", { name: "上に固定" }));
    await act(async () => {});
    expect(api.pinDm).toHaveBeenCalledWith("c");
    cleanup();
    expect(within((await menuFor(self, ["self"])).menu!).getByRole("menuitem", { name: "固定を外す" })).toBeTruthy();
    cleanup();
    expect(within((await menuFor(general, [])).menu!).queryByRole("menuitem", { name: "上に固定" })).toBeNull();
    cleanup();
    expect(within((await menuFor(a, null)).menu!).queryByRole("menuitem", { name: "上に固定" })).toBeNull();
  });
});
