// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CustomEmojiOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { CustomEmojiImage } from "../src/ui/customEmoji";

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
