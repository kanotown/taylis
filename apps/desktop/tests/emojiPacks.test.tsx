// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomEmojiOut, EmojiPackOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { packFiles, previewPackFolder, splitKeywords } from "../src/ui/customEmoji";
import { customEmojiCandidates, emojiCandidates, emojiQuery, foldSearch } from "../src/ui/emoji";
import { EmojiPicker } from "../src/ui/EmojiPicker";
import { TEXT_EMOJI_COLORS, TEXT_EMOJI_LABEL_MAX } from "../src/ui/textEmoji";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const base = { content_type: "image/png", width: 180, height: 180, keywords: [] as string[], position: 0, created_by: "u", created_at: "", kind: "image" as const };
const bow: CustomEmojiOut = { ...base, id: "e1", name: "hpd-bow", label: "おじぎ", keywords: ["ぺこり", "ありがとう"], pack_id: "p1", position: 1 };
const plain: CustomEmojiOut = { ...base, id: "e2", name: "hpd-plain", label: "通常", keywords: ["真顔"], pack_id: "p1", position: 0 };
const parrot: CustomEmojiOut = { ...base, id: "e3", name: "parrot", pack_id: null };
const kakunin: CustomEmojiOut = { ...base, id: "e4", name: "kakunin", kind: "text", label: "確認しました", color: "green", content_type: "", width: 0, height: 0, keywords: ["了解"], pack_id: null };
const pack: EmojiPackOut = { id: "p1", name: "ドットはんぺん", position: 0, tab_version: null, created_at: "", updated_at: "" };

describe("text emoji palette (M100)", () => {
  it("is the same as apps/shared/text-emoji.json", () => {
    const shared = JSON.parse(readFileSync(resolve(process.cwd(), "../shared/text-emoji.json"), "utf8")) as { label_max: number; colors: unknown };
    expect(TEXT_EMOJI_COLORS).toEqual(shared.colors);
    expect(Object.keys(TEXT_EMOJI_COLORS)).toEqual(Object.keys(shared.colors as object));
    expect(TEXT_EMOJI_LABEL_MAX).toBe(shared.label_max);
  });
});

describe("custom emoji search by label and keywords (M100)", () => {
  const table = new Map([bow, plain, parrot, kakunin].map((e) => [e.name, e]));

  it("finds by name first, then by label / keyword, katakana as hiragana", () => {
    expect(customEmojiCandidates("hpd", table, 8).map((e) => e.shortcode)).toEqual(["hpd-bow", "hpd-plain"]);
    expect(customEmojiCandidates("ありがとう", table, 8).map((e) => e.shortcode)).toEqual(["hpd-bow"]);
    expect(customEmojiCandidates("アリガトウ", table, 8).map((e) => e.shortcode)).toEqual(["hpd-bow"]);
    expect(customEmojiCandidates("おじ", table, 8).map((e) => e.shortcode)).toEqual(["hpd-bow"]);
    expect(customEmojiCandidates("確認", table, 8).map((e) => e.shortcode)).toEqual(["kakunin"]);
    expect(customEmojiCandidates("了解", table, 8).map((e) => e.shortcode)).toEqual(["kakunin"]);
    expect(foldSearch("ＯＫ")).toBe("ok");
  });

  it("completes a Japanese word after a colon, also a full-width one", () => {
    expect(emojiQuery("どうも :ありがとう", 10)).toEqual({ start: 4, query: "ありがとう" });
    expect(emojiQuery("：了解", 3)).toEqual({ start: 0, query: "了解" });
    expect(emojiQuery("例：説明", 4)).toBeNull(); // not at a word start
    expect(emojiQuery("hello :t", 8)).toBeNull(); // one Latin character is still too little
    // Standard emoji are found by their Japanese keywords too.
    expect(emojiCandidates("乾杯", 3).length).toBeGreaterThan(0);
  });

  it("splits keywords typed on one line", () => {
    expect(splitKeywords("ありがとう、よろしく  ok,ok")).toEqual(["ありがとう", "よろしく", "ok"]);
  });
});

describe("the picker's pack tabs (M100)", () => {
  const controller = {
    api: { fetchBlob: vi.fn(async () => new Blob(["x"])) },
    store: { sortedEmojiPacks: () => [pack] },
  } as unknown as AppController;

  it("shows a section and a tab per pack with its emoji in big cells; 「カスタム」 keeps only the ungrouped ones, text emoji as pills", () => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    const picked: string[] = [];
    render(<EmojiPicker onPick={(e) => picked.push(e.glyph)} custom={[bow, plain, parrot, kakunin]} controller={controller} />);
    expect(screen.getAllByRole("tab").map((tab) => tab.getAttribute("aria-label") ?? tab.textContent).slice(0, 3)).toEqual(["カスタム", "ドットはんぺん", "顔"]);
    const customSection = screen.getByRole("region", { name: "カスタム" });
    expect(within(customSection).getAllByTitle(":parrot:").length).toBeGreaterThan(0);
    expect(within(customSection).queryAllByTitle("おじぎ :hpd-bow:")).toHaveLength(0);
    expect(within(customSection).getByLabelText("文字の絵文字").textContent).toBe("確認しました");
    const packSection = screen.getByRole("region", { name: "ドットはんぺん" });
    const cells = within(packSection).getAllByTitle(/:hpd-/).filter((el) => el.tagName === "BUTTON");
    expect(cells.map((c) => c.getAttribute("title"))).toEqual(["通常 :hpd-plain:", "おじぎ :hpd-bow:"]); // pack order
    expect(cells[0]!.className).toContain("h-[4.5rem]");
    fireEvent.click(cells[1]!);
    expect(picked).toEqual([":hpd-bow:"]);
  });

  it("searches every custom emoji by keyword, packs included", () => {
    render(<EmojiPicker onPick={() => {}} custom={[bow, plain, parrot, kakunin]} controller={controller} />);
    fireEvent.change(screen.getByPlaceholderText(/検索/), { target: { value: "ありがとう" } });
    expect(screen.getAllByTitle("おじぎ :hpd-bow:").length).toBeGreaterThan(0);
    expect(screen.queryAllByTitle(":parrot:")).toHaveLength(0);
  });
});

describe("pack folder import (M100)", () => {
  it("previews pack.json and names the files it lists that the folder lacks", async () => {
    const manifest = new File([JSON.stringify({ name: "はんぺん", tab: "tab.png", items: [{ file: "001_通常.png", shortcode: "a" }, { file: "002.png", shortcode: "b" }] })], "pack.json");
    const files = packFiles([manifest, new File(["x"], "001_通常.png"), new File(["x"], "tab.png"), new File(["#"], "タグ案.md")]);
    expect(files.map((f) => f.name)).toEqual(["pack.json", "001_通常.png", "tab.png"]);
    expect(await previewPackFolder(files)).toEqual({ name: "はんぺん", items: 2, missing: ["002.png"], thumbnails: ["001_通常.png"] });
    expect(await previewPackFolder([new File(["x"], "a.png")])).toMatch(/^pack.json がありません/);
  });
});
