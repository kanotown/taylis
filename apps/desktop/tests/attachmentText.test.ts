/** A message without text says what was sent (tester, 2026-09-30); the same words as the server's push and the phones. */
import { expect, it } from "vitest";

import { attachmentText } from "../src/ui/markdown";

const files = (...types: string[]) => types.map((content_type) => ({ content_type }));

it("images, videos or files; one, or how many", () => {
  expect(attachmentText(undefined)).toBe("");
  expect(attachmentText([])).toBe("");
  expect(attachmentText(files("image/png"))).toBe("画像を送信しました");
  expect(attachmentText(files("image/png", "image/jpeg", "image/heic"))).toBe("画像を 3 枚送信しました");
  expect(attachmentText(files("video/mp4"))).toBe("動画を送信しました");
  expect(attachmentText(files("video/mp4", "video/quicktime"))).toBe("動画を 2 本送信しました");
  expect(attachmentText(files("application/pdf"))).toBe("ファイルを送信しました");
  expect(attachmentText(files("image/png", "video/mp4"))).toBe("ファイルを 2 件送信しました");
});
