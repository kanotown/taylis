import Foundation

/// L8 (TIMES_FEED.md §2, §5): the Times feed's rows, newest first. Pure: the screen's model (TimesFeedModel) feeds it
/// the pages of GET /times/feed and the live message events.
struct TimesFeedList: Equatable {
    private(set) var items: [MessageOut] = []
    /// The next page's cursor (opaque); nil at the end.
    private(set) var nextCursor: String?

    var hasMore: Bool { nextCursor != nil }

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

    /// The first page (opening, reconnecting, pulling to refresh): the rows are replaced.
    mutating func replace(with page: TimesFeedOut) {
        items = []
        nextCursor = page.nextCursor
        for message in page.items { insert(message) }
    }

    /// The next page: rows already held are not added again.
    mutating func append(_ page: TimesFeedOut) {
        nextCursor = page.nextCursor
        for message in page.items where index(of: message.id) == nil { insert(message) }
    }

    /// A live message.created / .updated / .deleted (§5). A held row takes the change, or goes when it is no longer a
    /// feed row (deleted, its times muted…); a new feed row is added in its place only when `adding` (the feed is on
    /// screen: while it is not, the next open reads it again).
    mutating func apply(event: String, message: MessageOut, isFeedRow: Bool, adding: Bool) {
        if let index = index(of: message.id) {
            if isFeedRow && event != "message.deleted" {
                if items[index].createdAt == message.createdAt {
                    items[index] = message
                } else {
                    items.remove(at: index)
                    insert(message)
                }
            } else {
                items.remove(at: index)
            }
        } else if event == "message.created" && isFeedRow && adding {
            insert(message)
        }
    }

    /// Leaving, muting or no longer being a times (§5): the rows of a channel that is no longer in the feed go.
    mutating func keepChannels(where keep: (String) -> Bool) {
        items.removeAll { !keep($0.channelId) }
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

    @ObservationIgnored private var request = 0
    /// Rows that came live while a first page was being read: the page may have been read before them.
    @ObservationIgnored private var cameDuringLoad: [MessageOut] = []

    typealias Fetch = (_ cursor: String?) async throws -> TimesFeedOut

    /// The first page again; the rows are replaced (§5: on open, after a reconnect, on pull to refresh).
    func refresh(fetch: Fetch, channel: (String) -> ChannelState?, now: () -> Date = Date.init) async {
        request += 1
        let id = request
        loading = true
        failure = nil
        cameDuringLoad = []
        defer { if id == request { loading = false } }
        do {
            let page = try await fetch(nil)
            guard id == request else { return }
            list.replace(with: page)
            for message in cameDuringLoad {
                list.apply(event: "message.created", message: message,
                           isFeedRow: TimesFeedList.isFeedRow(message, channel: channel(message.channelId), now: now()), adding: true)
            }
            cameDuringLoad = []
            loaded = true
        } catch {
            guard id == request else { return }
            failure = ErrorMessages.text(for: error)
        }
    }

    /// The next page, when the last row comes into view.
    func loadMore(fetch: Fetch) async {
        guard loaded, !loading, !loadingMore, let cursor = list.nextCursor else { return }
        let id = request
        loadingMore = true
        defer { loadingMore = false }
        do {
            let page = try await fetch(cursor)
            guard id == request else { return } // a refresh replaced the rows meanwhile
            list.append(page)
        } catch {
            failure = ErrorMessages.text(for: error)
        }
    }

    /// A live timeline event of any channel (SyncEngine.onTimelineMessage).
    func live(_ event: String, _ message: MessageOut, channel: ChannelState?, now: Date = Date()) {
        let row = TimesFeedList.isFeedRow(message, channel: channel, now: now)
        if loading && visible && event == "message.created" && row { cameDuringLoad.append(message) }
        list.apply(event: event, message: message, isFeedRow: row, adding: visible && loaded)
    }

    /// The feed's channels changed (left, muted, no longer a times): their rows go. A channel joined or unmuted comes
    /// with the next read of the first page (§5).
    func prune(channel: (String) -> ChannelState?, now: Date = Date()) {
        list.keepChannels { TimesFeedList.isFeedChannel(channel($0), now: now) }
    }
}
