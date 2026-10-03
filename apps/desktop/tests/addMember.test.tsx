// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { AddMemberDialog } from "../src/ui/Dialogs";
import { FakeServer } from "./fakeServer";

afterEach(cleanup);
function fixture() {
  const server = new FakeServer();
  const store = new Store();
  const me = server.addUser("me");
  const member = server.addUser("existing");
  const other = server.addUser("new-user");
  store.setMe({ ...me, email: null, must_change_password: false, notify_keywords: [], presence_hidden: false, notification_default: "mentions", notify_reactions: false, notify_tasks: true, has_password: true });
  [me, member, other].forEach((user) => store.upsertUser(user));
  const members = vi.fn();
  const addMembers = vi.fn(async () => []);
  const controller = { store, api: { members, addMembers }, describe: () => "ネットワークに接続できません" } as unknown as AppController;
  return { controller, members, addMembers, member, other };
}

it("does not offer users after a failed load and retries before allowing additions", async () => {
  const f = fixture();
  f.members.mockRejectedValueOnce(new Error("offline")).mockResolvedValue([{ user_id: f.member.id }]);
  render(<AddMemberDialog controller={f.controller} channelId="c" onClose={() => {}} />);
  await screen.findByRole("alert");
  expect(screen.queryByText(f.other.display_name)).toBeNull();
  expect((screen.getByRole("button", { name: "追加" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "再試行" }));
  const other = await screen.findByText(f.other.display_name);
  expect(screen.queryByText(f.member.display_name)).toBeNull();
  fireEvent.click(other);
  fireEvent.click(screen.getByRole("button", { name: "追加" }));
  // M88: everyone chosen in one request (one 「追加しました」 line).
  expect(f.addMembers).toHaveBeenCalledWith("c", [f.other.id]);
});

it("ignores an old channel response after switching channels", async () => {
  const f = fixture();
  let resolve!: (list: unknown[]) => void;
  f.members.mockImplementationOnce(() => new Promise((done) => { resolve = done; })).mockResolvedValue([{ user_id: f.other.id }]);
  const view = render(<AddMemberDialog controller={f.controller} channelId="old" onClose={() => {}} />);
  view.rerender(<AddMemberDialog controller={f.controller} channelId="new" onClose={() => {}} />);
  await screen.findByText(f.member.display_name);
  await act(async () => resolve([]));
  expect(screen.queryByText(f.other.display_name)).toBeNull();
});
