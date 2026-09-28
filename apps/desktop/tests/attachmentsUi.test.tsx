// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AttachmentOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { AttachmentList } from "../src/ui/Attachments";

const attachment: AttachmentOut = { id: "a", filename: "result.png", content_type: "image/png", size_bytes: 100, has_thumbnail: true, status: "attached", created_at: "", width: 10, height: 10 };
const controller = (fetchBlob: (...args: unknown[]) => Promise<Blob>) => ({ api: { fetchBlob } }) as unknown as AppController;
beforeEach(() => {
  vi.stubGlobal("URL", class extends URL {
    static override createObjectURL = vi.fn(() => "blob:photo");
    static override revokeObjectURL = vi.fn();
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("shows failed fetches and retries the authenticated thumbnail request", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new Blob());
  render(<AttachmentList attachments={[attachment]} controller={controller(fetch)} />);
  fireEvent.click(await screen.findByRole("button", { name: "再試行" }));
  expect(await screen.findByRole("img", { name: "result.png" })).toBeTruthy();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch).toHaveBeenLastCalledWith("/api/v1/attachments/a/thumbnail");
  fireEvent.error(screen.getByRole("img"));
  expect(screen.getByText("画像を読み込めませんでした")).toBeTruthy();
  cleanup();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:photo");
});

it("ignores late failures from an old session", async () => {
  let reject!: (error: Error) => void;
  const old = controller(() => new Promise<Blob>((_, fail) => { reject = fail; }));
  const view = render(<AttachmentList attachments={[attachment]} controller={old} />);
  view.rerender(<AttachmentList attachments={[attachment]} controller={controller(async () => new Blob())} />);
  await screen.findByRole("img");
  await act(async () => reject(new Error("old request")));
  expect(screen.queryByText("画像を読み込めませんでした")).toBeNull();
  expect(screen.getByRole("img")).toBeTruthy();
});

it("keeps the full image viewer open while retrying a failed original", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("offline"));
  render(<AttachmentList attachments={[attachment]} controller={controller(fetch)} />);
  fireEvent.click(await screen.findByRole("button", { name: "元の画像を開く" }));
  await waitFor(() => expect(screen.getAllByText("画像を読み込めませんでした")).toHaveLength(2));
  fetch.mockResolvedValue(new Blob());
  fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "再試行" }));
  await within(screen.getByRole("dialog")).findByRole("img");
  expect(fetch).toHaveBeenLastCalledWith("/api/v1/attachments/a/content");
  expect(screen.getByRole("dialog")).toBeTruthy();
});
