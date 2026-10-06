// @vitest-environment jsdom
/**
 * The profile card behind a user mention in a message (2026-10-06): hover opens it after a moment and leaving closes it
 * (with a grace to move into it), a click or Enter pins it open until Esc; unknown users and groups get no card.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GroupOut, UserMe, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { MessageBody } from "../src/ui/MessageBody";
import { MENTION_HOVER_MS, MENTION_LEAVE_MS } from "../src/ui/UserPopover";

const ALICE = "00000000-0000-7000-8000-000000000001";
const BOB = "00000000-0000-7000-8000-000000000002";
const GONE = "00000000-0000-7000-8000-000000000009";
const GROUP = "00000000-0000-7000-8000-00000000000a";

const person = (id: string, username: string, display_name: string, extra: Partial<UserPublic> = {}): UserPublic =>
  ({ id, username, display_name, role: "member", deactivated_at: null, created_at: "", updated_at: "", ...extra }) as UserPublic;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function view(body: string) {
  const store = new Store();
  const alice = person(ALICE, "alice", "Alice");
  store.setMe(alice as unknown as UserMe);
  store.upsertUser(alice);
  store.upsertUser(person(BOB, "bob.k", "Bob K", { title: "M2" }));
  const groups = new Map<string, GroupOut>([[GROUP, { id: GROUP, name: "design", description: null, member_ids: [ALICE, BOB], created_by: ALICE, created_at: "", updated_at: "", managed: false }]]);
  const controller = {
    store,
    subscribe: () => () => {},
    openDmWith: vi.fn(async () => "dm1"),
    setUserBlocked: vi.fn(),
  } as unknown as AppController;
  render(<MessageBody body={body} users={store.users} groups={groups} controller={controller} />);
  return { controller };
}

const mention = () => screen.getByRole("button", { name: "Bob K のプロフィール" });
const card = () => screen.queryByRole("dialog");
const wait = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe("a mention's profile card", () => {
  it("hover: opens after a moment, closes after the pointer leaves (the grace lets it move into the card)", () => {
    view(`hi <@${BOB}>`);
    fireEvent.pointerEnter(mention(), { pointerType: "mouse" });
    wait(MENTION_HOVER_MS - 1);
    expect(card()).toBeNull();
    wait(1);
    expect(card()!.textContent).toContain("Bob K");
    expect(card()!.textContent).toContain("@bob.k · M2");
    expect(screen.getByRole("button", { name: /メッセージを送る/ })).toBeTruthy();
    expect(document.activeElement).not.toBe(card()); // hover takes no focus

    fireEvent.pointerLeave(mention(), { pointerType: "mouse" });
    wait(MENTION_LEAVE_MS - 50);
    fireEvent.pointerEnter(card()!, { pointerType: "mouse" }); // reached the card in time
    wait(MENTION_LEAVE_MS * 2);
    expect(card()).not.toBeNull();
    fireEvent.pointerLeave(card()!, { pointerType: "mouse" });
    wait(MENTION_LEAVE_MS);
    expect(card()).toBeNull();
  });

  it("a pass over it opens nothing", () => {
    view(`<@${BOB}>`);
    fireEvent.pointerEnter(mention(), { pointerType: "mouse" });
    wait(MENTION_HOVER_MS / 2);
    fireEvent.pointerLeave(mention(), { pointerType: "mouse" });
    wait(MENTION_HOVER_MS * 2);
    expect(card()).toBeNull();
  });

  it("a click pins it open (leaving does not close it) until Esc; a second click closes it", () => {
    view(`<@${BOB}>`);
    fireEvent.click(mention());
    expect(card()).not.toBeNull();
    fireEvent.pointerLeave(mention(), { pointerType: "mouse" });
    wait(MENTION_LEAVE_MS * 3);
    expect(card()).not.toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(card()).toBeNull();
    fireEvent.click(mention());
    expect(card()).not.toBeNull();
    fireEvent.click(mention());
    expect(card()).toBeNull();
  });

  it("from the keyboard: the mention takes the focus and Enter opens the card; 「メッセージを送る」 opens the DM", async () => {
    const { controller } = view(`<@${BOB}>`);
    const opened = vi.fn();
    window.addEventListener("chikuwa:open-channel", opened);
    try {
      expect(mention().tabIndex).toBe(0);
      mention().focus();
      fireEvent.keyDown(mention(), { key: "Enter" });
      expect(card()).not.toBeNull();
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: /メッセージを送る/ })); });
      expect(controller.openDmWith).toHaveBeenCalledWith(BOB);
      expect(opened).toHaveBeenCalledTimes(1);
      expect(card()).toBeNull();
    } finally {
      window.removeEventListener("chikuwa:open-channel", opened);
    }
  });

  it("an unknown user, a group and @channel stay plain text", () => {
    view(`<@${GONE}> <@group:${GROUP}> <!channel>`);
    expect(screen.queryAllByRole("button")).toEqual([]);
    expect(document.body.textContent).toContain("@design");
  });
});
