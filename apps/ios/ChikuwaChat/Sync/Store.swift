import Foundation
import Observation

/// A channel as the client stores it: server fields plus the sync cursor (SYNC_PROTOCOL.md §7.1).
struct ChannelState: Codable, Identifiable, Equatable {
    var channel: ChannelOut
    var isMember: Bool
    /// nil: no timeline loaded yet.
    var syncedSeq: Int?
    var lastSeq: Int
    /// Server read position and counts (SYNC_PROTOCOL.md §10); counts are replaced by read.updated.
    var lastReadSeq: Int
    var unreadCount: Int
    var mentionCount: Int
    var hasOlder: Bool

    var id: String { channel.id }
    var hasUnread: Bool { unreadCount > 0 }
    /// Level "none" or an active timed mute (PUSH_NOTIFICATIONS.md §4).
    var isMuted: Bool {
        guard let pref = channel.notification else { return false }
        if pref.level == "none" { return true }
        guard let until = pref.mutedUntil.flatMap(parseIsoDate) else { return false }
        return until > Date()
    }
    /// Slack / Mattermost rule: a muted conversation is unread only when I am mentioned.
    var showsUnread: Bool { isMember && (isMuted ? mentionCount > 0 : unreadCount > 0) }
    /// What the app badge and the list show for this channel (PUSH_NOTIFICATIONS.md §4.2).
    var badgeContribution: Int { isMuted ? mentionCount : (channel.isDm ? unreadCount : mentionCount) }

    enum CodingKeys: String, CodingKey { case channel, isMember, syncedSeq, lastSeq, lastReadSeq, unreadCount, mentionCount, hasOlder }

    init(channel: ChannelOut, isMember: Bool, syncedSeq: Int?, lastSeq: Int, lastReadSeq: Int = 0, unreadCount: Int = 0, mentionCount: Int = 0, hasOlder: Bool) {
        self.channel = channel
        self.isMember = isMember
        self.syncedSeq = syncedSeq
        self.lastSeq = lastSeq
        self.lastReadSeq = lastReadSeq
        self.unreadCount = unreadCount
        self.mentionCount = mentionCount
        self.hasOlder = hasOlder
    }

    /// Rows persisted before M8b carry a local `seenSeq` instead of the server read state.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channel = try c.decode(ChannelOut.self, forKey: .channel)
        isMember = try c.decode(Bool.self, forKey: .isMember)
        syncedSeq = try c.decodeIfPresent(Int.self, forKey: .syncedSeq)
        lastSeq = try c.decode(Int.self, forKey: .lastSeq)
        lastReadSeq = try c.decodeIfPresent(Int.self, forKey: .lastReadSeq) ?? 0
        unreadCount = try c.decodeIfPresent(Int.self, forKey: .unreadCount) ?? 0
        mentionCount = try c.decodeIfPresent(Int.self, forKey: .mentionCount) ?? 0
        hasOlder = try c.decode(Bool.self, forKey: .hasOlder)
    }
}

/// A message as stored locally. Pending messages have seq nil and id "local:<client_msg_id>".
struct MessageState: Codable, Identifiable, Equatable {
    var id: String
    var channelId: String
    var senderId: String
    var seq: Int?
    var updatedSeq: Int
    var clientMsgId: String?
    var body: String
    var createdAt: String
    var editedAt: String?
    var deleted: Bool
    var pending: Bool
    var failed: Bool
    var reactions: [ReactionOut] = []
    var mentionedUserIds: [String] = []
    var mentionAll: Bool = false
    var parentId: String? = nil
    var replyCount: Int = 0
    var lastReplyAt: String? = nil
    var attachments: [AttachmentOut] = []

    enum CodingKeys: String, CodingKey {
        case id, channelId, senderId, seq, updatedSeq, clientMsgId, body, createdAt, editedAt, deleted, pending, failed
        case reactions, mentionedUserIds, mentionAll, parentId, replyCount, lastReplyAt, attachments
    }

    func reactedBy(_ userId: String, _ emoji: String) -> Bool {
        reactions.contains { $0.emoji == emoji && $0.userIds.contains(userId) }
    }

    var isReply: Bool { parentId != nil }

    init(_ message: MessageOut) {
        id = message.id
        channelId = message.channelId
        senderId = message.senderId
        seq = message.seq
        updatedSeq = message.updatedSeq
        clientMsgId = message.clientMsgId
        body = message.body
        createdAt = message.createdAt
        editedAt = message.editedAt
        deleted = message.deleted
        pending = false
        failed = false
        reactions = message.reactions
        mentionedUserIds = message.mentionedUserIds
        mentionAll = message.mentionAll
        parentId = message.parentId
        replyCount = message.replyCount
        lastReplyAt = message.lastReplyAt
        attachments = message.attachments
    }

    /// Rows persisted before M8a lack the reaction / mention fields.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        channelId = try c.decode(String.self, forKey: .channelId)
        senderId = try c.decode(String.self, forKey: .senderId)
        seq = try c.decodeIfPresent(Int.self, forKey: .seq)
        updatedSeq = try c.decode(Int.self, forKey: .updatedSeq)
        clientMsgId = try c.decodeIfPresent(String.self, forKey: .clientMsgId)
        body = try c.decode(String.self, forKey: .body)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        editedAt = try c.decodeIfPresent(String.self, forKey: .editedAt)
        deleted = try c.decode(Bool.self, forKey: .deleted)
        pending = try c.decode(Bool.self, forKey: .pending)
        failed = try c.decode(Bool.self, forKey: .failed)
        reactions = try c.decodeIfPresent([ReactionOut].self, forKey: .reactions) ?? []
        mentionedUserIds = try c.decodeIfPresent([String].self, forKey: .mentionedUserIds) ?? []
        mentionAll = try c.decodeIfPresent(Bool.self, forKey: .mentionAll) ?? false
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        replyCount = try c.decodeIfPresent(Int.self, forKey: .replyCount) ?? 0
        lastReplyAt = try c.decodeIfPresent(String.self, forKey: .lastReplyAt)
        attachments = try c.decodeIfPresent([AttachmentOut].self, forKey: .attachments) ?? []
    }

    init(placeholderFor clientMsgId: String, channelId: String, senderId: String, body: String, createdAt: String, parentId: String? = nil) {
        id = localPrefix + clientMsgId
        self.channelId = channelId
        self.senderId = senderId
        seq = nil
        updatedSeq = -1
        self.clientMsgId = clientMsgId
        self.body = body
        self.createdAt = createdAt
        editedAt = nil
        deleted = false
        pending = true
        failed = false
        self.parentId = parentId
    }
}

/// One row of the threads view (THREADS.md §5): the parent and my relation to the thread. Not persisted:
/// the badge comes with bootstrap and the list is fetched when the view opens.
struct ThreadEntry: Identifiable, Equatable {
    var parent: MessageOut
    var state: ThreadState
    var id: String { parent.id }
}

extension MessageOut {
    /// A confirmed local row in the server shape (thread rows built from the timeline).
    init?(_ state: MessageState) {
        guard let seq = state.seq, !state.pending else { return nil }
        self.init(id: state.id, channelId: state.channelId, senderId: state.senderId, seq: seq, updatedSeq: state.updatedSeq,
                  clientMsgId: state.clientMsgId, body: state.body, createdAt: state.createdAt, editedAt: state.editedAt, deleted: state.deleted,
                  mentionedUserIds: state.mentionedUserIds, mentionAll: state.mentionAll, reactions: state.reactions, parentId: state.parentId,
                  replyCount: state.replyCount, lastReplyAt: state.lastReplyAt, attachments: state.attachments)
    }
}

struct OutboxItem: Codable, Identifiable, Equatable {
    var clientMsgId: String
    var channelId: String
    var body: String
    var createdAt: String
    var failed: String?
    var parentId: String? = nil
    var attachmentIds: [String] = []

    var id: String { clientMsgId }
}

struct Draft: Codable, Equatable {
    var text = ""
    var attachments: [AttachmentOut] = []
}

struct Snapshot: Codable {
    var meta: [String: String] = [:]
    var users: [UserPublic] = []
    var channels: [ChannelState] = []
    var messages: [MessageState] = []
    var outbox: [OutboxItem] = []
}

/// Write-through persistence (SQLite in the app; nil in tests).
protocol Persistence {
    func loadAll() throws -> Snapshot
    func saveMeta(key: String, value: String?) throws
    func saveUser(_ user: UserPublic) throws
    func saveChannel(_ channel: ChannelState) throws
    func deleteChannel(id: String) throws
    func saveMessage(_ message: MessageState) throws
    func deleteMessage(id: String) throws
    func clearMessages(channelId: String) throws
    func saveOutbox(_ item: OutboxItem) throws
    func deleteOutbox(clientMsgId: String) throws
}

let localPrefix = "local:"

/// The single source of truth for the UI (ARCHITECTURE.md §11).
@MainActor
@Observable
final class Store {
    var me: UserMe?
    var users: [String: UserPublic] = [:]
    var channels: [String: ChannelState] = [:]
    var outbox: [OutboxItem] = []
    /// Followed threads (THREADS.md §5), replaced by thread.updated and GET /threads pages.
    var threads: [String: ThreadEntry] = [:]
    var threadSummary = ThreadSummary(unreadCount: 0, mentionCount: 0)
    var threadsFilter = "all"
    var threadsLoaded = false
    var threadsCursor: String?
    var threadsHasMore = false
    private var drafts: [String: Draft] = [:]
    private var uploads: [String: Int] = [:]

    private func draftKey(_ channelId: String, _ parentId: String?) -> String { "draft:\(channelId):\(parentId ?? "")" }
    func draft(_ channelId: String, parentId: String? = nil) -> Draft { drafts[draftKey(channelId, parentId)] ?? Draft() }
    func setDraft(_ channelId: String, parentId: String? = nil, _ mutate: (inout Draft) -> Void) {
        let key = draftKey(channelId, parentId)
        var value = draft(channelId, parentId: parentId)
        mutate(&value)
        drafts[key] = value.text.isEmpty && value.attachments.isEmpty ? nil : value
        let encoded = drafts[key].flatMap { try? JSON.plainEncoder.encode($0) }.flatMap { String(data: $0, encoding: .utf8) }
        persist { try $0.saveMeta(key: key, value: encoded) }
    }
    func uploading(_ channelId: String, parentId: String? = nil) -> Int { uploads[draftKey(channelId, parentId)] ?? 0 }
    func trackUpload(_ channelId: String, parentId: String? = nil, delta: Int) {
        let key = draftKey(channelId, parentId)
        uploads[key] = max(0, (uploads[key] ?? 0) + delta)
    }
    private var messagesByChannel: [String: [String: MessageState]] = [:]
    private let persistence: Persistence?

    init(persistence: Persistence? = nil) {
        self.persistence = persistence
    }

    func load() {
        guard let persistence, let snapshot = try? persistence.loadAll() else { return }
        apply(snapshot)
    }

    private func apply(_ snapshot: Snapshot) {
        for (key, value) in snapshot.meta where key.hasPrefix("draft:") {
            if let data = value.data(using: .utf8), let draft = try? JSON.plainDecoder.decode(Draft.self, from: data) { drafts[key] = draft }
        }
        if let me = snapshot.meta["me"], let data = me.data(using: .utf8) { self.me = try? JSON.plainDecoder.decode(UserMe.self, from: data) }
        for user in snapshot.users { users[user.id] = user }
        for channel in snapshot.channels { channels[channel.id] = channel }
        for message in snapshot.messages { messagesByChannel[message.channelId, default: [:]][message.id] = message }
        outbox = snapshot.outbox
    }

    private func persist(_ work: (Persistence) throws -> Void) {
        guard let persistence else { return }
        do { try work(persistence) } catch { print("persist failed: \(error)") }
    }

    // MARK: me / users

    func setMe(_ me: UserMe?) {
        self.me = me
        let encoded = me.flatMap { try? JSON.plainEncoder.encode($0) }.flatMap { String(data: $0, encoding: .utf8) }
        persist { try $0.saveMeta(key: "me", value: encoded) }
    }

    func upsertUser(_ user: UserPublic) {
        users[user.id] = user
        persist { try $0.saveUser(user) }
    }

    // MARK: channels

    func channel(_ id: String) -> ChannelState? { channels[id] }

    /// Merge server fields into the local channel, keeping the local cursor.
    @discardableResult
    func upsertChannel(_ channel: ChannelOut, isMember: Bool? = nil) -> ChannelState {
        let existing = channels[channel.id]
        let read = channel.readState
        var stripped = channel
        stripped.readState = nil
        // channel.updated events carry no per-user preference: keep the one we know.
        stripped.notification = channel.notification ?? existing?.channel.notification
        let merged = ChannelState(
            channel: stripped,
            isMember: isMember ?? existing?.isMember ?? (channel.membership != nil),
            syncedSeq: existing?.syncedSeq,
            lastSeq: max(existing?.lastSeq ?? 0, channel.lastSeq),
            lastReadSeq: max(existing?.lastReadSeq ?? 0, read?.lastReadSeq ?? 0),
            unreadCount: read?.unreadCount ?? existing?.unreadCount ?? 0,
            mentionCount: read?.mentionCount ?? existing?.mentionCount ?? 0,
            hasOlder: existing?.hasOlder ?? true
        )
        channels[channel.id] = merged
        persist { try $0.saveChannel(merged) }
        return merged
    }

    /// Unread DMs + channel mentions + followed threads with an unread mention (PUSH_NOTIFICATIONS.md §4.2).
    var badgeCount: Int { channels.values.reduce(0) { $0 + $1.badgeContribution } + threadSummary.mentionCount }

    // MARK: threads (THREADS.md §5)

    func setThreadSummary(_ summary: ThreadSummary) { threadSummary = summary }

    /// A page of GET /threads. Rows merge so an open thread keeps its state across filter changes and
    /// refreshes; on a first page, rows the server would have listed but did not (unfollowed or deleted
    /// elsewhere) are dropped.
    func setThreadPage(filter: String, items: [ThreadItem], cursor: String?, append: Bool, pageSize: Int) {
        if !append {
            let listed = Set(items.map(\.parent.id))
            let oldest = items.count >= pageSize ? (items.last?.state.lastReplyAt ?? "") : ""
            for (id, entry) in threads where !listed.contains(id) && entry.state.following {
                if filter == "unread" && entry.state.unreadCount == 0 { continue }
                if (entry.state.lastReplyAt ?? "") >= oldest { threads[id] = nil }
            }
        }
        for item in items { threads[item.parent.id] = ThreadEntry(parent: item.parent, state: item.state) }
        threadsFilter = filter
        threadsLoaded = true
        threadsCursor = cursor
        threadsHasMore = items.count >= pageSize
    }

    /// thread.updated / a PUT response: replace the state; the badge moves with it when the old state is known.
    func applyThreadState(_ state: ThreadState, parent: MessageOut? = nil) {
        let before = threads[state.parentId]?.state
        if var entry = threads[state.parentId] {
            entry.state = state
            entry.parent.replyCount = state.replyCount
            entry.parent.lastReplyAt = state.lastReplyAt
            threads[state.parentId] = entry
        } else if var known = parent ?? messagesByChannel[state.channelId]?[state.parentId].flatMap(MessageOut.init) {
            known.replyCount = state.replyCount
            known.lastReplyAt = state.lastReplyAt
            threads[state.parentId] = ThreadEntry(parent: known, state: state)
        }
        if let before {
            let unread = (state.following && state.unreadCount > 0 ? 1 : 0) - (before.following && before.unreadCount > 0 ? 1 : 0)
            let mention = (state.following && state.mentionCount > 0 ? 1 : 0) - (before.following && before.mentionCount > 0 ? 1 : 0)
            threadSummary = ThreadSummary(unreadCount: max(0, threadSummary.unreadCount + unread), mentionCount: max(0, threadSummary.mentionCount + mention))
        }
    }

    /// The rows of the threads view: followed, newest reply first, unread only when that filter is on.
    func threadList(filter: String? = nil) -> [ThreadEntry] {
        let filter = filter ?? threadsFilter
        return threads.values
            .filter { $0.state.following && (filter == "all" || $0.state.unreadCount > 0) }
            .sorted { ($0.state.lastReplyAt ?? "", $0.parent.seq) > ($1.state.lastReplyAt ?? "", $1.parent.seq) }
    }

    func setNotification(_ channelId: String, level: String, mutedUntil: String?) {
        updateChannel(channelId) { state in
            state.channel.notification = NotificationPreferenceOut(channelId: channelId, level: level, mutedUntil: mutedUntil)
        }
    }

    func updateChannel(_ id: String, _ mutate: (inout ChannelState) -> Void) {
        guard var state = channels[id] else { return }
        mutate(&state)
        channels[id] = state
        persist { try $0.saveChannel(state) }
    }

    func removeChannel(_ id: String) {
        channels[id] = nil
        messagesByChannel[id] = nil
        persist {
            try $0.clearMessages(channelId: id)
            try $0.deleteChannel(id: id)
        }
    }

    // MARK: messages

    /// Confirmed messages by seq, then pending ones in creation order (SYNC_PROTOCOL.md §9).
    /// Top-level messages: confirmed by seq, then pending ones in creation order (SYNC_PROTOCOL.md §9).
    func messages(_ channelId: String) -> [MessageState] {
        ordered((messagesByChannel[channelId] ?? [:]).values.filter { !$0.isReply })
    }

    /// A thread: the replies of one parent, oldest first (pending ones last).
    func replies(_ channelId: String, parentId: String) -> [MessageState] {
        ordered((messagesByChannel[channelId] ?? [:]).values.filter { $0.parentId == parentId })
    }

    private func ordered(_ all: some Collection<MessageState>) -> [MessageState] {
        let confirmed = all.filter { $0.seq != nil }.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
        let pending = all.filter { $0.seq == nil }.sorted { $0.createdAt < $1.createdAt }
        return confirmed + pending
    }

    func message(_ channelId: String, _ id: String) -> MessageState? { messagesByChannel[channelId]?[id] }
    func message(_ channelId: String, id: String) -> MessageState? { messagesByChannel[channelId]?[id] }

    /// A reply moved the parent's counters (message.created / message.deleted with parent_thread).
    func applyParentThread(_ channelId: String, _ thread: ParentThread) {
        guard var bucket = messagesByChannel[channelId], var parent = bucket[thread.id], thread.updatedSeq > parent.updatedSeq else { return }
        parent.replyCount = thread.replyCount
        parent.lastReplyAt = thread.lastReplyAt
        parent.updatedSeq = thread.updatedSeq
        bucket[parent.id] = parent
        messagesByChannel[channelId] = bucket
        persist { try $0.saveMessage(parent) }
    }

    /// The merge rule (SYNC_PROTOCOL.md §8): newer updated_seq wins; tombstones delete.
    @discardableResult
    func upsertMessage(_ message: MessageOut) -> Bool { upsertMessage(MessageState(message)) }

    @discardableResult
    func upsertMessage(_ message: MessageState) -> Bool {
        var bucket = messagesByChannel[message.channelId] ?? [:]
        if let clientMsgId = message.clientMsgId {
            let placeholder = localPrefix + clientMsgId
            if bucket.removeValue(forKey: placeholder) != nil { persist { try $0.deleteMessage(id: placeholder) } }
        }
        if let local = bucket[message.id], message.updatedSeq <= local.updatedSeq {
            messagesByChannel[message.channelId] = bucket
            return false
        }
        if message.deleted {
            bucket[message.id] = nil
            persist { try $0.deleteMessage(id: message.id) }
        } else {
            bucket[message.id] = message
            persist { try $0.saveMessage(message) }
        }
        messagesByChannel[message.channelId] = bucket
        return true
    }

    func putPlaceholder(_ message: MessageState) {
        messagesByChannel[message.channelId, default: [:]][message.id] = message
        persist { try $0.saveMessage(message) }
    }

    func markPlaceholderFailed(channelId: String, clientMsgId: String, failed: Bool) {
        let id = localPrefix + clientMsgId
        guard var message = messagesByChannel[channelId]?[id] else { return }
        message.failed = failed
        messagesByChannel[channelId]?[id] = message
        persist { try $0.saveMessage(message) }
    }

    func clearMessages(_ channelId: String) {
        messagesByChannel[channelId] = nil
        persist { try $0.clearMessages(channelId: channelId) }
    }

    // MARK: outbox

    func addOutbox(_ item: OutboxItem) {
        outbox.append(item)
        persist { try $0.saveOutbox(item) }
    }

    func removeOutbox(_ clientMsgId: String) {
        outbox.removeAll { $0.clientMsgId == clientMsgId }
        persist { try $0.deleteOutbox(clientMsgId: clientMsgId) }
    }

    func markOutboxFailed(_ clientMsgId: String, reason: String?) {
        guard let index = outbox.firstIndex(where: { $0.clientMsgId == clientMsgId }) else { return }
        outbox[index].failed = reason
        let item = outbox[index]
        markPlaceholderFailed(channelId: item.channelId, clientMsgId: clientMsgId, failed: reason != nil)
        persist { try $0.saveOutbox(item) }
    }

    // MARK: snapshots (tests, diagnostics)

    func snapshot() -> Snapshot {
        var snapshot = Snapshot()
        for (key, value) in drafts {
            if let data = try? JSON.plainEncoder.encode(value) { snapshot.meta[key] = String(data: data, encoding: .utf8) }
        }
        if let me, let data = try? JSON.plainEncoder.encode(me), let text = String(data: data, encoding: .utf8) { snapshot.meta["me"] = text }
        snapshot.users = Array(users.values)
        snapshot.channels = Array(channels.values)
        snapshot.messages = messagesByChannel.values.flatMap { $0.values }
        snapshot.outbox = outbox
        return snapshot
    }

    static func fromSnapshot(_ snapshot: Snapshot, persistence: Persistence? = nil) -> Store {
        let store = Store(persistence: persistence)
        store.apply(snapshot)
        return store
    }
}
