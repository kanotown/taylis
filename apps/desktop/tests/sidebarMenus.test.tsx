// @vitest-environment jsdom
/**
 * 2026-10-12 (docs/MOBILE_UI.md §18.6, §18.7): the sidebar's context menus. Right-click on its empty space: new section,
 * create / browse channels, new DM, mark all read, the sidebar's display. Right-click (or Shift+F10 / the context-menu
 * key) on a conversation row: read / unread, star, section, notifications, mute, copy link, details, rename, leave or
 * close, archive, with the channel's owners' and managers' items only for them.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import type { ChannelState } from "../src/sync/types";
import { Sidebar } from "../src/ui/Sidebar";
import { ChannelContextMenu } from "../src/ui/SidebarMenus";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ME = "u-me";

function channel(over: Partial<ChannelState> = {}): ChannelState {
  return {
    id: "c1", name: "general", type: "public", topic: null, archived: false, isMember: true, syncedSeq: 0, lastSeq: 5, lastReadSeq: 5,
    unreadCount: 0, mentionCount: 0, firstUnreadAt: null, notificationLevel: null, mutedUntil: null, muted: false,
    membership: { role: "member" }, dm_user_ids: null, times_owner_id: null,
    ...over,
  } as unknown as ChannelState;
}

function setup(rights: string[] = [], guest = false) {
  const store = new Store();
  store.setMe({ id: ME, username: "me", display_name: "わたし", role: "member", nav_items: null, desktop_places: null } as unknown as UserMe);
  store.replaceClosedDms([]);
  const engine = { markRead: vi.fn(), markUnread: vi.fn(), status: "online" };
  const controller = {
    store, engine, me: store.me, isGuest: guest, isAdmin: false, version: 0, subscribe: () => () => {},
    can: (capability: string) => rights.includes(capability),
    toggleFavorite: vi.fn(async () => {}), moveToSection: vi.fn(async () => true), setNotification: vi.fn(async () => {}),
    copyChannelLink: vi.fn(async () => {}), closeDm: vi.fn(async () => true), toggleDmPin: vi.fn(async () => {}), createSection: vi.fn(async () => true),
  };
  return { store, engine, controller, ctl: controller as unknown as AppController };
}

const items = (menu: HTMLElement) => within(menu).getAllByRole("menuitem").map((item) => item.textContent?.replace("›", "").trim());

describe("a conversation row's menu", () => {
  const open = async (row: ChannelState, rights: string[] = [], onAction = vi.fn()) => {
    const w = setup(rights);
    render(
      <ChannelContextMenu controller={w.ctl} channel={row} onAction={onAction}>
        <button type="button">row</button>
      </ChannelContextMenu>,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "row" }));
    await act(async () => {});
    return { ...w, menu: screen.getByRole("menu"), onAction };
  };

  it("a channel I own: everything, rename and archive included", async () => {
    const { menu } = await open(channel({ membership: { role: "owner" } as never, unreadCount: 2, lastReadSeq: 3 }));
    expect(items(menu)).toEqual([
      "既読にする", "お気に入りに追加", "セクションに移動", "通知", "ミュート", "リンクをコピー", "チャンネル情報", "名前を変更", "チャンネルを退出", "アーカイブ",
    ]);
  });

  it("a channel I am only a member of: no rename or archive; a manager (channels.manage) gets them", async () => {
    let w = await open(channel());
    expect(items(w.menu)).not.toContain("名前を変更");
    expect(items(w.menu)).not.toContain("アーカイブ");
    // Nothing unread: 未読にする instead.
    expect(items(w.menu)[0]).toBe("未読にする");
    cleanup();
    w = await open(channel(), ["channels.manage"]);
    expect(items(w.menu)).toContain("名前を変更");
    expect(items(w.menu)).toContain("アーカイブ");
    cleanup();
    // Archived: no rename / archive.
    w = await open(channel({ archived: true, membership: { role: "owner" } as never }));
    expect(items(w.menu)).not.toContain("アーカイブ");
  });

  it("a DM: 会話を閉じる, no leave, rename or archive, and 会話の情報", async () => {
    const { menu } = await open(channel({ id: "d1", type: "dm", name: null, dm_user_ids: [ME, "u-b"] }), ["channels.manage"]);
    const list = items(menu);
    expect(list).toContain("会話を閉じる");
    expect(list).toContain("会話の情報");
    for (const missing of ["チャンネルを退出", "名前を変更", "アーカイブ"]) expect(list).not.toContain(missing);
  });

  it("each item does its thing: read, unread, copy link, details, rename, leave, archive", async () => {
    let w = await open(channel({ unreadCount: 2, lastReadSeq: 3, membership: { role: "owner" } as never }));
    fireEvent.click(within(w.menu).getByRole("menuitem", { name: "既読にする" }));
    expect(w.engine.markRead).toHaveBeenCalledWith("c1", 5, { force: true });
    for (const [name, action] of [["チャンネル情報", "details"], ["名前を変更", "rename"], ["チャンネルを退出", "leave"], ["アーカイブ", "archive"]] as const) {
      fireEvent.contextMenu(screen.getByRole("button", { name: "row" }));
      await act(async () => {});
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name }));
      expect(w.onAction).toHaveBeenLastCalledWith("c1", action);
    }
    fireEvent.contextMenu(screen.getByRole("button", { name: "row" }));
    await act(async () => {});
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "リンクをコピー" }));
    expect(w.controller.copyChannelLink).toHaveBeenCalledWith("c1");
    cleanup();
    w = await open(channel());
    fireEvent.click(within(w.menu).getByRole("menuitem", { name: "未読にする" }));
    expect(w.engine.markUnread).toHaveBeenCalledWith("c1", 5);
  });

  it("通知 ›: 既定 / すべて / メンションのみ / 通知しない, the mute kept", async () => {
    const mutedUntil = new Date(Date.now() + 3_600_000).toISOString();
    const w = await open(channel({ notificationLevel: "all", mutedUntil }));
    fireEvent.click(within(w.menu).getByRole("menuitem", { name: /通知/ }));
    const sub = (await screen.findAllByRole("menu")).at(-1)!;
    const radios = within(sub).getAllByRole("menuitemradio");
    expect(radios.map((radio) => radio.textContent)).toEqual(["既定（メンションと DM のみ）", "すべてのメッセージ", "メンションのみ", "通知しない"]);
    expect(radios[1]!.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(radios[2]!);
    expect(w.controller.setNotification).toHaveBeenCalledWith("c1", "mentions", mutedUntil);
  });

  it("without the main screen's dialogs (the home list): no details / rename / leave / archive", async () => {
    const w = setup();
    render(
      <ChannelContextMenu controller={w.ctl} channel={channel({ membership: { role: "owner" } as never })}>
        <button type="button">row</button>
      </ChannelContextMenu>,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: "row" }));
    await act(async () => {});
    const list = items(screen.getByRole("menu"));
    for (const missing of ["チャンネル情報", "名前を変更", "チャンネルを退出", "アーカイブ"]) expect(list).not.toContain(missing);
    expect(list).toContain("リンクをコピー");
  });

  it("Shift+F10 and the context-menu key open it from the keyboard", async () => {
    const w = setup();
    render(
      <ChannelContextMenu controller={w.ctl} channel={channel()}>
        <button type="button">row</button>
      </ChannelContextMenu>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "row" }), { key: "F10", shiftKey: true });
    await act(async () => {});
    expect(screen.getByRole("menu")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await act(async () => {});
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(screen.getByRole("button", { name: "row" }), { key: "ContextMenu" });
    await act(async () => {});
    expect(screen.getByRole("menu")).toBeTruthy();
    // A plain F10 does nothing.
    cleanup();
    render(
      <ChannelContextMenu controller={w.ctl} channel={channel()}>
        <button type="button">row</button>
      </ChannelContextMenu>,
    );
    fireEvent.keyDown(screen.getByRole("button", { name: "row" }), { key: "F10" });
    await act(async () => {});
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("the sidebar's empty space", () => {
  const draw = (guest = false) => {
    const w = setup([], guest);
    const handlers = { onNewDm: vi.fn(), onNewChannel: vi.fn(), onBrowse: vi.fn(), onReadAll: vi.fn(), onArrangePlaces: vi.fn() };
    w.store.upsertChannel(channel() as never, { isMember: true, syncedSeq: 0, oldestLoadedSeq: 0 });
    render(<Sidebar controller={w.ctl} channels={[...w.store.channels.values()]} currentId={null} unreadOnly={false} onToggleUnreadOnly={() => {}} onOpen={() => {}} {...handlers} />);
    return { ...w, handlers };
  };
  const list = () => screen.getByRole("navigation", { name: "チャンネルとDM" });

  it("new section, create / browse channels, new DM, mark all read, the sidebar's display", async () => {
    const { handlers } = draw();
    fireEvent.contextMenu(list());
    await act(async () => {});
    const menu = screen.getByRole("menu");
    expect(items(menu)).toEqual(["新しいセクション", "チャンネルを作成", "チャンネルを探す", "新しい DM", "すべて既読にする", "サイドバーの表示（並べ替え・項目の配置）…"]);
    fireEvent.keyDown(menu, { key: "Escape" });
    await act(async () => {});
    for (const [name, handler] of [
      ["チャンネルを作成", "onNewChannel"], ["チャンネルを探す", "onBrowse"], ["新しい DM", "onNewDm"], ["すべて既読にする", "onReadAll"], ["サイドバーの表示（並べ替え・項目の配置）…", "onArrangePlaces"],
    ] as const) {
      fireEvent.contextMenu(list());
      await act(async () => {});
      fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name }));
      expect(handlers[handler], name).toHaveBeenCalledTimes(1);
    }
    fireEvent.contextMenu(list());
    await act(async () => {});
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: "新しいセクション" }));
    await act(async () => {});
    expect(screen.getByRole("dialog", { name: "新しいセクション" })).toBeTruthy();
  });

  it("a guest: no create or browse", async () => {
    draw(true);
    fireEvent.contextMenu(list());
    await act(async () => {});
    expect(items(screen.getByRole("menu"))).toEqual(["新しいセクション", "新しい DM", "すべて既読にする", "サイドバーの表示（並べ替え・項目の配置）…"]);
  });

  it("a row's own menu wins over it", async () => {
    draw();
    fireEvent.contextMenu(within(list()).getByRole("button", { name: "general" }));
    await act(async () => {});
    const menus = screen.getAllByRole("menu");
    expect(menus).toHaveLength(1);
    expect(items(menus[0]!)).toContain("お気に入りに追加");
    expect(items(menus[0]!)).not.toContain("新しいセクション");
  });
});
