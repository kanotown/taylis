// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomEmojiOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { CustomEmojiImage, customEmojiAspect, customEmojiBoxStyle } from "../src/ui/customEmoji";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("custom emoji image (M12f)", () => {
  it("shows the new emoji when the same component is reused for another one", async () => {
    let next = 0;
    URL.createObjectURL = vi.fn(() => `blob:image-${++next}`);
    const controller = { api: { fetchBlob: vi.fn(async (path: string) => new Blob([path])) } } as unknown as AppController;
    const emoji = (id: string, name: string): CustomEmojiOut => ({ id, name, kind: "image", content_type: "image/png", width: 32, height: 32, keywords: [], position: 0, created_by: "u", created_at: "" });
    const view = render(<CustomEmojiImage controller={controller} emoji={emoji("e-reuse-1", "parrot")} />);
    await waitFor(() => expect(screen.getByRole("img").getAttribute("src")).toBe("blob:image-1"));
    view.rerender(<CustomEmojiImage controller={controller} emoji={emoji("e-reuse-2", "cat")} />);
    expect(screen.queryByRole("img")).toBeNull(); // never the previous picture under the new name
    await waitFor(() => expect(screen.getByRole("img").getAttribute("alt")).toBe(":cat:"));
    expect(screen.getByRole("img").getAttribute("src")).toBe("blob:image-2");
  });
});

describe("custom emoji box (2026-10-04: no height change or jump when the image loads)", () => {
  const emoji = (id: string, width = 32, height = 32): CustomEmojiOut => ({ id, name: `e_${id}`, kind: "image", content_type: "image/png", width, height, keywords: [], position: 0, created_by: "u", created_at: "" });

  it("takes the same fixed square while loading and once loaded", async () => {
    let release: (blob: Blob) => void = () => {};
    URL.createObjectURL = vi.fn(() => "blob:square");
    const controller = { api: { fetchBlob: vi.fn(() => new Promise<Blob>((resolve) => { release = resolve; })) } } as unknown as AppController;
    const { container } = render(<CustomEmojiImage controller={controller} emoji={emoji("e-box-square", 64, 64)} size={16} />);
    const placeholder = container.querySelector<HTMLElement>("[data-custom-emoji]")!;
    expect([placeholder.style.width, placeholder.style.height]).toEqual(["16px", "16px"]);
    release(new Blob(["x"]));
    const img = await screen.findByRole("img");
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["16", "16"]);
    expect([img.style.width, img.style.height, img.style.objectFit]).toEqual(["16px", "16px", "contain"]);
  });

  it("M100: a wide image keeps its shape at the same height (at most 3:1), reserved before it loads", async () => {
    let release: (blob: Blob) => void = () => {};
    URL.createObjectURL = vi.fn(() => "blob:wide");
    const controller = { api: { fetchBlob: vi.fn(() => new Promise<Blob>((resolve) => { release = resolve; })) } } as unknown as AppController;
    const { container } = render(<CustomEmojiImage controller={controller} emoji={emoji("e-box-wide", 128, 32)} size={16} />);
    const placeholder = container.querySelector<HTMLElement>("[data-custom-emoji]")!;
    expect(placeholder.tagName).toBe("SPAN");
    expect([placeholder.style.width, placeholder.style.height]).toEqual(["48px", "16px"]); // 4:1 capped at 3:1
    release(new Blob(["x"]));
    const img = await screen.findByRole("img");
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["48", "16"]);
    expect([img.style.width, img.style.height, img.style.objectFit]).toEqual(["48px", "16px", "contain"]);
    // A picker cell keeps it square; a tall one is never narrower than square.
    expect(customEmojiAspect({ width: 96, height: 64 })).toBe(1.5);
    expect(customEmojiAspect({ width: 32, height: 64 })).toBe(1);
    expect(customEmojiBoxStyle("1.375em", true, 1.5).width).toBe("calc(1.375em * 1.5)");
  });

  it("an em size in text: the box follows the text, and counts as 1em for the line", () => {
    expect(customEmojiBoxStyle("1.375em", true)).toEqual({
      width: "1.375em", height: "1.375em", minWidth: "1.375em",
      marginTop: "calc((1em - 1.375em) / 2)", marginBottom: "calc((1em - 1.375em) / 2)", verticalAlign: "-0.12em",
    });
    // Outside text runs (cells, chips): no margins, centred where a standard emoji's middle is.
    expect(customEmojiBoxStyle(16, false)).toEqual({ width: "16px", height: "16px", minWidth: "16px", verticalAlign: "calc(0.38em - 16px / 2)" });
  });
});

describe("text emoji (M100)", () => {
  it("draws the label as a pill at the emoji's height, in its colour, with no image to load", () => {
    const controller = { api: { fetchBlob: vi.fn() } } as unknown as AppController;
    const text: CustomEmojiOut = { id: "t1", name: "kakunin", kind: "text", label: "確認しました", color: "green", content_type: "", width: 0, height: 0, keywords: [], position: 0, created_by: "u", created_at: "" };
    const { container } = render(<CustomEmojiImage controller={controller} emoji={text} size={16} />);
    const pill = container.querySelector<HTMLElement>("[data-text-emoji]")!;
    expect(pill.textContent).toBe("確認しました");
    expect(pill.style.height).toBe("16px");
    expect(pill.style.getPropertyValue("--te-bg")).toBe("#DDF4E4");
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("確認しました");
    expect((controller.api as unknown as { fetchBlob: ReturnType<typeof vi.fn> }).fetchBlob).not.toHaveBeenCalled();
  });
});
