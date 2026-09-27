import { describe, expect, it } from "vitest";

import { customEmojiName, splitCustomEmoji } from "../src/ui/customEmoji";
import { customEmojiCandidates } from "../src/ui/emoji";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { FakeServer } from "./fakeServer";

describe("custom emoji (M12f)", () => {
  const known = new Set(["party_parrot", "ok"]);
  it("recognises exact reaction names and splits text runs", () => {
    expect(customEmojiName(":party_parrot:")).toBe("party_parrot");
    expect(customEmojiName(":party parrot:")).toBeNull();
    expect(customEmojiName("🎉")).toBeNull();
    expect(splitCustomEmoji("done :ok: and :party_parrot:!", known)).toEqual(["done ", { name: "ok" }, " and ", { name: "party_parrot" }, "!"]);
    expect(splitCustomEmoji("plain :unknown: text", known)).toEqual(["plain :unknown: text"]);
    expect(splitCustomEmoji("no colons", known)).toEqual(["no colons"]);
  });
  it("suggests custom names by prefix first", () => {
    const custom = new Map([["party_parrot", { name: "party_parrot" }], ["superparty", { name: "superparty" }], ["ok", { name: "ok" }]]);
    expect(customEmojiCandidates("par", custom).map((e) => e.shortcode)).toEqual(["party_parrot", "superparty"]);
    expect(customEmojiCandidates("par", custom)[0]?.glyph).toBe(":party_parrot:");
    expect(customEmojiCandidates("", custom)).toEqual([]);
  });
  it("loads the table from bootstrap and follows emoji.updated", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    server.createChannel("general", alice.id);
    server.addEmoji("party_parrot", alice.id);
    const store = new Store();
    const engine = new SyncEngine(
      { api: server.apiFor(alice.id), connect: server.connectorFor(alice.id), store, getAccessToken: () => "t", sleep: async () => {} },
      { pageSize: 50 },
    );
    await engine.start();
    await engine.idle();
    expect([...store.customEmoji.keys()]).toEqual(["party_parrot"]);
    const ok = server.addEmoji("ok", alice.id);
    server.emitEmoji(ok, false);
    await engine.idle();
    expect([...store.customEmoji.keys()].sort()).toEqual(["ok", "party_parrot"]);
    server.emitEmoji(ok, true);
    await engine.idle();
    expect([...store.customEmoji.keys()]).toEqual(["party_parrot"]);
    engine.stop();
  });
});
