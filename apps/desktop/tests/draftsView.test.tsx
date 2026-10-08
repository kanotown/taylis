// @vitest-environment jsdom
/** 「下書き」 (M11h): a row opens its conversation; 2026-10-09: its × deletes the draft. */
import { useSyncExternalStore } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { ChannelOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { DraftsView } from "../src/ui/DraftsView";

afterEach(cleanup);

function setup() {
  const store = new Store();
  store.upsertChannel({ id: "c1", type: "public", name: "general", archived: false, last_seq: 0, created_at: "", updated_at: "" } as unknown as ChannelOut, { isMember: true });
  store.setDraft("c1", null, { text: "書きかけの本文" });
  store.setDraft("c1", "m1", { text: "スレッドへの返信" });
  const controller = { store, isAdmin: false } as unknown as AppController;
  return { store, controller };
}

function View({ controller, onOpen }: { controller: AppController; onOpen: (channelId: string, parentId: string | null) => void }) {
  useSyncExternalStore((fn) => controller.store.subscribe(fn), () => controller.store.version);
  return <DraftsView controller={controller} onOpen={onOpen} />;
}

it("a row opens its conversation; its × deletes that draft only", () => {
  const { store, controller } = setup();
  const onOpen = vi.fn();
  render(<View controller={controller} onOpen={onOpen} />);
  const rows = () => [...document.querySelectorAll<HTMLElement>("li[data-row-key]")];
  expect(rows().map((r) => r.dataset["rowKey"])).toEqual(["c1:", "c1:m1"]);
  fireEvent.click(screen.getByText("書きかけの本文"));
  expect(onOpen).toHaveBeenCalledWith("c1", null);
  fireEvent.click(within(rows()[1]!).getByRole("button", { name: "下書きを削除" }));
  expect(store.listDrafts().map((d) => d.draft.text)).toEqual(["書きかけの本文"]);
  expect(store.draft("c1", "m1").dirty).toBe(true); // the delete goes to the server next
  expect(rows().map((r) => r.dataset["rowKey"])).toEqual(["c1:"]);
  expect(onOpen).toHaveBeenCalledTimes(1); // the × is not the row's button
});
