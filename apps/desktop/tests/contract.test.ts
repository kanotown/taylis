/**
 * Runs the shared contract fixtures (server/tests/contract/*.json, SYNC_PROTOCOL.md §13)
 * against the desktop SyncEngine using the in-process fake server.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { FakeServer } from "./fakeServer";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "server", "tests", "contract");

interface Step {
  op: string;
  [key: string]: unknown;
}

class Scenario {
  readonly server = new FakeServer();
  channelId = "";
  store = new Store();
  engine: SyncEngine | null = null;
  clientUser = "";
  clientOptions: Step = { op: "" };
  posted = 0;

  private newEngine(store: Store): SyncEngine {
    const user = this.server.userByName(this.clientUser);
    return new SyncEngine(
      { api: this.server.apiFor(user.id), connect: this.server.connectorFor(user.id), store, getAccessToken: () => "t", sleep: async () => {} },
      { pageSize: Number(this.clientOptions["page_size"] ?? 50), gapLimit: Number(this.clientOptions["gap_limit"] ?? 5000) },
    );
  }

  async run(step: Step): Promise<void> {
    switch (step.op) {
      case "users":
        for (const name of step["names"] as string[]) this.server.addUser(name);
        return;
      case "channel": {
        const owner = this.server.userByName(step["owner"] as string);
        this.channelId = this.server.createChannel(step["name"] as string, owner.id).id;
        for (const member of (step["members"] as string[] | undefined) ?? []) this.server.join(this.channelId, this.server.userByName(member).id);
        return;
      }
      case "post": {
        const sender = this.server.userByName(step["as"] as string);
        for (let i = 0; i < Number(step["count"] ?? 1); i++) {
          this.posted += 1;
          this.server.post(this.channelId, sender.id, String(step["body"]).replace("{i}", String(this.posted)));
        }
        return;
      }
      case "edit": {
        const user = this.server.userByName(step["as"] as string);
        const target = this.server.messageByBody(this.channelId, step["body_of"] as string);
        this.server.edit(this.channelId, user.id, target.id, step["body"] as string);
        return;
      }
      case "delete": {
        const user = this.server.userByName(step["as"] as string);
        const target = this.server.messageByBody(this.channelId, step["body_of"] as string);
        this.server.delete(this.channelId, user.id, target.id);
        return;
      }
      case "react":
      case "unreact": {
        const user = this.server.userByName(step["as"] as string);
        const target = this.server.messageByBody(this.channelId, step["body_of"] as string);
        this.server.react(this.channelId, user.id, target.id, step["emoji"] as string, step.op === "react");
        return;
      }
      case "client.start":
        this.clientUser = step["as"] as string;
        this.clientOptions = step;
        this.store = new Store();
        this.engine = this.newEngine(this.store);
        await this.engine.openChannel(this.channelId);
        await this.engine.start();
        await this.engine.idle();
        return;
      case "client.stop":
        this.engine?.stop();
        return;
      case "client.restart": {
        const snapshot = this.store.snapshot();
        this.engine?.stop();
        this.store = Store.fromSnapshot(snapshot);
        this.engine = this.newEngine(this.store);
        await this.engine.openChannel(this.channelId);
        await this.engine.start();
        await this.engine.idle();
        return;
      }
      case "client.receive":
        await this.engine?.idle();
        return;
      case "client.drop_next": {
        const user = this.server.userByName(this.clientUser);
        for (const socket of this.server.socketsOf(user.id)) socket.dropNext += Number(step["count"]);
        return;
      }
      case "client.send": {
        const key = "00000000-0000-5000-8000-" + String(step["key"]).padStart(12, "0");
        await this.engine!.send(this.channelId, String(step["body"]), key);
        await this.engine!.idle();
        return;
      }
      case "client.send_event_first": {
        const key = "00000000-0000-5000-8000-" + String(step["key"]).padStart(12, "0");
        const user = this.server.userByName(this.clientUser);
        // Post directly on the server: the WS event is applied first, the "late" REST response after.
        this.store.putPlaceholder({ id: "local:" + key, channel_id: this.channelId, sender_id: user.id, seq: null, updated_seq: -1, client_msg_id: key, body: String(step["body"]), created_at: "9999", edited_at: null, deleted: false, pending: true });
        const { message } = this.server.post(this.channelId, user.id, String(step["body"]), key);
        await this.engine!.idle();
        this.store.upsertMessage(message);
        return;
      }
      case "expect": {
        const bodies = this.store.messages(this.channelId).map((m) => m.body);
        const channel = this.store.getChannel(this.channelId);
        if (step["messages"] !== undefined) expect(bodies).toEqual(step["messages"]);
        if (step["message_count"] !== undefined) expect(bodies).toHaveLength(Number(step["message_count"]));
        if (step["first_body"] !== undefined) expect(bodies[0]).toBe(step["first_body"]);
        if (step["last_body"] !== undefined) expect(bodies[bodies.length - 1]).toBe(step["last_body"]);
        if (step["synced_seq"] !== undefined) expect(channel?.syncedSeq).toBe(step["synced_seq"]);
        if (step["catch_ups"] !== undefined) expect(this.engine?.stats.catchUps).toBe(step["catch_ups"]);
        if (step["reloads"] !== undefined) expect(this.engine?.stats.reloads).toBe(step["reloads"]);
        if (step["reactions"] !== undefined) {
          const byBody = new Map(this.store.messages(this.channelId).map((m) => [m.body, m]));
          for (const [body, emojis] of Object.entries(step["reactions"] as Record<string, string[]>)) {
            expect((byBody.get(body)?.reactions ?? []).map((r) => r.emoji), body).toEqual(emojis);
          }
        }
        if (step["server_message_count"] !== undefined) expect(this.server.channels.get(this.channelId)!.messages).toHaveLength(Number(step["server_message_count"]));
        return;
      }
      default:
        throw new Error(`unknown op ${step.op}`);
    }
  }
}

const fixtures = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort();

describe("sync protocol contract fixtures", () => {
  for (const file of fixtures) {
    const spec = JSON.parse(readFileSync(join(FIXTURE_DIR, file), "utf8")) as { name: string; steps: Step[] };
    it(`${file}: ${spec.name}`, async () => {
      const scenario = new Scenario();
      try {
        for (const step of spec.steps) await scenario.run(step);
      } finally {
        scenario.engine?.stop();
      }
    });
  }
});
