import { describe, expect, it } from "vitest";

import type { MessageState } from "../src/sync/types";
import { buildTimeline, continuesGroup, dateLabel, initials } from "../src/ui/format";

const now = new Date("2026-09-26T12:00:00");
const message = (id: string, sender: string, at: string, seq: number | null = 1): MessageState => ({
  id,
  channel_id: "c",
  sender_id: sender,
  seq,
  updated_seq: seq ?? -1,
  client_msg_id: null,
  body: id,
  created_at: at,
  edited_at: null,
  deleted: false,
});

describe("timeline presentation", () => {
  it("labels days relative to today", () => {
    expect(dateLabel("2026-09-26T09:00:00", now)).toBe("今日");
    expect(dateLabel("2026-09-25T23:00:00", now)).toBe("昨日");
    expect(dateLabel("2026-09-01T09:00:00", now)).toBe("9月1日 (火)");
    expect(dateLabel("2025-12-31T09:00:00", now)).toBe("2025年12月31日 (水)");
  });

  it("groups my pending messages like sent ones, so confirming them changes nothing", () => {
    const pending = (id: string, at: string): MessageState => ({ ...message(id, "me", at, null), pending: true });
    const shape = (items: ReturnType<typeof buildTimeline>) => items.map((i) => (i.kind === "message" ? `${i.message.id}${i.compact ? "*" : ""}` : i.kind));
    const sending = buildTimeline([message("a", "me", "2026-09-26T10:00:00", 1), pending("b", "2026-09-26T10:00:05"), pending("c", "2026-09-26T10:00:09")], { firstUnreadAfterSeq: null, meId: "me", now, group: true });
    const sent = buildTimeline([message("a", "me", "2026-09-26T10:00:00", 1), message("b", "me", "2026-09-26T10:00:05", 2), message("c", "me", "2026-09-26T10:00:09", 3)], { firstUnreadAfterSeq: null, meId: "me", now, group: true });
    expect(shape(sending)).toEqual(["date", "a", "b*", "c*"]);
    expect(shape(sent)).toEqual(shape(sending));
  });

  const run = [
    message("a", "u1", "2026-09-25T10:00:00", 1),
    message("b", "u1", "2026-09-25T10:02:00", 2),
    message("c", "u1", "2026-09-25T10:20:00", 3),
    message("d", "u2", "2026-09-26T09:00:00", 4),
    message("e", "u2", "2026-09-26T09:01:00", 5),
    message("f", "u2", "2026-09-26T09:02:00", 6),
  ];
  const shapeOf = (items: ReturnType<typeof buildTimeline>) => items.map((i) => (i.kind === "message" ? `${i.message.id}${i.compact ? "*" : ""}` : i.kind));

  it("with 「連続した投稿をまとめる」 on, groups consecutive messages and places the unread divider once", () => {
    const items = buildTimeline(run, { firstUnreadAfterSeq: 3, meId: "me", now, group: true });
    expect(shapeOf(items)).toEqual(["date", "a", "b*", "c", "date", "unread", "d", "e*", "f*"]);
  });

  it("M47: off (the default) gives every message its own header; the dividers stay where they were", () => {
    expect(shapeOf(buildTimeline(run, { firstUnreadAfterSeq: 3, meId: "me", now }))).toEqual(["date", "a", "b", "c", "date", "unread", "d", "e", "f"]);
    expect(shapeOf(buildTimeline(run, { firstUnreadAfterSeq: 3, meId: "me", now, group: false }))).toEqual(["date", "a", "b", "c", "date", "unread", "d", "e", "f"]);
  });

  it("M47: the rule shared with threads cuts at another sender, five minutes, a new day and a system post; the timeline also at a reply sent to the channel", () => {
    const a = message("a", "u1", "2026-09-26T10:00:00");
    expect(continuesGroup(a, message("b", "u1", "2026-09-26T10:04:59"), now)).toBe(true);
    expect(continuesGroup(a, message("b", "u2", "2026-09-26T10:01:00"), now)).toBe(false);
    expect(continuesGroup(a, message("b", "u1", "2026-09-26T10:05:00"), now)).toBe(false);
    expect(continuesGroup(message("a", "u1", "2026-09-25T23:58:00"), message("b", "u1", "2026-09-26T00:01:00"), now)).toBe(false);
    expect(continuesGroup(a, { ...message("b", "u1", "2026-09-26T10:01:00"), type: "system" }, now)).toBe(false);
    const reply = { ...message("r", "u1", "2026-09-26T10:01:00", 2), parent_id: "p", also_in_channel: true };
    expect(continuesGroup(a, reply, now)).toBe(true); // in a thread, replies group
    expect(shapeOf(buildTimeline([a, reply], { now, group: true }))).toEqual(["date", "a", "r"]); // in the timeline it keeps its header
  });

  it("M47: a system row keeps its header and cuts the run", () => {
    const system = { ...message("s", "u1", "2026-09-26T10:01:00", 2), type: "system" };
    const items = buildTimeline([message("a", "u1", "2026-09-26T10:00:00", 1), system, message("b", "u1", "2026-09-26T10:02:00", 3), message("c", "u1", "2026-09-26T10:03:00", 4)], { now, group: true });
    expect(shapeOf(items)).toEqual(["date", "a", "s", "b", "c*"]);
  });

  it("derives initials", () => {
    expect(initials("Toru Kano")).toBe("TK");
    expect(initials("かのう")).toBe("か");
    expect(initials("  ")).toBe("?");
  });
});
