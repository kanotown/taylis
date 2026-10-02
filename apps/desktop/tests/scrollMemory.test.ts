import { beforeEach, expect, it } from "vitest";

import { clearScrollMemories, conversationScrollKey, restoreDecision, type SavedPosition, ScrollMemory, scrollMemoryFor } from "../src/ui/scrollMemory";
import { placeKey } from "../src/ui/placeHistory";

const at = (rowKey: string | null, offset = 0, atBottom = false, scrollTop = 0): SavedPosition => ({ rowKey, offset, scrollTop, atBottom });

beforeEach(() => clearScrollMemories());

it("keeps the newest positions up to the cap, dropping the least recently used", () => {
  const memory = new ScrollMemory(3);
  memory.save("a", at("1"));
  memory.save("b", at("2"));
  memory.save("c", at("3"));
  expect(memory.get("a")).toEqual(at("1")); // a use: a is now the most recent
  memory.save("d", at("4"));
  expect(memory.keys()).toEqual(["c", "a", "d"]);
  expect(memory.get("b")).toBeNull();
  memory.save("c", at("5")); // saved again: replaced and the most recent
  memory.save("e", at("6"));
  expect(memory.keys()).toEqual(["d", "c", "e"]);
  expect(memory.get("c")).toEqual(at("5"));
  expect(memory.size).toBe(3);
  memory.forget("c");
  expect(memory.get("c")).toBeNull();
});

it("holds 100 places by default, one memory per workspace", () => {
  const memory = scrollMemoryFor("https://a.example");
  for (let i = 0; i < 130; i++) memory.save(`channel:${i}`, at(String(i)));
  expect(memory.size).toBe(100);
  expect(memory.get("channel:29")).toBeNull();
  expect(memory.get("channel:30")).toEqual(at("30"));
  expect(scrollMemoryFor("https://a.example")).toBe(memory);
  expect(scrollMemoryFor("https://b.example").get("channel:30")).toBeNull();
  clearScrollMemories();
  expect(scrollMemoryFor("https://a.example").size).toBe(0);
});

it("restores a row in the middle, keeps the bottom as the usual landing, and lets an explicit move win", () => {
  const middle = at("m1", -12);
  expect(restoreDecision(middle, { explicit: false, requested: true })).toEqual({ kind: "anchor", rowKey: "m1", offset: -12 });
  // A search hit, a permalink, a reveal: that message, never the remembered row.
  expect(restoreDecision(middle, { explicit: true, requested: true })).toEqual({ kind: "default" });
  // Not asked for (a view opened from the sidebar) or nothing remembered: today's landing.
  expect(restoreDecision(middle, { explicit: false, requested: false })).toEqual({ kind: "default" });
  expect(restoreDecision(null, { explicit: false, requested: true })).toEqual({ kind: "default" });
  // Left at the bottom: stays with the new messages.
  expect(restoreDecision(at("m9", 0, true), { explicit: false, requested: true })).toEqual({ kind: "bottom" });
  // A list without keyed rows: its scrollTop.
  expect(restoreDecision(at(null, 0, false, 420), { explicit: false, requested: true })).toEqual({ kind: "scrollTop", scrollTop: 420 });
});

it("names a conversation as the history of places does", () => {
  expect(conversationScrollKey("c1")).toBe(placeKey({ kind: "channel", channelId: "c1", focus: null }));
});
