import Foundation

/// The composer shows `@username`; the wire format is `<@uuid>` / `<!channel>` (DATA_MODEL.md).
/// Encoding happens on send, decoding when a message is opened for editing.
enum Mentions {
    struct Candidate: Identifiable, Equatable {
        let username: String
        let label: String
        var id: String { username }
    }

    private static let handle = try! NSRegularExpression(pattern: #"(^|[\s(])@([A-Za-z0-9._-]+)"#)
    private static let userToken = try! NSRegularExpression(pattern: #"<@([0-9a-f-]{36})>"#)
    private static let allToken = try! NSRegularExpression(pattern: #"<!(channel|here)>"#)
    private static let queryPattern = try! NSRegularExpression(pattern: #"(^|[\s(])@([A-Za-z0-9._-]*)$"#)

    static func encode(_ text: String, users: some Collection<UserPublic>) -> String {
        let byName = Dictionary(users.map { ($0.username.lowercased(), $0.id) }, uniquingKeysWith: { first, _ in first })
        return replace(text, handle) { groups in
            let lead = groups[1]
            let name = groups[2].lowercased()
            if name == "channel" || name == "here" { return "\(lead)<!\(name)>" }
            if let id = byName[name] { return "\(lead)<@\(id)>" }
            return nil
        }
    }

    static func decode(_ text: String, users: [String: UserPublic]) -> String {
        let step = replace(text, userToken) { groups in users[groups[1]].map { "@" + $0.username } }
        return replace(step, allToken) { groups in "@" + groups[1] }
    }

    /// The `@prefix` being typed at the end of `text`, or nil.
    static func query(_ text: String) -> String? { groups(queryPattern, text)?[2] }

    static func candidates(_ query: String, users: some Collection<UserPublic>, limit: Int = 6) -> [Candidate] {
        let q = query.lowercased()
        let people = users
            .filter { $0.deactivatedAt == nil }
            .filter { $0.username.lowercased().hasPrefix(q) || $0.displayName.lowercased().contains(q) }
            .sorted { $0.username < $1.username }
            .map { Candidate(username: $0.username, label: $0.displayName) }
        let special = [Candidate(username: "channel", label: "全員に通知"), Candidate(username: "here", label: "全員に通知")]
            .filter { $0.username.hasPrefix(q) }
        return Array((people + special).prefix(limit))
    }

    /// Replace the `@prefix` at the end of `text` with the chosen handle.
    static func complete(_ text: String, username: String) -> String {
        let ns = text as NSString
        guard let match = queryPattern.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return text }
        let lead = ns.substring(with: match.range(at: 1))
        return ns.substring(to: match.range.location) + lead + "@" + username + " "
    }

    private static func groups(_ regex: NSRegularExpression, _ text: String) -> [String]? {
        let ns = text as NSString
        guard let match = regex.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (0..<match.numberOfRanges).map { index in
            let range = match.range(at: index)
            return range.location == NSNotFound ? "" : ns.substring(with: range)
        }
    }

    /// Replace each match with the closure's result (nil keeps the original text).
    private static func replace(_ text: String, _ regex: NSRegularExpression, _ transform: ([String]) -> String?) -> String {
        let ns = text as NSString
        var result = ""
        var last = 0
        for match in regex.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let groups = (0..<match.numberOfRanges).map { index -> String in
                let range = match.range(at: index)
                return range.location == NSNotFound ? "" : ns.substring(with: range)
            }
            result += ns.substring(with: NSRange(location: last, length: match.range.location - last))
            result += transform(groups) ?? groups[0]
            last = match.range.location + match.range.length
        }
        result += ns.substring(from: last)
        return result
    }
}
