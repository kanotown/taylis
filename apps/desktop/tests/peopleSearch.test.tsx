// @vitest-environment jsdom
/**
 * The people search of the new-DM and add-member dialogs (Dialogs.tsx `UserPicker`) and ✏️ 新しいメッセージ: the picker's
 * jump-match rule (display name and username, NFKC, kana-insensitive), the chosen people kept as chips while filtering,
 * Enter on the only match, ↑↓ between the field and the rows, Esc clearing the query before it closes.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { NewDmDialog } from "../src/ui/Dialogs";
import { searchPeople } from "../src/ui/home";
import { NewMessageView } from "../src/ui/NewMessageView";
import { FakeServer } from "./fakeServer";

afterEach(cleanup);

function fixture() {
  const server = new FakeServer();
  const store = new Store();
  const me = server.addUser("me");
  const sato = server.addUser("sato");
  sato.display_name = "さとう はなこ";
  const suzuki = server.addUser("suzuki");
  suzuki.display_name = "鈴木 一郎";
  const alice = server.addUser("alice");
  const bot = server.addUser("helper");
  bot.role = "bot";
  bot.display_name = "Alice Bot";
  store.setMe({ ...me, email: null, must_change_password: false, notify_keywords: [], presence_hidden: false, notification_default: "mentions", notify_reactions: false, notify_tasks: true, has_password: true });
  [me, sato, suzuki, alice, bot].forEach((user) => store.upsertUser(user));
  store.aiStatus = { agents: [{ bot_user_id: bot.id }] } as unknown as typeof store.aiStatus;
  const createDm = vi.fn(async (ids: string[]) => ({ id: "dm", type: ids.length > 1 ? "group_dm" : "dm" }));
  const controller = { store, me: store.me, api: { createDm }, describe: () => "error", openDmWith: vi.fn(async () => "dm") } as unknown as AppController;
  return { controller, store, createDm, me, sato, suzuki, alice, bot };
}

const field = () => screen.getByRole("searchbox", { name: "名前やユーザー名で検索" }) as HTMLInputElement;
const rows = () => screen.queryAllByRole("button").filter((b) => b.dataset.pick === "person");
const names = () => rows().map((b) => b.textContent);

it("searchPeople: the jump-match rule over display name and username, people before bots, everyone without a query", () => {
  const f = fixture();
  const all = [f.sato, f.suzuki, f.alice, f.bot] as UserPublic[];
  expect(searchPeople("", all)).toEqual(all);
  expect(searchPeople("サトウ", all)).toEqual([f.sato]); // katakana finds hiragana
  expect(searchPeople("ＳＵＺ", all)).toEqual([f.suzuki]); // full-width, by username
  expect(searchPeople("一郎", all)).toEqual([f.suzuki]); // a word of the name
  expect(searchPeople("alice", all)).toEqual([f.alice, f.bot]); // the bot after the people
  expect(searchPeople("zzz", all)).toEqual([]);
});

it("the new-DM dialog: the field is focused, filters, keeps the chosen as chips, and says when nobody matches", () => {
  const f = fixture();
  render(<NewDmDialog controller={f.controller} onClose={() => {}} onOpen={() => {}} />);
  expect(document.activeElement).toBe(field());
  expect(rows()).toHaveLength(4);
  fireEvent.click(rows().find((b) => b.textContent?.includes("Alice @alice"))!);
  fireEvent.change(field(), { target: { value: "さと" } });
  expect(names()).toHaveLength(1);
  expect(names()[0]).toContain("さとう はなこ @sato");
  // Alice is filtered out of the list but stays as a chip with its remove button.
  expect(screen.getByRole("button", { name: "Alice を外す" })).toBeTruthy();
  fireEvent.change(field(), { target: { value: "nobody" } });
  expect(screen.getByText("一致する人はいません")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Alice を外す" })).toBeTruthy();
});

it("the new-DM dialog: Enter toggles the only match and clears the query; Backspace takes the last chip off", async () => {
  const f = fixture();
  const onOpen = vi.fn();
  render(<NewDmDialog controller={f.controller} onClose={() => {}} onOpen={onOpen} />);
  fireEvent.change(field(), { target: { value: "スズキ" } }); // no match: 鈴木 is not read as すずき
  expect(rows()).toHaveLength(0);
  fireEvent.change(field(), { target: { value: "suz" } });
  fireEvent.keyDown(field(), { key: "Enter" });
  expect(field().value).toBe("");
  expect(screen.getByRole("button", { name: "鈴木 一郎 を外す" })).toBeTruthy();
  // Two matches: Enter does nothing.
  fireEvent.change(field(), { target: { value: "alice" } });
  fireEvent.keyDown(field(), { key: "Enter" });
  expect(field().value).toBe("alice");
  fireEvent.change(field(), { target: { value: "" } });
  fireEvent.keyDown(field(), { key: "Backspace" });
  expect(screen.queryByRole("button", { name: "鈴木 一郎 を外す" })).toBeNull();
  fireEvent.change(field(), { target: { value: "sato" } });
  fireEvent.keyDown(field(), { key: "Enter" });
  fireEvent.click(screen.getByRole("button", { name: "開く" }));
  await vi.waitFor(() => expect(f.createDm).toHaveBeenCalledWith([f.sato.id]));
});

it("the new-DM dialog: ↑↓ move between the field and the rows; my own DM only while its name matches", () => {
  const f = fixture();
  render(<NewDmDialog controller={f.controller} onClose={() => {}} onOpen={() => {}} />);
  const self = () => screen.queryAllByRole("button").find((b) => b.dataset.pick === "self");
  expect(self()).toBeTruthy();
  fireEvent.keyDown(field(), { key: "ArrowDown" });
  expect(document.activeElement).toBe(self());
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(rows()[0]);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(rows()[1]);
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
  expect(document.activeElement).toBe(field());
  fireEvent.change(field(), { target: { value: "sato" } });
  expect(self()).toBeUndefined();
  fireEvent.keyDown(field(), { key: "ArrowDown" });
  expect(document.activeElement).toBe(rows()[0]);
});

it("the new-DM dialog: Esc clears the query first, then closes", () => {
  const f = fixture();
  const onClose = vi.fn();
  render(<NewDmDialog controller={f.controller} onClose={onClose} onOpen={() => {}} />);
  fireEvent.change(field(), { target: { value: "sato" } });
  fireEvent.keyDown(field(), { key: "Escape" });
  expect(field().value).toBe("");
  expect(onClose).not.toHaveBeenCalled();
  expect(rows()).toHaveLength(4);
  fireEvent.keyDown(field(), { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

it("✏️ 新しいメッセージ: the same matching, Enter on the only match, ↓ to the rows, Esc clears before it closes", () => {
  const f = fixture();
  const onClose = vi.fn();
  render(<NewMessageView controller={f.controller} onOpen={() => {}} onClose={onClose} />);
  const input = screen.getByRole("textbox", { name: "宛先" }) as HTMLInputElement;
  fireEvent.change(input, { target: { value: "サトウ" } });
  expect(names()).toHaveLength(1);
  expect(names()[0]).toContain("@sato");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(input.value).toBe("");
  const sato = rows().find((b) => b.textContent?.includes("@sato"))!;
  expect(sato.getAttribute("aria-pressed")).toBe("true");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(document.activeElement).toBe(rows()[0]);
  fireEvent.change(input, { target: { value: "alice" } });
  expect(within(screen.getByRole("dialog")).getAllByRole("button").filter((b) => b.dataset.pick === "person")).toHaveLength(2);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(input.value).toBe("");
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});
