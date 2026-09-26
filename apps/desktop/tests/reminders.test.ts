import { describe, expect, it } from "vitest";

import type { ReminderOut } from "../src/api/types";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { FakeServer } from "./fakeServer";

describe("reminders (M12e)", () => {
  it("loads open reminders, lists fired ones first and nudges once when one fires", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const general = server.createChannel("general", alice.id);
    const { message } = server.post(general.id, alice.id, "remember me");
    const later = server.remind(alice.id, general.id, message.id, "2026-10-03T00:00:00Z");
    const sooner = server.remind(alice.id, general.id, message.id, "2026-10-02T00:00:00Z", "reply");
    const store = new Store();
    const nudges: ReminderOut[] = [];
    const engine = new SyncEngine(
      { api: server.apiFor(alice.id), connect: server.connectorFor(alice.id), store, getAccessToken: () => "t", sleep: async () => {}, onReminder: (r) => nudges.push(r) },
      { pageSize: 50 },
    );
    await engine.start();
    await engine.idle();
    expect(store.listReminders().map((r) => r.id)).toEqual([sooner.id, later.id]);
    expect(store.firedReminderCount()).toBe(0);

    server.emitReminder(alice.id, { ...sooner, status: "fired", fired_at: "2026-10-02T00:00:00Z" });
    server.emitReminder(alice.id, { ...sooner, status: "fired", fired_at: "2026-10-02T00:00:00Z" }); // a replayed event
    await engine.idle();
    expect(nudges.map((r) => r.id)).toEqual([sooner.id]);
    expect(store.firedReminderCount()).toBe(1);
    expect(store.listReminders().map((r) => r.status)).toEqual(["fired", "pending"]);

    server.emitReminder(alice.id, { ...sooner, status: "done" });
    server.emitReminder(alice.id, { ...later, status: "cancelled" });
    await engine.idle();
    expect(store.listReminders()).toEqual([]);
    engine.stop();
  });
});
