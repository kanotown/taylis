import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "../src/api/errors";
import { isTotpCode, normalizeTotpInput, recoveryCodesText, totpErrorText } from "../src/ui/totp";

describe("two-factor helpers (M12i)", () => {
  it("normalises and recognises app codes", () => {
    expect(normalizeTotpInput(" 123 456 ")).toBe("123456");
    expect(isTotpCode("123 456")).toBe(true);
    expect(isTotpCode("abcde-fghjk")).toBe(false);
    expect(isTotpCode("12345")).toBe(false);
  });

  it("explains failures in words", () => {
    expect(totpErrorText(new ApiError(422, "invalid_totp", "Invalid two-factor code"))).toBe("認証コードが違います");
    expect(totpErrorText(new ApiError(422, "invalid_password", "Invalid password"))).toBe("パスワードが違います");
    // Anything else: the shared Japanese text (ARCHITECTURE.md §9), never the server's English message.
    expect(totpErrorText(new ApiError(500, "server_error", "boom"))).toBe("サーバーで問題が発生しました。しばらくしてからお試しください");
    expect(totpErrorText(new ApiError(503, "http_503", "Request failed"))).toBe("サーバーで問題が発生しました。しばらくしてからお試しください");
    expect(totpErrorText(new NetworkError(new TypeError("Failed to fetch")))).toBe("サーバーに接続できません。ネットワークを確認してください");
  });

  it("formats recovery codes for the clipboard", () => {
    expect(recoveryCodesText(["abcde-fghjk", "mnpqr-stuvw"])).toBe("Taylis の回復コード (各 1 回だけ使えます)\n\nabcde-fghjk\nmnpqr-stuvw");
  });
});
