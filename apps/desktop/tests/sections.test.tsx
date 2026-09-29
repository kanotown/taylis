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
  store.replaceSidebar([{ id: "s1", name: "研究", emoji: "🔬", collapsed: true, position: 0, channel_ids: [papers.id, lab.id] }]);
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
});
