/**
 * A conversation's canvas list that could not be loaded says why (tester, 2026-09-30: the pane waited on 「読み込み中…」
 * for ever against a server from before M41): 404 is "unsupported", anything else "failed"; asking again clears it, and a
 * list that loads forgets it.
 */
import { expect, it, vi } from "vitest";

import { ApiError } from "../src/api/errors";
import type { CanvasMeta } from "../src/api/types";
import { CanvasHub, type CanvasSyncApi } from "../src/sync/canvases";
import { Store } from "../src/sync/store";

function hubWith(listCanvases: CanvasSyncApi["listCanvases"]) {
  const store = new Store();
  const api = { listCanvases } as unknown as CanvasSyncApi;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  return { store, hub: new CanvasHub({ api, store }) };
}

it("404: the server has no canvases yet", async () => {
  const { store, hub } = hubWith(async () => { throw new ApiError(404, "not_found", "Not Found"); });
  await hub.loadList("c1");
  expect(store.canvasesOf("c1")).toBeNull();
  expect(store.canvasListFailure("c1")).toBe("unsupported");
});

it("404 channel_not_found is a conversation I cannot see, not an old server", async () => {
  const { store, hub } = hubWith(async () => { throw new ApiError(404, "channel_not_found", "Channel not found"); });
  await hub.loadList("c1");
  expect(store.canvasListFailure("c1")).toBe("failed");
});

it("another failure can be retried; a list that loads clears it", async () => {
  let fail = true;
  const { store, hub } = hubWith(async () => {
    if (fail) throw new ApiError(500, "internal", "boom");
    return [] as CanvasMeta[];
  });
  await hub.loadList("c1");
  expect(store.canvasListFailure("c1")).toBe("failed");

  fail = false;
  const again = hub.loadList("c1");
  expect(store.canvasListFailure("c1")).toBeNull(); // 「読み込み中…」 while it asks
  await again;
  expect(store.canvasesOf("c1")).toEqual([]);
  expect(store.canvasListFailure("c1")).toBeNull();
});
