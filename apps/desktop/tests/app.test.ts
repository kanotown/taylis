// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import { UNKNOWN_ERROR_MESSAGE } from "../src/api/errorMessages";
import { ApiError } from "../src/api/errors";
import type { ScheduledOut } from "../src/api/types";
import { AppController, profileKey } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { FakeServer } from "./fakeServer";

/** A signed-in workspace as the controller keeps it (M16c), put in place without a login. */
function addSession(controller: AppController, serverUrl: string, session: Record<string, unknown>): void {
  (controller as unknown as { sessions: Map<string, unknown> }).sessions.set(serverUrl, { serverUrl, username: "bob", me: null, leaving: false, engine: null, ...session });
}

afterEach(() => localStorage.clear());

describe("app controller", () => {
  it("never stays on 起動中…: a credential store that fails leads to the login form with the error", async () => {
    localStorage.setItem("chikuwa.username", "bob");
    const controller = new AppController();
    (controller as unknown as { secrets: unknown }).secrets = { get: async () => { throw new Error("keychain locked"); } };
    await controller.boot();
    expect(controller.screen).toBe("login");
    expect(controller.error).toBe(UNKNOWN_ERROR_MESSAGE);
  });

  it("names the local database by a hash of server and user, so similar names never share one (§11)", async () => {
    const keys = await Promise.all(["t.kano", "t_kano", "t-kano"].map((name) => profileKey(`https://chat.example.com|${name}`)));
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(await profileKey("https://chat.example.com|t.kano")).toBe(keys[0]);
    const long = `https://${"x".repeat(200)}.example.com`; // the old name was cut at 80 characters
    expect(await profileKey(`${long}|a`)).not.toBe(await profileKey(`${long}|b`));
  });

  it("returns a cancelled scheduled message to the draft as the composer writes it, after what is already there", async () => {
    const server = new FakeServer();
    const bob = server.addUser("bob");
    const controller = new AppController();
    controller.store.upsertUser(bob);
    controller.api = { cancelScheduled: async () => {} } as unknown as ApiClient;
    const row: ScheduledOut = { id: "s1", channel_id: "c1", parent_id: null, client_msg_id: "k1", body: `<@${bob.id}> 明日の件 <!here>`, attachments: [], send_at: "2026-10-01T00:00:00Z", status: "pending", error: null, sent_message_id: null, created_at: "2026-09-27T00:00:00Z" };
    await controller.cancelScheduled(row);
    expect(controller.store.draft("c1").text).toBe("@bob 明日の件 @here");
    controller.store.setDraft("c1", null, { text: "書きかけ" });
    await controller.cancelScheduled({ ...row, id: "s2" });
    expect(controller.store.draft("c1").text).toBe("書きかけ\n@bob 明日の件 @here");
  });

  it("saves a draft typed just before ログアウト for my other devices, then signs out (M28b)", async () => {
    const server = new FakeServer();
    const bob = server.addUser("bob");
    const channel = server.createChannel("general", bob.id);
    const store = new Store();
    const engine = new SyncEngine({ api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {} }, { draftSaveMs: 60_000 });
    await engine.start();
    await engine.idle();
    store.setDraft(channel.id, null, { text: "書きかけ" }); // within draftSaveMs: not saved yet
    const controller = new AppController();
    (controller as unknown as { secrets: unknown }).secrets = { get: async () => null, set: async () => {}, delete: async () => {} };
    const logout = vi.fn(async () => {});
    addSession(controller, "http://one", { api: { baseUrl: "http://one", logout }, store, engine });
    await controller.signOutWorkspace("http://one");
    expect(server.draftsOf(bob.id).map((d) => d.body)).toEqual(["書きかけ"]);
    expect(logout).toHaveBeenCalledOnce();
    expect(engine.status).toBe("idle");
    expect(controller.isSignedIn("http://one")).toBe(false);
  });

  it("sends this device's name and version once the session is online, so an old \"MacIntel\" is renamed", async () => {
    const server = new FakeServer();
    const bob = server.addUser("bob");
    const store = new Store();
    const engine = new SyncEngine({ api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {} });
    const controller = new AppController();
    (controller as unknown as { deviceName: string }).deviceName = "Mac (Bob's MacBook Air)";
    const updateDevice = vi.fn(async () => ({}));
    addSession(controller, "http://one", { api: { baseUrl: "http://one", updateDevice }, store, engine });
    const internals = controller as unknown as { sessions: Map<string, unknown>; reportDeviceOnce: (session: unknown, engine: SyncEngine) => void };
    internals.reportDeviceOnce(internals.sessions.get("http://one"), engine);
    await engine.start();
    await engine.idle();
    await vi.waitFor(() => expect(updateDevice).toHaveBeenCalledOnce());
    expect(updateDevice).toHaveBeenCalledWith(expect.objectContaining({ device_name: "Mac (Bob's MacBook Air)" }));
    engine.stop();
  });

  it("lights the workspace dot for unread replies in followed threads too (WORKSPACES.md §3.2)", () => {
    const controller = new AppController();
    const store = new Store();
    addSession(controller, "http://one", { api: { baseUrl: "http://one" }, store });
    expect(controller.workspaceUnread("http://one")).toEqual({ badge: 0, unread: false });
    store.setThreadSummary({ unread_count: 1, mention_count: 0 });
    expect(controller.workspaceUnread("http://one")).toEqual({ badge: 0, unread: true });
  });

  it("makes a plain section with its name only, which a server before M26 accepts; icon and conversations when given", async () => {
    const bodies: unknown[] = [];
    const controller = new AppController();
    controller.api = { createSidebarSection: async (body: unknown) => { bodies.push(body); return []; } } as unknown as ApiClient;
    expect(await controller.createSection("研究", null, [])).toBe(true);
    expect(await controller.createSection("授業", "📚", ["c1"])).toBe(true);
    expect(bodies).toEqual([{ name: "研究" }, { name: "授業", emoji: "📚", channel_ids: ["c1"] }]);
  });

  describe("one place per conversation: お気に入り or one of my sections (DATA_MODEL.md sidebar_sections)", () => {
    const section = (channelIds: string[]) => ({ id: "s1", name: "研究", emoji: null, collapsed: false, position: 0, channel_ids: channelIds, sort: "name" as const, manual_order: [] });
    const setup = (api: Record<string, unknown>) => {
      const controller = new AppController();
      controller.api = { baseUrl: "http://one", ...api } as unknown as ApiClient;
      return { controller, store: controller.store };
    };

    it("a starred conversation put in a new section leaves お気に入り at once (user report 2026-10-07: nothing seemed to happen)", async () => {
      const { controller, store } = setup({ createSidebarSection: async () => [section(["c1", "c2"])] });
      store.replaceFavorites(["c1", "c3"]);
      expect(await controller.createSection("研究", null, ["c1", "c2"])).toBe(true);
      expect(store.sectionOf("c1")).toBe("s1");
      expect([...store.favorites]).toEqual(["c3"]);
    });

    it("moving a starred conversation into a section unstars it; a refusal keeps the star and shows the error", async () => {
      let refuse = false;
      const { controller, store } = setup({
        placeInSidebarSection: async () => {
          if (refuse) throw new ApiError(404, "section_not_found", "Section not found");
          return [section(["c1"])];
        },
      });
      store.replaceFavorites(["c1", "c2"]);
      expect(await controller.moveToSection("c1", "s1")).toBe(true);
      expect(store.isFavorite("c1")).toBe(false);
      refuse = true;
      expect(await controller.moveToSection("c2", "s1")).toBe(false);
      expect(store.isFavorite("c2")).toBe(true);
      expect(controller.error).toBeTruthy();
    });

    it("starring a conversation takes it out of my section at once, and puts it back when refused", async () => {
      let refuse = false;
      const { controller, store } = setup({
        favoriteChannel: async () => {
          if (refuse) throw new ApiError(403, "not_a_member", "Not a member");
          return { channel_id: "c1", favorite: true };
        },
      });
      store.replaceSidebar([section(["c1", "c2"])]);
      await controller.toggleFavorite("c1");
      expect(store.isFavorite("c1")).toBe(true);
      expect(store.sidebarSections[0]!.channel_ids).toEqual(["c2"]);
      refuse = true;
      await controller.toggleFavorite("c2");
      expect(store.isFavorite("c2")).toBe(false);
      expect(store.sidebarSections[0]!.channel_ids).toEqual(["c2"]);
    });
  });
});
