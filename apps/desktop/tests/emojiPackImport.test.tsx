// @vitest-environment jsdom
import { deflateRawSync } from "node:zlib";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError, describeFeatureError, isMissingRoute, serverTooOldMessage } from "../src/api/errors";
import { AppController } from "../src/state/app";
import { ImportPackDialog } from "../src/ui/customEmoji";
import { readZipPackFiles } from "../src/ui/emojiPackSource";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => {
  URL.createObjectURL = vi.fn(() => `blob:${Math.random()}`);
  URL.revokeObjectURL = vi.fn();
});

const TOO_OLD = "このサーバはまだセットの取り込みに対応していません。サーバを更新してからもう一度お試しください。";
const manifest = JSON.stringify({ name: "はんぺん", items: [{ file: "001.png", shortcode: "a" }, { file: "002.png", shortcode: "b" }] });

/** A minimal ZIP: `deflate` entries compressed, the rest stored. */
function zip(entries: Array<{ name: string; data: string; deflate?: boolean }>): File {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const raw = enc.encode(e.data);
    const body = e.deflate ? new Uint8Array(deflateRawSync(raw)) : raw;
    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, e.deflate ? 8 : 0, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(body, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, e.deflate ? 8 : 0, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const size = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  return new File([...locals, ...centrals, end] as BlobPart[], "hanpen.zip", { type: "application/zip" });
}

describe("an older server without the endpoint", () => {
  it("is a missing route on 404 not_found or 405, not on a row's own 404", () => {
    expect(isMissingRoute(new ApiError(404, "not_found", "Not Found"))).toBe(true);
    expect(isMissingRoute(new ApiError(405, "method_not_allowed", "Method Not Allowed"))).toBe(true);
    expect(isMissingRoute(new ApiError(404, "emoji_not_found", "no"))).toBe(false);
    expect(describeFeatureError(new ApiError(405, "method_not_allowed", ""), "セットの取り込み")).toBe(TOO_OLD);
    expect(describeFeatureError(new ApiError(404, "not_found", ""), "セットの取り込み")).not.toBe("見つかりませんでした");
    expect(describeFeatureError(new ApiError(403, "admin_required", ""), "セットの取り込み")).toBe("管理者だけが行える操作です");
  });

  it("the controller says so for a pack import and for a text emoji", async () => {
    const api = {
      importEmojiPack: vi.fn(async () => { throw new ApiError(404, "not_found", "Not Found"); }),
      createTextEmoji: vi.fn(async () => { throw new ApiError(405, "method_not_allowed", "Method Not Allowed"); }),
    };
    const self = { api, store: {}, error: null as string | null, emit: () => {}, setError: AppController.prototype.setError };
    const imported = await AppController.prototype.importEmojiPack.call(self as unknown as AppController, { files: [] });
    expect(imported).toBe(TOO_OLD);
    const ok = await AppController.prototype.createTextEmoji.call(self as unknown as AppController, { name: "kakunin", label: "確認", color: "gray", keywords: [] });
    expect(ok).toBe(false);
    expect(self.error).toBe(serverTooOldMessage("文字の絵文字"));
  });
});

describe("reading a pack ZIP for the preview", () => {
  it("returns pack.json and the images by base name, stored or deflated, skipping notes and __MACOSX", async () => {
    const files = await readZipPackFiles(zip([
      { name: "hanpen/", data: "" },
      { name: "hanpen/pack.json", data: manifest, deflate: true },
      { name: "hanpen/001.png", data: "png1" },
      { name: "hanpen/タグ案.md", data: "#" },
      { name: "__MACOSX/hanpen/._001.png", data: "x" },
    ]));
    expect(files?.map((f) => f.name)).toEqual(["pack.json", "001.png"]);
    expect(await files![0]!.text()).toBe(manifest);
  });

  it("is null for something that is not a ZIP", async () => {
    expect(await readZipPackFiles(new File(["not a zip at all, just text here"], "x.zip"))).toBeNull();
  });
});

describe("「セットを追加」 dialog", () => {
  const controllerWith = (importEmojiPack: () => Promise<unknown>) => ({ importEmojiPack: vi.fn(importEmojiPack) }) as unknown as AppController;

  it("offers a folder and a ZIP button, previews the pick, and can pick again", async () => {
    render(<ImportPackDialog controller={controllerWith(async () => TOO_OLD)} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: "フォルダを選ぶ" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "ZIP ファイルを選ぶ" })).toBeTruthy();
    expect(screen.getByText(/PNG 画像と pack.json の入ったフォルダ/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "取り込む" }) as HTMLButtonElement).disabled).toBe(true);

    const files = [new File([manifest], "pack.json"), new File(["x"], "001.png"), new File(["x"], "002.png")];
    fireEvent.change(screen.getByTestId("pack-folder"), { target: { files } });
    await screen.findByText("「はんぺん」 · 2 個");
    expect(screen.getByLabelText("見本").querySelectorAll("img")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "フォルダを選ぶ" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "選び直す" }));
    expect(screen.getByRole("button", { name: "フォルダを選ぶ" })).toBeTruthy();
  });

  it("previews a ZIP's pack.json too", async () => {
    render(<ImportPackDialog controller={controllerWith(async () => TOO_OLD)} onClose={() => {}} />);
    const archive = zip([{ name: "pack.json", data: manifest, deflate: true }, { name: "001.png", data: "x" }, { name: "002.png", data: "y" }]);
    fireEvent.change(screen.getByTestId("pack-zip"), { target: { files: [archive] } });
    await screen.findByText("「はんぺん」 · 2 個");
    expect(screen.getByText("hanpen.zip")).toBeTruthy();
  });

  it("says the server is too old instead of 「見つかりませんでした」", async () => {
    const controller = controllerWith(async () => TOO_OLD);
    render(<ImportPackDialog controller={controller} onClose={() => {}} />);
    fireEvent.change(screen.getByTestId("pack-folder"), { target: { files: [new File([manifest], "pack.json"), new File(["x"], "001.png"), new File(["x"], "002.png")] } });
    await screen.findByText("「はんぺん」 · 2 個");
    fireEvent.click(screen.getByRole("button", { name: "取り込む" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(TOO_OLD));
    expect(screen.queryByText("見つかりませんでした")).toBeNull();
  });
});
