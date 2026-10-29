// @vitest-environment jsdom
/**
 * 「よく使う」 (docs/EMOJI.md §9.4): the rule's cases shared with iOS and Android (apps/shared/emoji-frequent.json),
 * this device's list, and the picker filling whole rows.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CustomEmojiOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { EmojiPicker, frequentItems, readRecentEmoji, rememberEmoji } from "../src/ui/EmojiPicker";
import {
  fillFrequent, FREQUENT_HALF_LIFE_MS, FREQUENT_KEPT, FREQUENT_ROWS, type FrequentEntry, pillAspect, pillSpan,
  rankFrequent, readFrequentEmoji, recordFrequent, seedFrequent,
} from "../src/ui/emojiFrequent";

interface Shared {
  half_life_ms: number;
  kept: number;
  rows: number;
  rank: Array<{ name: string; uses: Array<[string, number]>; ranked: string[] }>;
  kept_case: { uses_count: number; step: number; start: number; count: number; forgotten: string; first: string };
  seed: Array<{ name: string; legacy: Array<{ glyph: string; count?: number }>; now: number; entries: FrequentEntry[] }>;
  span: Array<{ pill: number; cell: number; gap: number; columns: number; span: number }>;
  pill_aspect: Array<{ label: string; aspect: number }>;
  fill: Array<{ name: string; columns: number; rows: number; items: Array<{ glyph: string; span?: number }>; expected: string[][] }>;
}

const shared = JSON.parse(readFileSync(join(__dirname, "../../shared/emoji-frequent.json"), "utf8")) as Shared;

beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

describe("the shared rule (apps/shared/emoji-frequent.json)", () => {
  it("has the same constants", () => {
    expect(FREQUENT_HALF_LIFE_MS).toBe(shared.half_life_ms);
    expect(FREQUENT_KEPT).toBe(shared.kept);
    expect(FREQUENT_ROWS).toBe(shared.rows);
  });

  it("ranks uses by frecency", () => {
    for (const c of shared.rank) {
      let entries: FrequentEntry[] = [];
      for (const [glyph, at] of c.uses) entries = recordFrequent(entries, glyph, at);
      expect(rankFrequent(entries).map((e) => e.glyph), c.name).toEqual(c.ranked);
    }
  });

  it("keeps at most `kept`, forgetting the lowest ranked", () => {
    const k = shared.kept_case;
    let entries: FrequentEntry[] = [];
    for (let i = 0; i < k.uses_count; i++) entries = recordFrequent(entries, `e${i}`, k.start + i * k.step);
    expect(entries).toHaveLength(k.count);
    expect(entries.some((e) => e.glyph === k.forgotten)).toBe(false);
    expect(rankFrequent(entries)[0]!.glyph).toBe(k.first);
  });

  it("seeds from what was kept before", () => {
    for (const c of shared.seed) expect(seedFrequent(c.legacy, c.now), c.name).toEqual(c.entries);
  });

  it("spans and estimates pills", () => {
    for (const c of shared.span) expect(pillSpan(c.pill, c.cell, c.gap, c.columns), JSON.stringify(c)).toBe(c.span);
    for (const c of shared.pill_aspect) expect(pillAspect(c.label), c.label).toBeCloseTo(c.aspect, 5);
  });

  it("fills whole rows", () => {
    for (const c of shared.fill) expect(fillFrequent(c.items, c.columns, c.rows).map((row) => row.map((i) => i.glyph)), c.name).toEqual(c.expected);
  });
});

describe("this device's list", () => {
  it("starts from the recent list, then counts each use (the quick reactions keep their recent order)", () => {
    let clock = 1_790_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 1000));
    localStorage.setItem("chikuwa.emoji.recent", JSON.stringify(["🎉", "👍"]));
    expect(readFrequentEmoji()).toEqual(["🎉", "👍"]);
    rememberEmoji("👍");
    rememberEmoji("😂");
    rememberEmoji("👍");
    expect(readFrequentEmoji()).toEqual(["👍", "😂", "🎉"]);
    expect(readRecentEmoji()).toEqual(["👍", "😂", "🎉"]);
    rememberEmoji("😂");
    rememberEmoji("😂");
    expect(readFrequentEmoji()[0]).toBe("😂");
    expect(readRecentEmoji()[0]).toBe("😂");
    expect(readFrequentEmoji()).toBe(readFrequentEmoji()); // the same array while nothing changed
  });

  it("a corrupt stored value counts as none", () => {
    localStorage.setItem("chikuwa.emoji.frequent", "{broken");
    expect(readFrequentEmoji()).toEqual([]);
  });
});

const text = (name: string, label: string): CustomEmojiOut => ({ id: `t-${name}`, name, kind: "text", label, color: "blue", content_type: "", width: 0, height: 0, keywords: [], position: 0, created_by: "u", created_at: "" } as CustomEmojiOut);

describe("the picker's 「よく使う」 fills whole rows (2026-10-29)", () => {
  const glyphs = ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗", "😚", "😙"];

  it("shows two rows of eight from a longer list", () => {
    render(<EmojiPicker onPick={() => {}} frequent={glyphs} />);
    const row = screen.getByRole("group", { name: "よく使う" });
    expect(row.querySelectorAll("button")).toHaveLength(16);
  });

  it("shows what there is when there are fewer", () => {
    render(<EmojiPicker onPick={() => {}} frequent={glyphs.slice(0, 5)} />);
    expect(screen.getByRole("group", { name: "よく使う" }).querySelectorAll("button")).toHaveLength(5);
  });

  it("a text emoji's pill takes the cells it needs, and fewer squares come", () => {
    const thanks = text("thanks", "ありがとう"); // 20 × 3.96 + 8 ≈ 87px: 3 cells of 40px
    const items = frequentItems([":thanks:", ...glyphs], new Map([["thanks", thanks]]), 320);
    expect(items[0]).toMatchObject({ glyph: ":thanks:", span: 3 });
    expect(items.reduce((n, i) => n + i.span, 0)).toBe(16);
    expect(items).toHaveLength(14);
    // A wider list: the same pill needs 2 cells of 60px.
    expect(frequentItems([":thanks:", ...glyphs], new Map([["thanks", thanks]]), 480)[0]!.span).toBe(2);

    const controller = { api: { fetchBlob: vi.fn(async () => new Blob(["x"])) } } as unknown as AppController;
    render(<EmojiPicker onPick={() => {}} frequent={[":thanks:", ...glyphs]} custom={[thanks]} controller={controller} />);
    const buttons = [...screen.getByRole("group", { name: "よく使う" }).querySelectorAll("button")];
    expect(buttons).toHaveLength(14);
    expect(buttons[0]!.style.gridColumn).toBe("span 3");
  });
});
