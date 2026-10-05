import { describe, expect, it } from "vitest";

import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { sectionChannels } from "../src/ui/channels";
import { FakeServer } from "./fakeServer";

describe("favorites and read-all (M12a)", () => {
  it("lists starred conversations in their own section, out of the others", () => {
    const store = new Store();
    const base = { archived: false, last_seq: 0, last_message_at: null, created_at: "", updated_at: "", created_by: null, topic: null, purpose: null, membership: { role: "member", joined_at: "" }, dm_user_ids: null, read_state: null, notification: null, member_count: null };
    store.upsertChannel({ ...base, id: "g", type: "public", name: "general" } as never, { isMember: true });
    store.upsertChannel({ ...base, id: "r", type: "public", name: "random" } as never, { isMember: true });
    store.upsertChannel({ ...base, id: "d", type: "dm", name: null, dm_user_ids: ["u1", "u2"] } as never, { isMember: true });
    const plain = sectionChannels([...store.channels.values()]);
    expect(plain.favorites).toEqual([]);
    expect(plain.channels.map((c) => c.id)).toEqual(["g", "r"]);
    const starred = sectionChannels([...store.channels.values()], { favorites: new Set(["r", "d"]) });
    // Channels by name, then DMs (apps/shared/sidebar-order.json).
    expect(starred.favorites.map((c) => c.id)).toEqual(["r", "d"]);
    expect(starred.channels.map((c) => c.id)).toEqual(["g"]);
    expect(starred.dms).toEqual([]);
  });

  it("syncs stars from bootstrap and favorite.updated, and read-all clears every channel", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    const general = server.createChannel("general", alice.id);
    const random = server.createChannel("random", alice.id);
    server.join(general.id, bob.id);
    server.join(random.id, bob.id);
    server.setFavorite(bob.id, random.id, true);
    server.post(general.id, alice.id, "one");
    server.post(general.id, alice.id, "two");
    server.post(random.id, alice.id, "three");
    const store = new Store();
    const engine = new SyncEngine(
      { api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {} },
      { pageSize: 50 },
    );
    await engine.start();
    await engine.idle();
    expect([...store.favorites]).toEqual([random.id]);
    expect(store.getChannel(general.id)?.unreadCount).toBe(2);
    expect(store.getChannel(random.id)?.unreadCount).toBe(1);

    server.setFavorite(bob.id, general.id, true); // another device starred it
    await engine.idle();
    expect(store.isFavorite(general.id)).toBe(true);

    await engine.markAllRead();
    expect(store.getChannel(general.id)?.unreadCount).toBe(0);
    expect(store.getChannel(general.id)?.lastReadSeq).toBe(2);
    expect(store.getChannel(random.id)?.unreadCount).toBe(0);
    engine.stop();
  });
});
