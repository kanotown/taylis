/**
 * Runs the real ApiClient + SyncEngine + WebSocket transport against a live backend.
 * Enabled with LIVE_URL (and LIVE_PASS for the users dtuser1 / dtuser2), e.g. the compose stack.
 */
import { describe, expect, it } from "vitest";

import { ApiClient } from "../src/api/client";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { browserConnector } from "../src/sync/ws";

const LIVE_URL = process.env["LIVE_URL"];
const LIVE_PASS = process.env["LIVE_PASS"] ?? "";

async function waitFor(predicate: () => boolean, engine: SyncEngine, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await engine.idle();
  }
}

describe.skipIf(!LIVE_URL)("live backend", () => {
  it("logs in, bootstraps, receives realtime events and sends through the real server", async () => {
    const alice = new ApiClient(LIVE_URL!);
    const bob = new ApiClient(LIVE_URL!);
    await alice.login("dtuser1", LIVE_PASS, { platform: "desktop", device_name: "live-test" });
    await bob.login("dtuser2", LIVE_PASS, { platform: "desktop", device_name: "live-test" });
    const channel = await alice.createChannel("dt-" + Date.now().toString(36), "public");
    await bob.joinChannel(channel.id);

    const store = new Store();
    const engine = new SyncEngine({
      api: bob,
      connect: browserConnector(bob.wsUrl),
      store,
      getAccessToken: () => bob.accessToken,
      sleep: async () => {},
    });
    await engine.openChannel(channel.id);
    await engine.start();
    await engine.idle();
    expect(engine.status).toBe("online");
    expect(store.me?.username).toBe("dtuser2");
    expect(store.getChannel(channel.id)?.isMember).toBe(true);

    await alice.postMessage(channel.id, crypto.randomUUID(), "hello from the real server");
    await waitFor(() => store.messages(channel.id).length === 1, engine);
    expect(store.messages(channel.id).map((m) => m.body)).toEqual(["hello from the real server"]);
    expect(store.getChannel(channel.id)?.syncedSeq).toBe(1);

    await engine.send(channel.id, "reply from the desktop engine");
    await engine.idle();
    await waitFor(() => store.getChannel(channel.id)?.syncedSeq === 2, engine);
    const history = await alice.history(channel.id, null, 10);
    expect(history.messages.map((m) => m.body)).toEqual(["reply from the desktop engine", "hello from the real server"]);
    expect(store.messages(channel.id).every((m) => !m.pending)).toBe(true);

    engine.stop();
    await alice.logout();
    await bob.logout();
  }, 30_000);
});
