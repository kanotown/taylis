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
    }

    struct ChannelRecord {
        var channel: ChannelOut
        var members: Set<String>
        var messages: [MessageOut]
    }

    var users: [String: UserPublic] = [:]
    var channels: [String: ChannelRecord] = [:]
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
        return channel
    }

    func join(_ channelId: String, _ userId: String) { channels[channelId]?.members.insert(userId) }

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
                                 createdAt: now(), editedAt: nil, deleted: false)
        record.messages.append(message)
        channels[channelId] = record
        byClientKey[senderId + ":" + key] = message
        eventId += 1
        let payload: JSONValue = .object(["message": try! JSONValue.from(message)])
        emit(record.members, .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("message.created"), "ts": .string(now()),
                                      "channel_id": .string(channelId), "seq": .number(Double(seq)), "data": payload]))
        return (message, true)
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
                       membership: MembershipOut(role: record.channel.createdBy == userId ? "owner" : "member", joinedAt: now()), dmUserIds: nil)
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
