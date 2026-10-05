/** DATA_MODEL.md sidebar_sections 「セクションの中の並び順」: the same order on every client (apps/shared/sidebar-order.json). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ChannelState } from "../src/sync/types";
import { compareNames, sectionOrder } from "../src/ui/channels";

type Conversation = Pick<ChannelState, "id" | "type" | "name" | "last_message_at" | "created_at">;
type Vectors = {
  names: Array<{ name: string; input: string[]; sorted: string[] }>;
  sections: Array<{ name: string; conversations: Conversation[]; order: string[] }>;
};
const vectors = JSON.parse(readFileSync(new URL("../../shared/sidebar-order.json", import.meta.url), "utf8")) as Vectors;

describe("sidebar order (apps/shared/sidebar-order.json)", () => {
  it("has the cases", () => expect(vectors.names.length + vectors.sections.length).toBeGreaterThan(10));
  for (const c of vectors.names) it(`names: ${c.name}`, () => expect([...c.input].sort(compareNames)).toEqual(c.sorted));
  for (const c of vectors.sections) it(`sections: ${c.name}`, () => expect(sectionOrder(c.conversations).map((row) => row.id)).toEqual(c.order));
});
