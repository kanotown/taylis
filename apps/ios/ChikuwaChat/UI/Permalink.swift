import Foundation

/// Message permalinks (M12b): `<server>/m/<message_id>`, recognised only for the server we are logged into.
enum Permalink {
    static let scheme = "chikuwa-message"
    private static let uuid = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: [.caseInsensitive])

    static func url(base: URL, messageId: String) -> String {
        var text = base.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text + "/m/" + messageId
    }

    /// The message id when `url` is a permalink on `base` (case-insensitive prefix, query / fragment ignored).
    static func messageId(base: URL?, url: String) -> String? {
        guard let base else { return nil }
        var prefix = base.absoluteString
        while prefix.hasSuffix("/") { prefix.removeLast() }
        prefix += "/m/"
        guard url.count >= prefix.count, url.prefix(prefix.count).lowercased() == prefix.lowercased() else { return nil }
        var id = String(url.dropFirst(prefix.count))
        for stop in ["/", "?", "#"] { if let range = id.range(of: stop) { id = String(id[..<range.lowerBound]) } }
        let range = NSRange(location: 0, length: (id as NSString).length)
        return uuid.firstMatch(in: id, range: range) != nil ? id.lowercased() : nil
    }

    /// The in-app link put into a body's attributed text; the row's `openURL` handler turns it into a reveal.
    static func internalLink(messageId: String) -> URL? { URL(string: "\(scheme)://\(messageId)") }
}
