// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AttachmentOut } from "../src/api/types";
import type { AppController } from "../src/state/app";
import { PendingAttachments } from "../src/ui/Attachments";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const attachment = (id: string, filename: string, content_type: string, has_thumbnail: boolean): AttachmentOut =>
  ({ id, filename, content_type, size_bytes: 2048, width: null, height: null, has_thumbnail, status: "pending", created_at: "" }) as AttachmentOut;

describe("uploads waiting in the composer (testers, 2026-09-29: thumbnails like Slack, a tap previews)", () => {
  it("shows square thumbnails; × takes one out, a click previews a photo and downloads a file", async () => {
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:thumb", revokeObjectURL: () => {} }));
    const fetchBlob = vi.fn(async () => new Blob(["x"], { type: "image/jpeg" }));
    const downloadAttachment = vi.fn(async () => {});
    const controller = { api: { fetchBlob }, downloadAttachment } as unknown as AppController;
    const photo = attachment("a1", "photo.jpg", "image/jpeg", true);
    const video = attachment("a2", "IMG_0001.MOV", "video/quicktime", false);
    const onRemove = vi.fn();
    render(<PendingAttachments items={[photo, video]} uploading={1} controller={controller} onRemove={onRemove} />);

    await waitFor(() => expect(document.querySelector("img[src='blob:thumb']")).toBeTruthy());
    expect(fetchBlob).toHaveBeenCalledWith("/api/v1/attachments/a1/thumbnail");
    expect(screen.getByRole("status", { name: "アップロード中" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "IMG_0001.MOV を取り消す" }));
    expect(onRemove).toHaveBeenCalledWith(video);

    fireEvent.click(screen.getByRole("button", { name: "IMG_0001.MOV をダウンロード" }));
    expect(downloadAttachment).toHaveBeenCalledWith(video);

    fireEvent.click(screen.getByRole("button", { name: "photo.jpg をプレビュー" }));
    expect(await screen.findByText("写真のプレビュー")).toBeTruthy();
    await waitFor(() => expect(fetchBlob).toHaveBeenCalledWith("/api/v1/attachments/a1/content"));
  });
});
