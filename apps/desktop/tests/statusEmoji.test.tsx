// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomEmojiOut, UserPublic } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { EmojiText, StatusEmoji, StatusGlyph, statusCustomEmoji } from "../src/ui/UserPopover";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const hanpen: CustomEmojiOut = { id: "e-status-1", name: "hanpen", content_type: "image/png", width: 32, height: 32, created_by: "u", created_at: "" };

function controllerWith(status: { emoji: string; text: string }): AppController {
  URL.createObjectURL = vi.fn(() => "blob:hanpen");
  const user = { id: "u2", username: "toru", display_name: "Toru", role: "member", status_emoji: status.emoji, status_text: status.text } as unknown as UserPublic;
  return {
    api: { fetchBlob: vi.fn(async () => new Blob(["x"])) },
    store: { users: new Map([["u2", user]]), customEmoji: new Map([["hanpen", hanpen]]) },
  } as unknown as AppController;
}

describe("a custom emoji in a status (2026-10-02: it showed as its :name:)", () => {
  it("finds the custom emoji only for an exact :name: this workspace has", () => {
    const controller = controllerWith({ emoji: ":hanpen:", text: "" });
    expect(statusCustomEmoji(controller, ":hanpen:")).toBe(hanpen);
    expect(statusCustomEmoji(controller, " :hanpen: ")).toBe(hanpen);
    expect(statusCustomEmoji(controller, "🍢")).toBeUndefined();
    expect(statusCustomEmoji(controller, ":gone:")).toBeUndefined();
  });

  it("draws the status emoji next to a name as the image", async () => {
    const controller = controllerWith({ emoji: ":hanpen:", text: "会議中" });
    const view = render(<StatusEmoji controller={controller} userId="u2" />);
    await waitFor(() => expect(screen.getByRole("img").getAttribute("src")).toBe("blob:hanpen"));
    expect(view.container.textContent).not.toContain(":hanpen:");
    expect(view.container.firstElementChild?.getAttribute("aria-label")).toBe("会議中");
  });

  it("keeps a standard emoji and an unknown name as text", () => {
    const controller = controllerWith({ emoji: "🍢", text: "" });
    const standard = render(<StatusGlyph controller={controller} emoji="🍢" />);
    expect(standard.container.textContent).toBe("🍢");
    const unknown = render(<StatusGlyph controller={controller} emoji=":gone:" />);
    expect(unknown.container.textContent).toBe(":gone:");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("draws it as the image inside a line (a DM's subtitle, the directory)", async () => {
    const controller = controllerWith({ emoji: ":hanpen:", text: "会議中" });
    const view = render(<EmojiText controller={controller} text="研究室 · :hanpen: 会議中 :gone:" />);
    await waitFor(() => expect(screen.getByRole("img").getAttribute("alt")).toBe(":hanpen:"));
    expect(view.container.textContent).toBe("研究室 ·  会議中 :gone:");
  });
});
