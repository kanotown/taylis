// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { SectionDialog } from "../src/ui/SectionDialog";
import { Sidebar } from "../src/ui/Sidebar";
import { FakeServer } from "./fakeServer";

afterEach(() => { cleanup(); localStorage.clear(); });

function world() {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  store.upsertUser(me);
  const made = ["general", "papers", "lab", "random"].map((name) => server.createChannel(name, me.id));
  for (const channel of made) store.upsertChannel(channel, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
  const [general, papers, lab, random] = made as [typeof made[0], typeof made[0], typeof made[0], typeof made[0]];
  store.updateChannel(lab.id, { unreadCount: 2 });
  store.replaceSidebar([{ id: "s1", name: "研究", emoji: "🔬", collapsed: true, position: 0, channel_ids: [papers.id, lab.id], sort: "name", manual_order: [] }]);
  const controller = {
    store, engine: null, me, isGuest: false, isAdmin: false,
    moveToSection: vi.fn(async () => true), setSectionCollapsed: vi.fn(async () => true), toggleFavorite: vi.fn(async () => {}),
    createSection: vi.fn(async () => true),
  };
  const view = () => render(
    <Sidebar controller={controller as unknown as AppController} channels={[...store.channels.values()]} currentId={general.id} unreadOnly={false}
      onToggleUnreadOnly={() => {}} onOpen={() => {}} onNewDm={() => {}} onNewChannel={() => {}} />,
  );
  return { store, controller, view, general, papers, lab, random };
}

describe("sidebar sections (M26, Slack)", () => {
  it("shows the icon, and a folded section keeps only its unread conversations", () => {
    const w = world();
    w.view();
    const header = screen.getByRole("button", { name: "研究" });
    expect(header.textContent).toContain("🔬");
    expect(header.getAttribute("aria-expanded")).toBe("false");
    const section = header.closest("section")!;
    // Folded, nothing unread: folded away (it slides shut), out of reach of the keyboard and screen readers.
    const papers = within(section).getByText("papers").closest("li")!;
    expect(papers.className).toContain("folded");
    expect(papers.getAttribute("aria-hidden")).toBe("true");
    expect(within(section).queryByRole("button", { name: "papers" })).toBeNull();
    expect(within(section).getByRole("button", { name: "lab" })).toBeTruthy(); // unread: still shown
    fireEvent.click(header);
    expect(w.controller.setSectionCollapsed).toHaveBeenCalledWith("s1", false);
  });

  it("moves a conversation dragged onto a section, and back out onto 「チャンネル」", () => {
    const w = world();
    w.view();
    const drop = (target: HTMLElement, channelId: string) => {
      const dataTransfer = { types: ["application/x-chikuwa-channel"], getData: () => channelId, dropEffect: "none" };
      fireEvent.dragOver(target, { dataTransfer });
      fireEvent.drop(target, { dataTransfer });
    };
    drop(screen.getByRole("button", { name: "研究" }).closest("section")!, w.random.id);
    expect(w.controller.moveToSection).toHaveBeenCalledWith(w.random.id, "s1");
    drop(screen.getByRole("button", { name: /^チャンネル$/ }).closest("section")!, w.papers.id);
    expect(w.controller.moveToSection).toHaveBeenLastCalledWith(w.papers.id, null);
    // Files dragged in from outside are not conversations.
    const files = { types: ["Files"], getData: () => "", dropEffect: "none" };
    fireEvent.drop(screen.getByRole("button", { name: "研究" }).closest("section")!, { dataTransfer: files });
    expect(w.controller.moveToSection).toHaveBeenCalledTimes(2);
  });

  it("folds the default sections on this device", () => {
    const w = world();
    w.view();
    fireEvent.click(screen.getByRole("button", { name: /^チャンネル$/ }));
    expect(screen.queryByRole("button", { name: "random" })).toBeNull();
    expect(screen.getByRole("button", { name: "general" })).toBeTruthy(); // the open conversation stays
    expect(localStorage.getItem("chikuwa.sidebar.folded")).toContain("channels");
  });

  it("makes a section with a name and the conversations to put in it", async () => {
    const w = world();
    const onSubmit = vi.fn(async () => true);
    render(<SectionDialog controller={w.controller as unknown as AppController} title="新しいセクション" submitLabel="作成" pickChannels preselected={[w.random.id]} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByPlaceholderText(/研究、授業/), { target: { value: "事務連絡" } });
    fireEvent.click(screen.getByLabelText(/general/));
    expect(screen.getAllByText("研究 から移動")).toHaveLength(2); // papers and lab sit in 研究
    await act(async () => { fireEvent.click(screen.getByText("作成")); });
    expect(onSubmit).toHaveBeenCalledWith({ name: "事務連絡", emoji: null, channelIds: [w.random.id, w.general.id] });
  });

  it("one place per conversation: a starred one says it leaves お気に入り, and dropped on 「チャンネル」 it is unstarred", () => {
    const w = world();
    w.store.replaceFavorites([w.random.id]);
    render(<SectionDialog controller={w.controller as unknown as AppController} title="新しいセクション" submitLabel="作成" pickChannels preselected={[w.random.id]} onClose={() => {}} onSubmit={vi.fn(async () => true)} />);
    expect(screen.getAllByText("お気に入り から移動")).toHaveLength(1);
    cleanup();
    w.view();
    const dataTransfer = { types: ["application/x-chikuwa-channel"], getData: () => w.random.id, dropEffect: "none" };
    const channels = screen.getByRole("button", { name: /^チャンネル$/ }).closest("section")!;
    fireEvent.dragOver(channels, { dataTransfer });
    fireEvent.drop(channels, { dataTransfer });
    expect(w.controller.toggleFavorite).toHaveBeenCalledWith(w.random.id);
    expect(w.controller.moveToSection).not.toHaveBeenCalled();
  });

  it("keeps my avatar and the settings button pinned at the top of the scrolling list", () => {
    const w = world();
    render(
      <Sidebar controller={w.controller as unknown as AppController} channels={[...w.store.channels.values()]} currentId={w.general.id} unreadOnly={false}
        onToggleUnreadOnly={() => {}} onOpen={() => {}} onNewDm={() => {}} onNewChannel={() => {}} onSettings={() => {}} />,
    );
    const header = screen.getByTestId("sidebar-header");
    expect(header.className).toContain("sticky");
    expect(header.className).toContain("top-0");
    expect(header.className).toContain("bg-sidebar");
    expect(within(header).getByRole("button", { name: "設定" })).toBeTruthy();
  });
});

describe("a section's 並べ替え (DATA_MODEL.md sidebar_sections)", () => {
  const names = (section: HTMLElement) => within(section).getAllByRole("button").map((b) => b.getAttribute("title")).filter((x) => x?.startsWith("#"));

  it("lists 「チャンネル」 in the server's hand-made order, and a row dragged within it lands before the row under it", () => {
    const w = world();
    w.store.replaceSidebarDefaults([{ key: "channels", sort: "manual", manual_order: [w.random.id, w.general.id] }]);
    const reorderSection = vi.fn(async () => true);
    Object.assign(w.controller, { reorderSection });
    w.view();
    const section = screen.getByRole("button", { name: /^チャンネル$/ }).closest("section")!;
    expect(names(section)).toEqual(["#random", "#general"]);
    const dataTransfer = { types: ["application/x-chikuwa-channel"], setData: () => {}, getData: () => w.general.id, dropEffect: "none", effectAllowed: "none" };
    const general = within(section).getByRole("button", { name: "general" });
    const random = within(section).getByRole("button", { name: "random" }).closest("li")!;
    fireEvent.dragStart(general, { dataTransfer });
    fireEvent.dragOver(random, { dataTransfer, clientY: 0 });
    fireEvent.drop(random, { dataTransfer, clientY: 0 });
    expect(reorderSection).toHaveBeenCalledWith({ default: "channels" }, [w.general.id, w.random.id]);
    expect(w.controller.moveToSection).not.toHaveBeenCalled();
  });

  it("by name, a row dropped on another row goes to the section as before (no reordering)", () => {
    const w = world();
    const reorderSection = vi.fn(async () => true);
    Object.assign(w.controller, { reorderSection });
    w.view();
    const section = screen.getByRole("button", { name: /^チャンネル$/ }).closest("section")!;
    expect(names(section)).toEqual(["#general", "#random"]);
    const dataTransfer = { types: ["application/x-chikuwa-channel"], setData: () => {}, getData: () => w.random.id, dropEffect: "none", effectAllowed: "none" };
    fireEvent.dragStart(within(section).getByRole("button", { name: "random" }), { dataTransfer });
    fireEvent.drop(within(section).getByRole("button", { name: "general" }).closest("li")!, { dataTransfer });
    expect(reorderSection).not.toHaveBeenCalled();
  });
});

describe("the Times section folded", () => {
  /** alice, with (or without) her own times beside bob's; general is open. */
  function timesWorld(mine: boolean) {
    const w = world();
    const server = new FakeServer();
    const bob = server.addUser("bob");
    const add = (name: string, ownerId: string) => {
      const channel = { ...server.createChannel(name, ownerId), times_owner_id: ownerId };
      w.store.upsertChannel(channel, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
    };
    if (mine) add("times-alice", w.controller.me.id);
    add("times-bob", bob.id);
    render(
      <Sidebar controller={w.controller as unknown as AppController} channels={[...w.store.channels.values()]} currentId={w.general.id} unreadOnly={false}
        onToggleUnreadOnly={() => {}} onOpen={() => {}} onNewDm={() => {}} onNewChannel={() => {}} onTimesFeed={() => {}} onCreateTimes={() => {}} />,
    );
  }
  const row = (name: string) => screen.getByText(name).closest("li")!;
  const folded = (name: string) => row(name).className.includes("folded");
  const foldTimes = () => localStorage.setItem("chikuwa.sidebar.folded", JSON.stringify(["times"]));

  it("keeps 「フィード」 and my own times, and folds the others away", () => {
    foldTimes();
    timesWorld(true);
    expect(screen.getByRole("button", { name: "Times" }).getAttribute("aria-expanded")).toBe("false");
    expect(folded("フィード")).toBe(false);
    expect(folded("times-alice")).toBe(false);
    expect(screen.getByRole("button", { name: /times-alice/ })).toBeTruthy();
    expect(folded("times-bob")).toBe(true);
    expect(row("times-bob").getAttribute("aria-hidden")).toBe("true");
  });

  it("shows nothing extra when I have no times", () => {
    foldTimes();
    timesWorld(false);
    expect(folded("フィード")).toBe(true);
    expect(folded("times-bob")).toBe(true);
  });

  it("shows every row when open, with or without my times", () => {
    timesWorld(true);
    expect(screen.getByRole("button", { name: "Times" }).getAttribute("aria-expanded")).toBe("true");
    for (const name of ["フィード", "times-alice", "times-bob"]) expect(folded(name)).toBe(false);
    cleanup();
    timesWorld(false);
    for (const name of ["フィード", "times-bob"]) expect(folded(name)).toBe(false);
  });
});
