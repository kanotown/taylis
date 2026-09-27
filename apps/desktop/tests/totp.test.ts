import { describe, expect, it } from "vitest";

import { ApiError } from "../src/api/errors";
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
    expect(totpErrorText(new ApiError(500, "server_error", "boom"))).toBe("boom (server_error)");
    expect(totpErrorText(new Error("offline"))).toBe("offline");
  });

  it("formats recovery codes for the clipboard", () => {
    expect(recoveryCodesText(["abcde-fghjk", "mnpqr-stuvw"])).toBe("ChikuwaChat の回復コード (各 1 回だけ使えます)\n\nabcde-fghjk\nmnpqr-stuvw");
  });
});
