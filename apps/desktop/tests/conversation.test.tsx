// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { emptySnapshot, type Persistence, Store } from "../src/sync/store";
import { Composer } from "../src/ui/Composer";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const attachment: AttachmentOut = { id: "a1", filename: "note.txt", content_type: "text/plain", size_bytes: 4, width: null, height: null, has_thumbnail: false, status: "pending", created_at: "2026-09-26T00:00:00Z" };
function world() {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const channel = server.createChannel("general", me.id);
  const other = server.createChannel("other", me.id);
  const store = new Store();
  store.upsertUser(me);
  store.upsertChannel(channel, { isMember: true });
  store.upsertChannel(other, { isMember: true });
  const send = vi.fn(async () => {});
  const markRead = vi.fn();
  const controller = { store, engine: { send, markRead, status: "online" }, api: { uploadAttachment: vi.fn() }, setError: vi.fn(), messageFocus: null } as unknown as AppController;
  function DraftComposer({ id = channel.id, parentId = null }: { id?: string; parentId?: string | null }) {
    useSyncExternalStore(store.subscribe.bind(store), () => store.version);
    return <Composer controller={controller} channel={store.getChannel(id)!} parentId={parentId} />;
  }
  return { server, me, channel, other, store, controller, send, markRead, DraftComposer };
}

describe("conversation UX", () => {
  it("keeps channel and thread text separate across switches and restart", () => {
    const w = world();
    const view = render(<w.DraftComposer />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "channel draft" } });
    view.rerender(<w.DraftComposer parentId="parent" />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "thread draft" } });
    view.rerender(<w.DraftComposer id={w.other.id} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "other draft" } });
    view.rerender(<w.DraftComposer />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("channel draft");
    const restored = Store.fromSnapshot(w.store.snapshot());
    expect(restored.draft(w.channel.id, "parent").text).toBe("thread draft");
    expect(restored.draft(w.other.id).text).toBe("other draft");
  });

  it("blocks send during upload and puts the completed attachment in the original conversation", async () => {
    const w = world();
    let complete!: (attachment: AttachmentOut) => void;
    vi.mocked(w.controller.api!.uploadAttachment).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const view = render(<w.DraftComposer />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "with file" } });
    fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["note"], "note.txt")] } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(w.send).not.toHaveBeenCalled();
    view.rerender(<w.DraftComposer id={w.other.id} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "other conversation" } });
    await act(async () => { complete(attachment); });
    expect(w.store.draft(w.other.id).attachments).toEqual([]);
    expect(w.store.draft(w.channel.id).attachments).toEqual([attachment]);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(w.send).toHaveBeenLastCalledWith(w.other.id, "other conversation", undefined, null, []);
    view.rerender(<w.DraftComposer />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(w.send).toHaveBeenLastCalledWith(w.channel.id, "with file", undefined, null, ["a1"]);
    expect(w.store.draft(w.channel.id)).toEqual({ text: "", attachments: [] });
  });

  it("preserves a draft after a failed upload and does not send an IME confirmation", async () => {
    const w = world();
    vi.mocked(w.controller.api!.uploadAttachment).mockRejectedValue(new Error("offline"));
    const view = render(<w.DraftComposer />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "日本語" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", isComposing: true });
    expect(w.send).not.toHaveBeenCalled();
    await act(async () => { fireEvent.change(view.container.querySelector('input[type="file"]')!, { target: { files: [new File(["note"], "note.txt")] } }); });
    expect(w.store.draft(w.channel.id).text).toBe("日本語");
    expect(w.store.uploading(w.channel.id)).toBe(0);
    expect(w.controller.setError).toHaveBeenCalled();
  });

  it("only marks visible rows and never marks a search context read", () => {
    const w = world();
    const messages = [1, 2, 3].map((n) => w.server.post(w.channel.id, w.me.id, `message ${n}`).message);
    for (const message of messages) w.store.upsertMessage(message);
    w.store.updateChannel(w.channel.id, { lastSeq: 3, hasOlder: false });
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const scroll = vi.fn();
    HTMLElement.prototype.scrollIntoView = scroll;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const top = this.dataset.seq ? (Number(this.dataset.seq) - 1) * 60 : 0;
      const height = this.classList.contains("timeline") ? 120 : 60;
      return { top, bottom: top + height, height, left: 0, right: 300, width: 300, x: 0, y: top, toJSON: () => ({}) };
    });
    const view = render(<Timeline controller={w.controller} channel={w.store.getChannel(w.channel.id)!} />);
    expect(w.markRead).toHaveBeenLastCalledWith(w.channel.id, 2);
    w.markRead.mockClear();
    w.controller.messageFocus = { channelId: w.channel.id, messageId: messages[0]!.id, parentId: null, context: [messages[0]!] };
    view.rerender(<Timeline controller={w.controller} channel={w.store.getChannel(w.channel.id)!} />);
    expect(screen.getByText("検索位置の前後の会話")).toBeTruthy();
    expect(view.container.querySelector("article.highlighted")?.id).toBe(`timeline-${messages[0]!.id}`);
    expect(scroll).toHaveBeenLastCalledWith({ block: "center" });
    expect(w.markRead).not.toHaveBeenCalled();
  });

  it("persists the latest draft and its attachments in write order, then removes an empty draft", async () => {
    const snapshot = emptySnapshot();
    const persistence = { loadAll: async () => structuredClone(snapshot), saveMeta: async (key: string, value: string | null) => {
      await Promise.resolve();
      if (value === null) delete snapshot.meta[key]; else snapshot.meta[key] = value;
    } } as Persistence;
    const store = new Store(persistence);
    store.setDraft("c", null, { text: "a" });
    store.setDraft("c", null, { text: "ab", attachments: [attachment] });
    store.setDraft("c", "thread", { text: "reply" });
    await store.flushPersistence();
    const restored = new Store(persistence);
    await restored.load();
    expect(restored.draft("c")).toEqual({ text: "ab", attachments: [attachment] });
    restored.setDraft("c", null, { text: "", attachments: [] });
    await restored.flushPersistence();
    const reopened = new Store(persistence);
    await reopened.load();
    expect(reopened.draft("c").text).toBe("");
    expect(reopened.draft("c", "thread").text).toBe("reply");
  });

  it("edits my newest message with ↑ and replies to the newest message with Shift+↑", () => {
    const w = world();
    const setEditing = vi.fn();
    (w.controller as unknown as { setEditing: unknown }).setEditing = setEditing;
    const onReplyLast = vi.fn();
    w.store.setMe({ ...w.me, email: null, must_change_password: false });
    const bob = w.server.addUser("bob");
    w.server.join(w.channel.id, bob.id);
    w.store.upsertUser(bob);
    const mine = w.server.post(w.channel.id, w.me.id, "mine").message;
    w.store.upsertMessage(mine);
    w.store.upsertMessage(w.server.post(w.channel.id, bob.id, "theirs").message);
    render(<Composer controller={w.controller} channel={w.store.getChannel(w.channel.id)!} onReplyLast={onReplyLast} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });
    expect(setEditing).toHaveBeenCalledWith(mine.id);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp", shiftKey: true });
    expect(onReplyLast).toHaveBeenCalledTimes(1);
    // With text in the field ↑ is ordinary cursor movement.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "typing" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });
    expect(setEditing).toHaveBeenCalledTimes(1);
  });
});
