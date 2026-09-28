// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AppController } from "../src/state/app";
import { Store } from "../src/sync/store";
import { Composer } from "../src/ui/Composer";
import { FakeServer } from "./fakeServer";

afterEach(cleanup);
it("offers video selection and uploads the original file through the existing attachment API", async () => {
  const store = new Store();
  const server = new FakeServer();
  const me = server.addUser("me");
  const channel = store.upsertChannel(server.createChannel("video", me.id), { isMember: true });
  const meta = { id: "video", filename: "sample.mp4", content_type: "video/mp4", size_bytes: 4, status: "pending", has_thumbnail: false, created_at: "" };
  const uploadAttachment = vi.fn().mockResolvedValue(meta);
  const controller = { store, api: { uploadAttachment }, sendKey: "shift-enter", isAdmin: false } as unknown as AppController;
  const { container } = render(<Composer controller={controller} channel={channel} />);
  const media = screen.getByLabelText("写真・動画を選択") as HTMLInputElement;
  expect(media.accept).toBe("image/*,video/*");
  expect(media.multiple).toBe(true);
  // Generic files remain unrestricted; no document types disappear when video is added.
  expect(container.querySelector('input[type="file"]:not([accept])')).toBeTruthy();
  const video = new File([new Uint8Array([1, 2, 3, 4])], "sample.mp4", { type: "video/mp4" });
  fireEvent.change(media, { target: { files: [video] } });
  await waitFor(() => expect(store.draft(channel.id).attachments).toEqual([meta]));
  expect(uploadAttachment).toHaveBeenCalledExactlyOnceWith(video, "sample.mp4");
  expect(store.uploading(channel.id)).toBe(0);
});
