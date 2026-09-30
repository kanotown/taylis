import Foundation

/// M39: the activity endpoints the engine needs for the badge (implemented by ApiClient and by the test fake). A
/// separate protocol, as DraftApi: fakes without it leave the badge to bootstrap.
@MainActor
protocol ActivityApi: AnyObject {
    func activitySummary() async throws -> ActivitySummary
    func markActivityRead(readAt: String) async throws -> ActivitySummary
}

/// M39, the activity (MOBILE_UI.md §6.4 stage B, §7.2): the pure rules of the list, its badge and its read position
/// (the same rules as the web's ui/activity.ts).
enum ActivityRules {
    /// The filters in the order the tab shows them (the GET /activity `filter` values).
    static let filters = ["all", "mentions", "threads", "reactions"]
    static let kinds: Set<String> = ["mention", "reaction", "thread_reply"]

    static func filterLabel(_ filter: String) -> String {
        switch filter {
        case "mentions": "メンション"
        case "threads": "スレッド"
        case "reactions": "リアクション"
        default: "すべて"
        }
    }

    /// An empty list says what would be listed there.
    static func emptyText(_ filter: String) -> String {
        switch filter {
        case "mentions": "まだメンションはありません"
        case "threads": "フォロー中のスレッドへの返信はまだありません"
        case "reactions": "自分の投稿へのリアクションはまだありません"
        default: "まだアクティビティはありません"
        }
    }

    private static func time(_ iso: String?) -> Date {
        iso.flatMap(parseIsoDate) ?? .distantPast
    }

    /// The row's dot: it happened after the read position (an item at the position itself is read). No position
    /// known: no dots.
    static func isUnread(_ item: ActivityItem, readAt: String?) -> Bool {
        guard let readAt else { return false }
        return time(item.at) > time(readAt)
    }

    /// The newest `at` of the rows (what being on screen marks read); nil without rows.
    static func newest(_ items: [ActivityItem]) -> String? {
        items.max { time($0.at) < time($1.at) }?.at
    }

    /// Whether marking `at` read moves the position (the server only moves it forward).
    static func moves(_ at: String?, readAt: String?) -> Bool {
        guard let at else { return false }
        guard let readAt else { return true }
        return time(at) > time(readAt)
    }

    /// Being on screen reads the activity only on 「すべて」: one position covers every kind, so a filtered list would
    /// mark read what the other filters hold unseen (the lead's rule for all clients, 2026-09-30). 「すべて既読」 works
    /// on every filter.
    static func readsOnScreen(filter: String) -> Bool { filter == "all" }

    /// A summary replaces the one held unless it is behind it: the read position only moves forward, so a GET answered
    /// after a newer PUT (or activity.read) is stale. nil (a server before M39) always replaces.
    static func accepts(_ summary: ActivitySummary?, over current: ActivitySummary?) -> Bool {
        guard let summary, let current else { return true }
        return time(summary.readAt) >= time(current.readAt)
    }

    /// The next page after the rows held: a row already held (a tie at the page boundary, or a reaction item that
    /// moved) is not listed twice, the held one stays where it is. Kinds this build does not know are left out.
    static func append(_ held: [ActivityItem], _ page: [ActivityItem]) -> [ActivityItem] {
        var keys = Set(held.map(\.id))
        var rows = held
        for item in page where kinds.contains(item.kind) && !keys.contains(item.id) {
            keys.insert(item.id)
            rows.append(item)
        }
        return rows
    }

    /// Who did it, as the row's first line says it: 「〇〇 がメンション」, 「〇〇 がスレッドに返信」, and for reactions
    /// 「〇〇 が」 / 「〇〇 ほか N 人が」 followed by the emoji (drawn by the caller, custom emoji as pictures).
    static func headline(_ item: ActivityItem, nameOf: (String) -> String) -> (who: String, what: String) {
        let name = item.actorIds.first.map(nameOf) ?? "誰か"
        switch item.kind {
        case "mention": return (name, " がメンション")
        case "thread_reply": return (name, " がスレッドに返信")
        default:
            let others = max(0, item.actorIds.count - 1)
            return others > 0 ? ("\(name) ほか \(others) 人", "が") : (name, " が")
        }
    }

    /// The same headline as plain text (the row's accessibility label), the emoji written out.
    static func headlineText(_ item: ActivityItem, nameOf: (String) -> String) -> String {
        let (who, what) = headline(item, nameOf: nameOf)
        return item.kind == "reaction" ? "\(who)\(what) \(item.emojis.joined())" : who + what
    }

    /// The row's message line (MOBILE_POLISH.md X1): Timeline.excerpt — no markdown, one line, mentions as display
    /// names, 「画像を送信しました」 without text — the same for every kind (a reaction's no longer in 「」), as
    /// Android's activity and the search results say it.
    static func excerpt(_ message: MessageOut, users: [String: UserPublic], groups: [String: GroupOut] = [:]) -> String {
        if message.deleted { return "(削除されたメッセージ)" }
        return Timeline.excerpt(message.body, attachments: message.attachments, users: users, groups: groups)
    }

    /// The row's second line: the conversation, 「#c のスレッド」 for a reply.
    static func whereText(_ item: ActivityItem, conversation: String) -> String {
        item.kind == "thread_reply" ? "\(conversation) のスレッド" : conversation
    }

    /// A new message that is activity of mine moves the badge (the count itself is the server's, fetched again): it
    /// mentions me, or it is someone's reply in a thread I follow (its followers, or my own thread row, say so).
    static func refreshesBadge(on message: MessageOut, me: UserMe?, thread: ParentThread?, followed: Bool) -> Bool {
        guard let me, message.senderId != me.id else { return false }
        if message.parentId != nil && (followed || thread?.participantIds.contains(me.id) == true) { return true }
        return message.mentionsMe(me)
    }
}
