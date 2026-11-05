// @vitest-environment jsdom
/**
 * M185 (docs/LINK_PREVIEWS.md): message links' cards and removing a card. Which cards a message shows and the removed
 * cards' keys (the cases every client shares, apps/shared/link-cards.json); the card of a readable, an unreadable and a
 * deleted message; one request for the cards asked together; the × only for the sender and administrators; a removed
 * card goes away when message.updated brings `hidden_previews`.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { LinkPreviewOut, MessageOut, MessagePreviewOut, UserMe, UserPublic } from "../src/api/types";
import { AppController, MESSAGE_PREVIEW_BATCH } from "../src/state/app";
import type { MessageState } from "../src/sync/types";
import { cardLinks, previewKey } from "../src/ui/links";
import { excerptText } from "../src/ui/messageCards";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";

afterEach(cleanup);

interface Vectors {
  base_url: string;
  keys: Array<{ url: string; key: string | null }>;
  cards: Array<{ name: string; body: string; self_id?: string; hidden?: string[]; call?: boolean; messages: Array<{ id: string; url: string }>; external: string | null }>;
}

const vectors = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "link-cards.json"), "utf8")) as Vectors;
const BASE = vectors.base_url;

describe("link cards (apps/shared/link-cards.json)", () => {
  it.each(vectors.keys)("key of $url", ({ url, key }) => {
    expect(previewKey(url)).toBe(key);
  });

  it.each(vectors.cards)("cards: $name", ({ body, self_id, hidden, call, messages, external }) => {
    expect(cardLinks(body, BASE, { selfId: self_id, hidden, call })).toEqual({ messages, external });
  });

  it("without a server (no session) every link is external", () => {
    expect(cardLinks(`${BASE}/m/0190a1b2-0000-7000-8000-00000000000a`, null)).toEqual({ messages: [], external: `${BASE}/m/0190a1b2-0000-7000-8000-00000000000a` });
  });

  it("the excerpt: plain lines, mentions as names, blank lines left out, at most four", () => {
    const alice = "0190a1b2-0000-7000-8000-0000000000a1";
    const users = new Map([[alice, { id: alice, username: "alice", display_name: "Alice" } as UserPublic]]);
    expect(excerptText(`**計画** <@${alice}> を見て\n\n- 一つ目\n\`code\``, false, users)).toBe("計画 @Alice を見て\n一つ目\ncode");
    expect(excerptText("1\n2\n3\n4\n5", false, users)).toBe("1\n2\n3\n4…");
    expect(excerptText("短い", true, users)).toBe("短い…");
    expect(excerptText("", false, users)).toBe("");
  });
});

type Answer = (ids: string[]) => MessagePreviewOut[];

const okPreview = (message: MessageOut, extra: Partial<MessagePreviewOut> = {}): MessagePreviewOut => ({
  id: message.id,
  state: "ok",
  channel_id: message.channel_id,
  channel_type: "public",
  channel_name: "general",
  parent_id: message.parent_id ?? null,
  sender_id: message.sender_id,
  created_at: message.created_at,
  edited_at: null,
  excerpt: message.body,
  excerpt_truncated: false,
  attachment_count: 0,
  attachment_types: [],
  thumbnail_attachment_id: null,
  ...extra,
});

const bare = (id: string, state: "deleted" | "unavailable"): MessagePreviewOut => ({ id, state }) as MessagePreviewOut;

/** #general: bob's message, and alice's message linking it with an external link. Shown as `me`. */
function world(options: { me?: "alice" | "bob" | "carol"; answer?: (target: MessageOut) => Answer; targetInStore?: boolean } = {}) {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const carol = server.addUser("carol", "admin");
  const general = server.createChannel("general", alice.id);
  server.join(general.id, bob.id);
  server.join(general.id, carol.id);
  const target = server.post(general.id, bob.id, `計画 <@${alice.id}> を見て`).message;
  const linking = server.post(general.id, alice.id, `前の話 ${BASE}/m/${target.id} と https://example.com/page`).message;
  const me = { alice, bob, carol }[options.me ?? "alice"];
  const answer = (options.answer ?? ((t: MessageOut) => (ids: string[]) => ids.map((id) => (id === t.id ? okPreview(t) : bare(id, "unavailable")))))(target);
  const messagePreviews = vi.fn(async (ids: string[]) => ({ items: answer(ids) }));
  const setPreviewHidden = vi.fn(async (messageId: string, url: string, hidden: boolean) => {
    const current = controller.store.getMessage(general.id, messageId)!;
    const key = previewKey(url)!;
    const list = (current.hidden_previews ?? []).filter((k) => k !== key);
    return { ...current, seq: current.seq, hidden_previews: hidden ? [...list, key] : list, updated_seq: current.updated_seq + 1 } as MessageOut;
  });
  const controller = new AppController();
  controller.api = {
    baseUrl: BASE,
    messagePreviews,
    setPreviewHidden,
    linkPreview: vi.fn(async (url: string) => ({ url, status: "ok", title: "Example page", description: null, image_url: null, site_name: "Example", fetched_at: "2026-11-01T00:00:00Z" }) as LinkPreviewOut),
  } as unknown as ApiClient;
  const store = controller.store;
  store.setMe({ ...me, email: null, must_change_password: false, notify_keywords: [], presence_hidden: false, notification_default: "mentions", notify_reactions: false, notify_tasks: true, has_password: true } as UserMe);
  for (const user of [alice, bob, carol]) store.upsertUser(user);
  store.upsertMessage(linking);
  if (options.targetInStore) store.upsertMessage(target);
  store.upsertChannel(server.channels.get(general.id)!.channel, { isMember: true, syncedSeq: 2, oldestLoadedSeq: 0, lastReadSeq: 2 });
  const openPermalink = vi.spyOn(controller, "openPermalink").mockResolvedValue(true);
  function View() {
    useSyncExternalStore(
      (listener) => store.subscribe(listener),
      () => store.version,
    );
    return <Timeline controller={controller} channel={store.getChannel(general.id)!} onOpenThread={() => {}} />;
  }
  render(<View />);
  const card = () => document.querySelector<HTMLElement>(`[data-message-card="${target.id}"]`);
  return { controller, store, target, linking, general, alice, bob, messagePreviews, setPreviewHidden, openPermalink, card };
}

describe("message link cards (M185)", () => {
  it("a message I can read: its author, conversation, time and first lines; a press opens it", async () => {
    const w = world();
    await waitFor(() => expect(w.card()?.dataset.state).toBe("ok"));
    const card = within(w.card()!);
    expect(card.getByText("Bob")).toBeTruthy();
    expect(card.getByText("#general")).toBeTruthy();
    expect(card.getByText("計画 @Alice を見て")).toBeTruthy(); // the mention token as a name
    // Asked once, for the linked message only; the external link keeps its own card.
    expect(w.messagePreviews.mock.calls).toEqual([[[w.target.id]]]);
    expect(await screen.findByText("Example page")).toBeTruthy();
    fireEvent.click(card.getByRole("button", { name: /メッセージを開く/ }));
    expect(w.openPermalink).toHaveBeenCalledWith(w.target.id);
  });

  it("a thread reply's card names its thread", async () => {
    const w = world({ answer: (t) => (ids) => ids.map((id) => okPreview(t, { parent_id: "0190a1b2-0000-7000-8000-0000000000ff" })) });
    await waitFor(() => expect(w.card()?.dataset.state).toBe("ok"));
    expect(within(w.card()!).getByText("#general のスレッド")).toBeTruthy();
  });

  it("a message I cannot read says only that: no author, conversation or text", async () => {
    const w = world({ answer: () => (ids) => ids.map((id) => bare(id, "unavailable")) });
    await waitFor(() => expect(w.card()?.dataset.state).toBe("unavailable"));
    const card = w.card()!;
    expect(within(card).getByText("表示できないメッセージ")).toBeTruthy();
    expect(card.textContent).not.toContain("Bob");
    expect(card.textContent).not.toContain("general");
    expect(card.textContent).not.toContain("計画");
    expect(within(card).queryByRole("button", { name: /メッセージを開く/ })).toBeNull();
  });

  it("a deleted message says so", async () => {
    const w = world({ answer: () => (ids) => ids.map((id) => bare(id, "deleted")) });
    await waitFor(() => expect(w.card()?.dataset.state).toBe("deleted"));
    expect(within(w.card()!).getByText("削除されたメッセージ")).toBeTruthy();
  });

  it("follows the linked message this device holds: an edit, then its deletion", async () => {
    const w = world({ targetInStore: true });
    await waitFor(() => expect(w.card()?.dataset.state).toBe("ok"));
    const held = w.store.getMessage(w.general.id, w.target.id)!;
    act(() => void w.store.upsertMessage({ ...held, body: "直した計画", edited_at: "2026-11-01T00:00:00Z", updated_seq: held.updated_seq + 10 }));
    expect(within(w.card()!).getByText("直した計画")).toBeTruthy();
    act(() => void w.store.upsertMessage({ ...held, body: "", deleted: true, updated_seq: held.updated_seq + 20 }));
    expect(w.card()!.dataset.state).toBe("deleted");
  });

  it("the sender removes a card for everyone (× → the API, the row drops it, 「元に戻す」 brings it back)", async () => {
    const w = world({ me: "alice" });
    await waitFor(() => expect(w.card()?.dataset.state).toBe("ok"));
    await screen.findByText("Example page");
    const buttons = screen.getAllByRole("button", { name: "プレビューを削除" });
    expect(buttons).toHaveLength(2); // the message card and the Open Graph card
    await act(async () => fireEvent.click(within(w.card()!).getByRole("button", { name: "プレビューを削除" })));
    expect(w.setPreviewHidden).toHaveBeenCalledWith(w.linking.id, `${BASE}/m/${w.target.id}`, true);
    await waitFor(() => expect(w.card()).toBeNull());
    expect(screen.getByText("Example page")).toBeTruthy(); // the other card stays
    expect(w.controller.notice).toBe("プレビューを削除しました");
    await act(async () => w.controller.noticeAction!.run());
    expect(w.setPreviewHidden).toHaveBeenLastCalledWith(w.linking.id, `${BASE}/m/${w.target.id}`, false);
    await waitFor(() => expect(w.card()).not.toBeNull());
  });

  it("only the sender and administrators get the ×", async () => {
    const bobView = world({ me: "bob" });
    await waitFor(() => expect(bobView.card()?.dataset.state).toBe("ok"));
    await screen.findByText("Example page");
    expect(screen.queryAllByRole("button", { name: "プレビューを削除" })).toHaveLength(0);
    cleanup();
    const admin = world({ me: "carol" });
    await waitFor(() => expect(admin.card()?.dataset.state).toBe("ok"));
    await screen.findByText("Example page");
    expect(screen.getAllByRole("button", { name: "プレビューを削除" })).toHaveLength(2);
  });

  it("removed cards go when message.updated brings hidden_previews", async () => {
    const w = world({ me: "bob" });
    await waitFor(() => expect(w.card()?.dataset.state).toBe("ok"));
    await screen.findByText("Example page");
    const row = w.store.getMessage(w.general.id, w.linking.id)!;
    // What the engine does with the event: the newer row replaces the old one.
    act(() => void w.store.upsertMessage({ ...row, hidden_previews: ["https://example.com/page", `${BASE}/m/${w.target.id}`], updated_seq: row.updated_seq + 1 } as MessageState));
    expect(w.card()).toBeNull();
    expect(screen.queryByText("Example page")).toBeNull();
  });
});

describe("asking for the cards (controller)", () => {
  it("cards asked together go in one request, at most 20 ids each; a failure is asked again only later", async () => {
    const calls: string[][] = [];
    let fail = false;
    const controller = new AppController();
    controller.api = {
      baseUrl: BASE,
      messagePreviews: vi.fn(async (ids: string[]) => {
        calls.push(ids);
        if (fail) throw new Error("offline");
        return { items: ids.map((id) => bare(id, "unavailable")) };
      }),
    } as unknown as ApiClient;
    const ids = Array.from({ length: MESSAGE_PREVIEW_BATCH + 5 }, (_, i) => `0190a1b2-0000-7000-8000-${String(i).padStart(12, "0")}`);
    const heard = vi.fn();
    controller.subscribeMessagePreviews(heard);
    for (const id of ids) controller.requestMessagePreview(id);
    controller.requestMessagePreview(ids[0]!); // asked twice before the request: once
    await waitFor(() => expect(calls.flat()).toHaveLength(ids.length));
    expect(calls.map((batch) => batch.length)).toEqual([MESSAGE_PREVIEW_BATCH, 5]);
    expect(controller.messagePreviews.get(ids[3]!)?.preview?.state).toBe("unavailable");
    expect(heard).toHaveBeenCalled();
    // Fresh answers are not asked for again.
    controller.requestMessagePreview(ids[3]!);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(2);
    // A failure leaves no card for now and is not asked again at once.
    fail = true;
    controller.requestMessagePreview("0190a1b2-0000-7000-8000-0000000000ee");
    await waitFor(() => expect(controller.messagePreviews.get("0190a1b2-0000-7000-8000-0000000000ee")).toEqual({ preview: null, at: expect.any(Number) }));
    controller.requestMessagePreview("0190a1b2-0000-7000-8000-0000000000ee");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(3);
  });
});
