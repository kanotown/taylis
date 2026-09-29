// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "../src/api/client";
import type { PollOut, UserMe } from "../src/api/types";
import { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import type { MessageState } from "../src/sync/types";
import { PollCard, pollCounts, pollMine } from "../src/ui/PollCard";
import { FakeServer, MemoryPersistence } from "./fakeServer";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

async function live() {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const carol = server.addUser("carol");
  const channel = server.createChannel("general", alice.id);
  server.join(channel.id, bob.id);
  server.join(channel.id, carol.id);
  const persistence = new MemoryPersistence();
  const store = new Store(persistence);
  const engine = new SyncEngine({ api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "token", sleep: async () => {} });
  await engine.start();
  await engine.idle();
  await engine.openChannel(channel.id);
  await engine.idle();
  return { server, alice, bob, carol, channel, store, engine, persistence };
}

describe("poll counts and my votes (M27)", () => {
  const base = { question: "ランチは?", options: ["そば", "カレー", "パン"], multiple: true, closed_at: null };

  it("reads counts and my votes from a named poll, also one stored before M27 (no counts, no mine)", () => {
    const old: PollOut = { ...base, votes: [["u1", "me"], [], ["me"]] };
    expect(pollCounts(old)).toEqual([2, 0, 1]);
    expect(pollMine(old, "me")).toEqual([0, 2]);
    const current: PollOut = { ...base, anonymous: false, votes: [["u1", "me"], [], ["me"]], counts: [2, 0, 1], mine: [0, 2] };
    expect(pollCounts(current)).toEqual([2, 0, 1]);
    expect(pollMine(current, "me")).toEqual([0, 2]);
  });

  it("takes an anonymous poll's counts and my votes from the server's fields: its voters are never listed", () => {
    const anonymous: PollOut = { ...base, anonymous: true, votes: [[], [], []], counts: [3, 1, 0], mine: [1] };
    expect(pollCounts(anonymous)).toEqual([3, 1, 0]);
    expect(pollMine(anonymous, "me")).toEqual([1]);
    // An event's copy (mine null) says nothing about me: no option looks chosen by mistake.
    expect(pollMine({ ...anonymous, mine: null }, "me")).toEqual([]);
  });
});

describe("poll.mine merge (SYNC_PROTOCOL.md §8, M27)", () => {
  it("event first, then the vote's answer with the same updated_seq: my vote shows", async () => {
    const w = await live();
    const poll = w.server.postPoll(w.channel.id, w.alice.id, { question: "匿名で", options: ["A", "B"], anonymous: true });
    await w.engine.idle();
    expect(w.store.message(w.channel.id, poll.id)?.poll?.mine ?? null).toBeNull(); // from the event: unknown

    const answer = w.server.vote(w.channel.id, w.bob.id, poll.id, 1, true); // its event reaches the engine at once
    await w.engine.idle();
    const afterEvent = w.store.message(w.channel.id, poll.id)!;
    expect(afterEvent.updated_seq).toBe(answer.updated_seq);
    expect(afterEvent.poll?.counts).toEqual([0, 1]);
    w.store.upsertMessage(answer); // what AppController.vote does with the response
    expect(w.store.message(w.channel.id, poll.id)?.poll?.mine).toEqual([1]);
    await w.store.flushPersistence();
    expect(JSON.parse(w.persistence.messages.get(poll.id)!.json).poll.mine).toEqual([1]); // kept across a restart too
  });

  it("the answer first, then its event and others' votes (mine null): my vote stays", async () => {
    const w = await live();
    const poll = w.server.postPoll(w.channel.id, w.alice.id, { question: "匿名で", options: ["A", "B"], anonymous: true });
    await w.engine.idle();
    w.server.holdEvents = true;
    const answer = w.server.vote(w.channel.id, w.bob.id, poll.id, 0, true);
    w.store.upsertMessage(answer);
    expect(w.store.message(w.channel.id, poll.id)?.poll?.mine).toEqual([0]);
    w.server.release(); // the same updated_seq: ignored
    await w.engine.idle();
    expect(w.store.message(w.channel.id, poll.id)?.poll?.mine).toEqual([0]);
    w.server.holdEvents = false;
    w.server.vote(w.channel.id, w.carol.id, poll.id, 1, true); // a newer row, from an event
    await w.engine.idle();
    const row = w.store.message(w.channel.id, poll.id)!;
    expect(row.poll?.counts).toEqual([1, 1]);
    expect(row.poll?.votes).toEqual([[], []]);
    expect(row.poll?.mine).toEqual([0]);
  });

  it("my vote's answer counts also when another member's vote event came first with a newer updated_seq", () => {
    const store = new Store();
    const base = { id: "m1", channel_id: "c1", sender_id: "u1", seq: 1, client_msg_id: null, body: "📊 q", created_at: "", edited_at: null, deleted: false };
    const poll = { question: "q", options: ["a", "b"], multiple: false, anonymous: true, closed_at: null, votes: [[], []] };
    store.upsertMessage({ ...base, updated_seq: 6, poll: { ...poll, counts: [1, 1], mine: null } } satisfies MessageState); // carol's event
    const answer = { ...base, updated_seq: 5, poll: { ...poll, counts: [0, 1], mine: [1] } } satisfies MessageState; // my vote, older
    expect(store.upsertMessage(answer)).toBe(false); // the merge keeps the newer row…
    store.setMyVotes(answer); // …and AppController.vote still takes my votes from the answer
    const row = store.message("c1", "m1")!;
    expect(row.poll?.mine).toEqual([1]);
    expect(row.poll?.counts).toEqual([1, 1]);
  });

  it("an answer with the same updated_seq and the same votes changes nothing (no re-render)", () => {
    const store = new Store();
    const row = { id: "m1", channel_id: "c1", sender_id: "u1", seq: 1, updated_seq: 5, client_msg_id: null, body: "📊 q", created_at: "", edited_at: null, deleted: false, poll: { question: "q", options: ["a", "b"], multiple: false, anonymous: true, closed_at: null, votes: [[], []], counts: [1, 0], mine: [0] } } satisfies MessageState;
    store.upsertMessage(row);
    const version = store.version;
    expect(store.upsertMessage({ ...row, poll: { ...row.poll, mine: [0] } })).toBe(false);
    expect(store.upsertMessage({ ...row, poll: { ...row.poll, mine: null } })).toBe(false);
    expect(store.version).toBe(version);
  });
});

describe("making a poll against a server before M27", () => {
  it("sends `anonymous` only when set: a named poll's request has no such key", async () => {
    const bodies: Record<string, unknown>[] = [];
    const controller = new AppController();
    const api = new ApiClient("http://server", {
      fetchImpl: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ id: "m1", channel_id: "c1", parent_id: null, seq: 1 }), { status: 201, headers: { "Content-Type": "application/json" } });
      },
    });
    api.accessToken = "token";
    controller.api = api;
    expect(await controller.createPoll("c1", null, "いつ?", ["月", "火"], false)).toBe(true);
    expect(await controller.createPoll("c1", null, "満足度", ["高", "低"], false, true)).toBe(true);
    expect(bodies[0]!["poll"]).toEqual({ question: "いつ?", options: ["月", "火"], multiple: false });
    expect(Object.keys(bodies[0]!["poll"] as object)).not.toContain("anonymous");
    expect(bodies[1]!["poll"]).toEqual({ question: "満足度", options: ["高", "低"], multiple: false, anonymous: true });
  });
});

describe("the poll card (M27)", () => {
  /** Five members (Alice … Erin, me = Bob) and a card for the poll `make` builds from their ids. */
  function card(make: (ids: string[]) => PollOut) {
    const server = new FakeServer();
    const users = ["alice", "bob", "carol", "dave", "erin"].map((n) => server.addUser(n));
    const store = new Store();
    for (const user of users) store.upsertUser(user);
    store.setMe(users[1] as unknown as UserMe);
    const vote = vi.fn(async () => true);
    const controller = { store, vote, closePoll: vi.fn() } as unknown as AppController;
    const poll = make(users.map((u) => u.id));
    const message = { id: "m1", channel_id: "c1", sender_id: users[0]!.id, seq: 1, updated_seq: 1, client_msg_id: null, body: "", created_at: "", edited_at: null, deleted: false, poll } satisfies MessageState;
    render(<PollCard poll={poll} message={message} controller={controller} />);
    return { vote };
  }

  it("names who voted for each option in a named poll: a few, then 「ほか N 人」, all of them on hover", () => {
    card(([alice, bob, carol, dave, erin]) => ({ question: "場所", options: ["A", "B"], multiple: false, anonymous: false, closed_at: null, votes: [[alice!, bob!, carol!, dave!], [erin!]], counts: [4, 1], mine: [0] }));
    const [first, second] = screen.getAllByRole("button") as [HTMLElement, HTMLElement];
    expect(within(first).getByText("Alice、Bob、Carol ほか 1 人")).toBeTruthy();
    expect(first.getAttribute("title")).toBe("Alice、Bob、Carol、Dave");
    expect(within(second).getByText("Erin")).toBeTruthy();
    expect(screen.queryByText("匿名")).toBeNull();
  });

  it("says 「匿名」 and names nobody in an anonymous poll; counts and my vote come from the server", () => {
    const w = card(() => ({ question: "満足度", options: ["高い", "低い"], multiple: false, anonymous: true, closed_at: null, votes: [[], []], counts: [2, 1], mine: [1] }));
    expect(screen.getByText("匿名")).toBeTruthy();
    const [high, low] = screen.getAllByRole("button") as [HTMLElement, HTMLElement];
    expect(high.textContent).toContain("2");
    expect(high.getAttribute("title")).toBeNull();
    expect(low.textContent).toContain("1");
    expect(screen.getByText("3 票")).toBeTruthy();
    // My vote is the chosen option: a click takes it back.
    low.click();
    expect(w.vote).toHaveBeenCalledWith(expect.anything(), 1, false);
    high.click();
    expect(w.vote).toHaveBeenCalledWith(expect.anything(), 0, true);
  });
});
