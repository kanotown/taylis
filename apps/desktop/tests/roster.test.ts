import { describe, expect, it } from "vitest";

import type { LabProfileOut, UserPublic } from "../src/api/types";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { byCodePoint, compareByRoster, rosterLabel, rosterSection, rosterSummary } from "../src/ui/roster";
import { FakeServer } from "./fakeServer";

function person(id: string, name: string): UserPublic {
  return { id, username: id, display_name: name } as UserPublic;
}

function line(user: UserPublic, patch: Partial<LabProfileOut>): LabProfileOut {
  return { user_id: user.id, affiliation: "student", rank: null, grade: null, supervisor_id: null, research_topic: null, reading: null, updated_at: "", ...patch };
}

describe("the lab roster (M23)", () => {
  it("orders faculty by rank, students from D3 down, others, alumni, then people off the roster", () => {
    // The same people and order as the server's test_the_roster_orders_people_and_keeps_the_grade_groups.
    const prof = person("prof", "Prof");
    const assoc = person("assoc", "Assoc");
    const doc = person("doc", "Doc");
    const m1a = person("m1a", "M1a");
    const m1b = person("m1b", "M1b");
    const four = person("four", "Four");
    const old = person("old", "Old");
    const guest = person("guest", "Guest");
    const roster = new Map([
      line(prof, { affiliation: "faculty", rank: "professor" }),
      line(assoc, { affiliation: "faculty", rank: "associate_professor" }),
      line(doc, { grade: "D1", supervisor_id: prof.id }),
      line(m1a, { grade: "M1", reading: "いとう" }),
      line(m1b, { grade: "M1", reading: "あおき" }),
      line(four, { grade: "B4" }),
      line(old, { affiliation: "alumni" }),
    ].map((p) => [p.user_id, p]));
    const sorted = [guest, old, four, m1a, m1b, doc, assoc, prof].sort((a, b) => compareByRoster(a, b, roster));
    expect(sorted.map((u) => u.id)).toEqual(["prof", "assoc", "doc", "m1b", "m1a", "four", "old", "guest"]);

    expect(rosterLabel(roster.get("assoc")!)).toBe("准教授");
    expect(rosterSection(roster.get("assoc"))).toBe("教員");
    expect(rosterSection(roster.get("m1a"))).toBe("M1");
    expect(rosterSection(roster.get("old"))).toBe("卒業生");
    expect(rosterSection(undefined)).toBeNull();
    expect(rosterSummary(roster.get("doc")!, new Map([[prof.id, prof]]))).toBe("D1 · 指導教員：Prof");
  });

  it("compares names by code point like the server, also past U+FFFF", () => {
    // UTF-16 would put 𠀋 (U+2000B, a surrogate pair from U+D840) before ｱ (U+FF71); by code point it comes after.
    expect(byCodePoint("𠀋", "ｱ")).toBe(1);
    expect(byCodePoint("あおき", "いとう")).toBe(-1);
    expect(byCodePoint("かの", "かのう")).toBe(-1);
    expect(byCodePoint("同じ", "同じ")).toBe(0);
  });

  it("loads the roster from bootstrap and follows roster.updated", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    server.createChannel("general", alice.id);
    server.roster.set(bob.id, line(bob, { grade: "M1" }));
    const store = new Store();
    const engine = new SyncEngine(
      { api: server.apiFor(alice.id), connect: server.connectorFor(alice.id), store, getAccessToken: () => "t", sleep: async () => {} },
      { pageSize: 50 },
    );
    await engine.start();
    await engine.idle();
    expect(store.roster.get(bob.id)?.grade).toBe("M1");
    server.setRosterLine(bob.id, line(bob, { grade: "M2", research_topic: "音声合成" }));
    await engine.idle();
    expect(store.roster.get(bob.id)).toMatchObject({ grade: "M2", research_topic: "音声合成" });
    server.setRosterLine(bob.id, null);
    await engine.idle();
    expect(store.roster.has(bob.id)).toBe(false);
    engine.stop();
  });
});
