/** MOBILE_UI.md §23: the order of the @ suggestions against the cases every client shares (apps/shared/mention-rank.json). */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { GroupOut, UserPublic } from "../src/api/types";
import { conversationContext, documentContext, mentionCandidates, RECENT_MESSAGES, recentSpeakers, type SpokenMessage } from "../src/ui/mentions";

interface Vectors {
  recent_messages: number;
  recent: Array<{ name: string; cap?: number; thread: SpokenMessage[]; channel: SpokenMessage[]; speakers: string[] }>;
  rank: {
    users: Array<{ id: string; username: string; display_name: string; ai?: boolean; bot?: boolean; deactivated?: boolean }>;
    groups: Array<{ id: string; name: string; description: string | null; member_ids: string[] }>;
    cases: Array<{ name: string; query: string; me: string | null; recent: string[]; members: string[]; limit: number; expected: string[] }>;
  };
}

const vectors = JSON.parse(readFileSync(new URL("../../shared/mention-rank.json", import.meta.url), "utf8")) as Vectors;

const users: UserPublic[] = vectors.rank.users.map((u) => ({
  id: u.id,
  username: u.username,
  display_name: u.display_name,
  role: u.ai || u.bot ? "bot" : "member",
  bot_kind: u.ai ? "ai" : null,
  deactivated_at: u.deactivated ? "2026-01-01T00:00:00Z" : null,
  created_at: "",
  updated_at: "",
}));
const groups = vectors.rank.groups.map((g) => ({ ...g, created_by: "u1", created_at: "", updated_at: "", managed: false }) as GroupOut);

describe("mention rank (apps/shared/mention-rank.json)", () => {
  it("counts the same number of recent messages", () => {
    expect(RECENT_MESSAGES).toBe(vectors.recent_messages);
  });

  it.each(vectors.recent)("recent: $name", ({ cap, thread, channel, speakers }) => {
    expect(recentSpeakers(channel, thread, cap ?? vectors.recent_messages)).toEqual(speakers);
  });

  it.each(vectors.rank.cases)("rank: $name", ({ query, me, recent, members, limit, expected }) => {
    expect(mentionCandidates(query, users, groups, limit, null, { recent, members, me }).map((c) => c.username)).toEqual(expected);
  });
});

describe("the context from the store", () => {
  const message = (id: string, sender: string, extra: Partial<SpokenMessage> = {}) => ({ id, sender_id: sender, ...extra });
  const store = {
    me: { id: "u1" },
    channels: new Map([
      ["c1", { dm_user_ids: null }],
      ["d1", { dm_user_ids: ["u1", "u2", "u3"] }],
    ]),
    messages: (channelId: string) => (channelId === "c1" ? [message("m1", "u2"), message("p1", "u4"), message("m2", "u5")] : [message("m3", "u3")]),
    replies: (_channelId: string, parentId: string) => (parentId === "p1" ? [message("r1", "u6"), message("r2", "u7", { deleted: true })] : []),
    message: (_channelId: string, id: string) => (id === "p1" ? message("p1", "u4") : undefined),
  };

  it("a channel: the loaded senders, no members tier (not held locally), me", () => {
    expect(conversationContext(store, "c1")).toEqual({ recent: ["u5", "u4", "u2"], members: [], me: "u1" });
  });

  it("a thread: its reply authors and parent first, then the channel's", () => {
    expect(conversationContext(store, "c1", "p1").recent).toEqual(["u6", "u4", "u5", "u2"]);
  });

  it("a DM: its participants as members", () => {
    expect(conversationContext(store, "d1")).toEqual({ recent: ["u3"], members: ["u1", "u2", "u3"], me: "u1" });
  });

  it("a document: the DM's participants, else nobody; me", () => {
    expect(documentContext(store, "d1")).toEqual({ members: ["u1", "u2", "u3"], me: "u1" });
    expect(documentContext(store, null)).toEqual({ members: [], me: "u1" });
  });
});
