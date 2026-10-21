// @vitest-environment jsdom
/** MOBILE_UI.md §23: a channel's members (read for the @ list) rank before the others; a failed read keeps the order. */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppController } from "../src/state/app";
import { ChannelMembers, MEMBERS_MAX_AGE_MS, MEMBERS_RETRY_MS, requestChannelMembers } from "../src/sync/channelMembers";
import { Store } from "../src/sync/store";
import { Composer } from "../src/ui/Composer";
import { documentContext, mentionCandidates } from "../src/ui/mentions";
import { FakeServer } from "./fakeServer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

describe("ChannelMembers", () => {
  it("reads once, again when the members changed or the read is old, and keeps the ids meanwhile", async () => {
    const changed = vi.fn();
    const cache = new ChannelMembers(changed);
    const load = vi.fn(async () => ["u2"]);
    cache.want("c1", 0, load, 0);
    cache.want("c1", 0, load, 1); // running
    await settle();
    expect(cache.ids("c1")).toEqual(["u2"]);
    expect(changed).toHaveBeenCalledOnce();
    cache.want("c1", 0, load, 1000);
    expect(load).toHaveBeenCalledOnce();
    cache.want("c1", 1, async () => ["u2", "u3"], 2000); // a member joined
    expect(cache.ids("c1")).toEqual(["u2"]);
    await settle();
    expect(cache.ids("c1")).toEqual(["u2", "u3"]);
    const again = vi.fn(async () => ["u3"]);
    cache.want("c1", 1, again, 2000 + MEMBERS_MAX_AGE_MS);
    await settle();
    expect(again).toHaveBeenCalledOnce();
    expect(cache.ids("c1")).toEqual(["u3"]);
  });

  it("a failed read leaves nothing (or what was there) and is tried again only after a while", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const changed = vi.fn();
    const cache = new ChannelMembers(changed);
    const failing = vi.fn(async (): Promise<string[]> => { throw new Error("offline"); });
    cache.want("c1", 0, failing, 0);
    await settle();
    expect(cache.ids("c1")).toBeUndefined();
    expect(changed).not.toHaveBeenCalled();
    cache.want("c1", 0, failing, MEMBERS_RETRY_MS - 1);
    expect(failing).toHaveBeenCalledOnce();
    cache.want("c1", 0, async () => ["u2"], MEMBERS_RETRY_MS);
    await settle();
    expect(cache.ids("c1")).toEqual(["u2"]);
    cache.want("c1", 1, failing, MEMBERS_RETRY_MS + 1);
    await settle();
    expect(cache.ids("c1")).toEqual(["u2"]);
  });

  it("only public and private channels are read (a DM has its participants)", () => {
    const store = new Store();
    store.upsertChannel({ ...new FakeServer().createChannel("general", "u1"), type: "dm" }, { isMember: true, syncedSeq: 0 });
    const api = { members: vi.fn(async () => []) };
    requestChannelMembers(store, api, [...store.channels.keys()][0]);
    requestChannelMembers(store, api, null);
    expect(api.members).not.toHaveBeenCalled();
  });

  it("a channel canvas ranks its channel's members", async () => {
    const store = new Store();
    store.channelMembers.want("c1", 0, async () => ["u3"]);
    await settle();
    const user = (id: string, username: string) => ({ id, username, display_name: username, role: "member", deactivated_at: null, created_at: "", updated_at: "" });
    const users = [user("u2", "bob"), user("u3", "carol")];
    expect(mentionCandidates("", users, [], 8, null, documentContext(store, "c1")).map((c) => c.username)).toEqual(["carol", "bob", "channel", "here"]);
  });
});

function world(members: () => Promise<Array<{ user_id: string }>>) {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const bob = server.addUser("bob");
  const carol = server.addUser("carol");
  const channel = server.createChannel("general", me.id);
  const store = new Store();
  for (const user of [me, bob, carol]) store.upsertUser(user);
  store.me = me as unknown as Store["me"];
  store.upsertChannel(channel, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
  const api = { members: vi.fn(members) };
  const controller = { store, engine: { send: vi.fn(), sendTyping: vi.fn(), status: "online" }, api, setError: vi.fn(), sendKey: "shift-enter", isAdmin: false } as unknown as AppController;
  function View() {
    useSyncExternalStore(store.subscribe.bind(store), () => store.version);
    return <Composer controller={controller} channel={store.getChannel(channel.id)!} />;
  }
  render(<View />);
  const shown = () => [...document.querySelectorAll("li strong")].map((el) => el.textContent);
  const type = (value: string) => {
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value } });
    box.setSelectionRange(value.length, value.length);
  };
  return { api, store, channel, me, carol, shown, type };
}

describe("the composer's @ list in a channel", () => {
  it("reads the members when the list opens and re-ranks: members before the others, me last", async () => {
    const w = world(async () => [{ user_id: w.me.id }, { user_id: w.carol.id }]);
    w.type("@");
    expect(w.shown()).toEqual(["@bob", "@carol", "@alice", "@channel", "@here"]);
    await settle();
    expect(w.api.members).toHaveBeenCalledExactlyOnceWith(w.channel.id);
    expect(w.shown()).toEqual(["@carol", "@bob", "@alice", "@channel", "@here"]);
    w.type("@c");
    w.type("@");
    await settle();
    expect(w.api.members).toHaveBeenCalledOnce();
  });

  it("a failed read keeps the order without members", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const w = world(async () => { throw new Error("offline"); });
    w.type("@");
    await settle();
    expect(w.api.members).toHaveBeenCalledOnce();
    expect(w.shown()).toEqual(["@bob", "@carol", "@alice", "@channel", "@here"]);
  });
});
