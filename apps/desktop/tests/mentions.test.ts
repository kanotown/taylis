import { describe, expect, it } from "vitest";

import type { UserPublic } from "../src/api/types";
import { decodeMentions, encodeMentions, mentionCandidates, mentionQuery } from "../src/ui/mentions";
import { mentionsToNames } from "../src/ui/mentions";

const user = (id: string, username: string, display: string): UserPublic => ({
  id,
  username,
  display_name: display,
  role: "member",
  deactivated_at: null,
  created_at: "",
  updated_at: "",
});
const alice = user("00000000-0000-7000-8000-000000000001", "alice", "Alice");
const bob = user("00000000-0000-7000-8000-000000000002", "bob.k", "Bob K");
const users = [alice, bob];

describe("mentions", () => {
  it("encodes handles to tokens and leaves unknown ones alone", () => {
    expect(encodeMentions("hi @bob.k and @channel, mail me@x.io @nobody", users)).toBe(`hi <@${bob.id}> and <!channel>, mail me@x.io @nobody`);
    expect(encodeMentions("@Alice", users)).toBe(`<@${alice.id}>`);
  });

  it("decodes tokens back to handles for editing", () => {
    const byId = new Map(users.map((u) => [u.id, u]));
    expect(decodeMentions(`hi <@${bob.id}> <!unknown> <!here>`, byId)).toBe("hi @bob.k <!unknown> @here");
    expect(decodeMentions("<@00000000-0000-7000-8000-000000000009>", byId)).toBe("<@00000000-0000-7000-8000-000000000009>");
  });

  it("finds the query at the caret and ranks candidates", () => {
    expect(mentionQuery("hello @bo", 9)).toEqual({ start: 6, query: "bo" });
    expect(mentionQuery("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQuery("mail me@x", 9)).toBeNull();
    expect(mentionQuery("done @bob ", 10)).toBeNull();
    expect(mentionQuery("@bob tail", 4)).toEqual({ start: 0, query: "bob" });
    expect(mentionCandidates("bo", users).map((c) => c.username)).toEqual(["bob.k"]);
    expect(mentionCandidates("", users).map((c) => c.username)).toEqual(["alice", "bob.k", "channel", "here"]);
  });
});

it("renders mention tokens as display names for notifications", () => {
  const users = new Map([["00000000-0000-7000-8000-000000000001", { id: "00000000-0000-7000-8000-000000000001", username: "kano", display_name: "Toru Kano", role: "member", deactivated_at: null, created_at: "", updated_at: "" }]]);
  expect(mentionsToNames("hi <@00000000-0000-7000-8000-000000000001> and <@00000000-0000-7000-8000-000000000002> <!channel>", users)).toBe("hi @Toru Kano and @メンバー @channel");
});
