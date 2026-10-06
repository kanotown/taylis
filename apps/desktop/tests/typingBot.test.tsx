// @vitest-environment jsdom
/**
 * The AI bot's 「入力中」 (2026-10-06): while it prepares a reply to a mention the server sends `typing` with the bot as the
 * user; the existing typing line names it like anyone else, in the channel or in the thread, and drops it with its reply.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import type { UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { SyncEngine } from "../src/sync/engine";
import { Store } from "../src/sync/store";
import { TypingIndicator } from "../src/ui/Typing";
import { FakeServer } from "./fakeServer";

afterEach(cleanup);

it("names a bot that is typing, in the channel and in a thread, and clears it when its reply comes", async () => {
  const server = new FakeServer();
  const alice = server.addUser("alice");
  const bob = server.addUser("bob");
  const bot = Object.assign(server.addUser("ai-chikuwa"), { display_name: "ちくわ", role: "bot", bot_kind: "ai" } satisfies Partial<UserPublic>);
  const channel = server.createChannel("general", alice.id);
  server.join(channel.id, bob.id);
  server.join(channel.id, bot.id);
  const store = new Store();
  const engine = new SyncEngine({ api: server.apiFor(bob.id), connect: server.connectorFor(bob.id), store, getAccessToken: () => "t", sleep: async () => {} });
  await engine.start();
  await engine.openChannel(channel.id);
  expect(store.users.get(bot.id)?.display_name).toBe("ちくわ");
  const controller = { store } as unknown as AppController;
  const question = server.post(channel.id, bob.id, "@ちくわ 教えて").message;

  server.relayTyping(bot.id, channel.id, question.id); // a mention in the channel: the reply goes to its thread
  server.relayTyping(bot.id, channel.id, null);
  await engine.idle();
  const view = render(
    <>
      <TypingIndicator controller={controller} channelId={channel.id} />
      <TypingIndicator controller={controller} channelId={channel.id} parentId={question.id} />
    </>,
  );
  expect(screen.getAllByText("ちくわ が入力中…")).toHaveLength(2);

  // Its reply ends its typing there.
  server.post(channel.id, bot.id, "こたえ", undefined, question.id);
  await act(async () => { await engine.idle(); });
  view.rerender(<TypingIndicator controller={controller} channelId={channel.id} parentId={question.id} />);
  expect(screen.queryByText("ちくわ が入力中…")).toBeNull();

  // A bot this device does not know yet: a placeholder name, no crash.
  store.noteTyping(channel.id, null, "unknown-bot", Date.now() + 5_000);
  view.rerender(<TypingIndicator controller={controller} channelId={channel.id} />);
  expect(screen.getByText(/が入力中…$/)).toBeTruthy();
  engine.stop();
});
