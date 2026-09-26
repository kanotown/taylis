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

        func send(_ text: String) async throws {
            guard let data = text.data(using: .utf8), let frame = try? JSON.plainDecoder.decode([String: JSONValue].self, from: data) else { return }
            switch frame["type"]?.stringValue {
            case "auth": deliver(.object(["type": .string("hello"), "session_id": .string("s-" + userId), "server_time": .string(now()), "heartbeat_interval_sec": .number(30)]))
            case "ping": deliver(.object(["type": .string("pong"), "server_time": .string(now())]))
            default: break
            }
        }

        func close() { closeRemote(1000) }

        func closeRemote(_ code: Int) {
            guard !closed else { return }
            closed = true
            server.sockets.removeAll { $0 === self }
            onClose?(code)
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

        func postMessage(channelId: String, clientMsgId: String, body: String) async throws -> (MessageOut, Bool) {
            try maybeFail()
            return try server.post(channelId: channelId, senderId: userId, body: body, clientMsgId: clientMsgId)
        }

        func publicChannels() async throws -> [ChannelOut] {
            server.channels.values.filter { $0.channel.type == "public" && !$0.members.contains(userId) }.map { $0.channel }
        }

        func markRead(channelId: String, lastReadSeq: Int) async throws -> ReadStateOut {
            try maybeFail()
            return try server.markRead(userId: userId, channelId: channelId, seq: lastReadSeq)
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
    private func now() -> String { Self.now() }

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
        let unread = record.messages.filter { $0.seq > position && !$0.deleted }
        return ReadStateOut(lastReadSeq: position, unreadCount: unread.count, mentionCount: unread.filter { $0.mentions(userId) }.count)
    }

    /// PUT /channels/{id}/read: clamp, never regress, read.updated to the user's own sockets on change.
    @discardableResult
    func markRead(userId: String, channelId: String, seq: Int) throws -> ReadStateOut {
        let record = try requireMember(channelId, userId)
        let key = "\(userId):\(channelId)"
        let target = min(seq, record.channel.lastSeq)
        if target > (readPositions[key] ?? 0) {
            readPositions[key] = target
            let state = readState(userId: userId, channelId: channelId)
            eventId += 1
            emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("read.updated"), "ts": .string(now()),
                                    "channel_id": .string(channelId), "seq": .null,
                                    "data": .object(["channel_id": .string(channelId), "last_read_seq": .number(Double(state.lastReadSeq)),
                                                     "unread_count": .number(Double(state.unreadCount)), "mention_count": .number(Double(state.mentionCount))])]))
            return state
        }
        return readState(userId: userId, channelId: channelId)
    }

    private func requireMember(_ channelId: String, _ userId: String) throws -> ChannelRecord {
        guard let record = channels[channelId] else { throw ApiError.api(status: 404, code: "channel_not_found", message: "not found") }
        guard record.members.contains(userId) else { throw ApiError.api(status: 403, code: "not_a_member", message: "not a member") }
        return record
    }

    @discardableResult
    func post(channelId: String, senderId: String, body: String, clientMsgId: String? = nil) throws -> (MessageOut, Bool) {
        var record = try requireMember(channelId, senderId)
        let key = clientMsgId ?? nextId()
        if let existing = byClientKey[senderId + ":" + key] {
            if existing.channelId != channelId { throw ApiError.api(status: 409, code: "idempotency_conflict", message: "conflict") }
            return (existing, false)
        }
        let seq = record.channel.lastSeq + 1
        record.channel = ChannelOut(id: record.channel.id, type: record.channel.type, name: record.channel.name, topic: nil, purpose: nil, archived: false,
                                    createdBy: record.channel.createdBy, lastSeq: seq, lastMessageAt: now(), createdAt: record.channel.createdAt,
                                    updatedAt: now(), membership: nil, dmUserIds: nil)
        let message = MessageOut(id: nextId(), channelId: channelId, senderId: senderId, seq: seq, updatedSeq: seq, clientMsgId: key, body: body,
                                 createdAt: now(), editedAt: nil, deleted: false, mentionedUserIds: Self.mentionedIds(body), mentionAll: Self.mentionsAll(body))
        record.messages.append(message)
        channels[channelId] = record
        byClientKey[senderId + ":" + key] = message
        eventId += 1
        let payload: JSONValue = .object(["message": try! JSONValue.from(message)])
        emit(record.members, .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("message.created"), "ts": .string(now()),
                                      "channel_id": .string(channelId), "seq": .number(Double(seq)), "data": payload]))
        _ = try? markRead(userId: senderId, channelId: channelId, seq: seq) // the sender has read their own message (§10)
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
                         reactions: [ReactionOut]? = nil, mentionedUserIds: [String]? = nil, mentionAll: Bool? = nil) -> MessageOut {
        MessageOut(id: m.id, channelId: m.channelId, senderId: m.senderId, seq: m.seq, updatedSeq: updatedSeq ?? m.updatedSeq, clientMsgId: m.clientMsgId,
                   body: body ?? m.body, createdAt: m.createdAt, editedAt: editedAt ?? m.editedAt, deleted: deleted ?? m.deleted, type: m.type,
                   mentionedUserIds: mentionedUserIds ?? m.mentionedUserIds, mentionAll: mentionAll ?? m.mentionAll, reactions: reactions ?? m.reactions)
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

    func emitMembership(_ channelId: String, _ userId: String) {
        guard let record = channels[channelId] else { return }
        eventId += 1
        emit(record.members, .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("channel.member_added"), "ts": .string(now()),
                                      "channel_id": .string(channelId), "seq": .null, "data": .object(["channel_id": .string(channelId), "user_id": .string(userId)])]))
        eventId += 1
        emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("channel.created"), "ts": .string(now()),
                               "channel_id": .string(channelId), "seq": .null,
                               "data": .object(["channel": try! JSONValue.from(record.channel), "member_ids": .array(record.members.map(JSONValue.string))])]))
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
                       readState: readState(userId: userId, channelId: record.channel.id))
        }
        return BootstrapOut(serverTime: now(), me: me, users: Array(users.values), channels: mine,
                            limits: Limits(maxMessageLength: 20000, maxAttachmentBytes: 1, maxAttachmentsPerMessage: 10))
    }

    func history(userId: String, channelId: String, beforeSeq: Int?, limit: Int) throws -> HistoryOut {
        let record = try requireMember(channelId, userId)
        let channelLastSeq = record.channel.lastSeq // read BEFORE the rows (§4.3)
        var rows = record.messages.filter { !$0.deleted }
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
