// @vitest-environment jsdom
/**
 * Emoji-only messages (M101, docs/EMOJI.md §7): the tables and the cases shared with iOS and Android
 * (apps/shared/emoji-only.json).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { CustomEmojiOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { MessageBody } from "../src/ui/MessageBody";
import { EMOJI_ONLY_MAX_ITEMS, EMOJI_ONLY_PICTOGRAPHIC, EMOJI_ONLY_WHITESPACE, emojiOnly } from "../src/ui/emojiOnly";

interface Vectors {
  max_items: number;
  whitespace: string[];
  pictographic: string[];
  custom: Record<string, { kind: string; pack: boolean }>;
  cases: Array<{ body: string; jumbo: boolean; count: number; kinds: string[]; stamp: boolean }>;
}

const vectors = JSON.parse(readFileSync(resolve(process.cwd(), "../shared/emoji-only.json"), "utf8")) as Vectors;

describe("emoji-only (apps/shared/emoji-only.json)", () => {
  it("keeps the same tables", () => {
    expect(EMOJI_ONLY_MAX_ITEMS).toBe(vectors.max_items);
    expect(EMOJI_ONLY_WHITESPACE).toEqual(vectors.whitespace.map((h) => parseInt(h, 16)));
    expect(EMOJI_ONLY_PICTOGRAPHIC.map(([a, b]) => [a, b])).toEqual(vectors.pictographic.map((r) => {
      const [a, b] = r.split("-");
      return [parseInt(a!, 16), parseInt(b ?? a!, 16)];
    }));
  });

  const custom = new Map(Object.entries(vectors.custom).map(([name, e]) => [name, { kind: e.kind, pack_id: e.pack ? "p1" : null }]));
  for (const c of vectors.cases) {
    it(`${JSON.stringify(c.body)} → ${c.jumbo ? c.kinds.join(",") : "not emoji-only"}`, () => {
      const result = emojiOnly(c.body, custom);
      expect(result !== null).toBe(c.jumbo);
      expect(result?.kinds ?? []).toEqual(c.kinds);
      expect(result?.kinds.length ?? 0).toBe(c.count);
      expect(result?.stamp ?? false).toBe(c.stamp);
    });
  }
});

describe("jumbo emoji in a message body (M101)", () => {
  afterEach(cleanup);
  const base = { content_type: "image/png", width: 180, height: 180, keywords: [] as string[], position: 0, created_by: "u", created_at: "", kind: "image" as const };
  const table = new Map<string, CustomEmojiOut>([
    ["hpd-bow", { ...base, id: "e1", name: "hpd-bow", pack_id: "p1" }],
    ["hpd-wave", { ...base, id: "e2", name: "hpd-wave", pack_id: "p1" }],
    ["wide", { ...base, id: "e3", name: "wide", width: 300, height: 100, pack_id: null }],
    ["kakunin", { ...base, id: "e4", name: "kakunin", kind: "text", label: "確認", color: "green", content_type: "", width: 0, height: 0, pack_id: null }],
  ]);
  const controller = { api: null } as unknown as AppController;
  const body = (text: string, jumbo = true) => render(<MessageBody body={text} users={new Map()} customEmoji={table} controller={controller} jumbo={jumbo} />).container;

  it("draws a single pack emoji as a stamp, its box reserved before the image loads", () => {
    const root = body(":hpd-bow:");
    expect(root.querySelector("[data-jumbo]")?.getAttribute("data-jumbo")).toBe("stamp");
    const box = root.querySelector<HTMLElement>("[data-custom-emoji=hpd-bow]")!;
    expect(box.style.width).toBe("120px");
    expect(box.style.height).toBe("120px");
  });

  it("draws several pack emoji medium, wide ones keep their ratio, text emoji as larger pills", () => {
    const root = body(":hpd-bow: :hpd-wave: :wide: :kakunin: 🎉");
    expect(root.querySelector("[data-jumbo]")?.getAttribute("data-jumbo")).toBe("");
    expect(root.querySelector<HTMLElement>("[data-custom-emoji=hpd-wave]")!.style.height).toBe("64px");
    expect(root.querySelector<HTMLElement>("[data-custom-emoji=wide]")!.style.width).toBe("108px");
    expect(root.querySelector<HTMLElement>("[data-custom-emoji=kakunin]")!.style.height).toBe("32px");
    expect(root.textContent).toContain("🎉");
  });

  it("stays normal with text, or where jumbo is not asked for (previews, search results)", () => {
    expect(body("🎉 ok").querySelector("[data-jumbo]")).toBeNull();
    expect(body("🎉", false).querySelector("[data-jumbo]")).toBeNull();
  });
});
