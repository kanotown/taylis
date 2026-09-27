/**
 * M16c against two live servers (WORKSPACES.md): adding a workspace, the duplicate check, a workspace in
 * the background staying live (badge, notification), switching, restoring after a restart, signing out
 * of one of them. Enabled with LIVE_URL + LIVE_PASS (users dtuser1 / dtuser2 there) and LIVE_URL2 +
 * LIVE_USER2 + LIVE_PASS2, e.g. two compose stacks.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../src/api/client";
import { AppController } from "../src/state/app";
import { normalizeServerUrl } from "../src/state/workspaces";

const { disks, notes } = vi.hoisted(() => ({ disks: new Map<string, unknown>(), notes: [] as string[] }));
vi.mock("../src/platform/sqlite", async () => {
  const { MemoryPersistence } = await import("./fakeServer");
  return {
    // The same "file" for the same profile, so a restart finds what the last run saved.
    SqlitePersistence: {
      open: async (profile: string) => {
        if (!disks.has(profile)) disks.set(profile, new MemoryPersistence());
        return disks.get(profile);
      },
    },
  };
});
vi.mock("../src/platform/badge", () => ({ setUnreadBadge: async () => {}, setTitleBase: () => {} }));
vi.mock("../src/platform/notify", () => ({
  notify: async (title: string, body: string) => {
    notes.push(`${title}: ${body}`);
  },
  clearNotifications: () => {},
}));

const URL1 = process.env["LIVE_URL"];
const PASS1 = process.env["LIVE_PASS"] ?? "";
const URL2 = process.env["LIVE_URL2"];
const USER2 = process.env["LIVE_USER2"] ?? "android1";
const PASS2 = process.env["LIVE_PASS2"] ?? "";

async function until(predicate: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function stopAll(app: AppController): void {
  const sessions = (app as unknown as { sessions: Map<string, { engine: { stop(): void } | null }> }).sessions;
  for (const session of sessions.values()) session.engine?.stop();
}

describe.skipIf(!URL1 || !URL2)("workspaces on two live servers", () => {
  const secrets = new Map<string, string>();
  const secretStore = {
    get: async (account: string) => secrets.get(account) ?? null,
    set: async (account: string, value: string) => void secrets.set(account, value),
    delete: async (account: string) => void secrets.delete(account),
  };
  const make = () => {
    const app = new AppController();
    (app as unknown as { secrets: unknown }).secrets = secretStore;
    return app;
  };
  const one = normalizeServerUrl(URL1 ?? "")!;
  const two = normalizeServerUrl(URL2 ?? "")!;

  // Node, not jsdom: Node's own WebSocket; the desktop app's globals are stood in for.
  const globals = globalThis as unknown as Record<string, unknown>;
  beforeAll(() => {
    const data = new Map<string, string>();
    globals["localStorage"] = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, String(value)),
      removeItem: (key: string) => void data.delete(key),
      clear: () => data.clear(),
    };
    globals["document"] = { hasFocus: () => false };
    globals["window"] = { __TAURI_INTERNALS__: {} }; // the desktop app: several workspaces
  });
  afterAll(() => {
    for (const key of ["localStorage", "document", "window"]) delete globals[key];
  });

  it("adds, refuses duplicates, keeps the other live, switches, restores and signs out", { timeout: 60_000 }, async () => {
    const app = make();
    await app.boot();
    expect(app.screen).toBe("login");
    await app.login(URL1!, "dtuser1", PASS1);
    expect(app.screen).toBe("main");
    expect(app.workspaces).toHaveLength(1);
    const first = app.workspaces[0]!;
    expect(first.workspaceId).toMatch(/^[0-9a-f-]{36}$/);

    app.beginAddWorkspace();
    expect([app.screen, app.serverUrl, app.username]).toEqual(["login", "", ""]);
    await app.login(URL2!, USER2, PASS2);
    expect(app.workspaces.map((e) => e.serverUrl)).toEqual([one, two]);
    expect(app.activeServer).toBe(two);
    await until(() => app.isSignedIn(one) && app.isSignedIn(two));

    // The same server under another spelling is switched to, not added again (§5.1).
    app.beginAddWorkspace();
    await app.login(URL1!.replace("127.0.0.1", "localhost"), "dtuser1", PASS1);
    expect(app.workspaces).toHaveLength(2);
    expect(app.activeServer).toBe(one);
    expect(app.notice).toContain("登録済み");

    // A DM to the workspace behind reaches it live: a rail badge and a notification naming it (§6).
    await app.switchWorkspace(two);
    const peer = new ApiClient(URL1!);
    await peer.login("dtuser2", PASS1, { platform: "desktop", device_name: "live-peer" });
    const dm = await peer.createDm([first.userId!]);
    const text = `ワークスペース越しの DM ${Date.now()}`;
    await peer.postMessage(dm.id, crypto.randomUUID(), text);
    await until(() => app.workspaceUnread(one).badge >= 1);
    await until(() => notes.some((n) => n.includes(text)));
    expect(notes.find((n) => n.includes(text))).toContain(app.workspaces[0]!.name);

    // Switching shows that workspace's own store.
    await app.switchWorkspace(one);
    expect(app.screen).toBe("main");
    expect(app.store.channels.has(dm.id)).toBe(true);

    // A restart: the active workspace and the one behind it come back from the saved tokens and stores.
    stopAll(app);
    const again = make();
    await again.boot();
    expect(again.activeServer).toBe(one);
    expect(again.screen).toBe("main");
    expect(again.store.channels.has(dm.id)).toBe(true);
    await until(() => again.isSignedIn(two));

    // Signing out of one workspace leaves the other signed in (§5.3).
    await again.signOutWorkspace(two);
    expect(again.workspaces.map((e) => e.serverUrl)).toEqual([one]);
    expect(secrets.has(`${two}|${USER2}`)).toBe(false);
    expect(again.activeServer).toBe(one);
    expect(again.screen).toBe("main");
    await again.logout();
    expect(again.screen).toBe("login");
    expect(again.workspaces).toEqual([]);
    await peer.logout();
  });
});
