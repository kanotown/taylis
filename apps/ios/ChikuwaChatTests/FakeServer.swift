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
        /// A half-open connection: nothing reaches the client any more (pongs included) and no close is seen.
        var silent = false
        private unowned let server: FakeServer

        init(server: FakeServer, userId: String) {
            self.server = server
            self.userId = userId
        }

        var authed = false
        /// The `active` of every ping this client sent.
        var pings: [Bool] = []
        /// M73: the `canvas_presence` frames this client sent (the relay itself is not modelled).
        var canvasPresence: [[String: JSONValue]] = []

        func send(_ text: String) async throws {
            guard let data = text.data(using: .utf8), let frame = try? JSON.plainDecoder.decode([String: JSONValue].self, from: data) else { return }
            switch frame["type"]?.stringValue {
            case "auth":
                if !server.refuseAuths.isEmpty {
                    // SYNC_PROTOCOL.md §5.1: an error frame, then close 4001 (a late auth frame, a refused token).
                    deliver(.object(["type": .string("error"), "code": .string(server.refuseAuths.removeFirst()), "message": .string("refused")]))
                    closeRemote(closeAuthFailed)
                    return
                }
                authed = true
                deliver(.object(["type": .string("hello"), "session_id": .string("s-" + userId), "server_time": .string(now()), "heartbeat_interval_sec": .number(30)]))
                server.announcePresence(userId)
            case "ping":
                pings.append(frame["active"] == .bool(true))
                if case .bool(true)? = frame["active"] { server.markActive(userId) }
                deliver(.object(["type": .string("pong"), "server_time": .string(now())]))
            case "canvas_presence":
                canvasPresence.append(frame)
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
            guard !closed, !silent else { return }
            if frame["type"]?.stringValue == "event", dropNext > 0 {
                dropNext -= 1 // simulated loss
                return
            }
            let text = String(data: try! JSON.plainEncoder.encode(frame), encoding: .utf8)!
            onMessage?(text)
        }
    }

    @MainActor
    final class Api: SyncApi, DraftApi, ChannelLinksApi, ActivityApi, ReservationsApi, AttendanceApi, ActionsApi {
        func actions() async throws -> ActionListOut {
            try maybeFail("actions")
            server.actionReads += 1
            return server.actionList(for: userId)
        }

        func actionStatuses(refresh: Bool) async throws -> ActionStatusListOut {
            try maybeFail("actionStatuses")
            server.statusReads.append(refresh)
            guard server.actions?.enabled == true else { return ActionStatusListOut(enabled: false) }
            let role = server.users[userId]?.role
            return ActionStatusListOut(enabled: true, statuses: role == "guest" || role == "bot" ? [] : server.statuses)
        }

        func invokeAction(id: String, clientInvokeId: String) async throws -> ActionInvokeOut {
            try maybeFail("invokeAction")
            let out = try server.invokeAction(userId, actionId: id, clientInvokeId: clientInvokeId)
            if server.actionAnswersLost > 0 {  // the server did it, the answer never came back
                server.actionAnswersLost -= 1
                throw ApiError.network(URLError(.networkConnectionLost))
            }
            return out
        }

        func attendance() async throws -> AttendanceBoardOut {
            try maybeFail("attendance")
            server.attendanceReads += 1
            guard server.users[userId]?.role != "guest" else { throw ApiError.api(status: 403, code: "guest_restricted", message: "Guests") }
            return server.attendance ?? AttendanceBoardOut(enabled: false, states: [], entries: [])
        }

        func activitySummary() async throws -> ActivitySummary {
            try maybeFail("activitySummary")
            guard let summary = server.activity[userId] else { throw ApiError.api(status: 404, code: "not_found", message: "Not Found") }
            return summary
        }

        func markActivityRead(readAt: String) async throws -> ActivitySummary {
            try maybeFail("markActivityRead")
            return try server.markActivityRead(userId, readAt: readAt)
        }

        func markActivityItemsRead(itemIds: [String]) async throws -> ActivitySummary {
            try maybeFail("markActivityItemsRead")
            return try server.markActivityItemsRead(userId, itemIds: itemIds)
        }

        func channelLinks(channelId: String) async throws -> [ChannelLinkOut] {
            try maybeFail("channelLinks")
            guard server.channels[channelId]?.members.contains(userId) == true else { throw ApiError.api(status: 403, code: "not_a_member", message: "Not a member") }
            return server.links[channelId] ?? []
        }

        func reservationPools() async throws -> [PoolOut] {
            try maybeFail("reservationPools")
            server.poolReads += 1
            let pools = server.pools
            // Review v0.1.37 #6: the answer as the server was when asked, held until the test lets it go.
            if let hold = server.poolsHold { server.poolsHold = nil; await hold() }
            return pools
        }

        unowned let server: FakeServer
        let userId: String
        var pendingFailure: Error?
        /// One-shot failures of particular endpoints ("post", "delta", "markRead", "markThreadRead" …), in order.
        var failures: [String: [Error]] = [:]
        /// Runs inside every POST /messages before it is stored (a test holds a send in flight with it).
        var beforePost: (() async -> Void)?
        /// Runs after a POST /messages was stored, before its response: a slow response, or a lost one when it throws.
        var afterPost: (() async throws -> Void)?
        /// Runs inside every GET /channels/{id}/messages before it is answered (a test holds a page in flight with it).
        var beforeHistory: (() async -> Void)?
        private(set) var calls: [String] = []
        /// GET /channels/{id}/messages as "before_seq=…&limit=…" ("before_seq=nil" for the newest page).
        private(set) var historyRequests: [String] = []

        init(server: FakeServer, userId: String) {
            self.server = server
            self.userId = userId
        }

        func saveDraft(channelId: String, parentId: String?, body: String) async throws -> DraftOut {
            try maybeFail("saveDraft")
            return try server.saveDraft(userId, channelId: channelId, parentId: parentId, body: body)
        }

        func deleteDraft(channelId: String, parentId: String?) async throws {
            try maybeFail("deleteDraft")
            server.deleteDraft(userId, channelId: channelId, parentId: parentId)
        }

        private func maybeFail(_ endpoint: String) throws {
            calls.append(endpoint)
            if let error = pendingFailure {
                pendingFailure = nil
                throw error
            }
            if var queued = failures[endpoint], !queued.isEmpty {
                let error = queued.removeFirst()
                failures[endpoint] = queued
                throw error
            }
        }

        func bootstrap() async throws -> BootstrapOut {
            try maybeFail("bootstrap")
            return server.bootstrap(for: userId)
        }

        func history(channelId: String, beforeSeq: Int?, limit: Int) async throws -> HistoryOut {
            try maybeFail("history")
            historyRequests.append("before_seq=\(beforeSeq.map(String.init) ?? "nil")&limit=\(limit)")
            if let beforeHistory { await beforeHistory() }
            return try server.history(userId: userId, channelId: channelId, beforeSeq: beforeSeq, limit: limit)
        }

        func delta(channelId: String, sinceSeq: Int, limit: Int) async throws -> DeltaOut {
            try maybeFail("delta")
            return try server.delta(userId: userId, channelId: channelId, sinceSeq: sinceSeq, limit: limit)
        }

        func postMessage(channelId: String, clientMsgId: String, body: String, parentId: String?, attachmentIds: [String], options: SendOptions) async throws -> (MessageOut, Bool) {
            try maybeFail("post")
            if let beforePost { await beforePost() }
            let result = try server.post(channelId: channelId, senderId: userId, body: body, clientMsgId: clientMsgId, parentId: parentId, attachmentIds: attachmentIds,
                                         options: options)
            if let afterPost { try await afterPost() }
            return result
        }

        func replies(messageId: String) async throws -> [MessageOut] {
            try maybeFail("replies")
            return try server.replies(userId: userId, messageId: messageId)
        }

        /// GET /channels/{id} for a member, with `last_message` (M49).
        func channel(id: String) async throws -> ChannelOut {
            try maybeFail("channel")
            let record = try server.requireMember(id, userId)
            var out = record.channel
            out.memberCount = record.members.count
            out.lastMessage = server.lastMessage(id)
            return out
        }

        func publicChannels() async throws -> [ChannelOut] {
            server.channels.values.filter { $0.channel.type == "public" && !$0.members.contains(userId) }.map { record in
                var out = record.channel
                out.memberCount = record.members.count
                return out
            }
        }

        func listReminders() async throws -> [ReminderOut] {
            try maybeFail("listReminders")
            return server.reminders[userId] ?? []
        }
        func listScheduled() async throws -> [ScheduledOut] {
            try maybeFail("listScheduled")
            return server.scheduled[userId] ?? []
        }
        func readAll() async throws -> [ChannelReadStateOut] {
            try maybeFail("readAll")
            return try server.readAll(userId)
        }
        func markRead(channelId: String, lastReadSeq: Int) async throws -> ReadStateOut {
            try maybeFail("markRead")
            return try server.markRead(userId: userId, channelId: channelId, seq: lastReadSeq)
        }
        func threads(filter: String, cursor: String?, limit: Int) async throws -> ThreadListOut {
            try maybeFail("threads")
            return server.threads(userId: userId, filter: filter, cursor: cursor, limit: limit)
        }
        func threadState(messageId: String) async throws -> ThreadState {
            try maybeFail("threadState")
            return try server.threadState(userId: userId, parentId: messageId)
        }
        func markThreadRead(messageId: String, lastReadSeq: Int) async throws -> ThreadState {
            try maybeFail("markThreadRead")
            return try server.markThreadRead(userId: userId, messageId: messageId, seq: lastReadSeq)
        }
        func readAllThreads() async throws -> ThreadsReadAllOut {
            try maybeFail("readAllThreads")
            return server.readAllThreads(userId)
        }
        func setThreadFollow(messageId: String, following: Bool) async throws -> ThreadState {
            try maybeFail("setThreadFollow")
            return try server.setThreadFollow(userId: userId, messageId: messageId, following: following)
        }
        func setReadPosition(channelId: String, lastReadSeq: Int) async throws -> ReadStateOut {
            try maybeFail("setReadPosition")
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
    /// Error codes for the next auth frames to refuse (each followed by close 4001).
    var refuseAuths: [String] = []
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
        let unread = record.messages.filter { $0.seq > position && !$0.deleted && ($0.parentId == nil || $0.alsoInChannel) && $0.senderId != userId && $0.type == "user" }
        return ReadStateOut(lastReadSeq: position, unreadCount: unread.count, mentionCount: unread.filter { $0.mentions(userId) }.count,
                            firstUnreadAt: unread.first?.createdAt) // rows are in seq order
    }

    /// Stores `count` top-level messages at once, without events or read side effects: long histories (§10.1).
    /// `type` other than "user" makes rows that are shown but never counted as unread (system messages).
    @discardableResult
    func seed(_ channelId: String, senderId: String, count: Int, type: String = "user") -> [MessageOut] {
        guard var record = channels.removeValue(forKey: channelId) else { return [] } // appended to in place
        var seq = record.channel.lastSeq
        var added: [MessageOut] = []
        for _ in 0..<count {
            seq += 1
            var message = MessageOut(id: nextId(), channelId: channelId, senderId: senderId, seq: seq, updatedSeq: seq, clientMsgId: nextId(),
                                     body: "m\(seq)", createdAt: now(), editedAt: nil, deleted: false)
            message.type = type
            added.append(message)
        }
        record.messages.append(contentsOf: added)
        let c = record.channel
        record.channel = ChannelOut(id: c.id, type: c.type, name: c.name, topic: c.topic, purpose: c.purpose, archived: c.archived, createdBy: c.createdBy,
                                    lastSeq: seq, lastMessageAt: added.last?.createdAt ?? c.lastMessageAt, createdAt: c.createdAt, updatedAt: now(),
                                    membership: c.membership, dmUserIds: c.dmUserIds, postingPolicy: c.postingPolicy)
        channels[channelId] = record
        return added
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
                                                     "unread_count": .number(Double(state.unreadCount)), "mention_count": .number(Double(state.mentionCount)),
                                                     "first_unread_at": state.firstUnreadAt.map(JSONValue.string) ?? .null])]))
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

    /// L6 (RECURRING.md §7): a recurring post's collection changed (it was attached, a target replied or took the reply
    /// back, the nudges went out): the parent takes a new seq and message.updated (change=collection) goes out.
    @discardableResult
    func setCollection(channelId: String, messageId: String, _ collection: CollectionOut?) -> MessageOut? {
        guard let message = channels[channelId]?.messages.first(where: { $0.id == messageId }) else { return nil }
        var updated = rebuild(message, updatedSeq: bumpSeq(channelId))
        updated.collection = collection
        replace(channelId, updated, event: "message.updated", change: "collection")
        return updated
    }

    /// M79: the server filled in a message's videos later (`app.cli probe-videos`): a new seq and message.updated with
    /// `change` (normally "attachments"; tests send unknown ones too).
    @discardableResult
    func setAttachments(channelId: String, messageId: String, _ attachments: [AttachmentOut], change: String = "attachments") -> MessageOut? {
        guard let message = channels[channelId]?.messages.first(where: { $0.id == messageId }) else { return nil }
        var updated = rebuild(message, updatedSeq: bumpSeq(channelId))
        updated.attachments = attachments
        replace(channelId, updated, event: "message.updated", change: change)
        return updated
    }

    /// user → saved message ids, newest first.
    var bookmarks: [String: [String]] = [:]
    /// Custom emoji by name (M12f); everyone gets emoji.updated.
    var customEmoji: [String: CustomEmojiOut] = [:]
    /// M88: bootstrap's workspace_settings (nil: a server before M88 sends none).
    var workspaceSettings: WorkspaceSettings? = nil

    /// M88: workspace.settings_updated (audience all).
    func emitWorkspaceSettings(_ settings: WorkspaceSettings) {
        workspaceSettings = settings
        eventId += 1
        emit(Set(users.keys), .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("workspace.settings_updated"),
                                       "ts": .string(now()), "channel_id": .null, "seq": .null,
                                       "data": .object(["settings": try! JSONValue.from(settings)])]))
    }

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

    /// L4: a member's role changed (channel.member_updated; here to everyone, the channel's members in the server).
    func emitMemberRole(channelId: String, userId: String, role: String) {
        eventId += 1
        emit(Set(users.keys), .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("channel.member_updated"),
                                       "ts": .string(now()), "channel_id": .string(channelId), "seq": .null,
                                       "data": .object(["channel_id": .string(channelId), "user_id": .string(userId), "role": .string(role)])]))
    }

    /// M23: the lab roster by user id (bootstrap `roster`, roster.updated to everyone).
    var roster: [String: LabProfileOut] = [:]

    /// An administrator's PUT / DELETE /lab/roster/{user_id} (or the person's PATCH /me): the line, or nil to take them off.
    func setRosterLine(_ userId: String, _ profile: LabProfileOut?) {
        roster[userId] = profile
        eventId += 1
        emit(Set(users.keys), .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("roster.updated"), "ts": .string(now()),
                                       "channel_id": .null, "seq": .null,
                                       "data": .object(["user_id": .string(userId), "profile": profile.map { try! JSONValue.from($0) } ?? .null])]))
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

    /// M39: each user's activity summary (bootstrap `activity`); none = a server before M39. Tests set the counts.
    var activity: [String: ActivitySummary] = [:]

    /// PUT /activity/read: the position only moves forward; activity.read to the user's devices when it moved. Every
    /// item up to it is read here (the fake keeps no items: the count drops to 0).
    func markActivityRead(_ userId: String, readAt: String) throws -> ActivitySummary {
        guard var summary = activity[userId] else { throw ApiError.api(status: 404, code: "not_found", message: "Not Found") }
        let moved = (parseIsoDate(readAt) ?? .distantPast) > (parseIsoDate(summary.readAt) ?? .distantPast)
        if moved {
            summary = ActivitySummary(readAt: readAt, unreadCount: 0, mentionUnread: false)
            activity[userId] = summary
            emitActivityRead(userId, readAt: readAt)
        }
        return summary
    }

    /// 2026-10-07 PUT /activity/items/read: each opened item leaves the count (the fake keeps no items: one per id, never
    /// below 0, the position unchanged); activity.items_read to the user's devices.
    var itemsRead: [String: [String]] = [:]

    func markActivityItemsRead(_ userId: String, itemIds: [String]) throws -> ActivitySummary {
        guard var summary = activity[userId] else { throw ApiError.api(status: 404, code: "not_found", message: "Not Found") }
        let fresh = itemIds.filter { !(itemsRead[userId] ?? []).contains($0) }
        itemsRead[userId, default: []] += fresh
        summary.unreadCount = max(0, summary.unreadCount - fresh.count)
        if summary.unreadCount == 0 { summary.mentionUnread = false }
        activity[userId] = summary
        emitActivityItemsRead(userId, itemIds: itemIds, readAt: now())
        return summary
    }

    func emitActivityItemsRead(_ userId: String, itemIds: [String], readAt: String) {
        eventId += 1
        emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("activity.items_read"), "ts": .string(now()),
                                "channel_id": .null, "seq": .null,
                                "data": .object(["item_ids": .array(itemIds.map(JSONValue.string)), "read_at": .string(readAt)])]))
    }

    func emitActivityRead(_ userId: String, readAt: String) {
        eventId += 1
        emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("activity.read"), "ts": .string(now()),
                                "channel_id": .null, "seq": .null, "data": .object(["read_at": .string(readAt)])]))
    }

    /// Review v0.1.22 #3 (CANVAS.md §20.8): activity.updated to one person (an erased canvas version blanked these items).
    func emitActivityUpdated(_ userId: String, itemIds: [String]) {
        eventId += 1
        emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("activity.updated"), "ts": .string(now()),
                                "channel_id": .null, "seq": .null, "data": .object(["item_ids": .array(itemIds.map(JSONValue.string))])]))
    }

    /// reaction.added to the message's author (the reaction itself is `react`; the tests set the summary's counts).
    func emitReactionAdded(to authorId: String, channelId: String, messageId: String, by userId: String, emoji: String) {
        eventId += 1
        emit([authorId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("reaction.added"), "ts": .string(now()),
                                  "channel_id": .string(channelId), "seq": .null,
                                  "data": .object(["channel_id": .string(channelId), "message_id": .string(messageId), "user_id": .string(userId),
                                                   "emoji": .string(emoji), "at": .string(now())])]))
    }

    /// "user" → starred channel ids (M12a).
    var favorites: [String: [String]] = [:]
    /// M15f: each conversation's link bar; setLinks announces it like the server does.
    var links: [String: [ChannelLinkOut]] = [:]

    func setLinks(_ channelId: String, titles: [String]) {
        guard let record = channels[channelId] else { return }
        let rows = titles.enumerated().map { index, title in
            ChannelLinkOut(id: "link-\(channelId)-\(title)", title: title, url: "https://example.com/\(index)", position: index,
                           createdBy: record.channel.createdBy ?? "", createdAt: now())
        }
        links[channelId] = rows
        eventId += 1
        emit(record.members, .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("channel.links_updated"), "ts": .string(now()),
                                      "channel_id": .string(channelId), "seq": .null,
                                      "data": .object(["channel_id": .string(channelId), "links": try! JSONValue.from(rows)])]))
    }

    /// M112: the workspace's reservation pools; setPools announces a change like the server (to everyone, no pool in it).
    var pools: [PoolOut] = []
    /// How many times GET /reservation-pools was read.
    var poolReads = 0
    /// When set, the next GET /reservation-pools awaits it before answering (the answer is taken when asked).
    var poolsHold: (() async -> Void)?

    func setPools(_ rows: [PoolOut]) {
        pools = rows
        eventId += 1
        emit(Set(users.keys), .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("reservation.updated"), "ts": .string(now()),
                                       "channel_id": .null, "seq": .null,
                                       "data": .object(["pool_id": .string(rows.first?.id ?? "p"), "deleted": .bool(false)])]))
    }

    /// M112: a reservation notice for one person (an activity item; the app shows a banner).
    func noticeReservation(_ userId: String, text: String) {
        eventId += 1
        emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("reservation.notice"), "ts": .string(now()),
                                "channel_id": .null, "seq": .null,
                                "data": .object(["item_id": .string("n\(eventId)"), "pool_id": .string("p1"), "reservation_id": .null,
                                                 "text": .string(text), "operator": .bool(true), "at": .string(now())])]))
    }

    /// M140: the 在室状況 board (nil or `enabled: false` = off); bootstrap gives it to everyone but guests while on.
    var attendance: AttendanceBoardOut?
    /// How many times GET /attendance was read.
    var attendanceReads = 0

    private var attendanceAudience: Set<String> { Set(users.values.filter { $0.role != "guest" && $0.role != "bot" }.map(\.id)) }

    /// attendance.updated for one person's row (the board changes as the server's would).
    func setAttendance(_ entry: AttendanceEntryOut, logId: Int = 1) {
        if var board = attendance {
            board.entries.removeAll { $0.userId == entry.userId }
            board.entries.append(entry)
            attendance = board
        }
        var data = (try? JSONValue.from(entry)) ?? .null
        if case .object(var map) = data { map["log_id"] = .number(Double(logId)); data = .object(map) }
        emitEvent(attendanceAudience, "attendance.updated", channelId: nil, data: data)
    }

    /// M143: the 操作ボタン as the server holds them (nil = off); everyone but guests and bots may press them all here.
    var actions: ActionListOut?
    /// How many times GET /actions was read, and the presses that reached the relay (their action ids).
    var actionReads = 0
    var relayCalls: [String] = []
    /// What the relay answers (ok and its message).
    var relayAnswer: (ok: Bool, message: String?) = (true, nil)
    /// Presses whose answer is lost on the way back (the server did them): ApiError.network after the work.
    var actionAnswersLost = 0
    /// M143 §12: the groups' states GET /actions/status answers, and its reads (`refresh` each).
    var statuses: [ActionStatusOut] = []
    var statusReads: [Bool] = []

    /// actions.status_updated for one group's state.
    func sendActionStatus(_ status: ActionStatusOut) {
        emitEvent(actionsAudience, "actions.status_updated", channelId: nil, data: (try? JSONValue.from(status)) ?? .null)
    }

    /// "user:client_invoke_id" → the first answer (docs/ACTIONS.md §4 2.).
    private var invocations: [String: ActionInvokeOut] = [:]

    private var actionsAudience: Set<String> { Set(users.values.filter { $0.role != "guest" }.map(\.id)) }

    func actionList(for userId: String) -> ActionListOut {
        guard let list = actions, list.enabled else { return ActionListOut(enabled: false) }
        let role = users[userId]?.role
        return role == "guest" || role == "bot" ? ActionListOut(enabled: true, showOnAttendance: list.showOnAttendance) : list
    }

    /// actions.updated (empty) after the switch or a button changed.
    func setActionsConfig(_ list: ActionListOut?) {
        actions = list
        emitEvent(actionsAudience, "actions.updated", channelId: nil, data: .object([:]))
    }

    func invokeAction(_ userId: String, actionId: String, clientInvokeId: String) throws -> ActionInvokeOut {
        guard let list = actions, list.enabled else { throw ApiError.api(status: 409, code: "actions_disabled", message: "Off") }
        guard list.actions.contains(where: { $0.id == actionId }) else {
            throw ApiError.api(status: 404, code: "action_not_found", message: "Not found")
        }
        let role = users[userId]?.role
        guard role != "guest", role != "bot" else { throw ApiError.api(status: 403, code: "action_not_allowed", message: "No") }
        let key = "\(userId):\(clientInvokeId)"
        if let earlier = invocations[key] {
            guard earlier.actionId == actionId else { throw ApiError.api(status: 409, code: "action_invoke_id_reused", message: "Reused") }
            var again = earlier
            again.repeated = true
            return again
        }
        relayCalls.append(actionId)
        let out = ActionInvokeOut(invokeId: "inv\(relayCalls.count)", actionId: actionId, ok: relayAnswer.ok,
                                  status: relayAnswer.ok ? "succeeded" : "failed", statusCode: relayAnswer.ok ? 200 : 503,
                                  error: relayAnswer.ok ? nil : "relay_error", message: relayAnswer.message, at: now())
        invocations[key] = out
        return out
    }

    /// attendance.config_updated (empty) after the board's settings or states changed.
    func setAttendanceConfig(_ board: AttendanceBoardOut?) {
        attendance = board
        emitEvent(attendanceAudience, "attendance.config_updated", channelId: nil, data: .object([:]))
    }

    /// M15d: "user:channel:parent" → the saved draft.
    var drafts: [String: DraftOut] = [:]

    func saveDraft(_ userId: String, channelId: String, parentId: String?, body: String) throws -> DraftOut {
        guard channels[channelId]?.members.contains(userId) == true else { throw ApiError.api(status: 403, code: "not_a_member", message: "Not a member") }
        let draft = DraftOut(channelId: channelId, parentId: parentId, body: body, updatedAt: now())
        drafts["\(userId):\(channelId):\(parentId ?? "")"] = draft
        emitDraft(userId, DraftUpdated(channelId: channelId, parentId: parentId, body: body, updatedAt: draft.updatedAt, deleted: false))
        return draft
    }

    func deleteDraft(_ userId: String, channelId: String, parentId: String?) {
        guard drafts.removeValue(forKey: "\(userId):\(channelId):\(parentId ?? "")") != nil else { return }
        emitDraft(userId, DraftUpdated(channelId: channelId, parentId: parentId, body: "", updatedAt: now(), deleted: true))
    }

    func drafts(of userId: String) -> [DraftOut] {
        drafts.filter { $0.key.hasPrefix("\(userId):") }.map(\.value).sorted { $0.body < $1.body }
    }

    private func emitDraft(_ userId: String, _ data: DraftUpdated) {
        eventId += 1
        emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("draft.updated"), "ts": .string(now()),
                                "channel_id": .null, "seq": .null, "data": try! JSONValue.from(data)]))
    }

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
            return ChannelReadStateOut(channelId: record.channel.id, lastReadSeq: state.lastReadSeq, unreadCount: state.unreadCount, mentionCount: state.mentionCount,
                                       firstUnreadAt: state.firstUnreadAt)
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

    /// false: GET /threads answers as a server before the reply previews did (no latest_replies).
    var threadPreviews = true

    func threads(userId: String, filter: String, cursor: String?, limit: Int) -> ThreadListOut {
        var items: [ThreadItem] = threadFollows.values.filter { $0.userId == userId && $0.following }.compactMap { row in
            guard let found = try? threadParent(row.parentId), !found.parent.deleted, found.parent.replyCount > 0,
                  let state = try? threadState(userId: userId, parentId: row.parentId) else { return nil }
            // THREADS.md §5: the newest two live replies, oldest first; none from a server before the previews.
            let latest = found.record.messages.filter { $0.parentId == found.parent.id && !$0.deleted }.sorted { $0.seq < $1.seq }.suffix(2)
            return ThreadItem(parent: found.parent, state: state, latestReplies: threadPreviews ? Array(latest) : nil)
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
        // Reading is not following: a thread I have no row for keeps no position either.
        guard threadFollows[key] != nil else { return try threadState(userId: userId, parentId: found.parent.id) }
        if target > threadFollows[key]!.lastReadSeq {
            threadFollows[key]!.lastReadSeq = target
            emitThread(found.parent.id, to: [userId], reason: "read")
        }
        return try threadState(userId: userId, parentId: found.parent.id)
    }

    /// POST /threads/read-all (THREADS.md §3.2): every followed thread of a live parent to its newest live reply;
    /// one threads.read_all to my devices when something moved.
    @discardableResult
    func readAllThreads(_ userId: String) -> ThreadsReadAllOut {
        var moved: [ThreadReadStateOut] = []
        for (key, row) in threadFollows where row.userId == userId && row.following {
            guard let found = try? threadParent(row.parentId), !found.parent.deleted, found.record.members.contains(userId) else { continue }
            let newest = found.record.messages.filter { $0.parentId == found.parent.id && !$0.deleted }.map(\.seq).max() ?? 0
            guard newest > row.lastReadSeq else { continue }
            threadFollows[key]!.lastReadSeq = newest
            guard let state = try? threadState(userId: userId, parentId: row.parentId) else { continue }
            moved.append(ThreadReadStateOut(parentId: state.parentId, channelId: state.channelId, lastReadSeq: state.lastReadSeq,
                                            unreadCount: state.unreadCount, mentionCount: state.mentionCount))
        }
        let out = ThreadsReadAllOut(summary: threadSummary(for: userId), threads: moved)
        if !moved.isEmpty { emitThreadsReadAll(userId, out) }
        return out
    }

    func emitThreadsReadAll(_ userId: String, _ out: ThreadsReadAllOut) {
        eventId += 1
        emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("threads.read_all"), "ts": .string(now()),
                                "channel_id": .null, "seq": .null, "data": try! JSONValue.from(out)]))
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
        // As the server: a deleted root has no thread to read (THREADS.md §5).
        if record.messages.contains(where: { $0.id == messageId && $0.deleted }) {
            throw ApiError.api(status: 404, code: "message_not_found", message: "not found")
        }
        return record.messages.filter { $0.parentId == messageId && !$0.deleted }.sorted { $0.seq < $1.seq }
    }

    /// M49 (SYNC_PROTOCOL.md §7.8): the newest live timeline row (top-level or also sent to the channel) as one line.
    func lastMessage(_ channelId: String) -> LastMessageOut? {
        guard let row = channels[channelId]?.messages.filter({ !$0.deleted && ($0.parentId == nil || $0.alsoInChannel) }).max(by: { $0.seq < $1.seq })
        else { return nil }
        return LastMessageOut(id: row.id, senderId: row.senderId, type: row.type, seq: row.seq,
                              excerpt: Timeline.excerpt(row.body, attachments: row.attachments, users: users, limit: DMList.previewLength),
                              hasAttachments: !row.attachments.isEmpty, createdAt: row.createdAt)
    }

    fileprivate func requireMember(_ channelId: String, _ userId: String) throws -> ChannelRecord {
        guard let record = channels[channelId] else { throw ApiError.api(status: 404, code: "channel_not_found", message: "not found") }
        guard record.members.contains(userId) else { throw ApiError.api(status: 403, code: "not_a_member", message: "not a member") }
        return record
    }

    /// `type` other than "user" posts a system row (shown, never counted as unread); `advanceRead` false is a scheduled
    /// send (M12d), which does not read the channel for its sender.
    @discardableResult
    func post(channelId: String, senderId: String, body: String, clientMsgId: String? = nil, parentId: String? = nil, attachmentIds: [String] = [],
              options: SendOptions = SendOptions(), type: String = "user", advanceRead: Bool = true,
              systemEvent: SystemEvent? = nil) throws -> (MessageOut, Bool) {
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
        var message = MessageOut(id: nextId(), channelId: channelId, senderId: senderId, seq: seq, updatedSeq: seq, clientMsgId: key, body: body,
                                 createdAt: now(), editedAt: nil, deleted: false, mentionedUserIds: Self.mentionedIds(body), mentionAll: Self.mentionsAll(body),
                                 parentId: parentId, alsoInChannel: options.alsoInChannel && parentId != nil,
                                 attachments: attachmentIds.map { AttachmentOut(id: $0, filename: "file-\($0)", contentType: "application/octet-stream", sizeBytes: 1, width: nil, height: nil, hasThumbnail: false, status: "attached", createdAt: now()) },
                                 priority: parentId == nil ? options.priority : nil, ackRequested: parentId == nil && options.ackRequested)
        message.type = type
        message.systemEvent = systemEvent
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
        // §10: a top-level post reads the channel for its sender; a thread reply (even one also sent to the channel) does not.
        if parentId == nil && advanceRead { _ = try? markRead(userId: senderId, channelId: channelId, seq: seq) }
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
                   pinnedAt: m.pinnedAt, pinnedBy: m.pinnedBy, collection: m.collection)
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

    /// Delivers only the oldest held frame (the order of one post's events, one at a time).
    func releaseNext() {
        guard !held.isEmpty else { return }
        let (userIds, frame) = held.removeFirst()
        for socket in sockets where userIds.contains(socket.userId) { socket.deliver(frame) }
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

    /// DELETE /channels/{id}/members/{user} (or leaving): member_removed to the members and to that user.
    func removeMember(_ channelId: String, _ userId: String) {
        guard var record = channels[channelId] else { return }
        let audience = record.members
        record.members.remove(userId)
        channels[channelId] = record
        eventId += 1
        emit(audience, .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("channel.member_removed"), "ts": .string(now()),
                                "channel_id": .string(channelId), "seq": .null, "data": .object(["channel_id": .string(channelId), "user_id": .string(userId)])]))
    }

    func revokeSession(_ userId: String) {
        for socket in sockets where socket.userId == userId {
            eventId += 1
            socket.deliver(.object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("session.revoked"), "ts": .string(now()),
                                    "channel_id": .null, "seq": .null, "data": .object(["reason": .string("logout")])]))
            socket.closeRemote(closeSessionRevoked)
        }
    }

    /// M52: the calendar's events as each user sees them (the calendar calls of the Api read them, CalendarTests.swift).
    var calendarRows: [CalendarEventOut] = []
    /// M56: the tasks as each user sees them (the task calls of the Api read them, TaskTests.swift).
    var taskRows: [TaskOut] = []

    /// An event outside the channel seq (calendar.*, M52) to these users' sockets.
    func emitEvent(_ userIds: Set<String>, _ event: String, channelId: String?, data: JSONValue) {
        eventId += 1
        emit(userIds, .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string(event), "ts": .string(now()),
                               "channel_id": channelId.map(JSONValue.string) ?? .null, "seq": .null, "data": data]))
    }

    func disconnect(_ userId: String, code: Int = 1006) {
        for socket in sockets where socket.userId == userId { socket.closeRemote(code) }
    }

    func sockets(of userId: String) -> [Socket] { sockets.filter { $0.userId == userId } }

    /// M12g: a user's notification keywords (bootstrap `me` only; the server never tells others about hits).
    var notifyKeywords: [String: [String]] = [:]
    /// M35: a user's overall notification setting (bootstrap `me`; nil = omitted, as servers before M35 do).
    var notificationDefault: [String: String] = [:]

    /// notification_preference.updated to the user's devices, with the payload as given (M35 fields or the old shape).
    func emitNotificationPreference(_ userId: String, _ data: [String: JSONValue]) {
        eventId += 1
        emit([userId], .object(["type": .string("event"), "id": .number(Double(eventId)), "event": .string("notification_preference.updated"),
                                "ts": .string(now()), "channel_id": data["channel_id"] ?? .null, "seq": .null, "data": .object(data)]))
    }

    func bootstrap(for userId: String) -> BootstrapOut {
        let user = users[userId]!
        let me = UserMe(id: user.id, username: user.username, displayName: user.displayName, role: user.role, deactivatedAt: nil,
                        createdAt: user.createdAt, updatedAt: user.updatedAt, email: nil, mustChangePassword: false,
                        notifyKeywords: notifyKeywords[userId], notificationDefault: notificationDefault[userId])
        let mine = channels.values.filter { $0.members.contains(userId) }.map { record in
            ChannelOut(id: record.channel.id, type: record.channel.type, name: record.channel.name, topic: nil, purpose: nil, archived: false,
                       createdBy: record.channel.createdBy, lastSeq: record.channel.lastSeq, lastMessageAt: record.channel.lastMessageAt,
                       createdAt: record.channel.createdAt, updatedAt: record.channel.updatedAt,
                       membership: MembershipOut(role: record.channel.createdBy == userId ? "owner" : "member", joinedAt: now()), dmUserIds: nil,
                       readState: readState(userId: userId, channelId: record.channel.id), memberCount: record.members.count,
                       lastMessage: lastMessage(record.channel.id))
        }
        return BootstrapOut(serverTime: now(), me: me, users: Array(users.values), channels: mine,
                            limits: Limits(maxMessageLength: 20000, maxAttachmentBytes: 1, maxAttachmentsPerMessage: 10),
                            threads: threadSummary(for: userId),
                            presence: Array(Set(sockets.filter(\.authed).map(\.userId))).sorted().map { PresenceEntry(userId: $0, status: presenceOf($0)) },
                            bookmarks: bookmarks[userId] ?? [],
                            favorites: (favorites[userId] ?? []).filter { channels[$0]?.members.contains(userId) == true },
                            customEmoji: Array(customEmoji.values), roster: Array(roster.values), drafts: drafts(of: userId),
                            activity: activity[userId], workspaceSettings: workspaceSettings,
                            attendance: user.role == "guest" || attendance?.enabled != true ? nil : attendance,
                            actions: user.role == "guest" || actions?.enabled != true ? nil : actionList(for: user.id))
    }

    func history(userId: String, channelId: String, beforeSeq: Int?, limit: Int) throws -> HistoryOut {
        let record = try requireMember(channelId, userId)
        let channelLastSeq = record.channel.lastSeq // read BEFORE the rows (§4.3)
        var rows = record.messages.filter { !$0.deleted && ($0.parentId == nil || $0.alsoInChannel) }
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
