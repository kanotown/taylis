// @vitest-environment jsdom
/** M88 (docs/MEMBERSHIP.md): join / leave lines and the two workspace settings, on Desktop / Web. */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminWorkspaceSettingsOut, MessageOut, UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { PreviewJoinBar, PreviewTimeline, previewRefused } from "../src/ui/ChannelPreview";
import { buildTimeline } from "../src/ui/format";
import { isSystemMessage, systemMessageText } from "../src/ui/systemMessage";
import { WorkspaceSettingsTab } from "../src/ui/WorkspaceSettingsTab";
import { FakeServer, MemoryPersistence } from "./fakeServer";

afterEach(cleanup);

const names: Record<string, string> = { a: "Alice", b: "Bob", c: "Carol" };
const nameOf = (id: string) => names[id];
const line = (kind: NonNullable<MessageOut["system_event"]>["kind"], actor: string, users: string[], body = "fallback") => ({ body, system_event: { kind, actor_id: actor, user_ids: users } });

describe("systemMessageText", () => {
  it("writes each kind from the directory's names", () => {
    expect(systemMessageText(line("member_joined", "a", ["a"]), nameOf)).toBe("Alice が参加しました");
    expect(systemMessageText(line("member_left", "a", ["a"]), nameOf)).toBe("Alice が退出しました");
    expect(systemMessageText(line("members_added", "a", ["b", "c"]), nameOf)).toBe("Alice が Bob、Carol を追加しました");
    expect(systemMessageText(line("member_removed", "a", ["b"]), nameOf)).toBe("Alice が Bob を外しました");
  });

  it("falls back to the body: no event, an unknown kind, someone the directory does not have", () => {
    expect(systemMessageText({ body: "old line", system_event: null }, nameOf)).toBe("old line");
    expect(systemMessageText({ body: "new kind", system_event: { kind: "channel_renamed" as never, actor_id: "a", user_ids: [] } }, nameOf)).toBe("new kind");
    expect(systemMessageText(line("members_added", "a", ["zz"], "Alice が Zed を追加しました"), nameOf)).toBe("Alice が Zed を追加しました");
  });

  it("is never grouped with people's posts", () => {
    expect(isSystemMessage({ type: "system" })).toBe(true);
    expect(isSystemMessage({ type: "user" })).toBe(false);
    expect(isSystemMessage({})).toBe(false);
    const at = new Date().toISOString();
    const row = (id: string, seq: number, type: string) => ({ id, seq, type, sender_id: "a", created_at: at, body: id, channel_id: "c", updated_seq: seq, client_msg_id: null, edited_at: null, deleted: false });
    const items = buildTimeline([row("p1", 1, "user"), row("s", 2, "system"), row("p2", 3, "user")] as never, { firstUnreadAfterSeq: null, meId: null, group: true });
    const compact = items.filter((i) => i.kind === "message").map((i) => (i as { compact: boolean }).compact);
    expect(compact).toEqual([false, false, false]);
  });
});

async function world() {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const general = server.createChannel("general", alice.id);
  server.join(general.id, bob.id);
  const lab = server.createChannel("lab", alice.id);
  server.post(lab.id, alice.id, "公開の話題");
  const store = new Store(new MemoryPersistence());
  const notified: string[] = [];
  const engine = new SyncEngine(
    { api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "token", sleep: async () => {}, onNotify: (m) => notified.push(m.body), isActive: () => false },
    { pageSize: 3, readDebounceMs: 0 },
  );
  await engine.start();
  await engine.idle();
  return { server, alice, bob, general, lab, store, engine, notified };
}

describe("join / leave lines in the engine", () => {
  it("are neither counted as unread nor notified, at level all too", async () => {
    const w = await world();
    w.store.setMe({ ...(w.server.users.get(w.bob.id) as unknown as UserMe), notification_default: "all" });
    w.server.post(w.general.id, w.alice.id, "Alice が Carol を追加しました", undefined, null, [], { type: "system", systemEvent: { kind: "members_added", actor_id: w.alice.id, user_ids: [w.bob.id] } });
    await w.engine.idle();
    expect(w.store.getChannel(w.general.id)?.unreadCount).toBe(0);
    expect(w.notified).toEqual([]);
    w.server.post(w.general.id, w.alice.id, "hello");
    await w.engine.idle();
    expect(w.store.getChannel(w.general.id)?.unreadCount).toBe(1);
    expect(w.notified).toEqual(["hello"]);
  });
});

describe("参加前にチャンネルの中を見られる (preview_before_join)", () => {
  it("off in bootstrap: the preview asks for nothing and shows the join panel; on again, it loads", async () => {
    const w = await world();
    w.server.workspaceSettings = { show_membership_messages: true, preview_before_join: false };
    w.store.setWorkspaceSettings(w.server.workspaceSettings);
    const history = vi.spyOn((w.engine as unknown as { deps: { api: { history: (...args: unknown[]) => unknown } } }).deps.api, "history");
    await w.engine.openPreview(w.lab.id);
    expect(w.engine.preview).toMatchObject({ refused: true, loaded: false, messages: [] });
    expect(history).not.toHaveBeenCalled();

    // An administrator turns it on: the open preview loads at once (workspace.settings_updated).
    w.server.setWorkspaceSettings({ preview_before_join: true });
    await w.engine.idle();
    await waitFor(() => expect(w.engine.preview).toMatchObject({ refused: false, loaded: true }));
    expect(w.engine.preview!.messages.map((m) => m.body)).toEqual(["公開の話題"]);

    // And off again: the rows go.
    w.server.setWorkspaceSettings({ preview_before_join: false });
    await w.engine.idle();
    expect(w.engine.preview).toMatchObject({ refused: true, messages: [] });
    expect(w.store.workspaceSettings.preview_before_join).toBe(false);
  });

  it("a 403 preview_disabled from the server (the setting changed while offline) shows the panel too", async () => {
    const w = await world();
    w.server.workspaceSettings = { show_membership_messages: true, preview_before_join: false }; // no event sent
    await w.engine.openPreview(w.lab.id);
    expect(w.engine.preview).toMatchObject({ refused: true, loaded: false });
  });

  it("the panel shows what the browser shows and 参加, in place of the bar's button", async () => {
    const w = await world();
    w.store.setWorkspaceSettings({ show_membership_messages: true, preview_before_join: false });
    await w.engine.openPreview(w.lab.id);
    const onJoin = vi.fn(async () => true);
    const controller = { store: w.store, engine: w.engine, api: { baseUrl: "http://server" }, setError: vi.fn(), messageFocus: null, groupPosts: false } as unknown as AppController;
    const channel = { ...w.store.getChannel(w.lab.id)!, purpose: "研究の連絡", member_count: 1 };
    function View() {
      useSyncExternalStore((l) => w.engine.subscribe(l), () => w.engine.preview);
      return (
        <>
          <PreviewTimeline controller={controller} channel={channel} onJoin={onJoin} />
          {!previewRefused(controller, channel.id) && <PreviewJoinBar controller={controller} channel={channel} onJoin={onJoin} />}
        </>
      );
    }
    render(<View />);
    const panel = screen.getByTestId("join-to-read");
    expect(panel.textContent).toContain("参加するとメッセージを読めます");
    expect(panel.textContent).toContain("研究の連絡");
    expect(panel.textContent).toContain("メンバー 1 人");
    expect(screen.queryByText("#lab に参加する")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "参加" }));
    expect(onJoin).toHaveBeenCalledWith(w.lab.id);
  });

  it("a system line in the preview is one muted line with today's names, without actions", async () => {
    const w = await world();
    w.server.post(w.lab.id, w.alice.id, "Alice が参加しました", undefined, null, [], { type: "system", systemEvent: { kind: "member_joined", actor_id: w.alice.id, user_ids: [w.alice.id] } });
    w.store.upsertUser({ ...w.server.users.get(w.alice.id)!, display_name: "Alice (改名)" });
    w.store.setMe(w.server.users.get(w.bob.id) as unknown as UserMe);
    await w.engine.openPreview(w.lab.id);
    const controller = {
      store: w.store, engine: w.engine, api: { baseUrl: "http://server" }, version: 0, setError: vi.fn(), messageFocus: null, editing: null, isAdmin: false, sendKey: "shift-enter",
      linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {}, groupPosts: true,
    } as unknown as AppController;
    function View() {
      useSyncExternalStore((l) => w.engine.subscribe(l), () => w.engine.preview);
      return <PreviewTimeline controller={controller} channel={w.store.getChannel(w.lab.id)!} />;
    }
    render(<View />);
    const row = await screen.findByText("Alice (改名) が参加しました");
    const article = row.closest("article")!;
    expect(article.hasAttribute("data-system")).toBe(true);
    expect(article.querySelector("button")).toBeNull();
    expect(article.querySelector("img")).toBeNull(); // no avatar
  });
});

describe("Administration → 設定", () => {
  it("shows the two switches and saves each when flipped", async () => {
    const row: AdminWorkspaceSettingsOut = { show_membership_messages: true, preview_before_join: true, updated_at: null, updated_by: null };
    const adminWorkspaceSettings = vi.fn(async () => row);
    const adminUpdateWorkspaceSettings = vi.fn(async (patch: object) => ({ ...row, ...patch }));
    const controller = { api: { adminWorkspaceSettings, adminUpdateWorkspaceSettings }, store: new Store(), setError: vi.fn() } as unknown as AppController;
    render(<WorkspaceSettingsTab controller={controller} />);
    const lines = (await screen.findByRole("switch", { name: "参加・退出の表示" })) as HTMLInputElement;
    const preview = screen.getByRole("switch", { name: "参加前にチャンネルの中を見られる" }) as HTMLInputElement;
    expect(lines.checked).toBe(true);
    expect(preview.checked).toBe(true);
    await act(async () => { fireEvent.click(preview); });
    expect(adminUpdateWorkspaceSettings).toHaveBeenCalledWith({ preview_before_join: false });
    expect(preview.checked).toBe(false);
  });

  it("puts a switch back when the server refuses, and says so on a server before M88", async () => {
    const row: AdminWorkspaceSettingsOut = { show_membership_messages: true, preview_before_join: true, updated_at: null, updated_by: null };
    const setError = vi.fn();
    const controller = {
      api: { adminWorkspaceSettings: vi.fn(async () => row), adminUpdateWorkspaceSettings: vi.fn(async () => { throw new Error("offline"); }) },
      store: new Store(),
      setError,
    } as unknown as AppController;
    render(<WorkspaceSettingsTab controller={controller} />);
    const lines = (await screen.findByRole("switch", { name: "参加・退出の表示" })) as HTMLInputElement;
    await act(async () => { fireEvent.click(lines); });
    expect(lines.checked).toBe(true);
    expect(setError).toHaveBeenCalled();

    cleanup();
    const old = { api: { adminWorkspaceSettings: vi.fn(async () => { throw Object.assign(new Error("not found"), { status: 404 }); }) }, store: new Store(), setError: vi.fn() } as unknown as AppController;
    render(<WorkspaceSettingsTab controller={old} />);
    expect(await screen.findByText("このサーバはワークスペースの設定に対応していません。")).toBeTruthy();
  });
});
