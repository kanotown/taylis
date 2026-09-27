import Foundation
@testable import ChikuwaChat

/// In-process model of the server side of SYNC_PROTOCOL.md (same behaviour as the desktop fake).
@MainActor
final class FakeServer {
    @MainActor
    final class Socket: WsTransport {
        var onMessage: ((String) -> Void)?
        var onClose: ((Int) -> Void)?
        let userId: String
        var dropNext = 0
        var closed = false
        private unowned let server: FakeServer

        init(server: FakeServer, userId: String) {
            self.server = server
            self.userId = userId
        }

        var authed = false

        func send(_ text: String) async throws {
            guard let data = text.data(using: .utf8), let frame = try? JSON.plainDecoder.decode([String: JSONValue].self, from: data) else { return }
            switch frame["type"]?.stringValue {
            case "auth":
                authed = true
                deliver(.object(["type": .string("hello"), "session_id": .string("s-" + userId), "server_time": .string(now()), "heartbeat_interval_sec": .number(30)]))
                server.announcePresence(userId)
            case "ping":
                if case .bool(true)? = frame["active"] { server.markActive(userId) }
                deliver(.object(["type": .string("pong"), "server_time": .string(now())]))
            case "typing":
                if let channelId = frame["channel_id"]?.stringValue { server.relayTyping(userId, channelId: channelId, parentId: frame["parent_id"]?.stringValue) }
            default: break
            }
        }

        func close() { closeRemote(1000) }

        func closeRemote(_ code: Int) {
            guard !closed else { return }
            closed = true
            server.sockets.removeAll { $0 === self }
            onClose?(code)
            if authed { server.announcePresence(userId) }
        }

        func deliver(_ frame: JSONValue) {
            guard !closed else { return }
            if frame["type"]?.stringValue == "event", dropNext > 0 {
                dropNext -= 1 // simulated loss
                return
            }
            let text = String(data: try! JSON.plainEncoder.encode(frame), encoding: .utf8)!
            onMessage?(text)
        }
    }

    @MainActor
    final class Api: SyncApi {
        unowned let server: FakeServer
        let userId: String
        var pendingFailure: Error?

        init(server: FakeServer, userId: String) {
            self.server = server
            self.userId = userId
        }

        private func maybeFail() throws {
            if let error = pendingFailure {
                pendingFailure = nil
                throw error
            }
        }

        func bootstrap() async throws -> BootstrapOut {
            try maybeFail()
            return server.bootstrap(for: userId)
        }

        func history(channelId: String, beforeSeq: Int?, limit: Int) async throws -> HistoryOut {
            try maybeFail()
            return try server.history(userId: userId, channelId: channelId, beforeSeq: beforeSeq, limit: limit)
        }

        func delta(channelId: String, sinceSeq: Int, limit: Int) async throws -> DeltaOut {
            try maybeFail()
            return try server.delta(userId: userId, channelId: channelId, sinceSeq: sinceSeq, limit: limit)
        }

        func postMessage(channelId: String, clientMsgId: String, body: String, parentId: String?, attachmentIds: [String]) async throws -> (MessageOut, Bool) {
            try maybeFail()
            return try server.post(channelId: channelId, senderId: userId, body: body, clientMsgId: clientMsgId, parentId: parentId, attachmentIds: attachmentIds)
        }

        func replies(messageId: String) async throws -> [MessageOut] {
            try maybeFail()
            return try server.replies(userId: userId, messageId: messageId)
        }

        func publicChannels() async throws -> [ChannelOut] {
            server.channels.values.filter { $0.channel.type == "public" && !$0.members.contains(userId) }.map { record in
                var out = record.channel
                out.memberCount = record.members.count
                return out
            }
        }

        func listReminders() async throws -> [ReminderOut] {
            try maybeFail()
            return server.reminders[userId] ?? []
        }
        func listScheduled() async throws -> [ScheduledOut] {
            try maybeFail()
            return server.scheduled[userId] ?? []
        }
        func readAll() async throws -> [ChannelReadStateOut] {
            try maybeFail()
            return try server.readAll(userId)
        }
        func markRead(channelId: String, lastReadSeq: Int) async throws -> ReadStateOut {
            try maybeFail()
            return try server.markRead(userId: userId, channelId: channelId, seq: lastReadSeq)
        }
        func threads(filter: String, cursor: String?, limit: Int) async throws -> ThreadListOut {
            try maybeFail()
            return server.threads(userId: userId, filter: filter, cursor: cursor, limit: limit)
        }
        func threadState(messageId: String) async throws -> ThreadState {
            try maybeFail()
            return try server.threadState(userId: userId, parentId: messageId)
        }
        func markThreadRead(messageId: String, lastReadSeq: Int) async throws -> ThreadState {
            try maybeFail()
            return try server.markThreadRead(userId: userId, messageId: messageId, seq: lastReadSeq)
        }
        func setThreadFollow(messageId: String, following: Bool) async throws -> ThreadState {
            try maybeFail()
            return try server.setThreadFollow(userId: userId, messageId: messageId, following: following)
        }
        func setReadPosition(channelId: String, lastReadSeq: Int) async throws -> ReadStateOut {
            try maybeFail()
            return try server.markRead(userId: userId, channelId: channelId, seq: lastReadSeq, mode: "set")
        }
    }

    struct ChannelRecord {
        var channel: ChannelOut
        var members: Set<String>
        var messages: [MessageOut]
    }

    var users: [String: UserPublic] = [:]
    var channels: [String: ChannelRecord] = [:]
    /// "user:channel" → last_read_seq (DATA_MODEL.md read_states).
    var readPositions: [String: Int] = [:]
    var sockets: [Socket] = []
    var holdEvents = false
    private var held: [(Set<String>, JSONValue)] = []
    private var byClientKey: [String: MessageOut] = [:]
    private var counter = 0
    private var eventId = 0

    func nextId() -> String {
        counter += 1
        return "00000000-0000-7000-8000-" + String(format: "%012d", counter)
    }

    fileprivate static func now() -> String { ISO8601DateFormatter().string(from: Date()) }
    private static let fractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private var clock = Date()
    /// Strictly increasing so that timestamp cursors (threads) never tie inside one test.
    private func now() -> String {
        clock = clock.addingTimeInterval(0.001)
        return Self.fractional.string(from: clock)
    }

    @discardableResult
    func addUser(_ username: String, role: String = "member") -> UserPublic {
        let user = UserPublic(id: nextId(), username: username, displayName: username.capitalized, role: role, deactivatedAt: nil, createdAt: now(), updatedAt: now())
        users[user.id] = user
        return user
    }

    func user(named username: String) -> UserPublic { users.values.first { $0.username == username }! }

    @discardableResult
    func createChannel(_ name: String, ownerId: String, type: String = "public") -> ChannelOut {
        let channel = ChannelOut(id: nextId(), type: type, name: type == "dm" || type == "group_dm" ? nil : name, topic: nil, purpose: nil, archived: false,
                                 createdBy: ownerId, lastSeq: 0, lastMessageAt: nil, createdAt: now(), updatedAt: now(), membership: nil, dmUserIds: nil)
        channels[channel.id] = ChannelRecord(channel: channel, members: [ownerId], messages: [])
        readPositions["\(ownerId):\(channel.id)"] = 0
        return channel
    }

    func join(_ channelId: String, _ userId: String) {
        guard let record = channels[channelId] else { return }
        channels[channelId]?.members.insert(userId)
        if readPositions["\(userId):\(channelId)"] == nil { readPositions["\(userId):\(channelId)"] = record.channel.lastSeq } // history before the join is read
    }

    func readState(userId: String, channelId: String) -> ReadStateOut {
        let record = channels[channelId]!
        let position = readPositions["\(userId):\(channelId)"] ?? 0
        let unread = record.messages.filter { $0.seq > position && !$0.deleted && $0.parentId == nil }
        return ReadStateOut(lastReadSeq: position, unreadCount: unread.count, mentionCount: unread.filter { $0.mentions(userId) }.count)
    }

    /// PUT /channels/{id}/read: clamp, never regress, read.updated to the user's own sockets on change.
    @discardableResult
    func markRead(userId: String, channelId: String, seq: Int, mode: String = "advance") throws -> ReadStateOut {
        let record = try requireMember(channelId, userId)
        let key = "\(userId):\(channelId)"
        let target = min(seq, record.channel.lastSeq)
        let current = readPositions[key] ?? 0
        if mode == "set" ? target != current : target > current {
            readPositions[key] = target
            let state = readState(userId: userId, channelId: channelId)
            eventId += 1
            emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("read.updated"), "ts": .string(now()),
                                    "channel_id": .string(channelId), "seq": .null,
                                    "data": .object(["channel_id": .string(channelId), "reason": .string(mode), "last_read_seq": .number(Double(state.lastReadSeq)),
                                                     "unread_count": .number(Double(state.unreadCount)), "mention_count": .number(Double(state.mentionCount))])]))
            return state
        }
        return readState(userId: userId, channelId: channelId)
    }

    // MARK: pins and bookmarks (M11c)

    /// PUT / DELETE /messages/{id}/pin: any member; a change consumes a seq (message.updated change=pin).
    @discardableResult
    func pin(channelId: String, userId: String, messageId: String, pinned: Bool) throws -> MessageOut {
        let message = try live(channelId, userId, messageId)
        if (message.pinnedAt != nil) == pinned { return message }
        let seq = bumpSeq(channelId)
        var updated = rebuild(message, updatedSeq: seq)
        updated.pinnedAt = pinned ? now() : nil
        updated.pinnedBy = pinned ? userId : nil
        replace(channelId, updated, event: "message.updated", change: "pin")
        return updated
    }

    /// user → saved message ids, newest first.
    var bookmarks: [String: [String]] = [:]
    /// Custom emoji by name (M12f); everyone gets emoji.updated.
    var customEmoji: [String: CustomEmojiOut] = [:]

    func addEmoji(_ name: String, userId: String) -> CustomEmojiOut {
        eventId += 1
        let row = CustomEmojiOut(id: "emoji-\(eventId)", name: name, contentType: "image/png", width: 32, height: 32, createdBy: userId, createdAt: now())
        customEmoji[name] = row
        return row
    }

    func emitEmoji(_ row: CustomEmojiOut, deleted: Bool) {
        if deleted { customEmoji.removeValue(forKey: row.name) } else { customEmoji[row.name] = row }
        eventId += 1
        emit(Set(users.keys), .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("emoji.updated"), "ts": .string(now()),
                                       "channel_id": .null, "seq": .null,
                                       "data": .object(["emoji": try! JSONValue.from(row), "deleted": .bool(deleted)])]))
    }

    /// "user" → open reminders (M12e).
    var reminders: [String: [ReminderOut]] = [:]

    func remind(_ userId: String, channelId: String, messageId: String, remindAt: String, note: String? = nil) -> ReminderOut {
        eventId += 1
        let row = ReminderOut(id: "rem-\(eventId)", messageId: messageId, channelId: channelId, note: note, preview: "preview", remindAt: remindAt,
                              status: "pending", firedAt: nil, createdAt: now())
        reminders[userId, default: []].append(row)
        return row
    }

    func emitReminder(_ userId: String, _ row: ReminderOut) {
        let open = row.status == "pending" || row.status == "fired"
        reminders[userId] = (reminders[userId] ?? []).filter { $0.id != row.id } + (open ? [row] : [])
        eventId += 1
        emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("reminder.updated"), "ts": .string(now()),
                                "channel_id": .string(row.channelId), "seq": .null,
                                "data": .object(["reminder": try! JSONValue.from(row)])]))
    }

    /// "user" → pending scheduled messages (M12d).
    var scheduled: [String: [ScheduledOut]] = [:]

    func schedule(_ userId: String, channelId: String, body: String, sendAt: String) -> ScheduledOut {
        eventId += 1
        let row = ScheduledOut(id: "sch-\(eventId)", channelId: channelId, parentId: nil, clientMsgId: "c-\(eventId)", body: body, attachments: [],
                               sendAt: sendAt, status: "pending", error: nil, sentMessageId: nil, createdAt: now())
        scheduled[userId, default: []].append(row)
        return row
    }

    func emitScheduled(_ userId: String, _ row: ScheduledOut) {
        scheduled[userId] = (scheduled[userId] ?? []).filter { $0.id != row.id } + (row.status == "pending" ? [row] : [])
        eventId += 1
        emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("scheduled.updated"), "ts": .string(now()),
                                "channel_id": .string(row.channelId), "seq": .null,
                                "data": .object(["scheduled": try! JSONValue.from(row)])]))
    }

    /// "user" → starred channel ids (M12a).
    var favorites: [String: [String]] = [:]

    func setFavorite(_ userId: String, channelId: String, on: Bool) {
        var list = favorites[userId] ?? []
        if on == list.contains(channelId) { return }
        if on { list.append(channelId) } else { list.removeAll { $0 == channelId } }
        favorites[userId] = list
        eventId += 1
        emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("favorite.updated"), "ts": .string(now()),
                                "channel_id": .string(channelId), "seq": .null,
                                "data": .object(["channel_id": .string(channelId), "favorite": .bool(on)])]))
    }

    /// POST /channels/read-all: every membership read to its end; read.updated per moved channel.
    func readAll(_ userId: String) throws -> [ChannelReadStateOut] {
        try channels.values.filter { $0.members.contains(userId) }.map { record in
            let state = try markRead(userId: userId, channelId: record.channel.id, seq: record.channel.lastSeq)
            return ChannelReadStateOut(channelId: record.channel.id, lastReadSeq: state.lastReadSeq, unreadCount: state.unreadCount, mentionCount: state.mentionCount)
        }
    }

    func setBookmark(_ userId: String, messageId: String, on: Bool) {
        var list = bookmarks[userId] ?? []
        if on == list.contains(messageId) { return }
        if on { list.insert(messageId, at: 0) } else { list.removeAll { $0 == messageId } }
        bookmarks[userId] = list
        let channelId = channels.values.first { $0.messages.contains { $0.id == messageId } }?.channel.id
        eventId += 1
        emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("bookmark.updated"), "ts": .string(now()),
                                "channel_id": channelId.map(JSONValue.string) ?? .null, "seq": .null,
                                "data": .object(["message_id": .string(messageId), "channel_id": channelId.map(JSONValue.string) ?? .null, "bookmarked": .bool(on)])]))
    }

    // MARK: presence / typing (SYNC_PROTOCOL.md §5.2, volatile)

    /// Users whose window is "away" (set by tests); everyone connected is online otherwise.
    var awayUsers = Set<String>()
    private var announced: [String: String] = [:]

    func presenceOf(_ userId: String) -> String {
        guard sockets.contains(where: { $0.userId == userId && $0.authed }) else { return "offline" }
        return awayUsers.contains(userId) ? "away" : "online"
    }

    func markActive(_ userId: String) {
        if awayUsers.remove(userId) != nil { announcePresence(userId) }
    }

    /// Broadcast a presence frame when the user's status changed.
    func announcePresence(_ userId: String) {
        let status = presenceOf(userId)
        if (announced[userId] ?? "offline") == status { return }
        if status == "offline" { announced[userId] = nil } else { announced[userId] = status }
        for socket in sockets where socket.authed {
            socket.deliver(.object(["type": .string("presence"), "user_id": .string(userId), "status": .string(status)]))
        }
    }

    func relayTyping(_ userId: String, channelId: String, parentId: String?) {
        guard let record = channels[channelId], record.members.contains(userId) else { return }
        for socket in sockets where socket.authed && socket.userId != userId && record.members.contains(socket.userId) {
            socket.deliver(.object(["type": .string("typing"), "channel_id": .string(channelId), "parent_id": parentId.map(JSONValue.string) ?? .null, "user_id": .string(userId)]))
        }
    }

    // MARK: threads (THREADS.md §2)

    struct ThreadFollow {
        let parentId: String
        let userId: String
        var following: Bool
        var lastReadSeq: Int
        let order: Int
    }

    /// "parent:user" → follow row; `order` doubles as created_at.
    var threadFollows: [String: ThreadFollow] = [:]
    private var followOrder = 0

    private func followers(_ parentId: String) -> [String] {
        threadFollows.values.filter { $0.parentId == parentId && $0.following }.sorted { $0.order < $1.order }.map(\.userId)
    }

    private func autoFollow(_ parentId: String, _ userIds: [String]) {
        for userId in userIds where threadFollows["\(parentId):\(userId)"] == nil {
            followOrder += 1
            threadFollows["\(parentId):\(userId)"] = ThreadFollow(parentId: parentId, userId: userId, following: true, lastReadSeq: 0, order: followOrder)
        }
    }

    private func threadParent(_ messageId: String) throws -> (record: ChannelRecord, parent: MessageOut) {
        for record in channels.values {
            guard let message = record.messages.first(where: { $0.id == messageId && !$0.deleted }) else { continue }
            let parent = message.parentId.flatMap { pid in record.messages.first { $0.id == pid } } ?? message
            return (record, parent)
        }
        throw ApiError.api(status: 404, code: "message_not_found", message: "not found")
    }

    func threadState(userId: String, parentId: String) throws -> ThreadState {
        let found = try threadParent(parentId)
        _ = try requireMember(found.record.channel.id, userId)
        let row = threadFollows["\(found.parent.id):\(userId)"]
        let lastRead = row?.lastReadSeq ?? 0
        let unread = found.record.messages.filter { $0.parentId == found.parent.id && !$0.deleted && $0.seq > lastRead && $0.senderId != userId }
        return ThreadState(parentId: found.parent.id, channelId: found.record.channel.id, following: row?.following ?? false, lastReadSeq: lastRead,
                           unreadCount: unread.count, mentionCount: unread.filter { $0.mentions(userId) }.count,
                           replyCount: found.parent.replyCount, lastReplyAt: found.parent.lastReplyAt, participantIds: followers(found.parent.id))
    }

    private func emitThread(_ parentId: String, to userIds: [String], reason: String) {
        for userId in userIds {
            guard let state = try? threadState(userId: userId, parentId: parentId), case .object(var fields) = try! JSONValue.from(state) else { continue }
            fields["reason"] = .string(reason)
            eventId += 1
            emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("thread.updated"), "ts": .string(now()),
                                    "channel_id": .string(state.channelId), "seq": .null, "data": .object(fields)]))
        }
    }

    func threadSummary(for userId: String) -> ThreadSummary {
        let states = threadFollows.values.filter { $0.userId == userId && $0.following }.compactMap { try? threadState(userId: userId, parentId: $0.parentId) }
        return ThreadSummary(unreadCount: states.filter { $0.unreadCount > 0 }.count, mentionCount: states.filter { $0.mentionCount > 0 }.count)
    }

    func threads(userId: String, filter: String, cursor: String?, limit: Int) -> ThreadListOut {
        var items: [ThreadItem] = threadFollows.values.filter { $0.userId == userId && $0.following }.compactMap { row in
            guard let found = try? threadParent(row.parentId), !found.parent.deleted, found.parent.replyCount > 0,
                  let state = try? threadState(userId: userId, parentId: row.parentId) else { return nil }
            return ThreadItem(parent: found.parent, state: state)
        }
        items.sort { ($0.parent.lastReplyAt ?? "", $0.parent.seq) > ($1.parent.lastReplyAt ?? "", $1.parent.seq) }
        if let cursor { items = items.filter { ($0.parent.lastReplyAt ?? "") < cursor } }
        if filter == "unread" { items = items.filter { $0.state.unreadCount > 0 } }
        items = Array(items.prefix(limit))
        return ThreadListOut(items: items, nextCursor: items.last?.parent.lastReplyAt, summary: threadSummary(for: userId))
    }

    @discardableResult
    func markThreadRead(userId: String, messageId: String, seq: Int) throws -> ThreadState {
        let found = try threadParent(messageId)
        _ = try requireMember(found.record.channel.id, userId)
        let newest = found.record.messages.filter { $0.parentId == found.parent.id && !$0.deleted }.map(\.seq).max() ?? 0
        let target = min(seq, newest)
        let key = "\(found.parent.id):\(userId)"
        autoFollow(found.parent.id, [userId])
        if target > threadFollows[key]!.lastReadSeq {
            threadFollows[key]!.lastReadSeq = target
            emitThread(found.parent.id, to: [userId], reason: "read")
        }
        return try threadState(userId: userId, parentId: found.parent.id)
    }

    @discardableResult
    func setThreadFollow(userId: String, messageId: String, following: Bool) throws -> ThreadState {
        let found = try threadParent(messageId)
        _ = try requireMember(found.record.channel.id, userId)
        let key = "\(found.parent.id):\(userId)"
        let changed = threadFollows[key]?.following != following
        autoFollow(found.parent.id, [userId])
        threadFollows[key]!.following = following
        if changed { emitThread(found.parent.id, to: [userId], reason: "follow") }
        return try threadState(userId: userId, parentId: found.parent.id)
    }

    func replies(userId: String, messageId: String) throws -> [MessageOut] {
        guard let record = channels.values.first(where: { $0.messages.contains { $0.id == messageId } }) else { return [] }
        _ = try requireMember(record.channel.id, userId)
        return record.messages.filter { $0.parentId == messageId && !$0.deleted }.sorted { $0.seq < $1.seq }
    }

    private func requireMember(_ channelId: String, _ userId: String) throws -> ChannelRecord {
        guard let record = channels[channelId] else { throw ApiError.api(status: 404, code: "channel_not_found", message: "not found") }
        guard record.members.contains(userId) else { throw ApiError.api(status: 403, code: "not_a_member", message: "not a member") }
        return record
    }

    @discardableResult
    func post(channelId: String, senderId: String, body: String, clientMsgId: String? = nil, parentId: String? = nil, attachmentIds: [String] = []) throws -> (MessageOut, Bool) {
        var record = try requireMember(channelId, senderId)
        let key = clientMsgId ?? nextId()
        if let existing = byClientKey[senderId + ":" + key] {
            if existing.channelId != channelId { throw ApiError.api(status: 409, code: "idempotency_conflict", message: "conflict") }
            return (existing, false)
        }
        var parentIndex: Int?
        if let parentId {
            guard let index = record.messages.firstIndex(where: { $0.id == parentId && !$0.deleted }) else {
                throw ApiError.api(status: 404, code: "message_not_found", message: "parent not found")
            }
            if record.messages[index].parentId != nil { throw ApiError.api(status: 400, code: "reply_depth", message: "no replies to replies") }
            parentIndex = index
        }
        let seq = record.channel.lastSeq + 1
        record.channel = ChannelOut(id: record.channel.id, type: record.channel.type, name: record.channel.name, topic: nil, purpose: nil, archived: false,
                                    createdBy: record.channel.createdBy, lastSeq: seq, lastMessageAt: now(), createdAt: record.channel.createdAt,
                                    updatedAt: now(), membership: nil, dmUserIds: nil)
        let message = MessageOut(id: nextId(), channelId: channelId, senderId: senderId, seq: seq, updatedSeq: seq, clientMsgId: key, body: body,
                                 createdAt: now(), editedAt: nil, deleted: false, mentionedUserIds: Self.mentionedIds(body), mentionAll: Self.mentionsAll(body),
                                 parentId: parentId,
                                 attachments: attachmentIds.map { AttachmentOut(id: $0, filename: "file-\($0)", contentType: "application/octet-stream", sizeBytes: 1, width: nil, height: nil, hasThumbnail: false, status: "attached", createdAt: now()) })
        record.messages.append(message)
        var payloadFields: [String: JSONValue] = ["message": try! JSONValue.from(message)]
        if let parentIndex {
            let old = record.messages[parentIndex]
            let parent = rebuild(old, updatedSeq: seq, replyCount: old.replyCount + 1, lastReplyAt: message.createdAt)
            record.messages[parentIndex] = parent
            // THREADS.md §2: auto-follow, the replier has read their own reply, followers are the push targets.
            autoFollow(parent.id, [parent.senderId, senderId] + parent.mentionedUserIds + message.mentionedUserIds)
            threadFollows["\(parent.id):\(senderId)"]!.lastReadSeq = max(threadFollows["\(parent.id):\(senderId)"]!.lastReadSeq, seq)
            let thread = ParentThread(id: parent.id, replyCount: parent.replyCount, lastReplyAt: parent.lastReplyAt, updatedSeq: seq, participantIds: followers(parent.id))
            payloadFields["parent_thread"] = try! JSONValue.from(thread)
        }
        channels[channelId] = record
        byClientKey[senderId + ":" + key] = message
        eventId += 1
        let payload: JSONValue = .object(payloadFields)
        emit(record.members, .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("message.created"), "ts": .string(now()),
                                      "channel_id": .string(channelId), "seq": .number(Double(seq)), "data": payload]))
        _ = try? markRead(userId: senderId, channelId: channelId, seq: seq) // the sender has read their own message (§10)
        if let parentId { emitThread(parentId, to: followers(parentId), reason: "reply") }
        return (message, true)
    }

    static func mentionedIds(_ body: String) -> [String] {
        let regex = try! NSRegularExpression(pattern: #"<@([0-9a-f-]{36})>"#)
        let ns = body as NSString
        var ids: [String] = []
        for match in regex.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            let id = ns.substring(with: match.range(at: 1))
            if !ids.contains(id) { ids.append(id) }
        }
        return ids
    }

    static func mentionsAll(_ body: String) -> Bool { body.range(of: #"<!(channel|here)>"#, options: .regularExpression) != nil }

    func messageByBody(_ channelId: String, _ body: String) throws -> MessageOut {
        guard let message = channels[channelId]?.messages.first(where: { $0.body == body && !$0.deleted }) else {
            throw ApiError.api(status: 404, code: "message_not_found", message: "no message \(body)")
        }
        return message
    }

    private func rebuild(_ m: MessageOut, body: String? = nil, editedAt: String? = nil, updatedSeq: Int? = nil, deleted: Bool? = nil,
                         reactions: [ReactionOut]? = nil, mentionedUserIds: [String]? = nil, mentionAll: Bool? = nil,
                         replyCount: Int? = nil, lastReplyAt: String? = nil) -> MessageOut {
        MessageOut(id: m.id, channelId: m.channelId, senderId: m.senderId, seq: m.seq, updatedSeq: updatedSeq ?? m.updatedSeq, clientMsgId: m.clientMsgId,
                   body: body ?? m.body, createdAt: m.createdAt, editedAt: editedAt ?? m.editedAt, deleted: deleted ?? m.deleted, type: m.type,
                   mentionedUserIds: mentionedUserIds ?? m.mentionedUserIds, mentionAll: mentionAll ?? m.mentionAll, reactions: reactions ?? m.reactions,
                   parentId: m.parentId, replyCount: replyCount ?? m.replyCount, lastReplyAt: lastReplyAt ?? m.lastReplyAt, attachments: m.attachments,
                   pinnedAt: m.pinnedAt, pinnedBy: m.pinnedBy)
    }

    private func replace(_ channelId: String, _ updated: MessageOut, event: String, change: String? = nil) {
        guard var record = channels[channelId], let index = record.messages.firstIndex(where: { $0.id == updated.id }) else { return }
        record.messages[index] = updated
        channels[channelId] = record
        eventId += 1
        var data: [String: JSONValue] = ["message": try! JSONValue.from(updated)]
        if let change { data["change"] = .string(change) }
        emit(record.members, .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string(event), "ts": .string(now()),
                                      "channel_id": .string(channelId), "seq": .number(Double(updated.updatedSeq)), "data": .object(data)]))
    }

    private func live(_ channelId: String, _ userId: String, _ messageId: String) throws -> MessageOut {
        let record = try requireMember(channelId, userId)
        guard let message = record.messages.first(where: { $0.id == messageId && !$0.deleted }) else {
            throw ApiError.api(status: 404, code: "message_not_found", message: "not found")
        }
        return message
    }

    private func bumpSeq(_ channelId: String) -> Int {
        guard var record = channels[channelId] else { return 0 }
        let seq = record.channel.lastSeq + 1
        let c = record.channel
        record.channel = ChannelOut(id: c.id, type: c.type, name: c.name, topic: c.topic, purpose: c.purpose, archived: c.archived, createdBy: c.createdBy,
                                    lastSeq: seq, lastMessageAt: c.lastMessageAt, createdAt: c.createdAt, updatedAt: now(), membership: c.membership, dmUserIds: c.dmUserIds)
        channels[channelId] = record
        return seq
    }

    @discardableResult
    func edit(channelId: String, userId: String, messageId: String, body: String) throws -> MessageOut {
        let message = try live(channelId, userId, messageId)
        guard message.senderId == userId else { throw ApiError.api(status: 403, code: "not_message_owner", message: "not the author") }
        let seq = bumpSeq(channelId)
        let updated = rebuild(message, body: body, editedAt: now(), updatedSeq: seq, mentionedUserIds: Self.mentionedIds(body), mentionAll: Self.mentionsAll(body))
        replace(channelId, updated, event: "message.updated", change: "body")
        return updated
    }

    @discardableResult
    func delete(channelId: String, userId: String, messageId: String) throws -> MessageOut {
        let message = try live(channelId, userId, messageId)
        let seq = bumpSeq(channelId)
        let tombstone = rebuild(message, body: "", updatedSeq: seq, deleted: true, reactions: [], mentionedUserIds: [], mentionAll: false)
        replace(channelId, tombstone, event: "message.deleted")
        return tombstone
    }

    @discardableResult
    func react(channelId: String, userId: String, messageId: String, emoji: String, present: Bool) throws -> (MessageOut, Bool) {
        let message = try live(channelId, userId, messageId)
        var order: [String] = []
        var groups: [String: [String]] = [:]
        for reaction in message.reactions { order.append(reaction.emoji); groups[reaction.emoji] = reaction.userIds }
        var users = groups[emoji] ?? []
        var changed = false
        if present, !users.contains(userId) { users.append(userId); changed = true }
        if !present, let index = users.firstIndex(of: userId) { users.remove(at: index); changed = true }
        guard changed else { return (message, false) }
        if users.isEmpty { groups[emoji] = nil; order.removeAll { $0 == emoji } } else { groups[emoji] = users; if !order.contains(emoji) { order.append(emoji) } }
        let seq = bumpSeq(channelId)
        let updated = rebuild(message, updatedSeq: seq, reactions: order.map { ReactionOut(emoji: $0, count: groups[$0]!.count, userIds: groups[$0]!) })
        replace(channelId, updated, event: "message.updated", change: "reactions")
        return (updated, true)
    }

    private func emit(_ userIds: Set<String>, _ frame: JSONValue) {
        if holdEvents {
            held.append((userIds, frame))
            return
        }
        for socket in sockets where userIds.contains(socket.userId) { socket.deliver(frame) }
    }

    func release() {
        let pending = held
        held = []
        for (userIds, frame) in pending { emit(userIds, frame) }
    }

    /// PATCH /channels/{id} as the real server announces it (M15): to the members, to everyone for a conversion.
    func updateChannel(_ channelId: String, postingPolicy: String? = nil, type: String? = nil) {
        guard var record = channels[channelId] else { return }
        let converted = type != nil && type != record.channel.type
        if let postingPolicy { record.channel.postingPolicy = postingPolicy }
        if let type { record.channel.type = type }
        channels[channelId] = record
        eventId += 1
        emit(converted ? Set(users.keys) : record.members,
             .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("channel.updated"), "ts": .string(now()),
                      "channel_id": .string(channelId), "seq": .null,
                      "data": .object(["channel": try! JSONValue.from(record.channel), "member_ids": .array(record.members.map(JSONValue.string))])]))
    }

    func emitMembership(_ channelId: String, _ userId: String) {
        guard let record = channels[channelId] else { return }
        eventId += 1
        emit(record.members, .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("channel.member_added"), "ts": .string(now()),
                                      "channel_id": .string(channelId), "seq": .null, "data": .object(["channel_id": .string(channelId), "user_id": .string(userId)])]))
        eventId += 1
        var out = record.channel
        out.memberCount = record.members.count
        emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("channel.created"), "ts": .string(now()),
                               "channel_id": .string(channelId), "seq": .null,
                               "data": .object(["channel": try! JSONValue.from(out), "member_ids": .array(record.members.map(JSONValue.string))])]))
    }

    func revokeSession(_ userId: String) {
        for socket in sockets where socket.userId == userId {
            eventId += 1
            socket.deliver(.object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("session.revoked"), "ts": .string(now()),
                                    "channel_id": .null, "seq": .null, "data": .object(["reason": .string("logout")])]))
            socket.closeRemote(closeSessionRevoked)
        }
    }

    func disconnect(_ userId: String, code: Int = 1006) {
        for socket in sockets where socket.userId == userId { socket.closeRemote(code) }
    }

    func sockets(of userId: String) -> [Socket] { sockets.filter { $0.userId == userId } }

    func bootstrap(for userId: String) -> BootstrapOut {
        let user = users[userId]!
        let me = UserMe(id: user.id, username: user.username, displayName: user.displayName, role: user.role, deactivatedAt: nil,
                        createdAt: user.createdAt, updatedAt: user.updatedAt, email: nil, mustChangePassword: false)
        let mine = channels.values.filter { $0.members.contains(userId) }.map { record in
            ChannelOut(id: record.channel.id, type: record.channel.type, name: record.channel.name, topic: nil, purpose: nil, archived: false,
                       createdBy: record.channel.createdBy, lastSeq: record.channel.lastSeq, lastMessageAt: record.channel.lastMessageAt,
                       createdAt: record.channel.createdAt, updatedAt: record.channel.updatedAt,
                       membership: MembershipOut(role: record.channel.createdBy == userId ? "owner" : "member", joinedAt: now()), dmUserIds: nil,
                       readState: readState(userId: userId, channelId: record.channel.id), memberCount: record.members.count)
        }
        return BootstrapOut(serverTime: now(), me: me, users: Array(users.values), channels: mine,
                            limits: Limits(maxMessageLength: 20000, maxAttachmentBytes: 1, maxAttachmentsPerMessage: 10),
                            threads: threadSummary(for: userId),
                            presence: Array(Set(sockets.filter(\.authed).map(\.userId))).sorted().map { PresenceEntry(userId: $0, status: presenceOf($0)) },
                            bookmarks: bookmarks[userId] ?? [],
                            favorites: (favorites[userId] ?? []).filter { channels[$0]?.members.contains(userId) == true },
                            customEmoji: Array(customEmoji.values))
    }

    func history(userId: String, channelId: String, beforeSeq: Int?, limit: Int) throws -> HistoryOut {
        let record = try requireMember(channelId, userId)
        let channelLastSeq = record.channel.lastSeq // read BEFORE the rows (§4.3)
        var rows = record.messages.filter { !$0.deleted && $0.parentId == nil }
        if let beforeSeq { rows = rows.filter { $0.seq < beforeSeq } }
        rows.sort { $0.seq > $1.seq }
        return HistoryOut(channelLastSeq: channelLastSeq, messages: Array(rows.prefix(limit)), hasMore: rows.count > limit)
    }

    func delta(userId: String, channelId: String, sinceSeq: Int, limit: Int) throws -> DeltaOut {
        let record = try requireMember(channelId, userId)
        let channelLastSeq = record.channel.lastSeq
        let rows = record.messages.filter { $0.updatedSeq > sinceSeq }.sorted { $0.updatedSeq < $1.updatedSeq }
        let page = Array(rows.prefix(limit))
        let hasMore = rows.count > limit
        return DeltaOut(messages: page, nextSinceSeq: hasMore ? page.last!.updatedSeq : max(channelLastSeq, sinceSeq), hasMore: hasMore)
    }

    func api(for userId: String) -> Api { Api(server: self, userId: userId) }

    func connector(for userId: String) -> WsConnector {
        { [self] _, _ in
            let socket = Socket(server: self, userId: userId)
            sockets.append(socket)
            return socket
        }
    }
}

extension JSONValue {
    /// Encode a model to JSON with snake_case keys (what the server would send).
    static func from<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSON.plainDecoder.decode(JSONValue.self, from: JSON.snakeEncoder.encode(value))
    }
}
