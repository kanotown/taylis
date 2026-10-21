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

    /// AI.md §2.1 (2026-10-06): who the suggestions offer. People (not deactivated) and AI bots only: other bots (incoming
    /// webhooks, feeds, reservations, recurring posts, imported ones) answer nothing. `aiBotIds` is GET /ai/status's
    /// `agents[].bot_user_id` once it was read (then only those, a stopped or deleted AI bot drops out), nil before
    /// (then `bot_kind == "ai"` decides).
    static func offered(_ user: UserPublic, aiBotIds: Set<String>?) -> Bool {
        guard user.deactivatedAt == nil else { return false }
        guard user.role == "bot" else { return true }
        return aiBotIds.map { $0.contains(user.id) } ?? (user.botKind == "ai")
    }

    /// How many of the newest messages of a thread and of the channel count as recent (apps/shared/mention-rank.json).
    static let recentMessages = 50

    /// What `recentSpeakers` reads of a message.
    struct Spoken: Equatable {
        let senderId: String
        var deleted = false
        var type = "user"
    }

    /// Whom the list puts first (MOBILE_UI.md §23): what the device holds about the conversation being written in.
    struct Context: Equatable {
        /// `recentSpeakers` of the conversation (a thread's first), newest first.
        var recent: [String] = []
        /// The conversation's members as known locally (a DM / group DM: its participants).
        var members: [String] = []
        /// My user id: offered last.
        var me: String?
    }

    /// Who spoke recently, newest first, each once (MOBILE_UI.md §23, mention-rank.json `recent`): the thread's senders
    /// (its parent and replies, oldest first as given) before the channel's (the loaded timeline). Deleted and system
    /// messages do not count; only the newest `cap` counting messages of each list.
    static func recentSpeakers(channel: [Spoken], thread: [Spoken] = [], cap: Int = recentMessages) -> [String] {
        var seen = Set<String>()
        var speakers: [String] = []
        for list in [thread, channel] {
            for message in list.filter({ !$0.deleted && $0.type != "system" }).suffix(cap).reversed() where seen.insert(message.senderId).inserted {
                speakers.append(message.senderId)
            }
        }
        return speakers
    }

    /// The composer's context: the loaded messages' senders (in a thread, its own first) and a DM's participants. A
    /// channel's members are not held on the device (GET /channels/{id}/members is read by the member screens only),
    /// so a channel has no members tier.
    @MainActor static func context(store: Store, channelId: String, parentId: String?) -> Context {
        let spoken = { (message: MessageState) in Spoken(senderId: message.senderId, deleted: message.deleted, type: message.type) }
        var thread: [Spoken] = []
        if let parentId {
            thread = (store.message(channelId, parentId).map { [spoken($0)] } ?? []) + store.replies(channelId, parentId: parentId).map(spoken)
        }
        var context = documentContext(store: store, channelId: channelId)
        context.recent = recentSpeakers(channel: store.messages(channelId).map(spoken), thread: thread)
        return context
    }

    /// A canvas (MOBILE_UI.md §23): no conversation, only the participants of the DM it belongs to, and me last.
    @MainActor static func documentContext(store: Store, channelId: String?) -> Context {
        Context(members: channelId.flatMap { store.channel($0)?.channel.dmUserIds } ?? [], me: store.me?.id)
    }

    private static let japanese = Locale(identifier: "ja")

    /// People ranked by `context` (MOBILE_UI.md §23): a prefix match first, then recent speakers, members, everybody
    /// else and me, then by display name; the groups and @channel / @here follow as before.
    static func candidates(_ query: String, users: some Collection<UserPublic>, groups: [GroupOut] = [], aiBotIds: Set<String>? = nil,
                           limit: Int = 8, context: Context = Context()) -> [Candidate] {
        let q = query.lowercased()
        var recent: [String: Int] = [:]
        for id in context.recent where recent[id] == nil { recent[id] = recent.count }
        let members = Set(context.members)
        func tier(_ id: String) -> Int { id == context.me ? 3 : recent[id] != nil ? 0 : members.contains(id) ? 1 : 2 }
        func match(_ user: UserPublic) -> Int {
            q.isEmpty || user.username.lowercased().hasPrefix(q) || user.displayName.lowercased().hasPrefix(q) ? 0 : 1
        }
        let people = users
            .filter { offered($0, aiBotIds: aiBotIds) }
            .filter { $0.username.lowercased().hasPrefix(q) || $0.displayName.lowercased().contains(q) }
            .map { (user: $0, match: match($0), tier: tier($0.id), recent: recent[$0.id] ?? 0) }
            .sorted { a, b in
                if a.match != b.match { return a.match < b.match }
                if a.tier != b.tier { return a.tier < b.tier }
                if a.tier == 0, a.recent != b.recent { return a.recent < b.recent }
                let byName = a.user.displayName.compare(b.user.displayName, locale: japanese)
                if byName != .orderedSame { return byName == .orderedAscending }
                return a.user.username < b.user.username
            }
            .map { Candidate(username: $0.user.username, label: $0.user.displayName, kind: $0.user.role == "bot" ? "ai" : "user") }
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
