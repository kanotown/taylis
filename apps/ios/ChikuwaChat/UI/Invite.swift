import Foundation

/// Invite links (M12h): `<server>/invite/<token>`; the token is 20-128 URL-safe characters.
enum Invite {
    private static let token = try! NSRegularExpression(pattern: "^[A-Za-z0-9_-]{20,128}$")
    private static let link = try! NSRegularExpression(pattern: "^\\s*(https?://[^\\s/?#]+)/invite/([^\\s/?#]+)", options: [.caseInsensitive])

    static func url(base: URL, token: String) -> String {
        var text = base.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text + "/invite/" + token
    }

    /// The server and the token from a pasted link (trailing path, query and fragment ignored).
    static func parse(_ text: String) -> (server: URL, token: String)? {
        let whole = NSRange(location: 0, length: (text as NSString).length)
        guard let match = link.firstMatch(in: text, range: whole) else { return nil }
        let server = (text as NSString).substring(with: match.range(at: 1))
        let value = (text as NSString).substring(with: match.range(at: 2))
        let range = NSRange(location: 0, length: (value as NSString).length)
        guard token.firstMatch(in: value, range: range) != nil, let url = URL(string: server) else { return nil }
        return (url, value)
    }

    /// Invite failures in words; nil for anything that is not invite specific.
    static func errorText(_ error: Error) -> String? {
        guard case ApiError.api(_, let code, _) = error else { return nil }
        switch code {
        case "invite_not_found": return "この招待リンクは無効です"
        case "invite_expired": return "この招待リンクは期限切れです"
        case "invite_exhausted": return "この招待リンクはすでに使われています"
        case "invite_revoked": return "この招待リンクは取り消されています"
        case "username_taken": return "このユーザー名はすでに使われています"
        case "validation_error": return "入力内容を確認してください"
        default: return nil
        }
    }
}
