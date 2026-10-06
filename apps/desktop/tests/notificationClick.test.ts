// @vitest-environment jsdom
/**
 * A click on a desktop notification (WORKSPACES.md §7, 2026-10-06): the message opens in its own workspace, which comes
 * on screen first when another one is open (before, a click on another workspace's notification did nothing).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MessageOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import type { EngineDeps } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import type { ChannelState } from "../src/sync/types";
import { FakeServer } from "./fakeServer";

const { shown } = vi.hoisted(() => ({ shown: [] as Array<{ title: string; onClick?: () => void }> }));
vi.mock("../src/platform/notify", () => ({
  notify: async (title: string, _body: string, onClick?: () => void) => void shown.push({ title, onClick }),
  clearNotifications: () => {},
}));

const A = "https://a.example.com";
const B = "https://b.example.com";

afterEach(() => {
  localStorage.clear();
  shown.length = 0;
});

/** Two signed-in workspaces, A on screen; B's engine as the controller builds it (its notification callbacks). */
function twoWorkspaces() {
  const controller = new AppController();
  controller.workspaces = [A, B].map((serverUrl) => ({ serverUrl, workspaceId: null, name: serverUrl.slice(8, 9).toUpperCase(), username: "bob", userId: null }));
  const sessions = (controller as unknown as { sessions: Map<string, unknown> }).sessions;
  const session = (serverUrl: string) => {
    const api = { baseUrl: serverUrl, wsUrl: `${serverUrl.replace("https", "wss")}/api/v1/ws`, accessToken: "t", serverInfo: async () => { throw new Error("offline"); }, fetchBlob: async () => new Blob() };
    const value = { serverUrl, username: "bob", api, store: new Store(), engine: {} as unknown, me: null, leaving: false };
    sessions.set(serverUrl, value);
    return value;
  };
  const a = session(A);
  const b = session(B);
  (controller as unknown as { activate: (s: unknown) => void }).activate(a);
  const engine = (controller as unknown as { makeEngine: (s: unknown) => { deps: EngineDeps } }).makeEngine(b);
  return { controller, deps: engine.deps };
}

describe("notification clicks", () => {
  it("a message of another workspace: that workspace comes on screen, then the message (or its thread) is revealed there", async () => {
    const { controller, deps } = twoWorkspaces();
    expect(controller.activeServer).toBe(A);
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const channel = server.createChannel("general", alice.id);
    const parent = server.post(channel.id, alice.id, "parent").message;
    const reply: MessageOut = server.post(channel.id, alice.id, "a reply", undefined, parent.id).message;
    const revealedIn: Array<[string | null, MessageOut]> = [];
    vi.spyOn(controller, "revealMessage").mockImplementation(async (message) => {
      revealedIn.push([controller.activeServer, message]);
      return true;
    });
    deps.onNotify!(reply, { ...channel, type: "public" } as unknown as ChannelState);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    expect(shown[0]!.title).toContain("· B"); // several workspaces: the title names it
    shown[0]!.onClick!();
    await vi.waitFor(() => expect(revealedIn).toHaveLength(1));
    expect(revealedIn[0]![0]).toBe(B);
    expect(revealedIn[0]![1].parent_id).toBe(parent.id); // the main screen opens its thread
    expect(controller.activeServer).toBe(B);
  });

  it("the open workspace's notification opens at once; a signed-out workspace's does nothing", async () => {
    const { controller } = twoWorkspaces();
    const opened: Array<string | null> = [];
    await controller.openFromNotification(A, () => opened.push(controller.activeServer));
    expect(opened).toEqual([A]);
    const sessions = (controller as unknown as { sessions: Map<string, { leaving: boolean }> }).sessions;
    sessions.get(B)!.leaving = true;
    await controller.openFromNotification(B, () => opened.push(controller.activeServer));
    await controller.openFromNotification("https://gone.example.com", () => opened.push(controller.activeServer));
    expect(opened).toEqual([A]);
    expect(controller.activeServer).toBe(A);
  });

  it("a task, canvas or reservation notice of another workspace switches too (its request lands on that screen)", async () => {
    const { controller, deps } = twoWorkspaces();
    deps.onReservationNotice!({ text: "予約の順番が来ました" } as Parameters<NonNullable<EngineDeps["onReservationNotice"]>>[0]);
    await vi.waitFor(() => expect(shown).toHaveLength(1));
    const before = controller.openReservationsRequest;
    shown[0]!.onClick!();
    await vi.waitFor(() => expect(controller.openReservationsRequest).toBe(before + 1));
    expect(controller.activeServer).toBe(B);
  });
});
