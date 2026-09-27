import { describe, expect, it } from "vitest";

import { ApiError, NetworkError } from "../src/api/errors";
import { inviteErrorText, inviteLink, inviteUsesLabel, parseInviteLink } from "../src/ui/invite";

describe("invite links (M12h)", () => {
  const token = "Zy9_-abcdefghijklmnopqrstuvwxyz0123456789ABC";

  it("builds <server>/invite/<token> without doubling slashes", () => {
    expect(inviteLink("https://chat.example.com/", token)).toBe(`https://chat.example.com/invite/${token}`);
    expect(inviteLink("http://127.0.0.1:8000", token)).toBe(`http://127.0.0.1:8000/invite/${token}`);
  });

  it("parses a pasted link into the server and the token", () => {
    expect(parseInviteLink(`  https://chat.example.com/invite/${token}?utm=1 `)).toEqual({ server: "https://chat.example.com", token });
    expect(parseInviteLink(`http://127.0.0.1:8000/invite/${token}/`)).toEqual({ server: "http://127.0.0.1:8000", token });
    expect(parseInviteLink("https://chat.example.com/invite/short")).toBeNull();
    expect(parseInviteLink(`https://chat.example.com/m/${token}`)).toBeNull();
    expect(parseInviteLink(token)).toBeNull();
  });

  it("describes uses and explains failures in words", () => {
    const base = { id: "i", created_by: "u", role: "member", channel_ids: [], note: null, expires_at: "", revoked_at: null, created_at: "", used_by: [], status: "active" as const };
    expect(inviteUsesLabel({ ...base, max_uses: 1, use_count: 0 })).toBe("0 / 1 回");
    expect(inviteUsesLabel({ ...base, max_uses: null, use_count: 3 })).toBe("3 回使用 (回数無制限)");
    expect(inviteErrorText(new ApiError(410, "invite_expired", "Invite is expired"))).toBe("この招待リンクは期限切れです");
    expect(inviteErrorText(new ApiError(409, "username_taken", "taken"))).toBe("このユーザー名はすでに使われています");
    // Anything else: the shared Japanese text (ARCHITECTURE.md §9), never the server's English message.
    expect(inviteErrorText(new ApiError(500, "server_error", "boom"))).toBe("サーバーで問題が発生しました。しばらくしてからお試しください");
    expect(inviteErrorText(new ApiError(503, "http_503", "Request failed"))).toBe("サーバーで問題が発生しました。しばらくしてからお試しください");
    expect(inviteErrorText(new NetworkError(new TypeError("Failed to fetch")))).toBe("サーバーに接続できません。ネットワークを確認してください");
  });
});
