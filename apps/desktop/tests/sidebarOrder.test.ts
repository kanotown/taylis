/** DATA_MODEL.md sidebar_sections 「セクションの中の並び順」「並べ替え」: the same order on every client (apps/shared/sidebar-order.json). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ChannelState } from "../src/sync/types";
import { compareNames, sectionChannels, sectionOrder, type SidebarSort } from "../src/ui/channels";

type Conversation = Pick<ChannelState, "id" | "type" | "name" | "last_message_at" | "created_at"> & { title?: string };
type Vectors = {
  names: Array<{ name: string; input: string[]; sorted: string[] }>;
  sections: Array<{ name: string; sort?: SidebarSort; manual_order?: string[]; conversations: Conversation[]; order: string[] }>;
};
const vectors = JSON.parse(readFileSync(new URL("../../shared/sidebar-order.json", import.meta.url), "utf8")) as Vectors;

describe("sidebar order (apps/shared/sidebar-order.json)", () => {
  it("has the cases", () => expect(vectors.names.length + vectors.sections.length).toBeGreaterThan(15));
  for (const c of vectors.names) it(`names: ${c.name}`, () => expect([...c.input].sort(compareNames)).toEqual(c.sorted));
  for (const c of vectors.sections)
    it(`sections: ${c.name}`, () =>
      expect(sectionOrder(c.conversations, { sort: c.sort ?? "name", manual_order: c.manual_order }, (row) => row.title ?? row.name ?? "").map((row) => row.id)).toEqual(c.order));
});

describe("the default sections' sorts", () => {
  const row = (id: string, type: ChannelState["type"], name: string | null, last: string | null, dmUsers?: string[]) =>
    ({ id, type, name, last_message_at: last, created_at: "2026-09-01T00:00:00Z", isMember: true, archived: false, dm_user_ids: dmUsers ?? null }) as unknown as ChannelState;
  const all = [
    row("c1", "public", "2026修論指導", "2026-10-06T00:00:00Z"),
    row("c2", "public", "2026院ゼミ", null),
    row("me", "dm", null, null, ["u0"]),
    row("d1", "dm", null, "2026-10-01T00:00:00Z", ["u0", "u1"]),
    row("d2", "dm", null, "2026-10-05T00:00:00Z", ["u0", "u2"]),
  ];
  const title = (c: ChannelState) => ({ me: "わたし", d1: "伊藤", d2: "田中" })[c.id as "me"] ?? c.name ?? "";

  it("channels by name and DMs newest first (my own DM first) by default", () => {
    const sections = sectionChannels(all, { meId: "u0", title });
    expect(sections.channels.map((c) => c.id)).toEqual(["c2", "c1"]);
    expect(sections.dms.map((c) => c.id)).toEqual(["me", "d2", "d1"]);
  });

  it("follows the server's sorts", () => {
    const sections = sectionChannels(all, {
      meId: "u0",
      title,
      defaults: [
        { key: "favorites", sort: "name", manual_order: [] },
        { key: "channels", sort: "recent", manual_order: [] },
        { key: "dms", sort: "name", manual_order: [] },
      ],
    });
    expect(sections.channels.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(sections.dms.map((c) => c.id)).toEqual(["me", "d1", "d2"]);
    const manual = sectionChannels(all, { meId: "u0", title, defaults: [{ key: "dms", sort: "manual", manual_order: ["d2", "me"] }] });
    expect(manual.dms.map((c) => c.id)).toEqual(["d2", "me", "d1"]);
  });
});
