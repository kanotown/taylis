import { describe, expect, it } from "vitest";

import { caughtUp, countsAsUnread, covers, dividerMark, firstUnreadRow, jumpButtonShown, markUnreadOffered, nextAnchored, passedUnseen, readRangeReady } from "../src/sync/readGate";
import { bannerText, group3, sinceLabel } from "../src/ui/format";

// Local times: 2026-09-28 is a Monday.
const now = new Date(2026, 8, 28, 15, 0);
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();

// Real-shaped rows: confirmed messages keep the client_msg_id they were sent with, which is never their id (§10.3).
const row = (seq: number | null, sender = "alice") => ({ id: `id-${seq}`, client_msg_id: `cmid-${seq}`, seq, sender_id: sender });

describe("unread banner text (§10.1)", () => {
  it("V18: without first_unread_at only the count", () => {
    expect(bannerText(300, null, now)).toBe("未読 300 件");
    expect(bannerText(300, undefined, now)).toBe("未読 300 件");
  });

  it("V19: groups digits with ASCII commas whatever the locale", () => {
    expect([12, 999, 1234, 1_000_000].map((n) => bannerText(n, null, now))).toEqual(["未読 12 件", "未読 999 件", "未読 1,234 件", "未読 1,000,000 件"]);
    expect(group3(0)).toBe("0");
    expect(group3(100_000)).toBe("100,000");
  });

  it("V20: since today, yesterday, this year and an earlier year, always 24-hour HH:mm", () => {
    expect(sinceLabel(at(2026, 9, 28, 10, 23), now)).toBe("10:23");
    expect(sinceLabel(at(2026, 9, 27, 23, 5), now)).toBe("昨日 23:05");
    expect(sinceLabel(at(2026, 9, 26, 9, 7), now)).toBe("9月26日 (土) 09:07");
    expect(sinceLabel(at(2025, 12, 31, 10, 23), now)).toBe("2025年12月31日 (水) 10:23");
    expect(sinceLabel(at(2026, 9, 28, 0, 0), now)).toBe("00:00");
    expect(bannerText(2000, at(2026, 9, 28, 10, 23), now)).toBe("未読 2,000 件 · 10:23 以降");
  });
});

describe("read gate helpers (§10.1)", () => {
  it("V22: covers", () => {
    expect([covers(0, 5), covers(null, 5), covers(6, 5), covers(7, 5)]).toEqual([true, false, true, false]);
  });

  it("readRangeReady: nothing unread, or the read position is covered", () => {
    const synced = (lastSeq: number) => ({ syncedSeq: lastSeq, lastSeq });
    expect(readRangeReady({ unreadCount: 0, oldestLoadedSeq: null, lastReadSeq: 100, syncedSeq: null, lastSeq: 130 })).toBe(true);
    expect(readRangeReady({ unreadCount: 30, oldestLoadedSeq: 81, lastReadSeq: 100, ...synced(130) })).toBe(true); // V1
    expect(readRangeReady({ unreadCount: 2000, oldestLoadedSeq: 2951, lastReadSeq: 1000, ...synced(3000) })).toBe(false); // V2
    expect(readRangeReady({ unreadCount: 50, oldestLoadedSeq: 104, lastReadSeq: 100, ...synced(153) })).toBe(false); // V5: conservative
    expect(readRangeReady({ unreadCount: 60, oldestLoadedSeq: 11, lastReadSeq: 0, ...synced(60) })).toBe(false); // V28
  });

  it("V32: the newer side counts too: not ready until the catch-up has brought every row", () => {
    const held = { unreadCount: 300, lastReadSeq: 130, oldestLoadedSeq: 81 };
    expect(readRangeReady({ ...held, syncedSeq: 130, lastSeq: 430 })).toBe(false);
    expect(readRangeReady({ ...held, syncedSeq: 430, lastSeq: 430 })).toBe(true);
    expect(readRangeReady({ ...held, unreadCount: 0, syncedSeq: 130, lastSeq: 430 })).toBe(true);
    expect([caughtUp({ syncedSeq: null, lastSeq: 0 }), caughtUp({ syncedSeq: 129, lastSeq: 130 }), caughtUp({ syncedSeq: 130, lastSeq: 130 })]).toEqual([false, false, true]);
  });

  it("V21: the jump button up to 500 unread, or whenever the range is ready", () => {
    expect([jumpButtonShown(false, 500), jumpButtonShown(false, 501), jumpButtonShown(true, 501)]).toEqual([true, false, true]);
  });

  it("V23: dividerMark", () => {
    expect(dividerMark(null, 1000, 2951)).toBeNull();
    expect(dividerMark(null, 1000, 851)).toBe(1000);
    expect(dividerMark(109, null, 81)).toBe(109);
    expect(dividerMark(undefined, null, 0)).toBeNull();
  });

  it("firstUnreadRow skips my own rows and pending ones", () => {
    const rows = [row(100), row(101, "bob"), row(102), row(null)];
    expect(firstUnreadRow(rows, 100, "bob")?.id).toBe("id-102");
    expect(firstUnreadRow(rows, 102, "bob")).toBeNull();
    expect(firstUnreadRow(rows, 99, "bob")?.id).toBe("id-100");
  });

  it("nextAnchored: visible first unread row (by message id, not row key), sticky while ready, reset when not ready", () => {
    const first = row(101);
    const visibleIds = (...rows: ReturnType<typeof row>[]) => new Set(rows.map((r) => r.id));
    expect(nextAnchored(false, 0, false, first, new Set())).toBe(true); // nothing unread
    expect(nextAnchored(true, 30, false, first, visibleIds(first))).toBe(false); // the range stopped reaching the read position
    expect(nextAnchored(false, 30, true, first, visibleIds(row(115)))).toBe(false); // loaded above the viewport, not shown
    expect(nextAnchored(false, 30, true, first, visibleIds(first))).toBe(true);
    expect(nextAnchored(false, 30, true, first, new Set([first.client_msg_id]))).toBe(false); // a row key is not a message id
    expect(nextAnchored(true, 30, true, first, new Set())).toBe(true); // stays once set, until something drops it
    expect(nextAnchored(false, 3, true, null, new Set())).toBe(true); // no unread row from others is held
    expect(nextAnchored(true, 30, true, first, new Set(), true)).toBe(false); // passed above the screen unseen (V34)
    expect(nextAnchored(true, 0, true, first, new Set(), true)).toBe(true); // nothing unread
  });

  it("V34 / V51: passedUnseen, the first unread row above every row shown and not even partly on screen", () => {
    const first = { id: "id-131", seq: 131 };
    const shown = Array.from({ length: 15 }, (_, i) => 416 + i);
    expect(passedUnseen(first, shown, new Set(shown.map((seq) => `id-${seq}`)))).toBe(true); // followed to 416..430
    expect(passedUnseen(first, [132, 133], new Set(["id-131", "id-132", "id-133"]))).toBe(false); // partly on screen: reading on
    expect(passedUnseen(first, [131, 132], new Set(["id-131", "id-132"]))).toBe(false); // shown
    expect(passedUnseen(first, [100, 101], new Set())).toBe(false); // below the screen
    expect(passedUnseen(first, [], new Set())).toBe(false); // nothing shown: no verdict
    expect(passedUnseen(null, shown, new Set())).toBe(false);
  });

  it("V38: 「ここから未読にする」 moves the position forward only while every unread row is held; back always", () => {
    const v2 = { unreadCount: 2000, lastReadSeq: 1000, oldestLoadedSeq: 2951, syncedSeq: 3000, lastSeq: 3000 };
    expect(markUnreadOffered(2990, v2)).toBe(false);
    expect(markUnreadOffered(1001, v2)).toBe(true); // at the position: nothing moves forward
    expect(markUnreadOffered(900, v2)).toBe(true); // back (a search context)
    const v1 = { unreadCount: 15, lastReadSeq: 115, oldestLoadedSeq: 81, syncedSeq: 130, lastSeq: 130 };
    expect(markUnreadOffered(125, v1)).toBe(true);
    expect(markUnreadOffered(125, { ...v1, syncedSeq: 120 })).toBe(false); // catching up
  });

  it("V44: only what the server counts is unread: others' user rows in the timeline", () => {
    const base = { sender_id: "alice", type: "user", parent_id: null };
    expect(countsAsUnread(base, "bob")).toBe(true);
    expect(countsAsUnread({ ...base, type: "system" }, "bob")).toBe(false);
    expect(countsAsUnread(base, "alice")).toBe(false); // my own
    expect(countsAsUnread({ ...base, parent_id: "p" }, "bob")).toBe(false); // a reply only in its thread
    expect(countsAsUnread({ ...base, parent_id: "p", also_in_channel: true }, "bob")).toBe(true);
    expect(countsAsUnread({ sender_id: "alice" }, "bob")).toBe(true); // rows stored before types existed
  });
});
