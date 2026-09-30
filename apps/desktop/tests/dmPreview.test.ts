/**
 * M49: the DM list's preview (MOBILE_UI.md §6.3 / §7.1, SYNC_PROTOCOL.md §7.8): the rule against the cases every client
 * shares (apps/shared/dm-preview.json), how the store keeps `last_message` current, and the engine with the fake server.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { ChannelOut, GroupOut, LastMessageOut, MessageOut, UserPublic } from "../src/api/types";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { lastMessageOf, previewExcerpt, previewLine } from "../src/ui/dmPreview";
import { FakeServer } from "./fakeServer";

interface Vectors {
  me: string;
  users: Record<string, string>;
  groups: Record<string, string>;
  excerpt: Array<{ name: string; body: string; attachments: string[]; excerpt: string }>;
  line: Array<{ name: string; type: ChannelOut["type"]; dm_user_ids: string[] | null; last_message: Pick<LastMessageOut, "sender_id" | "type" | "excerpt"> | null; line: string }>;
}

const vectors = JSON.parse(readFileSync(new URL("../../shared/dm-preview.json", import.meta.url), "utf8")) as Vectors;
const users = new Map(Object.entries(vectors.users).map(([id, display_name]) => [id, { id, username: id, display_name } as UserPublic]));
const groups = new Map(Object.entries(vectors.groups).map(([id, name]) => [id, { id, name } as GroupOut]));

describe("dm-preview (apps/shared/dm-preview.json)", () => {
  it.each(vectors.excerpt)("excerpt: $name", ({ body, attachments, excerpt }) => {
    expect(previewExcerpt(body, attachments.map((content_type) => ({ content_type })), users, groups)).toBe(excerpt);
  });

  it.each(vectors.line)("line: $name", ({ type, dm_user_ids, last_message, line }) => {
    expect(previewLine({ type, dm_user_ids }, last_message, vectors.me, users)).toBe(line);
  });

  it("has cases for both parts", () => {
    expect(vectors.excerpt.length).toBeGreaterThan(10);
    expect(vectors.line.length).toBeGreaterThan(5);
  });
});

// --- the store ------------------------------------------------------------------------------------------------------

const ME = "me";
const base = { archived: false, last_seq: 0, last_message_at: null, created_at: "", updated_at: "", created_by: null, topic: null, purpose: null, membership: { role: "member", joined_at: "" }, read_state: null, notification: null, member_count: null, posting_policy: "everyone" };
const dm = (patch: Partial<ChannelOut> = {}): ChannelOut => ({ ...base, id: "d", type: "dm", name: null, dm_user_ids: [ME, "you"], ...patch }) as ChannelOut;
let seqCounter = 0;
const message = (seq: number, body: string, patch: Partial<MessageOut> = {}): MessageOut =>
  ({ id: `m${seq}`, channel_id: "d", sender_id: "you", parent_id: null, also_in_channel: false, seq, updated_seq: seq + ++seqCounter * 1000, client_msg_id: null, type: "user", body, attachments: [], reactions: [], mentioned_user_ids: [], mention_all: false, reply_count: 0, last_reply_at: null, created_at: `2026-09-30T10:00:${String(seq).padStart(2, "0")}Z`, edited_at: null, deleted: false, pinned_at: null, pinned_by: null, ...patch }) as MessageOut;
const last = (store: Store) => store.getChannel("d")?.last_message ?? null;

function storeWith(held: LastMessageOut | null, patch: Parameters<Store["upsertChannel"]>[1] = {}): Store {
  const store = new Store();
  store.upsertChannel(dm(), { isMember: true, last_message: held, ...patch });
  return store;
}

describe("the store keeps last_message (§7.8)", () => {
  it("keeps the one held when a response or event says nothing (null); bootstrap's patch replaces it, null too", () => {
    const held = lastMessageOf(message(3, "held"), new Map());
    const store = storeWith(held);
    store.upsertChannel(dm({ name: "renamed" })); // a PATCH answer, channel.updated …: null = not said
    expect(last(store)).toEqual(held);
    store.upsertChannel(dm({ last_message: { ...held, excerpt: "fresh" } })); // GET /channels/{id}, POST /dms
    expect(last(store)?.excerpt).toBe("fresh");
    store.upsertChannel(dm(), { last_message: null }); // bootstrap: nothing left
    expect(last(store)).toBeNull();
  });

  it("a newer timeline message takes its place; older rows, thread-only replies, pending sends and other people's channels do not", () => {
    const store = storeWith(null);
    store.upsertMessage(message(2, "two"));
    expect(last(store)?.excerpt).toBe("two");
    store.upsertMessage(message(1, "older (a history page)"));
    store.upsertMessage(message(3, "only in the thread", { parent_id: "m2" }));
    store.applyLastMessage({ ...message(9, "pending"), seq: null });
    expect(last(store)?.id).toBe("m2");
    store.upsertMessage(message(4, "also in the channel", { parent_id: "m2", also_in_channel: true }));
    expect(last(store)).toMatchObject({ id: "m4", seq: 4, excerpt: "also in the channel", sender_id: "you", type: "user", has_attachments: false });
    store.upsertMessage(message(5, "", { attachments: [{ id: "a", filename: "p.png", content_type: "image/png", size_bytes: 1, width: 1, height: 1, has_thumbnail: true, status: "attached", created_at: "" }] }));
    expect(last(store)).toMatchObject({ id: "m5", excerpt: "画像を送信しました", has_attachments: true });

    store.upsertChannel({ ...dm(), id: "p", type: "public", name: "p", dm_user_ids: null } as ChannelOut, { isMember: false });
    store.upsertMessage(message(7, "a preview's row", { channel_id: "p" }));
    expect(store.getChannel("p")?.last_message ?? null).toBeNull();
  });

  it("an edit of the one shown brings its text (mention names too); a reaction alone changes nothing", () => {
    const store = storeWith(null);
    const you = "00000000-0000-7000-8000-0000000000a1";
    store.upsertUser({ id: you, username: "you", display_name: "相手" } as UserPublic);
    store.upsertMessage(message(2, "before"));
    store.upsertMessage(message(2, `after <@${you}>`, { edited_at: "x" }));
    expect(last(store)?.excerpt).toBe("after @相手");
    const version = store.version;
    store.upsertMessage(message(2, `after <@${you}>`, { edited_at: "x", reactions: [{ emoji: "👍", user_ids: [ME] }] as never }));
    expect(store.version).toBe(version + 1); // the row's own change, not a second one for the preview
  });

  it("deleting the one shown falls back to the newest live row held below it when the timeline reaches it", () => {
    const store = storeWith(null);
    const stale = vi.fn();
    store.onStalePreview = stale;
    for (const seq of [1, 2, 3]) store.upsertMessage(message(seq, `m${seq}`));
    store.upsertMessage(message(2, "", { deleted: true })); // not the one shown: nothing moves
    store.updateChannel("d", { syncedSeq: 3, oldestLoadedSeq: 1, hasOlder: false });
    store.upsertMessage(message(3, "", { deleted: true }));
    expect(last(store)?.id).toBe("m1");
    store.upsertMessage(message(1, "", { deleted: true }));
    expect(last(store)).toBeNull(); // the start of the conversation: nothing left, nothing to ask
    expect(stale).not.toHaveBeenCalled();
  });

  it("when the rows held cannot say, it empties and asks (onStalePreview); the answer never replaces a newer one", () => {
    const store = storeWith(lastMessageOf(message(8, "shown"), new Map()));
    const stale = vi.fn();
    store.onStalePreview = stale;
    store.applyLastMessage(message(8, "", { deleted: true })); // no timeline here (syncedSeq null)
    expect(last(store)).toBeNull();
    expect(stale).toHaveBeenCalledWith("d");

    store.applyLastMessage(message(9, "arrived meanwhile"));
    store.setFetchedLastMessage("d", lastMessageOf(message(7, "the server's (older)"), new Map()));
    expect(last(store)?.id).toBe("m9");
    store.setFetchedLastMessage("d", null);
    expect(last(store)?.id).toBe("m9");
    const emptied = storeWith(null);
    emptied.setFetchedLastMessage("d", lastMessageOf(message(7, "the server's"), new Map()));
    expect(last(emptied)?.excerpt).toBe("the server's");
  });
});

// --- the engine and the fake server -----------------------------------------------------------------------------------

describe("the engine (§7.8)", () => {
  it("bootstrap brings it; live events move it, also without a timeline; a deletion there asks GET /channels/{id}", async () => {
    const server = new FakeServer();
    const alice = server.addUser("alice");
    const bob = server.addUser("bob");
    const dmId = server.createChannel("", alice.id, "dm").id;
    server.channels.get(dmId)!.channel.dm_user_ids = [alice.id, bob.id];
    server.join(dmId, bob.id);
    const first = server.post(dmId, alice.id, "はじめまして").message;
    const store = new Store();
    const inner = server.apiFor(bob.id);
    const fetched: string[] = [];
    const api = { ...inner, channel: async (id: string) => { fetched.push(id); return inner.channel!(id); } };
    const engine = new SyncEngine({ api, connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {} }, { pageSize: 50 });
    await engine.start();
    await engine.idle();
    const shown = () => previewLine(store.getChannel(dmId)!, store.getChannel(dmId)!.last_message, bob.id, store.users);
    expect(store.getChannel(dmId)?.last_message?.id).toBe(first.id);
    expect(shown()).toBe("はじめまして");

    const mine = server.post(dmId, bob.id, "よろしく").message; // another device of mine
    await engine.idle();
    expect(shown()).toBe("あなた: よろしく");
    server.delete(dmId, bob.id, mine.id);
    await engine.idle();
    await vi.waitFor(() => expect(shown()).toBe("はじめまして"));
    expect(fetched).toEqual([dmId]);

    // With the conversation open (its timeline held), a deletion falls back without asking.
    await engine.openChannel(dmId);
    await engine.idle();
    const again = server.post(dmId, bob.id, "もう一度").message;
    await engine.idle();
    expect(shown()).toBe("あなた: もう一度");
    server.delete(dmId, bob.id, again.id);
    await engine.idle();
    expect(shown()).toBe("はじめまして");
    expect(fetched).toEqual([dmId]);
    engine.stop();
  });
});
