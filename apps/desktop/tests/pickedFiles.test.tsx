// @vitest-environment jsdom
/**
 * Picked files (platform/pickedFiles.ts, review v0.1.30 #5): the count and each size are checked before any byte is
 * read (a refused pick reads nothing), the allowed ones are copied one at a time (each uploaded before the next is
 * read), and the input keeps its value until the last copy is made (WKWebView could not read a picked File after
 * the input was reset).
 */
import { useSyncExternalStore } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttachmentOut } from "../src/api/types";
import { ATTACHMENT_MAX_BYTES, copyPickedFile, forEachPicked, isPickBusy, refusePicked, takePicked } from "../src/platform/pickedFiles";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Composer } from "../src/ui/Composer";
import { FakeServer } from "./fakeServer";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Byte reads of the picked files: how many started, and the most at once. */
function readLog() {
  const log = { started: 0, open: 0, most: 0 };
  const file = (name: string, size = 4, type = "video/mp4") => {
    const f = new File([new Uint8Array(4)], name, { type });
    if (size !== 4) Object.defineProperty(f, "size", { value: size });
    const real = f.arrayBuffer.bind(f);
    f.arrayBuffer = async () => {
      log.started += 1;
      log.open += 1;
      log.most = Math.max(log.most, log.open);
      await new Promise((resolve) => setTimeout(resolve, 1));
      try { return await real(); } finally { log.open -= 1; }
    };
    return f;
  };
  return { log, file };
}

function pick(input: HTMLInputElement, files: File[]): void {
  fireEvent.change(input, { target: { files } });
}

const meta = (id: string): AttachmentOut => ({ id, filename: `${id}.mp4`, content_type: "video/mp4", size_bytes: 4, width: null, height: null, has_thumbnail: false, has_poster: false, duration_ms: null, status: "pending", created_at: "2026-10-04T00:00:00Z" });

function composer() {
  const server = new FakeServer();
  const me = server.addUser("me");
  const store = new Store();
  const channel = store.upsertChannel(server.createChannel("general", me.id), { isMember: true });
  let n = 0;
  const uploads: string[] = [];
  const uploadAttachment = vi.fn(async (file: File) => {
    uploads.push(file.name);
    await new Promise((resolve) => setTimeout(resolve, 2));
    n += 1;
    return meta(`a${n}`);
  });
  const setError = vi.fn();
  const controller = { store, api: { uploadAttachment }, setError, sendKey: "shift-enter", isAdmin: false } as unknown as AppController;
  function View() {
    useSyncExternalStore(store.subscribe.bind(store), () => store.version);
    return <Composer controller={controller} channel={store.getChannel(channel.id)!} />;
  }
  const view = render(<View />);
  const input = view.container.querySelector('input[type="file"]:not([accept])') as HTMLInputElement;
  return { store, channel, uploadAttachment, uploads, setError, input, view };
}

describe("pickedFiles helpers", () => {
  it("copies a picked file (name, type, lastModified and bytes kept)", async () => {
    const a = new File([new Uint8Array([137, 80, 78, 71])], "icon.png", { type: "image/png", lastModified: 5 });
    const copy = await copyPickedFile(a);
    expect(copy).not.toBe(a);
    expect([copy.name, copy.type, copy.lastModified]).toEqual(["icon.png", "image/png", 5]);
    expect(new Uint8Array(await copy.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it("refusePicked reads only the count and the sizes", () => {
    const { log, file } = readLog();
    expect(refusePicked([file("a"), file("b")], { maxFiles: 1, maxBytes: 10 })).toBe("添付は10件までです");
    expect(refusePicked([file("big.mov", ATTACHMENT_MAX_BYTES + 1)], { maxFiles: 10, maxBytes: ATTACHMENT_MAX_BYTES })).toBe("「big.mov」は大きすぎます (100 MB まで)");
    expect(refusePicked([file("ok")], { maxFiles: 10, maxBytes: ATTACHMENT_MAX_BYTES })).toBeNull();
    expect(log.started).toBe(0);
  });

  it("forEachPicked hands each copy on before reading the next, then releases the input", async () => {
    const { log, file } = readLog();
    const input = document.createElement("input");
    input.type = "file";
    Object.defineProperty(input, "files", { value: [file("1"), file("2"), file("3")], configurable: true });
    const picked = takePicked(input);
    expect(isPickBusy(input)).toBe(true);
    const order: string[] = [];
    await forEachPicked(picked.files, async (copy) => {
      order.push(`use ${copy.name} (open reads ${log.open})`);
      expect(isPickBusy(input)).toBe(true);
    }, picked.release, () => {});
    expect(order).toEqual(["use 1 (open reads 0)", "use 2 (open reads 0)", "use 3 (open reads 0)"]);
    expect(log.most).toBe(1);
    expect(isPickBusy(input)).toBe(false);
  });

  it("a file that cannot be read is reported and the others still follow", async () => {
    const bad = new File(["x"], "bad.bin");
    bad.arrayBuffer = () => Promise.reject(new Error("NotReadableError"));
    const good = new File(["y"], "good.bin");
    const used: string[] = [];
    const errors: string[] = [];
    const release = vi.fn();
    await forEachPicked([bad, good], async (copy) => { used.push(copy.name); }, release, (_e, f) => errors.push(f.name));
    expect(used).toEqual(["good.bin"]);
    expect(errors).toEqual(["bad.bin"]);
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("the composer's picker (review v0.1.30 #5)", () => {
  it("11 files: refused before any byte is read, nothing uploaded, the input cleared", () => {
    const { log, file } = readLog();
    const c = composer();
    pick(c.input, Array.from({ length: 11 }, (_, i) => file(`v${i}.mp4`)));
    expect(c.setError).toHaveBeenCalledWith("添付は10件までです");
    expect(log.started).toBe(0);
    expect(c.uploadAttachment).not.toHaveBeenCalled();
    expect(c.store.uploading(c.channel.id)).toBe(0);
    expect(isPickBusy(c.input)).toBe(false);
  });

  it("with attachments already there, more than 10 together is refused before reading", async () => {
    const { log, file } = readLog();
    const c = composer();
    pick(c.input, Array.from({ length: 8 }, (_, i) => file(`v${i}.mp4`)));
    await waitFor(() => expect(c.store.draft(c.channel.id).attachments).toHaveLength(8));
    const before = log.started;
    pick(c.input, [file("x.mp4"), file("y.mp4"), file("z.mp4")]);
    expect(c.setError).toHaveBeenCalledWith("添付は10件までです");
    expect(log.started).toBe(before);
    expect(c.uploadAttachment).toHaveBeenCalledTimes(8);
  });

  it("a file over the size limit refuses the whole pick before any read", () => {
    const { log, file } = readLog();
    const c = composer();
    pick(c.input, [file("small.mp4"), file("huge.mov", ATTACHMENT_MAX_BYTES + 1)]);
    expect(c.setError).toHaveBeenCalledWith("「huge.mov」は大きすぎます (100 MB まで)");
    expect(log.started).toBe(0);
    expect(c.uploadAttachment).not.toHaveBeenCalled();
  });

  it("allowed videos are read one at a time, each uploaded before the next is read; the input stays busy until the last", async () => {
    const { log, file } = readLog();
    const c = composer();
    pick(c.input, [file("a.mp4"), file("b.mp4"), file("c.mp4")]);
    // The counter that holds back sending rises at once; the input is not cleared yet.
    expect(c.store.uploading(c.channel.id)).toBe(3);
    expect(isPickBusy(c.input)).toBe(true);
    await waitFor(() => expect(c.store.draft(c.channel.id).attachments).toHaveLength(3));
    expect(log.most).toBe(1);
    expect(log.started).toBe(3);
    expect(c.uploads).toEqual(["a.mp4", "b.mp4", "c.mp4"]);
    expect(isPickBusy(c.input)).toBe(false);
    expect(c.store.uploading(c.channel.id)).toBe(0);
  });

  it("while a pick is still being read, opening the picker again is held back", async () => {
    const { file } = readLog();
    const c = composer();
    pick(c.input, [file("a.mp4"), file("b.mp4")]);
    const click = vi.spyOn(c.input, "click");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "u", metaKey: true });
    expect(click).not.toHaveBeenCalled();
    expect(c.setError).toHaveBeenCalledWith("前に選んだファイルを読み込み中です");
    await waitFor(() => expect(isPickBusy(c.input)).toBe(false));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "u", metaKey: true });
    expect(click).toHaveBeenCalledTimes(1);
  });
});
