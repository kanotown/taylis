// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TemplateOut } from "../src/api/types";
import { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { TemplatesSettings } from "../src/ui/TemplatesSettings";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const template = (patch: Partial<TemplateOut> & Pick<TemplateOut, "id" | "name">): TemplateOut => ({
  body: `${patch.name}\n- `,
  scope: "workspace",
  owner_id: null,
  suggest_in: "any",
  position: 0,
  created_at: "",
  updated_at: "",
  ...patch,
});

function world(isAdmin: boolean) {
  const store = new Store();
  store.replaceTemplates([
    template({ id: "w1", name: "日報", suggest_in: "times" }),
    template({ id: "u1", name: "メモ", scope: "user", owner_id: "me" }),
    template({ id: "u2", name: "議事録", scope: "user", owner_id: "me" }),
  ]);
  const controller = {
    store,
    isAdmin,
    can: () => isAdmin,
    setError: vi.fn(),
    createTemplate: vi.fn(async () => template({ id: "new", name: "x" })),
    updateTemplate: vi.fn(async () => template({ id: "u1", name: "x" })),
    deleteTemplate: vi.fn(async () => true),
    moveTemplate: vi.fn(async () => true),
  };
  render(<TemplatesSettings controller={controller as unknown as AppController} />);
  return controller;
}

describe("settings → テンプレート (M30)", () => {
  it("shows the workspace's read-only to a member; mine can be added, moved and deleted", async () => {
    const controller = world(false);
    const shared = screen.getByLabelText("共通のテンプレート");
    expect(shared.textContent).toContain("/日報");
    expect(within(shared).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getAllByText("追加")).toHaveLength(1); // no 「追加」 for the workspace's
    await act(async () => { fireEvent.click(screen.getByLabelText("議事録 を上へ")); });
    expect(controller.moveTemplate).toHaveBeenCalledWith([expect.objectContaining({ id: "u1" }), expect.objectContaining({ id: "u2" })], "u2", -1);
    fireEvent.click(screen.getByText("追加"));
    fireEvent.change(screen.getByPlaceholderText("例：日報"), { target: { value: "週報" } });
    fireEvent.change(screen.getByRole("textbox", { name: /本文/ }), { target: { value: "週報 {week}" } });
    fireEvent.click(screen.getByLabelText("times で先に出す"));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "追加" })); });
    expect(controller.createTemplate).toHaveBeenCalledWith({ name: "週報", body: "週報 {week}", suggest_in: "times", scope: "user" });
    fireEvent.click(screen.getByLabelText("メモ を削除"));
    await act(async () => { fireEvent.click(screen.getByText("削除する")); });
    expect(controller.deleteTemplate).toHaveBeenCalledWith("u1");
  });

  it("lets an admin edit the workspace's", async () => {
    const controller = world(true);
    fireEvent.click(screen.getByLabelText("日報 を編集"));
    fireEvent.change(screen.getByRole("textbox", { name: /本文/ }), { target: { value: "**日報 {date}**" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "保存" })); });
    expect(controller.updateTemplate).toHaveBeenCalledWith("w1", { name: "日報", body: "**日報 {date}**", suggest_in: "times" });
  });
});

describe("moving a template (AppController.moveTemplate)", () => {
  it("gives every row out of place its index, so rows that shared a position get an order", async () => {
    const rows = [template({ id: "a", name: "a" }), template({ id: "b", name: "b" }), template({ id: "c", name: "c" })];
    const updateTemplate = vi.fn(async () => template({ id: "x", name: "x" }));
    const fake = { updateTemplate } as unknown as AppController;
    expect(await AppController.prototype.moveTemplate.call(fake, rows, "c", -1)).toBe(true);
    expect(updateTemplate.mock.calls).toEqual([["c", { position: 1 }], ["b", { position: 2 }]]);
    expect(await AppController.prototype.moveTemplate.call(fake, rows, "a", -1)).toBe(false);
  });
});
