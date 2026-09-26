import { describe, expect, it } from "vitest";

import type { MessageState } from "../src/sync/types";
import { buildTimeline, dateLabel, initials } from "../src/ui/format";

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

  it("groups consecutive messages and places the unread divider once", () => {
    const items = buildTimeline(
      [
        message("a", "u1", "2026-09-25T10:00:00", 1),
        message("b", "u1", "2026-09-25T10:02:00", 2),
        message("c", "u1", "2026-09-25T10:20:00", 3),
        message("d", "u2", "2026-09-26T09:00:00", 4),
        message("e", "u2", "2026-09-26T09:01:00", 5),
      ],
      { firstUnreadAfterSeq: 3, meId: "me", now },
    );
    expect(items.map((i) => (i.kind === "message" ? `${i.message.id}${i.compact ? "*" : ""}` : i.kind))).toEqual([
      "date",
      "a",
      "b*",
      "c",
      "date",
      "unread",
      "d",
      "e*",
    ]);
  });

  it("derives initials", () => {
    expect(initials("Toru Kano")).toBe("TK");
    expect(initials("かのう")).toBe("か");
    expect(initials("  ")).toBe("?");
  });
});
