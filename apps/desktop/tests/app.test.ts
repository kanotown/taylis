// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { ApiClient } from "../src/api/client";
import { UNKNOWN_ERROR_MESSAGE } from "../src/api/errorMessages";
import type { ScheduledOut } from "../src/api/types";
import { AppController, profileKey } from "../src/state/app";
import { FakeServer } from "./fakeServer";

afterEach(() => localStorage.clear());

describe("app controller", () => {
  it("never stays on 起動中…: a credential store that fails leads to the login form with the error", async () => {
    localStorage.setItem("chikuwa.username", "bob");
    const controller = new AppController();
    (controller as unknown as { secrets: unknown }).secrets = { get: async () => { throw new Error("keychain locked"); } };
    await controller.boot();
    expect(controller.screen).toBe("login");
    expect(controller.error).toBe(UNKNOWN_ERROR_MESSAGE);
  });

  it("names the local database by a hash of server and user, so similar names never share one (§11)", async () => {
    const keys = await Promise.all(["t.kano", "t_kano", "t-kano"].map((name) => profileKey(`https://chat.example.com|${name}`)));
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}$/);
    expect(await profileKey("https://chat.example.com|t.kano")).toBe(keys[0]);
    const long = `https://${"x".repeat(200)}.example.com`; // the old name was cut at 80 characters
    expect(await profileKey(`${long}|a`)).not.toBe(await profileKey(`${long}|b`));
  });

  it("returns a cancelled scheduled message to the draft as the composer writes it, after what is already there", async () => {
    const server = new FakeServer();
    const bob = server.addUser("bob");
    const controller = new AppController();
    controller.store.upsertUser(bob);
    controller.api = { cancelScheduled: async () => {} } as unknown as ApiClient;
    const row: ScheduledOut = { id: "s1", channel_id: "c1", parent_id: null, client_msg_id: "k1", body: `<@${bob.id}> 明日の件 <!here>`, attachments: [], send_at: "2026-10-01T00:00:00Z", status: "pending", error: null, sent_message_id: null, created_at: "2026-09-27T00:00:00Z" };
    await controller.cancelScheduled(row);
    expect(controller.store.draft("c1").text).toBe("@bob 明日の件 @here");
    controller.store.setDraft("c1", null, { text: "書きかけ" });
    await controller.cancelScheduled({ ...row, id: "s2" });
    expect(controller.store.draft("c1").text).toBe("書きかけ\n@bob 明日の件 @here");
  });
});
