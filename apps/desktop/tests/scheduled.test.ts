import { describe, expect, it } from "vitest";

import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { FakeServer } from "./fakeServer";

describe("scheduled messages (M12d)", () => {
  it("loads pending rows after bootstrap and follows scheduled.updated", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const general = server.createChannel("general", alice.id);
    const row = server.schedule(alice.id, general.id, "later", "2026-10-03T00:00:00Z");
    const store = new Store();
    const engine = new SyncEngine(
      { api: server.apiFor(alice.id), connect: server.connectorFor(alice.id), store, getAccessToken: () => "t", sleep: async () => {} },
      { pageSize: 50 },
    );
    await engine.start();
    await engine.idle();
    expect(store.listScheduled().map((r) => r.body)).toEqual(["later"]);

    const second = server.schedule(alice.id, general.id, "sooner", "2026-10-02T00:00:00Z");
    server.emitScheduled(alice.id, second);
    await engine.idle();
    expect(store.listScheduled().map((r) => r.body)).toEqual(["sooner", "later"]); // soonest first

    server.emitScheduled(alice.id, { ...row, status: "sent", sent_message_id: "m1" });
    server.emitScheduled(alice.id, { ...second, status: "cancelled" });
    await engine.idle();
    expect(store.listScheduled()).toEqual([]);
    engine.stop();
  });
});
