import Foundation

/// Rows of a channel timeline: date separators, one 「新着メッセージ」 divider and grouped messages.
enum TimelineItem: Identifiable {
    case date(label: String, key: String)
    case unread
    case message(MessageState, compact: Bool)

    var id: String {
        switch self {
        case .date(_, let key): return key
        case .unread: return "unread"
        case .message(let message, _): return message.rowKey
        }
    }
}

extension MessageState {
    /// A row's identity in lists: the client_msg_id, which my pending message keeps when the server confirms it
    /// (its id changes from "local:…" to the server's). Keyed by id, SwiftUI dropped and re-inserted my row on every
    /// send and scrolled to it twice: the jolt when sending. Every client keys its rows this way.
    var rowKey: String { clientMsgId ?? id }
}

enum Timeline {
    /// One line of plain text for a message (thread lists, "replied to a thread" lines).
    static func excerpt(_ body: String, hasAttachments: Bool, users: [String: UserPublic], groups: [String: GroupOut] = [:]) -> String {
        if body.isEmpty { return hasAttachments ? "(添付ファイル)" : "" }
        var text = Mentions.decode(body, users: users, groups: groups)
        // M15g: a table becomes its cell text (separator rows vanish, pipes become spaces).
        text = text.replacingOccurrences(of: #"(?m)^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$"#, with: "", options: .regularExpression)
        text = text.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("|"), trimmed.hasSuffix("|") else { return String(line) }
            return BodyTokenizer.splitTableRow(trimmed).joined(separator: " ")
        }.joined(separator: "\n")
        for pattern in ["```[a-zA-Z0-9_+-]*", "^#{1,3}\\s+", "^>\\s?", "^\\s*[-*]\\s+", "^\\s*\\d+\\.\\s+", "\\*\\*", "~~", "`"] {
            text = text.replacingOccurrences(of: pattern, with: "", options: [.regularExpression], range: nil)
        }
        // Italics and links keep their text (the web and Android; parity audit 2026-09-29).
        for (pattern, template) in [("\\*([^*\\n]+)\\*", "$1"), ("_([^_\\n]+)_", "$1"), ("\\[([^\\]\\n]+)\\]\\(https?://[^\\s)]+\\)", "$1")] {
            text = text.replacingOccurrences(of: pattern, with: template, options: [.regularExpression], range: nil)
        }
        let line = text.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
        return line.count > 80 ? String(line.prefix(79)) + "…" : line // the same cap as the web and Android
    }

    static let groupWindow: TimeInterval = 5 * 60
    private static let weekdays = ["日", "月", "火", "水", "木", "金", "土"]

    /// 今日 / 昨日 / 9月26日 (金) / 2025年12月31日 (水)
    static func dayLabel(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "今日" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "昨日" }
        let parts = calendar.dateComponents([.year, .month, .day, .weekday], from: date)
        let md = "\(parts.month ?? 0)月\(parts.day ?? 0)日 (\(weekdays[max(0, (parts.weekday ?? 1) - 1) % 7]))"
        return parts.year == calendar.component(.year, from: now) ? md : "\(parts.year ?? 0)年\(md)"
    }

    static func timeLabel(_ iso: String) -> String {
        guard let date = parseIsoDate(iso) else { return "送信中…" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    static func fullLabel(_ iso: String) -> String {
        guard let date = parseIsoDate(iso) else { return "" }
        return date.formatted(date: .long, time: .shortened)
    }

    /// 「Toru Kano」→ TK, 「かのう」→ か.
    static func initials(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "?" }
        let words = trimmed.split(whereSeparator: { $0.isWhitespace })
        if words.count >= 2, let a = words[0].first, let b = words[1].first, a.isASCII, b.isASCII, a.isLetter {
            return String([a, b]).uppercased()
        }
        return String(first).uppercased()
    }

    /// Stable hue in 0..<1 per user id (same colour on every device and client).
    static func hue(_ id: String) -> Double {
        var hash: UInt32 = 0
        for scalar in id.unicodeScalars { hash = hash &* 31 &+ scalar.value }
        return Double(hash % 360) / 360
    }

    /// M47 「連続した投稿をまとめる」 (自分 → 表示, this device only, off by default): off, every post in a channel, a DM
    /// or a thread shows its picture, name and time; on, a run of posts from one person shows them once.
    static let groupingKey = "groupConsecutivePosts"

    /// Whether `message` (posted at `at`) goes under `previous` without its header: the same sender within
    /// `groupWindow`. Callers pass nil for `previous` where a run is cut (a day separator, the unread divider).
    static func continues(_ message: MessageState, at: Date, after previous: MessageState?) -> Bool {
        guard let previous, previous.senderId == message.senderId, let previousAt = parseIsoDate(previous.createdAt) else { return false }
        return abs(at.timeIntervalSince(previousAt)) < groupWindow
    }

    static func build(
        _ messages: [MessageState],
        firstUnreadAfterSeq: Int?,
        meId: String?,
        grouping: Bool,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [TimelineItem] {
        var items: [TimelineItem] = []
        items.reserveCapacity(messages.count + 8)
        var previous: MessageState?
        var previousDay: Date?
        var unreadPlaced = false
        for message in messages {
            let at = parseIsoDate(message.createdAt) ?? now
            let day = calendar.startOfDay(for: at)
            if day != previousDay {
                items.append(.date(label: dayLabel(at, now: now, calendar: calendar), key: "date:\(day.timeIntervalSince1970)"))
                previousDay = day
                previous = nil
            }
            if !unreadPlaced, let after = firstUnreadAfterSeq, let seq = message.seq, seq > after, message.senderId != meId {
                items.append(.unread)
                unreadPlaced = true
                previous = nil
            }
            // A reply also sent to the channel (M15c) keeps its own header. Pending messages group like sent ones:
            // my second message must not show the header until the server confirms it and then drop it.
            let compact = grouping && !message.isReply && !(previous?.isReply ?? false) && continues(message, at: at, after: previous)
            items.append(.message(message, compact: compact))
            previous = message
        }
        return items
    }

    /// M47: the replies of a thread shown under the one before them (their ids), by the timeline's rule; a new day and
    /// the 「新しい返信」 divider cut a run as the separators do in the channel. The first reply always has its header
    /// (the reply count is between it and the parent), and so does the parent.
    static func threadCompactIds(_ replies: [MessageState], firstUnreadId: String?, grouping: Bool,
                                 now: Date = Date(), calendar: Calendar = .current) -> Set<String> {
        guard grouping else { return [] }
        var ids: Set<String> = []
        var previous: MessageState?
        for reply in replies {
            let at = parseIsoDate(reply.createdAt) ?? now
            if let before = previous, reply.id == firstUnreadId
                || calendar.startOfDay(for: at) != calendar.startOfDay(for: parseIsoDate(before.createdAt) ?? now) {
                previous = nil
            }
            if continues(reply, at: at, after: previous) { ids.insert(reply.id) }
            previous = reply
        }
        return ids
    }

    /// "HH:mm までミュート" while a mute is active, otherwise nil.
    static func muteLabel(_ mutedUntil: String?, now: Date = Date()) -> String? {
        guard let mutedUntil, let until = parseIsoDate(mutedUntil), until > now else { return nil }
        return until.formatted(date: .omitted, time: .shortened) + " までミュート"
    }
}

/// SYNC_PROTOCOL.md §10.1–§10.3 (M17): whether the reader's first unread row is held, and what the channel and thread
/// views do about it. The same pure rules in every client.
enum ReadGate {
    /// The largest unread count that gets 「最初の未読へ」 while the range is not loaded yet (rows held at once stay near
    /// the planned retention).
    static let unreadJumpMax = 500
    static let jumpPageSize = 200
    /// A safety valve per press (rows that are not counted as unread, such as system messages, can be many).
    static let jumpMaxPages = 4

    /// Every timeline row with seq > m is held: the window is contiguous from the newest page (§7.3). Conservative, as
    /// seqs skip over thread replies.
    static func covers(_ oldestLoadedSeq: Int?, _ m: Int) -> Bool {
        oldestLoadedSeq == 0 || (oldestLoadedSeq.map { $0 <= m + 1 } ?? false)
    }

    /// Visible-range read marks may move the position: nothing is unread, or every unread row is held. `covers` sees only
    /// the older end; the newer end is held once the window has caught up to last_seq. Until then (bootstrap raised
    /// last_seq after the app was away, a catch-up on its way or failed) the unread rows may not be here at all.
    static func readRangeReady(_ channel: ChannelState) -> Bool {
        channel.unreadCount == 0 || (covers(channel.oldestLoadedSeq, channel.lastReadSeq) && reachesNewest(channel))
    }

    /// The window has caught up to the channel's newest seq (§7.3): no row after it is missing.
    static func reachesNewest(_ channel: ChannelState) -> Bool {
        channel.syncedSeq.map { $0 >= channel.lastSeq } ?? false
    }

    /// The row the 「新着メッセージ」 divider precedes: the first confirmed row past `afterSeq` from someone else.
    static func firstUnreadRow(_ rows: [MessageState], afterSeq: Int, meId: String?) -> MessageState? {
        rows.first { ($0.seq.map { $0 > afterSeq } ?? false) && $0.senderId != meId }
    }

    /// The divider stays at the position captured when the channel opened (or the one held by 「ここから未読にする」),
    /// and is drawn only when every row after it is held: at the top of a partial window it would be a lie.
    static func dividerMark(held: Int?, captured: Int?, oldestLoadedSeq: Int?) -> Int? {
        guard let mark = held ?? captured, covers(oldestLoadedSeq, mark) else { return nil }
        return mark
    }

    /// Visible-range marking starts once the first unread row has been on screen with the range held (or there is
    /// nothing unread), and stops again whenever the range is not held.
    static func nextAnchored(_ previous: Bool, unreadCount: Int, ready: Bool, firstUnread: MessageState?, visibleMessageIds: Set<String>) -> Bool {
        if unreadCount == 0 { return true }
        if !ready { return false }
        if previous { return true }
        return firstUnread.map { visibleMessageIds.contains($0.id) } ?? true
    }

    /// The list is past the first unread row while that row is not on screen at all: rows arrived while the reader was
    /// not looking (another app, the thread sheet, offline) and the list followed the bottom, a catch-up or a reload
    /// filled in rows, or a scroll has not landed yet. The rows on screen are then below unread rows never shown, and
    /// marking them would skip those (§10). A row still partly on screen was seen: reading down keeps the anchor.
    static func passedUnseen(_ firstUnread: MessageState?, visibleSeqs: [Int], onScreenIds: Set<String>) -> Bool {
        guard let first = firstUnread, let seq = first.seq, let top = visibleSeqs.min(), seq < top else { return false }
        return !onScreenIds.contains(first.id)
    }

    static func jumpButtonShown(ready: Bool, unreadCount: Int) -> Bool { ready || unreadCount <= unreadJumpMax }

    /// 「ここから未読にする」 on the row with `seq` (§10.1 10.): moving the position back is always offered; moving it
    /// forward reads the rows before `seq`, so only while every unread row is held (unread rows this device never loaded
    /// would be read on every device otherwise).
    static func markUnreadOffered(_ channel: ChannelState, seq: Int) -> Bool { seq - 1 <= channel.lastReadSeq || readRangeReady(channel) }

    /// The read position a view captures for its 「新着メッセージ」 divider when it opens, or comes back from the search
    /// context (§10.1 4.); nil when nothing is unread.
    static func openMark(_ channel: ChannelState) -> Int? { channel.unreadCount > 0 ? channel.lastReadSeq : nil }

    /// §10.1 4.: a channel opened while its catch-up is on its way (connecting or online, the window short of last_seq)
    /// is placed once the catch-up is in, as the first unread row may be in it. Not when offline (nothing comes), once
    /// the reader has scrolled, or after the wait (3 s) is over.
    static func placementWaits(_ channel: ChannelState, status: EngineStatus?, userScrolled: Bool, waitOver: Bool) -> Bool {
        channel.isMember && catchingUp(channel, status: status) && !userScrolled && !waitOver
    }

    /// The window has not caught up to last_seq while connected (or connecting): a catch-up is on its way.
    static func catchingUp(_ channel: ChannelState, status: EngineStatus?) -> Bool {
        (status == .online || status == .connecting) && !reachesNewest(channel)
    }

    /// 「新着 N 件」: rows from others after `seenSeq` (the read position at open, or the newest row seen at the bottom).
    /// Every row it counts is held: a view whose unread rows are not all held opens at the bottom and sees them (§10.1 7.).
    static func newBelow(_ rows: [MessageState], seenSeq: Int?, meId: String?) -> Int {
        guard let seenSeq else { return 0 }
        return rows.filter { ($0.seq ?? 0) > seenSeq && $0.senderId != meId }.count
    }

    /// Being at the bottom sees the newest row, but only once the view is placed and no landing is on its way (§10.1
    /// 7.): the list starts at the bottom before it is placed, and counting that as seen would make 「新着 N 件」 0 for
    /// a view that opens at the divider.
    static func seenAtBottom(_ seenSeq: Int?, rows: [MessageState], placed: Bool) -> Int? {
        guard placed, let newest = rows.compactMap(\.seq).max(), newest > (seenSeq ?? 0) else { return seenSeq }
        return newest
    }

    /// §10.1 7.: a view the reader scrolled before it was placed stays where it is. 「新着 N 件」 then counts from the
    /// divider when every row after it is held, and otherwise from the newest row: rows past a partial range are never
    /// counted as if they were all the unread ones.
    static func seenLeftInPlace(_ rows: [MessageState], dividerMark: Int?) -> Int? {
        dividerMark ?? rows.compactMap(\.seq).max()
    }

    /// Only this device's own top-level post, while it is still pending, takes the timeline to the bottom (§10.1 11.).
    /// Replies (also sent to the channel or not), posts from my other devices and scheduled ones follow the bottom like
    /// anyone else's: jumping there would pass unread rows unseen.
    static func ownPendingPost(_ row: MessageState?, meId: String?) -> Bool {
        guard let row, let meId else { return false }
        return row.pending && row.senderId == meId && row.parentId == nil
    }

    /// 「10:23」 today, 「昨日 23:05」, otherwise the day separator's words and the time. Always 24 h and zero-padded,
    /// whatever the locale; nil when the timestamp does not parse.
    static func sinceLabel(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String? {
        guard let date = parseIsoDate(iso) else { return nil }
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        if calendar.isDate(date, inSameDayAs: now) { return time }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "昨日 " + time }
        return Timeline.dayLabel(date, now: now, calendar: calendar) + " " + time
    }

    /// 「未読 2,000 件 · 10:23 以降」; the count is the server's, grouped with ASCII commas in any locale.
    static func bannerText(_ count: Int, firstUnreadAt: String?, now: Date = Date(), calendar: Calendar = .current) -> String {
        let since = firstUnreadAt.flatMap { sinceLabel($0, now: now, calendar: calendar) }
        return "未読 \(group3(count)) 件" + (since.map { " · \($0) 以降" } ?? "")
    }

    static func group3(_ n: Int) -> String {
        let digits = Array(String(n.magnitude))
        var out = n < 0 ? "-" : ""
        for (index, digit) in digits.enumerated() {
            if index > 0 && (digits.count - index) % 3 == 0 { out.append(",") }
            out.append(digit)
        }
        return out
    }

    /// The unread banner at the top of a conversation (§10.1 5.); nil = hidden.
    struct Banner: Equatable {
        var text: String
        /// 「最初の未読へ」 is offered (「既読にする」 always is).
        var jump: Bool
        /// 「読み込み中…」 replaces both buttons.
        var loading: Bool
        /// Both buttons are disabled while offline.
        var enabled: Bool
    }

    /// `firstUnreadHeld`: a row from someone else past the read position is held. While a catch-up is on its way and
    /// none is, the banner stays hidden: the unread rows are coming, and it would flash on every reconnect.
    static func banner(_ channel: ChannelState, focused: Bool, positioned: Bool, anchored: Bool, held: Bool, jumping: Bool, status: EngineStatus?,
                       firstUnreadHeld: Bool = true, now: Date = Date(), calendar: Calendar = .current) -> Banner? {
        guard !focused, positioned, channel.unreadCount > 0, !anchored, !held else { return nil }
        if !firstUnreadHeld && catchingUp(channel, status: status) { return nil }
        return Banner(text: bannerText(channel.unreadCount, firstUnreadAt: channel.firstUnreadAt, now: now, calendar: calendar),
                      jump: jumpButtonShown(ready: readRangeReady(channel), unreadCount: channel.unreadCount), loading: jumping, enabled: status == .online)
    }

    /// Where a view scrolls when it opens: a list row key, or the bottom (newest).
    enum Target: Equatable {
        case center(String)
        case top(String)
        case bottom
    }

    /// §10.1 4.: a search / permalink hit in the middle; otherwise the divider's row at the top when it can be drawn;
    /// otherwise the newest row. Rows are keyed by rowKey and targets named by message id, so lookups go through the
    /// message (§10.3).
    static func openTarget(_ rows: [MessageState], focusId: String?, mark: Int?, meId: String?) -> Target {
        if let focusId { return .center(rows.first { $0.id == focusId }?.rowKey ?? focusId) }
        if let mark, let first = firstUnreadRow(rows, afterSeq: mark, meId: meId) { return .top(first.rowKey) }
        return .bottom
    }

    /// §10.2: a thread positions the same way once its replies and read position are known.
    static func threadTarget(_ replies: [MessageState], focusId: String?, lastReadSeq: Int, meId: String?) -> Target {
        openTarget(replies, focusId: focusId, mark: lastReadSeq, meId: meId)
    }
}

/// The read anchor of one open view (§10.1 2. for a channel, §10.2 for a thread), kept out of the views so the order of
/// events can be tested: visible rows mark read only while anchored, and nothing is judged while a positioning scroll
/// is on its way (the frames still describe the old viewport).
struct ReadAnchor: Equatable {
    /// A scroll that brings the first unread row to the top (opening at the divider, 「最初の未読へ」).
    struct Landing: Equatable {
        /// The row's message id (frames are keyed by it) and its list key (what is scrolled to), §10.3.
        let rowId: String
        let rowKey: String
        /// Tells two landings on the same row apart, so the scroll runs again.
        let serial: Int
    }

    private(set) var anchored = false
    private(set) var landing: Landing?
    private var serial = 0

    /// The unread banner is hidden while anchored, and while a landing is on its way (it would flash).
    var hidesBanner: Bool { anchored || landing != nil }

    /// Opened, or back from the search context: the first unread row has to be seen again.
    mutating func reset() {
        anchored = false
        landing = nil
    }

    /// The read position went down (「ここから未読にする」 here or on another device, bootstrap), or a hold ended
    /// without a read: the rows on screen may be past unread rows that were never shown.
    mutating func positionLowered() { anchored = false }

    mutating func land(on row: MessageState) {
        serial += 1
        landing = Landing(rowId: row.id, rowKey: row.rowKey, serial: serial)
    }

    /// The landing scroll is over, wherever it ended: the next look judges from real frames.
    mutating func landed() { landing = nil }

    /// One look at the screen; returns the seq visible rows may mark read. `unreadCount` is the channel's (nil for a
    /// thread, whose count says nothing about the rows held), `ready` whether every unread row is held, `visible` the
    /// rows passing the visibility predicate, `onScreenIds` the message ids of rows at least partly on screen.
    mutating func observe(unreadCount: Int?, ready: Bool, firstUnread: MessageState?, visible: [MessageState], onScreenIds: Set<String>) -> Int? {
        guard landing == nil else { return nil }
        let ids = Set(visible.map(\.id))
        var next = if let unreadCount {
            ReadGate.nextAnchored(anchored, unreadCount: unreadCount, ready: ready, firstUnread: firstUnread, visibleMessageIds: ids)
        } else {
            ready && (anchored || firstUnread.map { ids.contains($0.id) } ?? true)
        }
        let seqs = visible.compactMap(\.seq)
        if next, unreadCount != 0, ReadGate.passedUnseen(firstUnread, visibleSeqs: seqs, onScreenIds: onScreenIds) { next = false }
        anchored = next
        return next ? seqs.max() : nil
    }
}

/// M25: scrolling up to the top of the loaded range loads the page before it by itself, as on Android (its 「older」
/// item), in place of the 「以前のメッセージを読み込む」 button; the reader's place is kept while the page goes in
/// above. The rules are pure so their order can be tested.
enum OlderPaging {
    /// The progress row at the top of the list is on screen: its real frame in the list's visible coordinates (0 at the
    /// top), not onAppear, which LazyVStack also sends for rows it builds just outside the screen.
    static func topShown(_ frame: CGRect?, viewportHeight: CGFloat) -> Bool {
        guard let frame, viewportHeight > 0 else { return false }
        return frame.maxY > 0 && frame.minY < viewportHeight
    }

    /// Whether the page before the window loads now: there is one and the window has been read (§7.3), online, the
    /// normal conversation (not the search context), the view placed and no landing on the first unread row on its way
    /// (§10.1 4./6.: its frames would be judged from the wrong place, and rows put in above would move it), nothing else
    /// loading, the list at rest (never under the reader's finger, nor while it glides), and the top row on screen. A
    /// list that fills the screen and was not scrolled never has that row on screen, so opening a channel loads
    /// nothing; a short one loads until it fills the screen or the channel has nothing older (Android does the same).
    static func shouldLoad(_ channel: ChannelState?, topRow: CGRect?, viewportHeight: CGFloat, status: EngineStatus?, focused: Bool,
                           placed: Bool, landing: Bool, busy: Bool, moving: Bool) -> Bool {
        guard let channel, channel.hasOlder, channel.syncedSeq != nil, status == .online else { return false }
        guard !focused, placed, !landing, !busy, !moving else { return false }
        return topShown(topRow, viewportHeight: viewportHeight)
    }
}
