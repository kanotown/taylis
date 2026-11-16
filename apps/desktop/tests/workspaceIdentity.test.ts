// @vitest-environment jsdom
/**
 * WORKSPACES.md §5.1 step 3 and §7 (2026-11-16, a hostile-server review): a registered workspace is found by its URL
 * only. A server that claims another workspace's `workspace_id` cannot have that workspace's sign-in (password,
 * two-factor code) sent to itself, its entry keeps the first id it recorded, and one server's name never lands in
 * another's entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TokenResponse, UserMe } from "../src/api/types";
import { AppController } from "../src/state/app";
import type { WorkspaceEntry } from "../src/state/workspaces";
import { Store } from "../src/sync/store";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("../src/platform/badge", () => ({ setUnreadBadge: async () => {}, setTitleBase: () => {} }));

const A = "https://a.example.com"; // hostile: claims B's workspace_id
const B = "https://b.example.com";
const B_ID = "0190aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

const ME: UserMe = {
  id: "u1", username: "bob", display_name: "Bob", role: "member", deactivated_at: null, created_at: "", updated_at: "",
  email: null, must_change_password: false, notify_keywords: [], presence_hidden: false, notification_default: "mentions", notify_reactions: false, notify_tasks: true, has_password: true,
} as unknown as UserMe;

function tokens(): TokenResponse {
  return {
    access_token: "a", refresh_token: "r", token_type: "bearer", expires_in: 900, session_id: "s",
    device: { id: "d", platform: "desktop", device_name: "Mac", app_version: "0.1.0", enabled: true, disabled_reason: null, push_provider: "none", push_environment: null, push_registered: false, last_seen_at: null, created_at: "", updated_at: "" },
    user: ME,
  } as unknown as TokenResponse;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Two servers by URL: GET /server answers what `info` says for each; a login answers tokens. Every call recorded. */
function serve(info: Record<string, { workspace_id: string; name: string }>) {
  const calls: { url: string; method: string; body: string | null }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : null });
    const origin = new URL(url).origin;
    if (url.endsWith("/api/v1/server") && info[origin]) return json({ product: "chikuwachat", api_version: "0.1.0", ...info[origin] });
    if (url.endsWith("/api/v1/auth/login")) return json(tokens());
    return json({ error: { code: "not_found", message: "x", details: {} } }, 404);
  }));
  return calls;
}

/** A controller of the desktop app with `entries` saved; nothing starts an engine (no local store in tests). */
function controllerWith(entries: WorkspaceEntry[]) {
  const controller = new AppController();
  controller.workspaces = entries.map((e) => ({ ...e }));
  vi.spyOn(controller as unknown as { startEngine: () => Promise<boolean> }, "startEngine").mockResolvedValue(true);
  return controller;
}

function hostileEntry(signedOut: boolean): WorkspaceEntry {
  return { serverUrl: A, workspaceId: B_ID, name: "B", username: "bob", userId: "u-a", signedOut };
}

beforeEach(() => {
  (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

describe("adding a workspace is matched by URL only (§5.1 step 3)", () => {
  it("a signed-out server that claimed B's id does not receive B's password: the login goes to B and A's entry is untouched", async () => {
    const calls = serve({ [B]: { workspace_id: B_ID, name: "B の研究室" } });
    const before = hostileEntry(true);
    const controller = controllerWith([before]);
    controller.beginAddWorkspace();
    await controller.login(B, "bob", "secret-of-B", "123456");

    const logins = calls.filter((c) => c.url.endsWith("/api/v1/auth/login"));
    expect(logins.map((c) => c.url)).toEqual([`${B}/api/v1/auth/login`]);
    expect(calls.some((c) => c.url.startsWith(A) && c.body?.includes("secret-of-B"))).toBe(false);
    expect(controller.workspaces.find((e) => e.serverUrl === A)).toEqual(before);
    const added = controller.workspaces.find((e) => e.serverUrl === B)!;
    expect(added).toMatchObject({ workspaceId: B_ID, name: "B の研究室", username: "bob" });
    expect(controller.activeServer).toBe(B);
  });

  it("a signed-in server with B's id is not switched to: B is added as its own workspace", async () => {
    serve({ [A]: { workspace_id: B_ID, name: "B" }, [B]: { workspace_id: B_ID, name: "B の研究室" } });
    const controller = controllerWith([hostileEntry(false)]);
    const sessions = (controller as unknown as { sessions: Map<string, unknown> }).sessions;
    sessions.set(A, { serverUrl: A, username: "bob", api: { baseUrl: A }, store: new Store(), engine: {}, me: ME, leaving: false });
    controller.beginAddWorkspace();
    await controller.login(B, "bob", "pw");
    expect(controller.notice).toBeNull();
    expect(controller.workspaces.map((e) => [e.serverUrl, e.workspaceId])).toEqual([[A, B_ID], [B, B_ID]]);
    expect(controller.activeServer).toBe(B);
  });

  it("the same URL in another spelling is still the registered workspace (switched to when signed in)", async () => {
    serve({ [B]: { workspace_id: B_ID, name: "B" } });
    const controller = controllerWith([{ serverUrl: B, workspaceId: B_ID, name: "B", username: "bob", userId: "u1" }]);
    const sessions = (controller as unknown as { sessions: Map<string, unknown> }).sessions;
    const session = { serverUrl: B, username: "bob", api: { baseUrl: B, serverInfo: async () => ({}) }, store: new Store(), engine: {}, me: ME, leaving: false };
    sessions.set(B, session);
    controller.beginAddWorkspace();
    await controller.login("HTTPS://B.example.com/", "bob", "pw");
    expect(controller.workspaces).toHaveLength(1);
    expect(controller.activeServer).toBe(B);
    expect(controller.notice).toContain("登録済み");
  });

  it("an invite and Google's start go to the URL given, not to an entry that claims the same id", async () => {
    const calls = serve({ [B]: { workspace_id: B_ID, name: "B" } });
    const controller = controllerWith([hostileEntry(true)]);
    const openBrowser = vi.fn(async (_url: string) => {});
    controller.openBrowser = openBrowser;
    controller.beginAddWorkspace();
    await controller.startGoogleSignIn(B);
    expect(new URL(openBrowser.mock.calls[0]![0]).origin).toBe(B);
    controller.cancelGoogleSignIn();

    await controller.acceptInvite(B, "invite-token", { username: "bob", display_name: "Bob", password: "pw" });
    expect(calls.filter((c) => c.method === "POST").every((c) => c.url.startsWith(B))).toBe(true);
  });
});

describe("the recorded workspace_id", () => {
  async function refresh(entry: WorkspaceEntry, answer: { workspace_id: string; name: string; icon_version?: string | null }) {
    const controller = controllerWith([entry]);
    const session = { serverUrl: entry.serverUrl, api: { baseUrl: entry.serverUrl, serverInfo: async () => ({ product: "chikuwachat", api_version: "0.1.0", ...answer }) } };
    await (controller as unknown as { refreshServerInfo: (s: unknown) => Promise<void> }).refreshServerInfo(session);
    return controller.workspaces[0]!;
  }

  it("GET /server cannot change it later; the name and icon follow the server", async () => {
    const entry = await refresh({ serverUrl: A, workspaceId: "first-id", name: "A", username: "bob", userId: "u1" }, { workspace_id: B_ID, name: "A2", icon_version: "v2" });
    expect(entry).toMatchObject({ workspaceId: "first-id", name: "A2", iconVersion: "v2" });
  });

  it("an entry without one (a migrated install) records the first it hears", async () => {
    const entry = await refresh({ serverUrl: A, workspaceId: null, name: "a.example.com", username: "bob", userId: null }, { workspace_id: "w-a", name: "A" });
    expect(entry).toMatchObject({ workspaceId: "w-a", name: "A" });
  });

  it("signing in again keeps the entry's first id", async () => {
    serve({ [A]: { workspace_id: B_ID, name: "A" } });
    const controller = controllerWith([{ serverUrl: A, workspaceId: "first-id", name: "A", username: "bob", userId: "u1", signedOut: true }]);
    await controller.login(A, "bob", "pw");
    expect(controller.workspaces[0]).toMatchObject({ serverUrl: A, workspaceId: "first-id", signedOut: false });
  });
});
