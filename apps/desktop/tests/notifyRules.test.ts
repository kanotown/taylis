/** PUSH_NOTIFICATIONS.md §4: the notification rule against the cases the server and every client share (apps/shared/notify-rules.json). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { notifies, type NotifyLevel, type ReplyKind } from "../src/sync/notifications";

interface Case {
  name: string;
  level: NotifyLevel;
  reply: ReplyKind;
  follower: boolean;
  unfollowed: boolean;
  mentioned: boolean;
  mention_all: boolean;
  keyword: boolean;
  expect: { notify: boolean };
}

const vectors = JSON.parse(readFileSync(new URL("../../shared/notify-rules.json", import.meta.url), "utf8")) as { cases: Case[] };

describe("notify rules (apps/shared/notify-rules.json)", () => {
  it.each(vectors.cases)("$name", (c) => {
    const result = notifies({
      level: c.level,
      reply: c.reply,
      follower: c.follower,
      unfollowed: c.unfollowed,
      mentioned: c.mentioned,
      mentionAll: c.mention_all,
      keyword: c.keyword,
    });
    expect(result).toBe(c.expect.notify);
  });

  it("has cases, and a mute silences every one", () => {
    expect(vectors.cases.length).toBeGreaterThan(0);
    for (const c of vectors.cases) {
      expect(notifies({ level: c.level, muted: true, reply: c.reply, follower: c.follower, unfollowed: c.unfollowed, mentioned: c.mentioned, mentionAll: c.mention_all, keyword: c.keyword })).toBe(false);
    }
  });
});
