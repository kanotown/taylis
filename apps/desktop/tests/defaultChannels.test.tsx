// @vitest-environment jsdom
/** M90 (docs/MEMBERSHIP.md §6): 「既定のチャンネル」 in Administration → 設定, and the summarized join line. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AdminWorkspaceSettingsOut, ChannelOut, DefaultChannelsApplyOut, WorkspaceSettingsUpdate } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { systemMessageText } from "../src/ui/systemMessage";
import { WorkspaceSettingsTab } from "../src/ui/WorkspaceSettingsTab";

afterEach(cleanup);

const channel = (id: string, name: string, extra: Partial<ChannelOut> = {}) => ({ id, name, type: "public", archived: false, membership: null, ...extra }) as ChannelOut;

const BASE: AdminWorkspaceSettingsOut = {
  show_membership_messages: true,
  preview_before_join: true,
  updated_at: null,
  updated_by: null,
  default_channel_ids: [],
  default_channels: [],
  default_channels_set: false,
  legacy_sso_default_channels: [],
};

function setup(row: AdminWorkspaceSettingsOut, extra: Record<string, unknown> = {}) {
  let current = row;
  const names: Record<string, string> = { a: "全体連絡", b: "談話スペース", c: "random" };
  const adminUpdateWorkspaceSettings = vi.fn(async (patch: WorkspaceSettingsUpdate) => {
    const ids = patch.default_channel_ids ?? current.default_channel_ids;
    current = { ...current, ...patch, default_channel_ids: ids, default_channels: ids.map((id) => ({ id, name: names[id] ?? id })), default_channels_set: true } as AdminWorkspaceSettingsOut;
    return current;
  });
  const api = {
    adminWorkspaceSettings: vi.fn(async () => current),
    adminUpdateWorkspaceSettings,
    channels: vi.fn(async () => [channel("a", "全体連絡"), channel("b", "談話スペース"), channel("c", "random"), channel("p", "secret", { type: "private" }), channel("z", "old", { archived: true })]),
    adminApplyDefaultChannels: vi.fn(),
    createChannel: vi.fn(),
    ...extra,
  };
  const setError = vi.fn();
  const controller = { api, store: new Store(), setError } as unknown as AppController;
  render(<WorkspaceSettingsTab controller={controller} />);
  return { api, setError };
}

describe("既定のチャンネル", () => {
  it("adds from the public channels, reorders and removes, saving the whole list each time", async () => {
    const { api } = setup({ ...BASE, default_channel_ids: ["a"], default_channels: [{ id: "a", name: "全体連絡" }], default_channels_set: true });
    const section = await screen.findByRole("region", { name: "既定のチャンネル" });
    expect(within(section).getByText("#全体連絡")).toBeTruthy();
    const picker = (await waitFor(() => {
      const select = within(section).getByRole("combobox", { name: "既定のチャンネルを追加" }) as HTMLSelectElement;
      expect(select.disabled).toBe(false);
      return select;
    })) as HTMLSelectElement;
    // Only open public channels that are not chosen yet.
    expect([...picker.options].map((o) => o.textContent)).toEqual(["公開チャンネルを追加…", "#random", "#談話スペース"]);
    await act(async () => { fireEvent.change(picker, { target: { value: "b" } }); });
    expect(api.adminUpdateWorkspaceSettings).toHaveBeenLastCalledWith({ default_channel_ids: ["a", "b"] });
    await act(async () => { fireEvent.click(within(section).getByRole("button", { name: "#談話スペース を上へ" })); });
    expect(api.adminUpdateWorkspaceSettings).toHaveBeenLastCalledWith({ default_channel_ids: ["b", "a"] });
    await act(async () => { fireEvent.click(within(section).getByRole("button", { name: "#全体連絡 を外す" })); });
    expect(api.adminUpdateWorkspaceSettings).toHaveBeenLastCalledWith({ default_channel_ids: ["b"] });
    expect(within(section).queryByRole("button", { name: "#全体連絡 を外す" })).toBeNull(); // back in the picker
  });

  it("puts the list back when the server refuses", async () => {
    const { setError } = setup({ ...BASE, default_channel_ids: ["a"], default_channels: [{ id: "a", name: "全体連絡" }], default_channels_set: true }, {
      adminUpdateWorkspaceSettings: vi.fn(async () => { throw new Error("default_channel_archived"); }),
    });
    const section = await screen.findByRole("region", { name: "既定のチャンネル" });
    await act(async () => { fireEvent.click(within(section).getByRole("button", { name: "#全体連絡 を外す" })); });
    expect(within(section).getByText("#全体連絡")).toBeTruthy();
    expect(setError).toHaveBeenCalled();
  });

  it("offers the two suggested channels, creating the missing one", async () => {
    const created = channel("n", "談話スペース");
    const { api } = setup(BASE, {
      channels: vi.fn(async () => [channel("a", "全体連絡")]),
      createChannel: vi.fn(async () => created),
    });
    const button = await screen.findByRole("button", { name: "「全体連絡」と「談話スペース」を既定にする" });
    await act(async () => { fireEvent.click(button); });
    expect(api.createChannel).toHaveBeenCalledTimes(1);
    expect(api.createChannel).toHaveBeenCalledWith("談話スペース", "public");
    expect(api.adminUpdateWorkspaceSettings).toHaveBeenCalledWith({ default_channel_ids: ["a", "n"] });
  });

  it("shows SSO_DEFAULT_CHANNELS while the list was never saved", async () => {
    setup({ ...BASE, legacy_sso_default_channels: ["general"] });
    expect(await screen.findByText(/SSO_DEFAULT_CHANNELS \(#general\)/)).toBeTruthy();
  });

  it("asks with the count before adding everyone, then reports", async () => {
    const counted: DefaultChannelsApplyOut = { dry_run: true, users: 3, memberships: 4, channels: [{ id: "a", name: "全体連絡", added: 3 }, { id: "b", name: "談話スペース", added: 1 }] };
    const adminApplyDefaultChannels = vi.fn(async (dryRun: boolean) => (dryRun ? counted : { ...counted, dry_run: false }));
    setup({ ...BASE, default_channel_ids: ["a", "b"], default_channels: [{ id: "a", name: "全体連絡" }, { id: "b", name: "談話スペース" }], default_channels_set: true }, { adminApplyDefaultChannels });
    const everyone = await screen.findByRole("button", { name: "今いる人も全員入れる" });
    await act(async () => { fireEvent.click(everyone); });
    expect(adminApplyDefaultChannels).toHaveBeenCalledWith(true);
    const ask = screen.getByRole("alertdialog", { name: "今いる人も全員入れる" });
    expect(within(ask).getByText(/3 人を既定のチャンネルに追加します \(のべ 4 件/)).toBeTruthy();
    expect(within(ask).getByText("#談話スペース: 1 人")).toBeTruthy();
    await act(async () => { fireEvent.click(within(ask).getByRole("button", { name: "追加する" })); });
    expect(adminApplyDefaultChannels).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("status").textContent).toBe("3 人を既定のチャンネルに追加しました。");
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("says so when everyone is already in, without asking", async () => {
    const adminApplyDefaultChannels = vi.fn(async () => ({ dry_run: true, users: 0, memberships: 0, channels: [] }));
    setup({ ...BASE, default_channel_ids: ["a"], default_channels: [{ id: "a", name: "全体連絡" }], default_channels_set: true }, { adminApplyDefaultChannels });
    const everyone = await screen.findByRole("button", { name: "今いる人も全員入れる" });
    await act(async () => { fireEvent.click(everyone); });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("全員がすでに既定のチャンネルに入っています。");
  });

  it("says a server before M90 does not support it (no fields)", async () => {
    const { api } = setup({ show_membership_messages: true, preview_before_join: true, updated_at: null, updated_by: null } as AdminWorkspaceSettingsOut);
    expect(await screen.findByText("このサーバは既定のチャンネルに対応していません。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "今いる人も全員入れる" })).toBeNull();
    expect(api.channels).not.toHaveBeenCalled();
    // The M88 switches still work.
    expect(screen.getByRole("switch", { name: "参加・退出の表示" })).toBeTruthy();
  });
});

describe("a join line naming many people", () => {
  it("lists ten names and 「ほか N 人」 like the server's body", () => {
    const ids = Array.from({ length: 13 }, (_, i) => `u${i}`);
    const text = systemMessageText({ body: "fallback", system_event: { kind: "members_added", actor_id: "admin", user_ids: ids } }, (id) => (id === "admin" ? "Admin" : id.toUpperCase()));
    expect(text).toBe("Admin が U0、U1、U2、U3、U4、U5、U6、U7、U8、U9 ほか 3 人 を追加しました");
  });
});
