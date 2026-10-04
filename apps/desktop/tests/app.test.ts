// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import { UNKNOWN_ERROR_MESSAGE } from "../src/api/errorMessages";
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
});
