// @vitest-environment jsdom
/** LAB.md 「肩書と名簿」: the profile card and the member directory show the roster label as the title, once. */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { LabProfileOut, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { DirectoryDialog } from "../src/ui/DirectoryDialog";
import { UserPopover } from "../src/ui/UserPopover";

afterEach(cleanup);

function controller(): AppController {
  const store = new Store();
  const person = (id: string, username: string, display_name: string, title: string | null) =>
    ({ id, username, display_name, title, role: "member", deactivated_at: null, created_at: "", updated_at: "" }) as unknown as UserPublic;
  store.users.set("u-kano", person("u-kano", "kano", "加納", "教授"));
  store.users.set("u-ebi", person("u-ebi", "ebi", "海老", "研究室長"));
  store.users.set("u-sato", person("u-sato", "sato", "佐藤", "秘書"));
  store.roster.set("u-kano", { user_id: "u-kano", affiliation: "faculty", rank: "professor" } as LabProfileOut);
  store.roster.set("u-ebi", { user_id: "u-ebi", affiliation: "student", grade: "M2", supervisor_id: "u-kano", research_topic: "音声合成" } as LabProfileOut);
  return { store, version: 0, subscribe: () => () => {}, openDmWith: vi.fn() } as unknown as AppController;
}

it("the profile card: 「@ebi · M2 · 研究室長」, and the roster block keeps the supervisor and the topic without the grade again", async () => {
  render(<UserPopover controller={controller()} userId="u-ebi">海老</UserPopover>);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "海老 のプロフィール" })); });
  expect(screen.getByText("@ebi · M2 · 研究室長")).toBeTruthy();
  expect(screen.getByText("指導教員：加納")).toBeTruthy();
  expect(screen.getByText("研究テーマ：音声合成")).toBeTruthy();
  expect(screen.queryByText(/M2 · 指導教員/)).toBeNull();
});

it("the profile card: a title equal to the rank shows once", async () => {
  render(<UserPopover controller={controller()} userId="u-kano">加納</UserPopover>);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "加納 のプロフィール" })); });
  expect(screen.getByText("@kano · 教授")).toBeTruthy();
});

it("the directory: the badge is the roster label, the line under the name adds only the rest", () => {
  render(<DirectoryDialog controller={controller()} onClose={() => {}} onOpen={() => {}} />);
  const row = (name: string) => screen.getByText(name, { selector: "span.font-medium" }).closest("li")!;
  expect(row("海老").textContent).toContain("M2");
  expect(row("海老").textContent).toContain("研究室長 · 音声合成");
  expect(row("加納").textContent).not.toContain("教授 · ");
  expect(row("加納").textContent?.match(/教授/g)).toHaveLength(1);
  expect(row("佐藤").textContent).toContain("秘書");
});
