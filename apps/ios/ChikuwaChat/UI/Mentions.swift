import Foundation

/// The composer shows `@username`; the wire format is `<@uuid>` / `<!channel>` (DATA_MODEL.md).
/// Encoding happens on send, decoding when a message is opened for editing.
enum Mentions {
    struct Candidate: Identifiable, Equatable {
        let username: String
        let label: String
        /// M12k: "group" notifies the members; "all" is @channel / @here; M66: "ai" is an AI bot (its 「AI」 mark).
        var kind: String = "user"
        var id: String { username }
    }

    /// After anything but an ASCII handle character, @ or <: 「まとめます。@kano」 is a mention, a@b.jp and <@uuid> are not.
    private static let handle = try! NSRegularExpression(pattern: #"(^|[^A-Za-z0-9._@<-])@([A-Za-z0-9._-]+)"#)
    private static let userToken = try! NSRegularExpression(pattern: #"<@([0-9a-f-]{36})>"#)
    private static let allToken = try! NSRegularExpression(pattern: #"<!(channel|here)>"#)
    private static let groupToken = try! NSRegularExpression(pattern: #"<@group:([0-9a-f-]{36})>"#)
    private static let queryPattern = try! NSRegularExpression(pattern: #"(^|[^A-Za-z0-9._@<-])@([\p{L}\p{M}\p{N}._-]*)$"#)

    static func encode(_ text: String, users: some Collection<UserPublic>, groups: [GroupOut] = []) -> String {
        var byName = Dictionary(users.map { ($0.username.lowercased(), "<@\($0.id)>") }, uniquingKeysWith: { first, _ in first })
        for group in groups { byName[group.name.lowercased()] = "<@group:\(group.id)>" } // names never collide (server)
        return replace(text, handle) { match in
            let lead = match[1]
            let name = match[2].lowercased()
            if name == "channel" || name == "here" { return "\(lead)<!\(name)>" }
            if let token = byName[name] { return "\(lead)\(token)" }
            return nil
        }
    }

    static func decode(_ text: String, users: [String: UserPublic], groups: [String: GroupOut] = [:]) -> String {
        let step = replace(text, userToken) { match in users[match[1]].map { "@" + $0.username } }
        let withGroups = replace(step, groupToken) { match in groups[match[1]].map { "@" + $0.name } }
        return replace(withGroups, allToken) { match in "@" + match[1] }
    }

    /// Mention tokens as display names, for notifications and previews (`@Toru Kano`, `@design`, `@channel`).
    static func toNames(_ text: String, users: [String: UserPublic], groups: [String: GroupOut] = [:]) -> String {
        let step = replace(text, userToken) { match in "@" + (users[match[1]]?.displayName ?? tr("メンバー")) }
        let withGroups = replace(step, groupToken) { match in "@" + (groups[match[1]]?.name ?? tr("グループ")) }
        return replace(withGroups, allToken) { match in "@" + match[1] }
    }

    /// The `@prefix` being typed at the end of `text`, or nil.
    static func query(_ text: String) -> String? { groups(queryPattern, text)?[2] }

    static func candidates(_ query: String, users: some Collection<UserPublic>, groups: [GroupOut] = [], aiBotIds: Set<String> = [],
                           limit: Int = 6) -> [Candidate] {
        let q = query.lowercased()
        let people = users
            .filter { $0.deactivatedAt == nil }
            .filter { $0.username.lowercased().hasPrefix(q) || $0.displayName.lowercased().contains(q) }
            .sorted { $0.username < $1.username }
            .map { Candidate(username: $0.username, label: $0.displayName, kind: aiBotIds.contains($0.id) ? "ai" : "user") }
        let teams = groups
            .filter { $0.name.lowercased().hasPrefix(q) || ($0.description ?? "").lowercased().contains(q) }
            .sorted { $0.name < $1.name }
            .map { Candidate(username: $0.name, label: tr("グループ · \($0.memberIds.count) 人") + ($0.description.map { " · " + $0 } ?? ""), kind: "group") }
        let special = [Candidate(username: "channel", label: tr("全員に通知"), kind: "all"), Candidate(username: "here", label: tr("全員に通知"), kind: "all")]
            .filter { $0.username.hasPrefix(q) }
        return Array((people + teams + special).prefix(limit))
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
