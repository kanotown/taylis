// @vitest-environment jsdom
/**
 * A link card (M11g; 2026-11-16, a hostile-server review): it opens the link the message has, never the `url` of the
 * server's answer, and draws its picture only from https.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LinkPreviewOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { LinkPreviewCard } from "../src/ui/LinkPreviewCard";

const openUrl = vi.fn(async (_url: string) => {});
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: (url: string) => openUrl(url) }));

afterEach(() => {
  cleanup();
  openUrl.mockClear();
  delete (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"];
});

const MESSAGE_LINK = "https://example.com/paper";

function card(preview: Partial<LinkPreviewOut>) {
  const answer = { status: "ok", url: MESSAGE_LINK, title: "論文", site_name: null, description: null, image_url: null, ...preview } as unknown as LinkPreviewOut;
  const controller = {
    linkPreviews: new Map([[MESSAGE_LINK, answer]]),
    linkPreview: vi.fn(),
    subscribeLinkPreviews: () => () => {},
  } as unknown as AppController;
  render(<LinkPreviewCard controller={controller} url={MESSAGE_LINK} />);
  return document.querySelector("[data-link-card] a") as HTMLAnchorElement;
}

describe("link cards", () => {
  it("open the message's own link, whatever URL the server's answer names", async () => {
    const link = card({ url: "https://evil.example/login" });
    expect(link.getAttribute("href")).toBe(MESSAGE_LINK);
    expect(link.textContent).toContain("example.com"); // the host shown is the link's
    expect(link.textContent).not.toContain("evil.example");
    (window as unknown as Record<string, unknown>)["__TAURI_INTERNALS__"] = {};
    fireEvent.click(link);
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith(MESSAGE_LINK));
  });

  it("draw the picture only from https", () => {
    expect(card({ image_url: "https://cdn.example.com/og.png" }).querySelector("img")?.getAttribute("src")).toBe("https://cdn.example.com/og.png");
    cleanup();
    for (const image of ["http://cdn.example.com/og.png", "data:image/svg+xml,<svg/>", "blob:https://x/1", "javascript:alert(1)", "//cdn.example.com/og.png"]) {
      expect(card({ image_url: image }).querySelector("img"), image).toBeNull();
      cleanup();
    }
  });
});
