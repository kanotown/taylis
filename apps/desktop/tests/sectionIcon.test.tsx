// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserMe } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { SectionDialog, SectionIcon } from "../src/ui/SectionDialog";
import { normalizeLetterInput, parseLetterIcon } from "../src/ui/sectionIcon";
import { FakeServer } from "./fakeServer";

interface Vectors {
  cases: { icon: string; letter: { text: string; color: string } | null }[];
}
const vectors = JSON.parse(readFileSync(resolve(process.cwd(), "../shared/section-icons.json"), "utf8")) as Vectors;

afterEach(() => cleanup());

function controller() {
  const server = new FakeServer();
  const me = server.addUser("alice");
  const store = new Store();
  store.setMe(me as unknown as UserMe);
  store.upsertUser(me);
  return { store, engine: null, me, isGuest: false, isAdmin: false } as unknown as AppController;
}

describe("section letter badges (M114, apps/shared/section-icons.json)", () => {
  it.each(vectors.cases)("parses $icon", ({ icon, letter }) => {
    expect(parseLetterIcon(icon)).toEqual(letter);
  });

  it("makes full-width letters and half-width kana their usual form", () => {
    expect(normalizeLetterInput("Ｍ")).toBe("M");
    expect(normalizeLetterInput(" ｱ ")).toBe("ア");
  });

  it("draws a badge, and falls back to the emoji for anything else", () => {
    const c = controller();
    const { container, rerender } = render(<SectionIcon controller={c} emoji="letter:修:purple" size={16} />);
    const badge = container.querySelector("[data-letter-icon]") as HTMLElement;
    expect(badge.textContent).toBe("修");
    expect(badge.style.width).toBe("16px");
    expect(badge.style.getPropertyValue("--te-bg")).toBe("#ECE2FC");
    rerender(<SectionIcon controller={c} emoji="🔬" size={16} />);
    expect(container.querySelector("[data-letter-icon]")).toBeNull();
    expect(container.textContent).toBe("🔬");
  });

  it("picks letters and a colour in the 「文字」 tab", async () => {
    const onSubmit = vi.fn(async () => true);
    render(<SectionDialog controller={controller()} title="新しいセクション" submitLabel="作成" pickChannels={false} onClose={() => {}} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByPlaceholderText(/研究、授業/), { target: { value: "修論指導" } });
    fireEvent.click(screen.getByRole("button", { name: "アイコンを選ぶ" }));
    fireEvent.click(await screen.findByRole("tab", { name: "文字" }));
    const input = screen.getByLabelText("アイコンの文字");
    const apply = screen.getByRole("button", { name: "このアイコンにする" }) as HTMLButtonElement;
    fireEvent.change(input, { target: { value: "MBA" } });
    expect(apply.disabled).toBe(true); // three letters
    fireEvent.change(input, { target: { value: "ｍ" } });
    fireEvent.click(screen.getByRole("radio", { name: "緑" }));
    fireEvent.click(apply);
    await act(async () => { fireEvent.click(screen.getByText("作成")); });
    expect(onSubmit).toHaveBeenCalledWith({ name: "修論指導", emoji: "letter:m:green", channelIds: [] });
  });

  it("opens on the 「文字」 tab with the badge being edited", async () => {
    render(<SectionDialog controller={controller()} title="セクションを編集" submitLabel="保存" pickChannels={false} initial={{ name: "卒論指導", emoji: "letter:B:orange" }} onClose={() => {}} onSubmit={vi.fn(async () => true)} />);
    fireEvent.click(screen.getByRole("button", { name: "アイコンを変更" }));
    expect(((await screen.findByLabelText("アイコンの文字")) as HTMLInputElement).value).toBe("B");
    expect(screen.getByRole("radio", { name: "オレンジ" }).getAttribute("aria-checked")).toBe("true");
  });

  it("draws the colour swatches as fixed squares (no line box under the badge, never stretched)", async () => {
    render(<SectionDialog controller={controller()} title="セクションを編集" submitLabel="保存" pickChannels={false} initial={{ name: "卒論指導", emoji: "letter:B:orange" }} onClose={() => {}} onSubmit={vi.fn(async () => true)} />);
    fireEvent.click(screen.getByRole("button", { name: "アイコンを変更" }));
    await screen.findByLabelText("アイコンの文字");
    for (const swatch of screen.getAllByRole("radio")) {
      expect(swatch.className).toMatch(/\bsize-7\b/);
      expect(swatch.className).toMatch(/\bshrink-0\b/);
      expect(swatch.className).toMatch(/\binline-flex\b/);
      const badge = swatch.querySelector("[data-letter-icon]") as HTMLElement;
      expect(badge.className).toMatch(/\bblock\b/);
      expect(badge.className).not.toMatch(/inline-block/);
    }
  });
});
