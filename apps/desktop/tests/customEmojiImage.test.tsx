// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomEmojiOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { CustomEmojiImage, customEmojiBoxStyle } from "../src/ui/customEmoji";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("custom emoji image (M12f)", () => {
  it("shows the new emoji when the same component is reused for another one", async () => {
    let next = 0;
    URL.createObjectURL = vi.fn(() => `blob:image-${++next}`);
    const controller = { api: { fetchBlob: vi.fn(async (path: string) => new Blob([path])) } } as unknown as AppController;
    const emoji = (id: string, name: string): CustomEmojiOut => ({ id, name, content_type: "image/png", width: 32, height: 32, created_by: "u", created_at: "" });
    const view = render(<CustomEmojiImage controller={controller} emoji={emoji("e-reuse-1", "parrot")} />);
    await waitFor(() => expect(screen.getByRole("img").getAttribute("src")).toBe("blob:image-1"));
    view.rerender(<CustomEmojiImage controller={controller} emoji={emoji("e-reuse-2", "cat")} />);
    expect(screen.queryByRole("img")).toBeNull(); // never the previous picture under the new name
    await waitFor(() => expect(screen.getByRole("img").getAttribute("alt")).toBe(":cat:"));
    expect(screen.getByRole("img").getAttribute("src")).toBe("blob:image-2");
  });
});

describe("custom emoji box (2026-10-04: no height change or jump when the image loads)", () => {
  const emoji = (id: string, width = 32, height = 32): CustomEmojiOut => ({ id, name: `e_${id}`, content_type: "image/png", width, height, created_by: "u", created_at: "" });

  it("takes the same fixed square while loading and once loaded, a wide image fitted into it", async () => {
    let release: (blob: Blob) => void = () => {};
    URL.createObjectURL = vi.fn(() => "blob:wide");
    const controller = { api: { fetchBlob: vi.fn(() => new Promise<Blob>((resolve) => { release = resolve; })) } } as unknown as AppController;
    const { container } = render(<CustomEmojiImage controller={controller} emoji={emoji("e-box-wide", 128, 32)} size={16} />);
    const placeholder = container.querySelector<HTMLElement>("[data-custom-emoji]")!;
    expect(placeholder.tagName).toBe("SPAN");
    expect([placeholder.style.width, placeholder.style.height]).toEqual(["16px", "16px"]);
    release(new Blob(["x"]));
    const img = await screen.findByRole("img");
    expect([img.getAttribute("width"), img.getAttribute("height")]).toEqual(["16", "16"]);
    expect([img.style.width, img.style.height, img.style.objectFit]).toEqual(["16px", "16px", "contain"]);
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
