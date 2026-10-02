// @vitest-environment jsdom
/** docs/AI.md §4 (review v0.1.18 #5): an AI bot's links get no card fetched by themselves, only when asked for. */
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AiStatusOut } from "../src/api/ai";
import type { LinkPreviewOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { autoLinkPreview } from "../src/ui/LinkPreviewCard";
import { Timeline } from "../src/ui/Timeline";
import { FakeServer } from "./fakeServer";

afterEach(cleanup);

// A synthetic secret the model was steered into writing into the URL.
const LEAK = "https://evil.example.net/c?d=SECRET-ab12cd34";
const HUMAN_LINK = "https://example.com/paper";

/** #general with one post of a human and one of the AI bot, each with an external link (rows as history would give them). */
function world(options: { status: "loaded" | "unknown" }) {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const bob = server.addUser("bob");
  const botUser = server.addUser("claude");
  const bot: UserPublic = { ...botUser, role: "bot" } as UserPublic;
  const channel = server.createChannel("general", me.id);
  server.join(channel.id, bob.id);
  server.join(channel.id, bot.id);
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  for (const user of [me, bob, bot]) store.upsertUser(user);
  const status: AiStatusOut = { available: true, summary_available: true, agents: [{ id: "agent-1", bot_user_id: bot.id, name: "Claude", model: "claude-sonnet-4-5" as AiStatusOut["agents"][number]["model"] }] };
  if (options.status === "loaded") store.setAiStatus(status);
  const human = server.post(channel.id, bob.id, `論文 ${HUMAN_LINK}`).message;
  const answer = server.post(channel.id, bot.id, `詳しくは ${LEAK} を見てください`).message;
  for (const message of [human, answer]) store.upsertMessage(message);
  store.upsertChannel(server.channels.get(channel.id)!.channel, { isMember: true, syncedSeq: 2, oldestLoadedSeq: 0, lastReadSeq: 2 });

  const listeners = new Set<() => void>();
  const previewListeners = new Set<() => void>();
  const controller = {
    store,
    engine: null,
    api: null,
    version: 0,
    setError: vi.fn(),
    messageFocus: null,
    editing: null as string | null,
    isAdmin: false,
    sendKey: "shift-enter",
    linkPreviews: new Map<string, LinkPreviewOut | null>(),
    linkPreview: vi.fn(),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeLinkPreviews(listener: () => void) {
      previewListeners.add(listener);
      return () => previewListeners.delete(listener);
    },
    previewArrived(url: string, preview: LinkPreviewOut) {
      this.linkPreviews.set(url, preview);
      for (const listener of previewListeners) listener();
    },
  };
  function View() {
    useSyncExternalStore(
      (listener) => store.subscribe(listener),
      () => store.version,
    );
    return <Timeline controller={controller as unknown as AppController} channel={store.getChannel(channel.id)!} onOpenThread={() => {}} />;
  }
  render(<View />);
  return { store, controller, bob, bot, status };
}

const asked = (controller: { linkPreview: ReturnType<typeof vi.fn> }) => controller.linkPreview.mock.calls.map((call) => call[0] as string);

describe("link previews of AI bot posts (docs/AI.md §4)", () => {
  it("an AI bot's external link is not fetched until 「プレビューを表示」 is clicked; a human's still is", () => {
    const { controller } = world({ status: "loaded" });
    expect(asked(controller)).toEqual([HUMAN_LINK]); // never the bot's URL with the secret in it
    expect(screen.getByRole("link", { name: LEAK })).toBeTruthy(); // the link itself stays a plain link
    const button = screen.getByRole("button", { name: "プレビューを表示" });
    fireEvent.click(button);
    expect(asked(controller)).toEqual([HUMAN_LINK, LEAK]);
    expect(screen.queryByRole("button", { name: "プレビューを表示" })).toBeNull();
    act(() => controller.previewArrived(LEAK, { status: "ok", url: LEAK, title: "Evil page", site_name: "evil", description: null, image_url: null } as unknown as LinkPreviewOut));
    expect(screen.getByText("Evil page")).toBeTruthy();
    expect(asked(controller)).toHaveLength(2);
  });

  it("while the AI status is unknown, no bot's post fetches its card by itself", () => {
    const { controller } = world({ status: "unknown" });
    expect(asked(controller)).toEqual([HUMAN_LINK]);
    expect(screen.getAllByRole("button", { name: "プレビューを表示" })).toHaveLength(1);
  });

  it("decides by the sender, so a status read later takes over", () => {
    const { store, bob, bot, status } = world({ status: "unknown" });
    expect([autoLinkPreview(store, bob.id), autoLinkPreview(store, bot.id)]).toEqual([true, false]);
    store.setAiStatus(status);
    expect([autoLinkPreview(store, bob.id), autoLinkPreview(store, bot.id)]).toEqual([true, false]);
    // A bot that is not (or no longer) an AI agent still waits for a click: the same rule on the three clients.
    store.setAiStatus({ ...status, agents: [] });
    expect(autoLinkPreview(store, bot.id)).toBe(false);
  });
});
