// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomEmojiOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { reactionText } from "../src/ui/customEmoji";
import { EmojiText } from "../src/ui/UserPopover";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const yay: CustomEmojiOut = { id: "e-yay", name: "ckw-yay", kind: "image", content_type: "image/png", width: 96, height: 32, label: "ちくわ わーい", keywords: [], position: 0, created_by: "u", created_at: "" };
const ok: CustomEmojiOut = { id: "e-ok", name: "ok-text", kind: "text", content_type: "", width: 0, height: 0, label: "了解", color: "blue", keywords: [], position: 0, created_by: "u", created_at: "" };
const plain: CustomEmojiOut = { id: "e-plain", name: "plain", kind: "image", content_type: "image/png", width: 32, height: 32, keywords: [], position: 0, created_by: "u", created_at: "" };

function controller(): AppController {
  URL.createObjectURL = vi.fn(() => "blob:yay");
  return {
    api: { fetchBlob: vi.fn(async () => new Blob(["x"])) },
    store: { customEmoji: new Map([["ckw-yay", yay], ["ok-text", ok], ["plain", plain]]) },
  } as unknown as AppController;
}

describe("emoji in one-line excerpts (2026-10-05: the activity showed :ckw-yay:)", () => {
  it("draws a pack emoji as its image in a reserved wide box, a text emoji as its pill, a shortcode as its glyph", async () => {
    const view = render(<EmojiText controller={controller()} text="「やった :ckw-yay: :ok-text: :+1: :gone:」" size={16} />);
    // The box is there before the image loads (no jump), as wide as the emoji's aspect.
    const box = view.container.querySelector('[data-custom-emoji="ckw-yay"]') as HTMLElement;
    expect(box.style.width).toBe("48px");
    expect(box.style.height).toBe("16px");
    await waitFor(() => expect(screen.getByAltText(":ckw-yay:").getAttribute("src")).toBe("blob:yay"));
    expect(screen.getByRole("img", { name: "了解" }).textContent).toBe("了解");
    expect(view.container.textContent).toBe("「やった  了解 👍 :gone:」");
  });
});

describe("a reaction as notification text", () => {
  it("names a workspace emoji by its label, keeps the rest", () => {
    const custom = controller().store.customEmoji;
    expect(reactionText(":ckw-yay:", custom)).toBe("【ちくわ わーい】");
    expect(reactionText(":ok-text:", custom)).toBe("【了解】");
    expect(reactionText(":plain:", custom)).toBe(":plain:");
    expect(reactionText(":gone:", custom)).toBe(":gone:");
    expect(reactionText("👍", custom)).toBe("👍");
  });
});
