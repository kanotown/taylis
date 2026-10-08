import { describe, expect, it } from "vitest";

import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { FakeServer } from "./fakeServer";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Two devices of bob; drafts are saved only when a test says so (flushDrafts), or at once when emptied. */
async function devices() {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const channel = server.createChannel("general", alice.id);
  server.join(channel.id, bob.id);
  const make = (store: Store) =>
    new SyncEngine({ api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {} }, { draftSaveMs: 60_000 });
  const laptop = new Store();
  const phone = new Store();
  const a = make(laptop);
  const b = make(phone);
  for (const engine of [a, b]) {
    await engine.start();
    await engine.idle();
  }
  return { server, bob, channel, laptop, phone, a, b, make };
}

describe("drafts shared by my devices (M15d)", () => {
  it("saves a draft, shows it on my other device and removes it everywhere once sent", async () => {
    const { server, bob, channel, laptop, phone, a, b } = await devices();
    laptop.setDraft(channel.id, null, { text: "書きかけ" });
    expect(laptop.draft(channel.id).dirty).toBe(true);
    await a.flushDrafts();
    await b.idle();
    expect(server.draftsOf(bob.id).map((d) => d.body)).toEqual(["書きかけ"]);
    expect(laptop.draft(channel.id)).toMatchObject({ text: "書きかけ", dirty: false });
    expect(phone.draft(channel.id)).toMatchObject({ text: "書きかけ" });
    expect(phone.listDrafts().map((d) => d.draft.text)).toEqual(["書きかけ"]);

    // Sending empties the composer: the delete goes out at once and reaches the phone.
    laptop.setDraft(channel.id, null, { text: "" });
    await tick();
    await a.drafts.idle();
    await b.idle();
    expect(server.draftsOf(bob.id)).toEqual([]);
    expect(phone.draft(channel.id).text).toBe("");
    expect(phone.listDrafts()).toEqual([]);
    expect(laptop.draftEntries()).toEqual([]); // the tombstone is gone once the delete is saved
    a.stop();
    b.stop();
  });

  it("「下書き」's 削除 removes the draft here, on the server and on my other device (2026-10-09)", async () => {
    const { server, bob, channel, laptop, phone, a, b } = await devices();
    laptop.setDraft(channel.id, null, { text: "消す下書き" });
    await a.flushDrafts();
    await b.idle();
    expect(phone.listDrafts().map((d) => d.draft.text)).toEqual(["消す下書き"]);

    phone.discardDraft(channel.id, null);
    expect(phone.listDrafts()).toEqual([]);
    await tick();
    await b.drafts.idle();
    await a.idle();
    expect(server.draftsOf(bob.id)).toEqual([]);
    expect(laptop.listDrafts()).toEqual([]);
    expect(phone.draftEntries()).toEqual([]);
    a.stop();
    b.stop();
  });

  it("keeps this device's unsaved edits when another device saves an older idea", async () => {
    const { channel, laptop, phone, a, b } = await devices();
    phone.setDraft(channel.id, null, { text: "スマホで書いた" }); // not saved yet
    laptop.setDraft(channel.id, null, { text: "PC で書いた" });
    await a.flushDrafts();
    await b.idle();
    expect(phone.draft(channel.id).text).toBe("スマホで書いた"); // dirty: the laptop's version is ignored
    await b.flushDrafts();
    await a.idle();
    expect(laptop.draft(channel.id).text).toBe("スマホで書いた"); // the latest save wins everywhere
    a.stop();
    b.stop();
  });

  it("bootstrap takes the server's drafts, pushes older local ones and forgets drafts deleted elsewhere", async () => {
    const { server, bob, channel, laptop, a, make } = await devices();
    const other = server.createChannel("random", bob.id);
    laptop.setDraft(channel.id, null, { text: "共有される" });
    await a.flushDrafts();

    // A device that kept drafts before they synced, plus one this device saved but another deleted.
    const tablet = new Store();
    tablet.setDraft(other.id, null, { text: "昔の下書き" });
    tablet.markDraftSaved(other.id, null, "昔の下書き", null); // as if written before M15d: not dirty, never synced
    tablet.applyRemoteDraft(channel.id, "gone-parent", "消された", "2026-09-27T00:00:00Z");
    const c = make(tablet);
    await c.start();
    await c.idle();
    await c.drafts.idle();
    expect(tablet.draft(channel.id).text).toBe("共有される");
    expect(tablet.draft(channel.id, "gone-parent").text).toBe(""); // not on the server any more
    expect(server.draftsOf(bob.id).map((d) => d.body).sort()).toEqual(["共有される", "昔の下書き"]);
    a.stop();
    c.stop();
  });
});
