import { expect, it } from "vitest";

import { canGo, emptyHistory, go, HISTORY_CAP, type Place, type PlaceHistory, placeKey, visit } from "../src/ui/placeHistory";
import { EMPTY_SEARCH } from "../src/ui/search";

const ch = (id: string, focus: string | null = null): Place<string> => ({ kind: "channel", channelId: id, focus });
const view = (name: "threads" | "saved" | "activity" | "times"): Place<string> => ({ kind: "view", view: name, search: null, filesChannelId: null });
const all = () => true;
const keys = (history: PlaceHistory<string>) => history.entries.map(placeKey);
const build = (...places: Place<string>[]) => places.reduce((h, p) => visit(h, p), emptyHistory<string>());

it("visit pushes places; back and forward move between them", () => {
  let h = build(ch("a"), view("threads"), ch("b"));
  expect(keys(h)).toEqual(["channel:a", "view:threads", "channel:b"]);
  expect(h.index).toBe(2);
  expect(canGo(h, 1, all)).toBe(false);
  expect(canGo(h, -1, all)).toBe(true);
  let moved = go(h, -1, all)!;
  expect(moved.place).toEqual(view("threads"));
  h = moved.history;
  moved = go(h, -1, all)!;
  expect(moved.place).toEqual(ch("a"));
  h = moved.history;
  expect(canGo(h, -1, all)).toBe(false);
  expect(go(h, -1, all)).toBeNull();
  moved = go(h, 1, all)!;
  expect(moved.place).toEqual(view("threads"));
  expect(moved.history.index).toBe(1);
  expect(keys(moved.history)).toEqual(["channel:a", "view:threads", "channel:b"]);
});

it("navigating elsewhere after going back drops the forward entries", () => {
  const h = build(ch("a"), ch("b"), ch("c"));
  const back = go(go(h, -1, all)!.history, -1, all)!.history; // at a
  const next = visit(back, view("saved"));
  expect(keys(next)).toEqual(["channel:a", "view:saved"]);
  expect(canGo(next, 1, all)).toBe(false);
});

it("the place being shown again (a restored entry, a reveal in the same conversation) replaces it instead of adding one", () => {
  let h = build(ch("a"), ch("b"));
  h = visit(h, ch("b", "m1"));
  expect(keys(h)).toEqual(["channel:a", "channel:b"]);
  expect(h.entries[1]).toEqual(ch("b", "m1"));
  // Restoring an entry visits it again: nothing is added and the forward entries stay.
  const back = go(h, -1, all)!;
  const shown = visit(back.history, back.place);
  expect(keys(shown)).toEqual(["channel:a", "channel:b"]);
  expect(canGo(shown, 1, all)).toBe(true);
});

it("search entries are told apart by their query; files by their channel", () => {
  const search = (q: string): Place<string> => ({ kind: "view", view: "search", search: { ...EMPTY_SEARCH, q }, filesChannelId: null });
  const files = (id: string | null): Place<string> => ({ kind: "view", view: "files", search: null, filesChannelId: id });
  const h = build(search("実験"), search("実験"), search("論文"), files(null), files("a"));
  expect(h.entries).toHaveLength(4);
});

it("keeps at most HISTORY_CAP entries, dropping the oldest", () => {
  let h = emptyHistory<string>();
  for (let i = 0; i < HISTORY_CAP + 7; i++) h = visit(h, ch(`c${i}`));
  expect(h.entries).toHaveLength(HISTORY_CAP);
  expect(h.index).toBe(HISTORY_CAP - 1);
  expect(placeKey(h.entries[0]!)).toBe("channel:c7");
  expect(placeKey(h.entries.at(-1)!)).toBe(`channel:c${HISTORY_CAP + 6}`);
  expect(visit(h, ch("x"), 3).entries.map(placeKey)).toEqual([`channel:c${HISTORY_CAP + 5}`, `channel:c${HISTORY_CAP + 6}`, "channel:x"]);
});

it("skips (and drops) entries whose conversation can no longer be shown, both ways", () => {
  const h = build(ch("a"), ch("gone"), view("activity"), ch("left"), ch("b"));
  const available = (place: Place<string>) => place.kind !== "channel" || !["gone", "left"].includes(place.channelId);
  const back = go(h, -1, available)!;
  expect(back.place).toEqual(view("activity"));
  expect(keys(back.history)).toEqual(["channel:a", "channel:gone", "view:activity", "channel:b"]);
  const back2 = go(back.history, -1, available)!;
  expect(back2.place).toEqual(ch("a"));
  expect(keys(back2.history)).toEqual(["channel:a", "view:activity", "channel:b"]);
  const forward = go(back2.history, 1, available)!;
  expect(forward.place).toEqual(view("activity"));

  // Forward over a gone entry.
  const f = go(go(h, -1, all)!.history, -1, all)!.history; // at activity, with left and b ahead
  const ahead = go(f, 1, available)!;
  expect(ahead.place).toEqual(ch("b"));
  expect(keys(ahead.history)).toEqual(["channel:a", "channel:gone", "view:activity", "channel:b"]);

  // Nothing showable behind: the button is off.
  const only = build(ch("gone"), ch("b"));
  expect(canGo(only, -1, available)).toBe(false);
  expect(go(only, -1, available)).toBeNull();
});

it("an entry equal to the current one (left behind by a skipped entry) is not a move", () => {
  const h = build(ch("a"), ch("gone"), ch("a"));
  const available = (place: Place<string>) => place.kind !== "channel" || place.channelId !== "gone";
  expect(canGo(h, -1, available)).toBe(false);
});
