import Foundation

/// L8 (TIMES_FEED.md §2, §5): the Times feed's rows, newest first. Pure: the screen's model (TimesFeedModel) feeds it
/// the pages of GET /times/feed, the live message events and the rows the conversation store takes.
struct TimesFeedList: Equatable {
    private(set) var items: [MessageOut] = []
    /// The next page's cursor (opaque); nil at the end.
    private(set) var nextCursor: String?

    var hasMore: Bool { nextCursor != nil }

    /// The event name of a row the conversation store took (the delta, a page, the answer to one of my actions).
    static let stored = "stored"

    /// A times I follow (am a member of) and have not muted (§2; muted as SYNC_PROTOCOL.md §10.5).
    static func isFeedChannel(_ channel: ChannelState?, now: Date = Date()) -> Bool {
        guard let channel else { return false }
        return channel.isMember && channel.channel.timesOwnerId != nil && !channel.isMuted(now: now)
    }

    /// §5 isFeedRow: a user message, not deleted, in the channel's timeline (top-level or a reply also sent there), of a
    /// feed channel. System rows and thread-only replies stay out.
    static func isFeedRow(_ message: MessageOut, channel: ChannelState?, now: Date = Date()) -> Bool {
        message.type == "user" && !message.deleted && (message.parentId == nil || message.alsoInChannel)
            && isFeedChannel(channel, now: now)
    }

    /// The server's order: created_at descending, then id descending (UUIDv7, so the later of two rows of one instant).
    static func precedes(_ a: MessageOut, _ b: MessageOut) -> Bool {
        if a.createdAt != b.createdAt {
            if let first = parseIsoDate(a.createdAt), let second = parseIsoDate(b.createdAt) {
                if first != second { return first > second }
            } else {
                return a.createdAt > b.createdAt
            }
        }
        return a.id > b.id
    }

    /// §4: the row is past that times' read position (a small dot; nothing is marked read here). Mine never is.
    static func isNew(_ message: MessageOut, channel: ChannelState?, meId: String?) -> Bool {
        guard let channel, message.senderId != meId else { return false }
        return message.seq > channel.lastReadSeq
    }

    /// SYNC_PROTOCOL.md §8 for one held row (review #9, #10): an older version changes nothing; the same version brings
    /// only my own poll part (a response to me after the event of the same change); a newer one replaces the row but keeps
    /// the poll part of mine that an event does not carry. nil when nothing changes.
    static func merged(_ held: MessageOut, _ incoming: MessageOut) -> MessageOut? {
        if incoming.updatedSeq < held.updatedSeq { return nil }
        if incoming.updatedSeq == held.updatedSeq {
            guard let response = incoming.poll, let poll = held.poll?.withMyPart(of: response) else { return nil }
            var kept = held
            kept.poll = poll
            return kept
        }
        var out = incoming
        if let poll = out.poll { out.poll = poll.keepingMyPart(of: held.poll) }
        return out
    }

    /// The first page (opening, reconnecting, pulling to refresh): the rows are replaced. `keep` is the feed's rule at the
    /// time the page lands (review #2): a page read before a leave, a removal or a mute brings none of that channel's rows.
    mutating func replace(with page: TimesFeedOut, keep: (MessageOut) -> Bool = { _ in true }) {
        items = []
        nextCursor = page.nextCursor
        for message in page.items where keep(message) { insert(message) }
    }

    /// The next page: a row already held keeps the newer of the two versions (review #9); `keep` as for the first page.
    mutating func append(_ page: TimesFeedOut, keep: (MessageOut) -> Bool = { _ in true }) {
        nextCursor = page.nextCursor
        for message in page.items where keep(message) {
            if let index = index(of: message.id) {
                if let merged = Self.merged(items[index], message) { items[index] = merged }
            } else {
                insert(message)
            }
        }
    }

    /// A message the client learned of (§5): a live message.created / .updated / .deleted, or `Self.stored` (review #4).
    /// A held row takes a newer version, or goes when it is no longer a feed row (deleted, its times muted…); a new feed
    /// row is added only when `adding` (the feed is on screen: while it is not, the next open reads it again) — a created
    /// one always, a stored one only inside the rows read so far (older ones come with the next page). True when changed.
    @discardableResult
    mutating func apply(event: String, message: MessageOut, isFeedRow: Bool, adding: Bool) -> Bool {
        if let index = index(of: message.id) {
            if message.updatedSeq < items[index].updatedSeq { return false }
            guard isFeedRow && event != "message.deleted" else {
                items.remove(at: index)
                return true
            }
            guard let merged = Self.merged(items[index], message) else { return false }
            if items[index].createdAt == merged.createdAt {
                items[index] = merged
            } else {
                items.remove(at: index)
                insert(merged)
            }
            return true
        }
        guard isFeedRow && adding else { return false }
        guard event == "message.created" || (event == Self.stored && reaches(message)) else { return false }
        insert(message)
        return true
    }

    /// The answer to my own vote, close or schedule answer (§8, review #10): its `mine` / `my_answers` / `my_comment`.
    @discardableResult
    mutating func applyMyPart(of answer: MessageOut) -> Bool {
        guard let index = index(of: answer.id), let response = answer.poll,
              let poll = items[index].poll?.withMyPart(of: response) else { return false }
        items[index].poll = poll
        return true
    }

    /// A reply moved its parent's counters (message.created / .deleted with parent_thread, review #11): a held parent
    /// takes them when newer, as the conversation store does.
    @discardableResult
    mutating func apply(thread: ParentThread) -> Bool {
        guard let index = index(of: thread.id), thread.updatedSeq > items[index].updatedSeq else { return false }
        items[index].replyCount = thread.replyCount
        items[index].lastReplyAt = thread.lastReplyAt
        if let ids = thread.replyUserIds { items[index].replyUserIds = ids }
        items[index].updatedSeq = thread.updatedSeq
        return true
    }

    /// Leaving, muting or no longer being a times (§5): the rows of a channel that is no longer in the feed go.
    mutating func keepChannels(where keep: (String) -> Bool) {
        items.removeAll { !keep($0.channelId) }
    }

    func row(_ id: String) -> MessageOut? { index(of: id).map { items[$0] } }

    /// Inside the rows read so far: an older row comes with the next page.
    private func reaches(_ message: MessageOut) -> Bool {
        guard hasMore else { return true }
        guard let last = items.last else { return false }
        return Self.precedes(message, last)
    }

    private func index(of id: String) -> Int? { items.firstIndex { $0.id == id } }

    private mutating func insert(_ message: MessageOut) {
        if let index = index(of: message.id) {
            items[index] = message
            return
        }
        let at = items.firstIndex { Self.precedes(message, $0) } ?? items.count
        items.insert(message, at: at)
    }
}

/// The Times feed while the app runs (one per open workspace, AppController.timesFeed): the rows stay in memory only
/// (§5: nothing on disk), so a feed opened offline shows what the last open read.
@MainActor
@Observable
final class TimesFeedModel {
    static let pageSize = 50

    private(set) var list = TimesFeedList()
    /// A first page has come at least once.
    private(set) var loaded = false
    private(set) var loading = false
    private(set) var loadingMore = false
    /// Why the last read failed (the rows held stay on screen).
    private(set) var failure: String?
    /// The feed screen is on a stack (§5 feedVisible): only then do live events add rows.
    var visible = false
    /// Parents of threads opened from the feed that no row holds (a reply also sent to the channel; review #8): ThreadView
    /// falls back to them.
    private(set) var parents: [String: MessageOut] = [:]

    @ObservationIgnored private var request = 0
    /// Everything that came while a page was being read (review #3): the page may have been read before any of it, so it
    /// is applied again after the page, by updated_seq. A deletion so stays a tombstone against the page's older copy.
    @ObservationIgnored private var cameDuringLoad: [Change] = []

    enum Change {
        case message(event: String, MessageOut)
        case thread(ParentThread)
        case myPart(MessageOut)

        var updatedSeq: Int {
            switch self {
            case .message(_, let message), .myPart(let message): message.updatedSeq
            case .thread(let thread): thread.updatedSeq
            }
        }

        var channelId: String? {
            switch self {
            case .message(_, let message), .myPart(let message): message.channelId
            case .thread: nil
            }
        }
    }

    typealias Fetch = (_ cursor: String?) async throws -> TimesFeedOut
    typealias Channel = (String) -> ChannelState?

    /// The first page again; the rows are replaced (§5: on open, after a reconnect, on pull to refresh).
    func refresh(fetch: Fetch, channel: Channel, now: () -> Date = Date.init) async {
        request += 1
        let id = request
        loading = true
        failure = nil
        cameDuringLoad = []
        defer { if id == request { loading = false } }
        do {
            let page = try await fetch(nil)
            guard id == request else { return }
            let at = now()
            list.replace(with: page) { TimesFeedList.isFeedRow($0, channel: channel($0.channelId), now: at) }
            loaded = true
            replay(channel: channel, now: at)
        } catch {
            guard id == request else { return }
            failure = ErrorMessages.text(for: error)
        }
    }

    /// The next page, when the last row comes into view.
    func loadMore(fetch: Fetch, channel: Channel, now: () -> Date = Date.init) async {
        guard loaded, !loading, !loadingMore, let cursor = list.nextCursor else { return }
        let id = request
        loadingMore = true
        cameDuringLoad = []
        defer { loadingMore = false }
        do {
            let page = try await fetch(cursor)
            guard id == request else { return } // a refresh replaced the rows meanwhile
            let at = now()
            list.append(page) { TimesFeedList.isFeedRow($0, channel: channel($0.channelId), now: at) }
            replay(channel: channel, now: at)
        } catch {
            failure = ErrorMessages.text(for: error)
        }
    }

    /// A live timeline event of any channel (SyncEngine.onTimelineMessage), with the parent's new counters of a reply.
    func live(_ event: String, _ message: MessageOut, thread: ParentThread? = nil, channel: ChannelState?, now: Date = Date()) {
        take(.message(event: event, message), channel: channel, now: now)
        if let thread { take(.thread(thread), channel: nil, now: now) }
    }

    /// A row the conversation store took (Store.onMessageTaken: the delta, pages, the answers to my actions; review #4).
    func stored(_ message: MessageOut, channel: ChannelState?, now: Date = Date()) {
        take(.message(event: TimesFeedList.stored, message), channel: channel, now: now)
    }

    /// The answer to my vote or schedule answer (Store.onMyPart; review #10).
    func myPart(_ answer: MessageOut) { take(.myPart(answer), channel: nil, now: Date()) }

    /// A parent's counters moved (Store.onParentThread).
    func thread(_ thread: ParentThread) { take(.thread(thread), channel: nil, now: Date()) }

    /// The feed's channels changed (left, muted, no longer a times): their rows go. A channel joined or unmuted comes
    /// with the next read of the first page (§5). A page being read is pruned by the same rule when it lands.
    func prune(channel: Channel, now: Date = Date()) {
        list.keepChannels { TimesFeedList.isFeedChannel(channel($0), now: now) }
    }

    /// The parent of a thread opened from the feed: a row, or one fetched for it (review #8).
    func parent(_ id: String) -> MessageOut? { list.row(id) ?? parents[id] }

    func keepParent(_ message: MessageOut) {
        if let held = parents[message.id], TimesFeedList.merged(held, message) == nil { return }
        parents[message.id] = message
    }

    private func take(_ change: Change, channel: ChannelState?, now: Date) {
        if loading || loadingMore { cameDuringLoad.append(change) }
        apply(change, channel: channel, now: now)
    }

    /// One change on a copy of the rows, put back only when it changed something (every row the store takes comes by).
    private func apply(_ change: Change, channel: ChannelState?, now: Date) {
        var copy = list
        let changed: Bool
        switch change {
        case .message(let event, let message):
            changed = copy.apply(event: event, message: message, isFeedRow: TimesFeedList.isFeedRow(message, channel: channel, now: now),
                                 adding: visible && loaded)
            if let held = parents[message.id], let merged = TimesFeedList.merged(held, message) { parents[message.id] = merged }
        case .thread(let thread):
            changed = copy.apply(thread: thread)
            if var parent = parents[thread.id], thread.updatedSeq > parent.updatedSeq {
                parent.replyCount = thread.replyCount
                parent.lastReplyAt = thread.lastReplyAt
                if let ids = thread.replyUserIds { parent.replyUserIds = ids }
                parent.updatedSeq = thread.updatedSeq
                parents[thread.id] = parent
            }
        case .myPart(let answer):
            changed = copy.applyMyPart(of: answer)
        }
        if changed { list = copy }
    }

    /// The changes that came during the read, again on the page's rows, oldest version first.
    private func replay(channel: Channel, now: Date) {
        let changes = cameDuringLoad.enumerated().sorted { ($0.element.updatedSeq, $0.offset) < ($1.element.updatedSeq, $1.offset) }
        cameDuringLoad = []
        for (_, change) in changes { apply(change, channel: change.channelId.flatMap(channel), now: now) }
    }
}
