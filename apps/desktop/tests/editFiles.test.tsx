// @vitest-environment jsdom
// M186 (docs/CHANNEL_FILES.md §7.6): files in the inline edit box — taken off, added, and what the save sends.
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "../src/api/client";
import type { AttachmentOut, MessageOut, UserMe } from "../src/api/types";
import { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { editFilesApplied, type EditFile, planEditSave, startEditFiles } from "../src/ui/editFileList";
import { messageActions } from "../src/ui/messageActions";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";

afterEach(cleanup);

const file = (id: string, extra: Partial<AttachmentOut> = {}): AttachmentOut => ({
  id, filename: `${id}.pdf`, content_type: "application/pdf", size_bytes: 10, width: null, height: null, has_thumbnail: false, has_poster: false, has_display: false, duration_ms: null, status: "attached", created_at: "", ...extra,
});
const added = (id: string): EditFile => ({ key: `new:${id}`, state: "added", attachment: file(id, { status: "pending" }) });

describe("planEditSave", () => {
  const message = { body: "hello", attachments: [file("a"), file("b")] };

  it("closes without a request when nothing changed", () => {
    expect(planEditSave(message, "hello", startEditFiles(message.attachments))).toEqual({ kind: "unchanged" });
  });

  it("sends the body alone when the files are as they were (the edit older servers know)", () => {
    expect(planEditSave(message, "hi", startEditFiles(message.attachments))).toEqual({ kind: "save", body: "hi" });
  });

  it("names the files left and the new ones after them when the files changed", () => {
    const kept = startEditFiles(message.attachments).filter((item) => item.state !== "kept" || item.attachment.id !== "a");
    expect(planEditSave(message, "hello", kept)).toEqual({ kind: "save", body: "hello", attachmentIds: ["b"] });
    // A new one listed before a kept one in the editor still goes after the kept ones.
    const mixed: EditFile[] = [added("n1"), ...startEditFiles(message.attachments), added("n2")];
    expect(planEditSave(message, "hello", mixed)).toEqual({ kind: "save", body: "hello", attachmentIds: ["a", "b", "n1", "n2"] });
  });

  it("takes an empty body while a file is left, naming the files even when they did not change", () => {
    expect(planEditSave(message, "", startEditFiles(message.attachments))).toEqual({ kind: "save", body: "", attachmentIds: ["a", "b"] });
    expect(planEditSave(message, "", [])).toEqual({ kind: "blocked" });
    // A files-only message opened and closed as it was: nothing to send.
    const filesOnly = { body: "", attachments: [file("a")] };
    expect(planEditSave(filesOnly, "", startEditFiles(filesOnly.attachments))).toEqual({ kind: "unchanged" });
  });

  it("waits for uploads, and for a failed one to be tried again or taken away", () => {
    const pdf = new File(["x"], "x.pdf");
    const uploading: EditFile[] = [...startEditFiles(message.attachments), { key: "u", state: "uploading", file: pdf }];
    expect(planEditSave(message, "hello", uploading)).toEqual({ kind: "blocked" });
    const failed: EditFile[] = [...startEditFiles(message.attachments), { key: "f", state: "failed", file: pdf, error: "x" }];
    expect(planEditSave(message, "hi", failed)).toEqual({ kind: "blocked" });
  });
});

describe("editFilesApplied (an older server ignores attachment_ids)", () => {
  it("compares the files as sets", () => {
    expect(editFilesApplied(["a", "n1", "n2"], [file("a"), file("n2"), file("n1")])).toBe(true);
    expect(editFilesApplied(["b", "n1"], [file("a"), file("b")])).toBe(false);
    expect(editFilesApplied([], [])).toBe(true);
  });
});

describe("the 編集 action", () => {
  it("is offered for my message with files and no text", () => {
    const message = { id: "m", channel_id: "c", sender_id: "me", body: "", attachments: [file("a")], seq: 1, pending: false, deleted: false } as unknown as Parameters<typeof messageActions>[0]["message"];
    const keys = messageActions({ message, mine: true, isAdmin: false, saved: false, thread: true, editable: true, showReactions: true, canMakeTask: false, canRequestReview: false, unreadOffered: false }).map((action) => action.key);
    expect(keys).toContain("edit");
  });
});

/** The timeline with my message open in the inline editor. */
function setUp(body: string, attachments: AttachmentOut[], upload = vi.fn(async (blob: Blob, name: string) => file(`up-${name}`, { filename: name, status: "pending", size_bytes: blob.size }))) {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const channel = server.createChannel("general", me.id);
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  store.upsertUser(me);
  const mine = { ...server.post(channel.id, me.id, body).message, attachments };
  store.upsertMessage(mine);
  store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: 1, oldestLoadedSeq: 0, lastReadSeq: 1 });
  const controller = {
    store, engine: null, version: 0, setError: vi.fn(), setNotice: vi.fn(), messageFocus: null, editing: mine.id as string | null, isAdmin: false, sendKey: "shift-enter",
    api: { uploadAttachment: upload, fetchBlob: vi.fn(async () => { throw new Error("no pictures here"); }) },
    linkPreviews: new Map(), linkPreview: vi.fn(), subscribeLinkPreviews: () => () => {}, subscribe: () => () => {},
    setEditing: vi.fn(function (this: { editing: string | null }, id: string | null) { this.editing = id; }),
    editMessage: vi.fn(async () => true),
  };
  function View() {
    useSyncExternalStore((l) => store.subscribe(l), () => store.version);
    return <Timeline controller={controller as unknown as AppController} channel={store.getChannel(channel.id)!} />;
  }
  render(<View />);
  const box = document.querySelector<HTMLElement>("[data-edit-box]")!;
  return { controller, mine, upload, box, editor: screen.getByLabelText("メッセージを編集") as HTMLTextAreaElement };
}

const paste = (target: HTMLElement, files: File[]) => fireEvent.paste(target, { clipboardData: { files, types: ["Files"], getData: () => "" } });
const saveButton = (box: HTMLElement) => within(box).getByRole("button", { name: "保存" }) as HTMLButtonElement;

describe("the inline editor's files", () => {
  it("takes one off, adds a pasted one and saves the list (kept first, then the new)", async () => {
    const { controller, mine, upload, box, editor } = setUp("two files", [file("a"), file("b")]);
    const list = within(box).getByRole("list", { name: "メッセージのファイル" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(within(box).getByRole("button", { name: "a.pdf を外す" }));
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);

    const picture = new File([new Uint8Array([1, 2, 3])], "new.png", { type: "image/png" });
    await act(async () => { paste(editor, [picture]); });
    expect(upload).toHaveBeenCalledExactlyOnceWith(picture, "new.png");
    await waitFor(() => expect(box.querySelector('[data-edit-file="added"]')).not.toBeNull());

    await act(async () => { fireEvent.click(saveButton(box)); });
    expect(controller.editMessage).toHaveBeenCalledExactlyOnceWith(mine.id, "two files", ["b", "up-new.png"]);
    expect(controller.setEditing).toHaveBeenCalledWith(null);
  });

  it("saves a body-only edit without naming the files", async () => {
    const { controller, mine, box, editor } = setUp("before", [file("a")]);
    fireEvent.change(editor, { target: { value: "after" } });
    await act(async () => { fireEvent.click(saveButton(box)); });
    expect(controller.editMessage).toHaveBeenCalledExactlyOnceWith(mine.id, "after");
  });

  it("saves an empty body while a file is left, and cannot save once nothing is left", async () => {
    const { controller, mine, box, editor } = setUp("caption", [file("a")]);
    fireEvent.change(editor, { target: { value: "" } });
    expect(saveButton(box).disabled).toBe(false);
    fireEvent.click(within(box).getByRole("button", { name: "a.pdf を外す" }));
    expect(saveButton(box).disabled).toBe(true);
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true }); // the save key does nothing either
    expect(controller.editMessage).not.toHaveBeenCalled();
    fireEvent.change(editor, { target: { value: "text again" } });
    await act(async () => { fireEvent.click(saveButton(box)); });
    expect(controller.editMessage).toHaveBeenCalledExactlyOnceWith(mine.id, "text again", []);
  });

  it("opens a files-only message and lists a 「削除されたファイル」 to take off", async () => {
    const gone = file("g", { drive: { item_id: null, version_id: null, state: "deleted" } as unknown as AttachmentOut["drive"] });
    const { controller, mine, box } = setUp("", [file("a"), gone]);
    expect(within(box).getByTitle("削除されたファイル").textContent).toBe("削除された\nファイル");
    expect(saveButton(box).disabled).toBe(false);
    fireEvent.click(within(box).getByRole("button", { name: "削除されたファイル を外す" }));
    await act(async () => { fireEvent.click(saveButton(box)); });
    expect(controller.editMessage).toHaveBeenCalledExactlyOnceWith(mine.id, "", ["a"]);
  });

  it("holds the save while a file goes up; a failed one can be tried again or taken away", async () => {
    let fail = true;
    let finish: (value: AttachmentOut) => void = () => {};
    const upload = vi.fn((_blob: Blob, name: string) => {
      if (fail) return Promise.reject(new TypeError("Failed to fetch"));
      return new Promise<AttachmentOut>((resolve) => { finish = resolve; void name; });
    });
    const { controller, mine, box, editor } = setUp("text", [file("a")], upload);
    await act(async () => { paste(editor, [new File(["x"], "doc.txt", { type: "text/plain" })]); });
    expect(box.querySelector('[data-edit-file="failed"]')).not.toBeNull();
    expect(controller.setError).toHaveBeenCalled();
    expect(saveButton(box).disabled).toBe(true);
    expect(within(box).getByText("アップロードできなかったファイルを外すか、もう一度アップロードすると保存できます")).toBeTruthy();

    fail = false;
    await act(async () => { fireEvent.click(within(box).getByRole("button", { name: "doc.txt をもう一度アップロード" })); });
    expect(upload).toHaveBeenCalledTimes(2);
    expect(box.querySelector('[data-edit-file="uploading"]')).not.toBeNull();
    expect(within(box).getByText("アップロード中… 完了後に保存できます")).toBeTruthy();
    expect(saveButton(box).disabled).toBe(true);

    await act(async () => { finish(file("up-doc", { filename: "doc.txt", status: "pending" })); });
    expect(saveButton(box).disabled).toBe(false);
    await act(async () => { fireEvent.click(saveButton(box)); });
    expect(controller.editMessage).toHaveBeenCalledExactlyOnceWith(mine.id, "text", ["a", "up-doc"]);
  });

  it("refuses files past ten with the composer's wording", async () => {
    const ten = Array.from({ length: 10 }, (_, index) => file(`f${index}`));
    const { controller, upload, editor } = setUp("full", ten);
    await act(async () => { paste(editor, [new File(["x"], "one-more.txt")]); });
    expect(upload).not.toHaveBeenCalled();
    expect(controller.setError).toHaveBeenCalledWith("添付は10件までです");
  });

  it("takes files dropped on the box (not the composer)", async () => {
    const { upload, box } = setUp("drop", []);
    const dropped = new File(["x"], "dropped.txt");
    const dataTransfer = { types: ["Files"], files: [dropped], dropEffect: "none" };
    fireEvent.dragEnter(box, { dataTransfer });
    expect(box.querySelector("[data-edit-drop]")).not.toBeNull();
    await act(async () => { fireEvent.drop(box, { dataTransfer }); });
    expect(upload).toHaveBeenCalledExactlyOnceWith(dropped, "dropped.txt");
    expect(box.querySelector("[data-edit-drop]")).toBeNull();
  });
});

describe("AppController.editMessage", () => {
  const answer = (attachments: AttachmentOut[]): MessageOut => ({ id: "m", channel_id: "c", sender_id: "u", body: "x", attachments, seq: 1, updated_seq: 2 }) as unknown as MessageOut;

  it("says so when the server kept the files as they were (older than M186)", async () => {
    const controller = new AppController();
    const editMessage = vi.fn(async () => answer([file("a"), file("b")]));
    controller.api = { editMessage } as unknown as ApiClient;
    expect(await controller.editMessage("m", "x", ["b", "n1"])).toBe(true);
    expect(editMessage).toHaveBeenCalledWith("m", "x", ["b", "n1"]);
    expect(controller.error).toBe("このサーバではファイルを変更できません");
  });

  it("stays quiet when the files came back as sent, or were not sent", async () => {
    const controller = new AppController();
    controller.api = { editMessage: vi.fn(async () => answer([file("b"), file("n1")])) } as unknown as ApiClient;
    expect(await controller.editMessage("m", "x", ["b", "n1"])).toBe(true);
    expect(await controller.editMessage("m", "x")).toBe(true);
    expect(controller.error).toBeNull();
  });
});

describe("ApiClient.editMessage", () => {
  it("sends attachment_ids only when given", async () => {
    const bodies: unknown[] = [];
    const client = new ApiClient("http://server", {
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: "m" }), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    client.accessToken = "a";
    await client.editMessage("m", "text");
    await client.editMessage("m", "", ["a", "n1"]);
    expect(bodies).toEqual([{ body: "text" }, { body: "", attachment_ids: ["a", "n1"] }]);
  });
});
