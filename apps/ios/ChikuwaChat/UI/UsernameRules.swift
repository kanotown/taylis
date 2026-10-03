import Foundation

/// M96: usernames can change (my own: 3 times in 24 hours, DATA_MODEL.md users「ユーザー名の変更」). The screen checks
/// what the server checks before sending; whether a name is taken (by a person or a group) only the server knows.
/// Same rules and texts as the desktop (apps/desktop/src/ui/username.ts).
enum UsernameRules {
    /// groups.schemas.RESERVED_NAMES on the server; `deleted-…` is the anonymized accounts' prefix.
    static let reserved: Set<String> = ["channel", "here", "everyone", "all", "group"]
    static let anonymizedPrefix = "deleted-"
    static let limitNote = "変更は 24 時間に 3 回までです。"

    /// As the field keeps it: lowercase, no surrounding spaces.
    static func normalize(_ value: String) -> String {
        value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    /// Why `value` cannot be a username (nil: send it and let the server decide).
    static func problem(_ value: String) -> String? {
        let name = normalize(value)
        if name.isEmpty { return "ユーザー名を入力してください" }
        if name.count < 3 || name.count > 32 { return "3〜32 文字にしてください" }
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789._-")
        if !name.allSatisfy({ allowed.contains($0) }) { return "使えるのは a-z、0-9、. _ - だけです" }
        if reserved.contains(name) || name.hasPrefix(anonymizedPrefix) { return "このユーザー名は予約されているため使えません" }
        return nil
    }

    /// What the screen says under the field.
    static func hint(hasPassword: Bool) -> String {
        (hasPassword ? "パスワードでのログインには新しいユーザー名を使います。" : "")
            + "過去のメッセージとメンションはそのままです。古いユーザー名はすぐにほかの人が使えるようになります。"
    }
}
