// @vitest-environment jsdom
/**
 * Dragging my own sections' headers to reorder them (before / after the section dropped on, by the pointer's half), the
 * drop line, conversation drags kept apart from section drags, and AppController.moveSection moving at once (and back on a
 * failure).
 */
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiClient } from "../src/api/client";
import type { SidebarSectionOut, UserMe } from "../src/api/types";
import { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { SECTION_DRAG, Sidebar } from "../src/ui/Sidebar";
import { FakeServer } from "./fakeServer";

afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); });

const sections: SidebarSectionOut[] = [
  { id: "a", name: "研究", emoji: null, collapsed: false, position: 0, channel_ids: [] },
  { id: "b", name: "授業", emoji: null, collapsed: false, position: 1, channel_ids: [] },
  { id: "c", name: "雑談", emoji: null, collapsed: false, position: 2, channel_ids: [] },
];

function world() {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  const general = server.createChannel("general", me.id);
  store.upsertChannel(general, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
  store.replaceSidebar(sections);
  const controller = {
    store, engine: null, me, isGuest: false, isAdmin: false,
    moveToSection: vi.fn(async () => true), moveSection: vi.fn(async () => true), setSectionCollapsed: vi.fn(async () => true), toggleFavorite: vi.fn(async () => {}),
  };
  render(
    <Sidebar controller={controller as unknown as AppController} channels={[...store.channels.values()]} currentId={null} unreadOnly={false}
      onToggleUnreadOnly={() => {}} onOpen={() => {}} onNewDm={() => {}} onNewChannel={() => {}} />,
  );
  return { controller, general };
}

const sectionOf = (name: string) => screen.getByRole("button", { name }).closest("section")!;
const headerOf = (name: string) => sectionOf(name).querySelector("h2")!;

/** A drag of one header onto a section, the pointer in its top (`after` false) or bottom half. */
function dragSection(from: string, onto: string, after: boolean) {
  const data: Record<string, string> = {};
  const dataTransfer = { types: [] as string[], setData: (type: string, value: string) => { data[type] = value; dataTransfer.types.push(type); }, getData: (type: string) => data[type] ?? "", effectAllowed: "", dropEffect: "none" };
  fireEvent.dragStart(headerOf(from), { dataTransfer });
  const target = sectionOf(onto);
  vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 100, height: 40, bottom: 140, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON: () => ({}) });
  const clientY = after ? 130 : 110;
  // jsdom has no DragEvent: the pointer's height is set on the event by hand.
  const at = (event: Event) => { Object.defineProperty(event, "clientY", { value: clientY }); return event; };
  fireEvent(target, at(createEvent.dragOver(target, { dataTransfer })));
  const edge = target.getAttribute("data-drop-edge");
  fireEvent(target, at(createEvent.drop(target, { dataTransfer })));
  return { edge, types: dataTransfer.types };
}

describe("reordering my sections by their headers", () => {
  it("only my own sections' headers drag, and they carry a section, not a conversation", () => {
    world();
    expect(headerOf("研究").getAttribute("draggable")).toBe("true");
    expect(headerOf("チャンネル").getAttribute("draggable")).toBeNull();
    const { types } = dragSection("雑談", "研究", false);
    expect(types).toEqual([SECTION_DRAG]);
  });

  it("drops before or after the section under the pointer, with the line where it lands", () => {
    const w = world();
    expect(dragSection("雑談", "研究", false).edge).toBe("before");
    expect(w.controller.moveSection).toHaveBeenLastCalledWith("c", 0);
    expect(dragSection("研究", "授業", true).edge).toBe("after");
    expect(w.controller.moveSection).toHaveBeenLastCalledWith("a", 1);
    expect(dragSection("研究", "雑談", true).edge).toBe("after");
    expect(w.controller.moveSection).toHaveBeenLastCalledWith("a", 2);
    // Onto its own place: nothing to do.
    dragSection("授業", "授業", false);
    dragSection("授業", "研究", true);
    expect(w.controller.moveSection).toHaveBeenCalledTimes(3);
    expect(sectionOf("研究").getAttribute("data-drop-edge")).toBeNull(); // the line goes away on the drop
  });

  it("a section dropped on a default section, or a conversation on a header, does neither", () => {
    const w = world();
    dragSection("雑談", "チャンネル", false);
    expect(w.controller.moveSection).not.toHaveBeenCalled();
    const conversation = { types: ["application/x-chikuwa-channel"], getData: () => w.general.id, dropEffect: "none" };
    fireEvent.dragOver(sectionOf("研究"), { dataTransfer: conversation });
    fireEvent.drop(sectionOf("研究"), { dataTransfer: conversation });
    expect(w.controller.moveToSection).toHaveBeenCalledWith(w.general.id, "a");
    expect(w.controller.moveSection).not.toHaveBeenCalled();
  });
});

describe("AppController.moveSection", () => {
  function controllerWith(update: (id: string, patch: { position?: number }) => Promise<SidebarSectionOut[]>) {
    const store = new Store();
    store.replaceSidebar(sections);
    const controller = new AppController();
    const api = { updateSidebarSection: update } as unknown as ApiClient;
    (controller as unknown as { active: unknown }).active = { serverUrl: "http://server", username: "alice", api, store, engine: null, me: null, leaving: false };
    vi.spyOn(controller, "setError").mockImplementation(() => {});
    return { store, controller };
  }

  it("moves at once, then takes the server's list", async () => {
    let release!: (rows: SidebarSectionOut[]) => void;
    const { store, controller } = controllerWith(() => new Promise((resolve) => { release = resolve; }));
    const done = controller.moveSection("c", 0);
    expect(store.sidebarSections.map((s) => s.id)).toEqual(["c", "a", "b"]);
    release([{ ...sections[2]!, position: 0 }, { ...sections[0]!, position: 1 }, { ...sections[1]!, position: 2 }]);
    expect(await done).toBe(true);
    expect(store.sidebarSections.map((s) => s.id)).toEqual(["c", "a", "b"]);
  });

  it("puts the old order back when the server refuses", async () => {
    const { store, controller } = controllerWith(async () => { throw new Error("サーバに接続できません"); });
    expect(await controller.moveSection("a", 2)).toBe(false);
    expect(store.sidebarSections.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });
});
