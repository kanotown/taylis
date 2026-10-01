// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomEmojiOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { EmojiPicker } from "../src/ui/EmojiPicker";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("the picker's recent row (testers, 2026-09-29: 「:hanpen:」 as text, wider than its cell)", () => {
  it("shows a recent custom emoji as its image and leaves out names that are no emoji", async () => {
    URL.createObjectURL = vi.fn(() => "blob:hanpen");
    const controller = { api: { fetchBlob: vi.fn(async () => new Blob(["x"])) } } as unknown as AppController;
    const hanpen: CustomEmojiOut = { id: "e-recent-1", name: "hanpen", content_type: "image/png", width: 32, height: 32, created_by: "u", created_at: "" };
    render(<EmojiPicker onPick={() => {}} recent={["👍", ":hanpen:", ":gone:"]} custom={[hanpen]} controller={controller} />);
    const row = screen.getByText("最近").nextElementSibling as HTMLElement;
    expect(row.querySelectorAll("button")).toHaveLength(2); // 👍 and :hanpen:, not :gone:
    expect(row.textContent).not.toContain(":gone:");
    await waitFor(() => expect(row.querySelector("img")?.getAttribute("src")).toBe("blob:hanpen"));
    expect(row.textContent).not.toContain(":hanpen:");
  });

  it("shows each recent emoji once (a repeat in the stored list would be a repeated key)", () => {
    const controller = { api: { fetchBlob: vi.fn(async () => new Blob(["x"])) } } as unknown as AppController;
    const hanpen: CustomEmojiOut = { id: "e-recent-2", name: "hanpen", content_type: "image/png", width: 32, height: 32, created_by: "u", created_at: "" };
    render(<EmojiPicker onPick={() => {}} recent={["👍", ":hanpen:", "👍", "", ":hanpen:"]} custom={[hanpen]} controller={controller} />);
    const row = screen.getByText("最近").nextElementSibling as HTMLElement;
    expect(row.querySelectorAll("button")).toHaveLength(2);
  });
});
