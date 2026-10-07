// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomEmojiOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { EmojiPicker } from "../src/ui/EmojiPicker";
import { gridChunks, pickerSectionKeys, sectionAt } from "../src/ui/emojiPickerLayout";

/** 2026-10-07 (docs/EMOJI.md §6): one scrolling list of sections; a tab jumps to its section, the scroll moves the tab. */

describe("the picker's layout", () => {
  it("orders the sections recent, custom, packs, then the standard categories", () => {
    expect(pickerSectionKeys({ recent: true, custom: true, packIds: ["p1", "p2"], standard: ["smileys", "flags"] })).toEqual(["recent", "custom", "pack:p1", "pack:p2", "smileys", "flags"]);
    expect(pickerSectionKeys({ recent: false, custom: false, packIds: [], standard: ["smileys"] })).toEqual(["smileys"]);
  });

  it("finds the section at the scroll position: the last one whose top is at or above the view's top", () => {
    const tops = [0, 100, 400, 900];
    expect(sectionAt(tops, 0)).toBe(0);
    expect(sectionAt(tops, 99)).toBe(1); // 1px of slack: a fractional jump to 100 still counts as there
    expect(sectionAt(tops, 98)).toBe(0);
    expect(sectionAt(tops, 100)).toBe(1);
    expect(sectionAt(tops, 650)).toBe(2);
    expect(sectionAt(tops, 5000)).toBe(3);
    expect(sectionAt([], 10)).toBe(0);
  });

  it("cuts a grid into chunks of exact heights", () => {
    expect(gridChunks(0, 8, 32, 6)).toEqual([]);
    expect(gridChunks(50, 8, 32, 6)).toEqual([{ start: 0, end: 48, height: 192 }, { start: 48, end: 50, height: 32 }]);
    expect(gridChunks(5, 4, 72, 3)).toEqual([{ start: 0, end: 5, height: 144 }]);
  });
});

describe("the picker's one list", () => {
  const controller = { api: { fetchBlob: vi.fn(async () => new Blob(["x"])) }, store: { sortedEmojiPacks: () => [] } } as unknown as AppController;
  const parrot: CustomEmojiOut = { id: "e-s-1", name: "parrot", kind: "image", content_type: "image/png", width: 32, height: 32, keywords: [], position: 0, created_by: "u", created_at: "" };
  // jsdom has no layout: each section's offsetTop is its index × 1000, and frames run at once.
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:x");
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 1; });
    vi.spyOn(HTMLElement.prototype, "offsetTop", "get").mockImplementation(function (this: HTMLElement) {
      if (!this.dataset.emojiSection) return 0;
      return [...(this.parentElement?.children ?? [])].indexOf(this) * 1000;
    });
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  const list = () => document.querySelector<HTMLElement>("[data-emoji-list]")!;
  const sectionKeys = () => [...document.querySelectorAll<HTMLElement>("[data-emoji-section]")].map((s) => s.dataset.emojiSection);
  const selected = () => screen.getAllByRole("tab").filter((tab) => tab.getAttribute("aria-selected") === "true").map((tab) => tab.getAttribute("aria-label") ?? tab.textContent);

  it("draws every section in one list, each under its header, starting at the top with the first tab", () => {
    render(<EmojiPicker onPick={() => {}} recent={["👍"]} custom={[parrot]} controller={controller} />);
    expect(sectionKeys()).toEqual(["recent", "custom", "smileys", "people", "nature", "food", "travel", "activities", "objects", "symbols", "flags"]);
    expect(screen.getAllByRole("tab")).toHaveLength(11);
    expect(list().scrollTop).toBe(0);
    expect(selected()).toEqual(["最近使った絵文字"]);
    // Every category is there at once (no page per tab): a face, an animal, a flag.
    for (const title of [":grinning:", ":dog:", ":checkered_flag:", ":parrot:"]) expect(screen.getAllByTitle(title).length).toBeGreaterThan(0);
    const header = screen.getByRole("region", { name: "動物・自然" }).firstElementChild as HTMLElement;
    expect(header.className).toContain("sticky");
    expect(header.textContent).toBe("動物・自然");
  });

  it("a tab scrolls its section's top to the top of the list and is highlighted, without another tab in between", () => {
    render(<EmojiPicker onPick={() => {}} recent={["👍"]} custom={[parrot]} controller={controller} />);
    fireEvent.click(screen.getByRole("tab", { name: "動物・自然" }));
    expect(list().scrollTop).toBe(4000); // recent 0, custom 1000, smileys 2000, people 3000, nature 4000
    expect(selected()).toEqual(["動物・自然"]);
    fireEvent.scroll(list());
    expect(selected()).toEqual(["動物・自然"]);
    // Back up: the list does not keep the previous position (the 2026-10-07 report).
    fireEvent.click(screen.getByRole("tab", { name: "カスタム" }));
    expect(list().scrollTop).toBe(1000);
    expect(selected()).toEqual(["カスタム"]);
  });

  it("the highlighted tab follows the section scrolled into view", () => {
    render(<EmojiPicker onPick={() => {}} recent={["👍"]} custom={[parrot]} controller={controller} />);
    list().scrollTop = 5500;
    fireEvent.scroll(list());
    expect(selected()).toEqual(["食べ物"]);
    list().scrollTop = 1200;
    fireEvent.scroll(list());
    expect(selected()).toEqual(["カスタム"]);
  });

  it("searching shows a flat list of hits; clearing it comes back to the top of the list", () => {
    const picked: string[] = [];
    render(<EmojiPicker onPick={(e) => picked.push(e.glyph)} recent={["👍"]} custom={[parrot]} controller={controller} />);
    fireEvent.click(screen.getByRole("tab", { name: "旗" }));
    const search = screen.getByPlaceholderText(/検索/);
    fireEvent.change(search, { target: { value: "sushi" } });
    expect(document.querySelector("[data-emoji-section]")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    fireEvent.click(screen.getByTitle(":sushi:"));
    expect(picked).toEqual(["🍣"]);
    fireEvent.change(search, { target: { value: "" } });
    expect(list().scrollTop).toBe(0);
    expect(selected()).toEqual(["最近使った絵文字"]);
  });
});
