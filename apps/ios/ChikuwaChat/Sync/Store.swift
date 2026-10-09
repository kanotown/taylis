import Foundation
import UIKit
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
    /// §7.3: the oldest seq of the timeline window read contiguously from the newest page (0 = all of it; nil = no
    /// window yet). Older rows that arrive on their own are stored but neither shown nor used for paging.
    var oldestLoadedSeq: Int?
    /// §10.1 (M17): created_at of the oldest unread message, for the unread banner's 「… 以降」; replaced with the counts.
    var firstUnreadAt: String?

    var id: String { channel.id }
    /// The channel's own notification level; nil = it follows my overall setting (M35).
    var ownNotificationLevel: String? { channel.notification?.ownLevel }
    /// Own level "none", muted until unmuted (M35) or an active timed mute (SYNC_PROTOCOL.md §10.5). The overall
    /// setting never counts: it silences pushes, not unread.
    var isMuted: Bool { isMuted(now: Date()) }
    func isMuted(now: Date) -> Bool {
        guard let pref = channel.notification else { return false }
        if pref.ownLevel == "none" || pref.muted { return true }
        guard let until = pref.mutedUntil.flatMap(parseIsoDate) else { return false }
        return until > now
    }
    /// M24: someone else's times whose own level is not "all" is quiet unread: unread only with a mention, a faint dot
    /// otherwise (SYNC_PROTOCOL.md §10.5; the vectors in apps/shared/unread-rules.json).
    func isQuiet(meId: String?, now: Date = Date()) -> Bool {
        guard let owner = channel.timesOwnerId, owner != meId else { return false }
        return ownNotificationLevel != "all" && !isMuted(now: now)
    }
    /// M35: what this conversation notifies me of, with my overall setting (PUSH_NOTIFICATIONS.md §4).
    func pushLevel(overall: String, meId: String?) -> String {
        let othersTimes = channel.timesOwnerId.map { $0 != meId } ?? false
        return NotificationRules.pushLevel(own: ownNotificationLevel, isDm: channel.isDm, othersTimes: othersTimes, overall: overall)
    }
    /// Slack / Mattermost rule: a muted conversation is unread only when I am mentioned; so is a quiet one (M24).
    /// Bold rows, the unread filter and the workspace dot all ask this, with my id.
    func hasUnread(meId: String?, now: Date = Date()) -> Bool {
        guard isMember else { return false }
        return isMuted(now: now) || isQuiet(meId: meId, now: now) ? mentionCount > 0 : unreadCount > 0
    }
    /// What the app badge and the list show for this channel (PUSH_NOTIFICATIONS.md §4.2). Quiet channels need no
    /// rule of their own: a channel's badge is its mentions already.
    var badgeContribution: Int { badgeContribution(now: Date()) }
    func badgeContribution(now: Date) -> Int { isMuted(now: now) ? mentionCount : (channel.isDm ? unreadCount : mentionCount) }
    /// M15a: whether I may start top-level posts here; thread replies stay open to every member.
    func canPostTopLevel(isAdmin: Bool) -> Bool {
        !channel.isAnnouncement || isAdmin || channel.membership?.role == "owner"
    }

    enum CodingKeys: String, CodingKey {
        case channel, isMember, syncedSeq, lastSeq, lastReadSeq, unreadCount, mentionCount, hasOlder, oldestLoadedSeq, firstUnreadAt
    }

    init(channel: ChannelOut, isMember: Bool, syncedSeq: Int?, lastSeq: Int, lastReadSeq: Int = 0, unreadCount: Int = 0, mentionCount: Int = 0, hasOlder: Bool,
         oldestLoadedSeq: Int? = nil, firstUnreadAt: String? = nil) {
        self.channel = channel
        self.isMember = isMember
        self.syncedSeq = syncedSeq
        self.lastSeq = lastSeq
        self.lastReadSeq = lastReadSeq
        self.unreadCount = unreadCount
        self.mentionCount = mentionCount
        self.hasOlder = hasOlder
        self.oldestLoadedSeq = oldestLoadedSeq
        self.firstUnreadAt = firstUnreadAt
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
        oldestLoadedSeq = try c.decodeIfPresent(Int.self, forKey: .oldestLoadedSeq)
        firstUnreadAt = try c.decodeIfPresent(String.self, forKey: .firstUnreadAt)
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
    /// "user", or "system" for rows the server writes itself (never counted as unread, §10.1 12.). Rows persisted
    /// before M17 lack it.
    var type = "user"
    var reactions: [ReactionOut] = []
    var mentionedUserIds: [String] = []
    var mentionAll: Bool = false
    var parentId: String? = nil
    /// M15c: a reply shown in the channel timeline as well as in its thread.
    var alsoInChannel: Bool = false
    var replyCount: Int = 0
    var lastReplyAt: String? = nil
    /// C3: who replied, most recent first (at most 5); rows persisted earlier, and older servers, have none.
    var replyUserIds: [String] = []
    var attachments: [AttachmentOut] = []
    /// M11c: pinned in the channel; rows persisted earlier lack the fields.
    var pinnedAt: String? = nil
    var pinnedBy: String? = nil
    /// M14b: the poll, when the message carries one.
    var poll: PollOut? = nil
    /// M15e: priority label and acknowledgements (only when asked for).
    var priority: String? = nil
    var ackRequested: Bool = false
    var acks: [AckOut] = []
    /// L6 (M59): who of a collecting post's targets has replied; rows persisted earlier lack it.
    var collection: CollectionOut? = nil
    /// L9 (M64): the shared tasks made from it, for their chips; rows persisted earlier lack it.
    var tasks: [MessageTaskOut] = []
    /// M88 (MEMBERSHIP.md §5): a system line's event, kept so the line is written again with today's names after a
    /// restart; rows persisted earlier lack it (their `body` shows).
    var systemEvent: SystemEvent? = nil
    /// M95 (WORKFLOWS.md §8): the workflow whose form posted it (「⚡ name」 above it); rows persisted earlier lack it.
    var workflow: MessageWorkflow? = nil
    /// M117 (docs/CALLS.md §5): the call it started (its card instead of the link); rows persisted earlier lack it.
    var call: MessageCall? = nil

    enum CodingKeys: String, CodingKey {
        case id, channelId, senderId, seq, updatedSeq, clientMsgId, body, createdAt, editedAt, deleted, pending, failed, type
        case reactions, mentionedUserIds, mentionAll, parentId, alsoInChannel, replyCount, lastReplyAt, replyUserIds, attachments, pinnedAt, pinnedBy, poll
        case priority, ackRequested, acks, collection, tasks, systemEvent, workflow, call
    }

    /// M88: a line the server writes (the join / leave lines): one muted line, never grouped, no actions.
    var isSystem: Bool { type != "user" }

    func reactedBy(_ userId: String, _ emoji: String) -> Bool {
        reactions.contains { $0.emoji == emoji && $0.userIds.contains(userId) }
    }

    var isReply: Bool { parentId != nil }
    /// The channel timeline shows top-level messages and replies also sent to the channel (M15c).
    var inTimeline: Bool { parentId == nil || alsoInChannel }
    /// Counted in unread_count the way the server counts it (§10.1 12.): someone else's user message in the timeline.
    func countsAsUnread(meId: String?) -> Bool { senderId != meId && type == "user" && inTimeline && !deleted && !pending }

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
        type = message.type
        reactions = message.reactions
        mentionedUserIds = message.mentionedUserIds
        mentionAll = message.mentionAll
        parentId = message.parentId
        alsoInChannel = message.alsoInChannel
        replyCount = message.replyCount
        lastReplyAt = message.lastReplyAt
        replyUserIds = message.replyUserIds
        attachments = message.attachments
        pinnedAt = message.pinnedAt
        pinnedBy = message.pinnedBy
        poll = message.poll
        priority = message.priority
        ackRequested = message.ackRequested
        acks = message.acks
        collection = message.collection
        tasks = message.tasks
        systemEvent = message.systemEvent
        workflow = message.workflow
        call = message.call
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
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "user"
        reactions = try c.decodeIfPresent([ReactionOut].self, forKey: .reactions) ?? []
        mentionedUserIds = try c.decodeIfPresent([String].self, forKey: .mentionedUserIds) ?? []
        mentionAll = try c.decodeIfPresent(Bool.self, forKey: .mentionAll) ?? false
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        alsoInChannel = try c.decodeIfPresent(Bool.self, forKey: .alsoInChannel) ?? false
        replyCount = try c.decodeIfPresent(Int.self, forKey: .replyCount) ?? 0
        lastReplyAt = try c.decodeIfPresent(String.self, forKey: .lastReplyAt)
        replyUserIds = try c.decodeIfPresent([String].self, forKey: .replyUserIds) ?? []
        attachments = try c.decodeIfPresent([AttachmentOut].self, forKey: .attachments) ?? []
        pinnedAt = try c.decodeIfPresent(String.self, forKey: .pinnedAt)
        pinnedBy = try c.decodeIfPresent(String.self, forKey: .pinnedBy)
        poll = try c.decodeIfPresent(PollOut.self, forKey: .poll)
        priority = try c.decodeIfPresent(String.self, forKey: .priority)
        ackRequested = try c.decodeIfPresent(Bool.self, forKey: .ackRequested) ?? false
        acks = try c.decodeIfPresent([AckOut].self, forKey: .acks) ?? []
        collection = try? c.decodeIfPresent(CollectionOut.self, forKey: .collection)
        tasks = MessageTaskOut.list(c, forKey: .tasks)
        systemEvent = try? c.decodeIfPresent(SystemEvent.self, forKey: .systemEvent)
        workflow = try? c.decodeIfPresent(MessageWorkflow.self, forKey: .workflow)
        call = try? c.decodeIfPresent(MessageCall.self, forKey: .call)
    }

    init(placeholderFor clientMsgId: String, channelId: String, senderId: String, body: String, createdAt: String, parentId: String? = nil,
         alsoInChannel: Bool = false, priority: String? = nil, ackRequested: Bool = false) {
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
        self.alsoInChannel = alsoInChannel
        self.priority = priority
        self.ackRequested = ackRequested
    }
}

/// One row of the threads view (THREADS.md §5): the parent and my relation to the thread. Not persisted:
/// the badge comes with bootstrap and the list is fetched when the view opens.
struct ThreadEntry: Identifiable, Equatable {
    var parent: MessageOut
    var state: ThreadState
    /// The thread's newest replies, oldest first (at most `Store.threadPreviewReplies`; GET /threads `latest_replies`, then
    /// kept by message events). nil: a server before the previews, or a row made from thread.updated alone; the card
    /// shows the parent only.
    var latestReplies: [MessageState]? = nil
    var id: String { parent.id }
}

extension MessageOut {
    /// A confirmed local row in the server shape (thread rows built from the timeline).
    init?(_ state: MessageState) {
        guard let seq = state.seq, !state.pending else { return nil }
        self.init(id: state.id, channelId: state.channelId, senderId: state.senderId, seq: seq, updatedSeq: state.updatedSeq,
                  clientMsgId: state.clientMsgId, body: state.body, createdAt: state.createdAt, editedAt: state.editedAt, deleted: state.deleted,
                  type: state.type, mentionedUserIds: state.mentionedUserIds, mentionAll: state.mentionAll, reactions: state.reactions, parentId: state.parentId,
                  alsoInChannel: state.alsoInChannel, replyCount: state.replyCount, lastReplyAt: state.lastReplyAt, replyUserIds: state.replyUserIds, attachments: state.attachments,
                  pinnedAt: state.pinnedAt, pinnedBy: state.pinnedBy, poll: state.poll,
                  priority: state.priority, ackRequested: state.ackRequested, acks: state.acks, collection: state.collection,
                  tasks: state.tasks, systemEvent: state.systemEvent, workflow: state.workflow, call: state.call)
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
    /// M15c / M15e; optional so that rows queued by earlier versions still decode.
    var alsoInChannel: Bool? = nil
    var priority: String? = nil
    var ackRequested: Bool? = nil

    var id: String { clientMsgId }
}

struct Draft: Codable, Equatable {
    var text = ""
    var attachments: [AttachmentOut] = []
    /// M15d: edited here and not yet saved on the server (an emptied draft stays until its delete is saved).
    var dirty: Bool? = nil
    /// M15d: the server's `updated_at` of the version this device last matched.
    var syncedAt: String? = nil

    var isDirty: Bool { dirty ?? false }
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
    func close()
    func loadAll() throws -> Snapshot
    func saveMeta(key: String, value: String?) throws
    func saveUser(_ user: UserPublic) throws
    func saveChannel(_ channel: ChannelState) throws
    func deleteChannel(id: String) throws
    func saveMessage(_ message: MessageState) throws
    func deleteMessage(id: String) throws
    func clearMessages(channelId: String) throws
    /// Confirmed rows of the channel with seq < beforeSeq (pending ones stay).
    func deleteOlderMessages(channelId: String, beforeSeq: Int) throws
    func saveOutbox(_ item: OutboxItem) throws
    func deleteOutbox(clientMsgId: String) throws
    /// M74: the cached canvases' metadata (their bodies stay on disk until one opens).
    func loadCachedCanvasIndex() throws -> [CachedCanvasEntry]
    func loadCachedCanvasBody(id: String) throws -> String?
    /// A nil body only moves `savedAt` (a 304: the copy is still the current one).
    func saveCachedCanvas(_ entry: CachedCanvasEntry, body: String?) throws
    func deleteCachedCanvas(id: String) throws
}

/// M74 (CANVAS.md §19.1): a canvas as this device last received it from the server.
struct CachedCanvasEntry: Equatable {
    var meta: CanvasMeta
    /// When the server last gave (or confirmed) this copy: 「最後に読み込んだ時点」.
    var savedAt: Date
}

struct CachedCanvas: Equatable {
    var canvas: CanvasOut
    var savedAt: Date
}

/// M74: at most this many canvases are kept to read offline (the ones most recently read or saved here), and only of
/// conversations I am a member of.
let cachedCanvasLimit = 200

let localPrefix = "local:"

/// At most this many messages are kept per channel (M22, SYNC_PROTOCOL.md §7.7): the newest ones (pending sends always
/// stay). Older history is paged in again when the reader scrolls up.
let cachedMessagesPerChannel = 500

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
    /// M39: the activity badge and read position; nil while the server has sent none (before M39: stage A). Kept with
    /// `me`, so an offline start shows the last badge; bootstrap replaces it.
    private(set) var activity: ActivitySummary?
    var threadsFilter = "all"
    var threadsLoaded = false
    var threadsCursor: String?
    var threadsHasMore = false
    /// Who is connected right now (SYNC_PROTOCOL.md §5.2); absent = offline. Replaced by bootstrap.
    var presence: [String: String] = [:]
    /// "channel[:parent]" → user id → expiry; volatile typing indicators.
    var typing: [String: [String: Date]] = [:]
    /// M73 (CANVAS.md §18.2): who else edits which canvas (volatile `canvas_presence` frames, 45 s without a refresh).
    private(set) var canvasEditing = CanvasEditors()
    /// My saved message ids (M11c); from bootstrap and bookmark.updated, not persisted.
    var bookmarks: Set<String> = []
    /// My starred channel ids (M12a); from bootstrap and favorite.updated, not persisted.
    var favorites: Set<String> = []
    /// M118 (DATA_MODEL.md conversation_pins): the DMs pinned to the top of the DM lists, oldest pin first; from bootstrap
    /// and dm_pin.updated, not persisted (an offline start lists without pins until the first bootstrap).
    private(set) var dmPins: [String] = []
    /// The server sends `dm_pins` (M118 or later): only then are 「上に固定」/「固定を外す」 offered.
    private(set) var dmPinsSupported = false
    /// M141 (SYNC_PROTOCOL.md §7.9): the DMs I closed (「会話を閉じる」), hidden from the DM lists until a new message
    /// or an explicit open; from bootstrap, dm_close.updated and message.created, not persisted.
    private(set) var closedDms: Set<String> = []
    /// The server sends `closed_dms` (M141 or later): only then is 「会話を閉じる」 offered.
    private(set) var closedDmsSupported = false
    /// M104 (MODERATION.md §4): the people I blocked; from bootstrap and block.updated, not persisted.
    var blockedUsers: Set<String> = []
    /// My pending scheduled messages (M12d); from GET /scheduled and scheduled.updated, not persisted.
    var scheduled: [String: ScheduledOut] = [:]
    /// My open reminders (M12e): fired ones wait for 完了, pending ones for their time.
    var reminders: [String: ReminderOut] = [:]
    /// Custom emoji by name (M12f); from bootstrap and emoji.updated. Images are cached by id once fetched.
    var customEmoji: [String: CustomEmojiOut] = [:]
    /// Post templates (M30): the workspace's and mine; from bootstrap and template.updated.
    var templates: [TemplateOut] = []
    var emojiImages: [String: UIImage] = [:]
    /// M100: emoji packs by id (picker tabs) and their tab icons by "id:version".
    var emojiPacks: [String: EmojiPackOut] = [:]
    var packTabImages: [String: UIImage] = [:]
    /// The frames of the animated ones (GIF), by id; their first frame is in `emojiImages`.
    var emojiAnimations: [String: EmojiAnimation] = [:]
    /// User groups by id (M12k); from bootstrap and group.updated. `@name` expands on the server.
    var groups: [String: GroupOut] = [:]
    /// The lab roster by user id (M23, DATA_MODEL.md lab_profiles); from bootstrap and roster.updated, not persisted.
    /// Only the member lists and profile screens read it, so a change redraws those and no timeline (M20). The order is
    /// Roster's.
    var roster: [String: LabProfileOut] = [:]
    /// My sidebar sections (M14f), in order; from bootstrap and sidebar.updated.
    var sidebarSections: [SidebarSectionOut] = []
    /// The default sections' sorts (DATA_MODEL.md 「並べ替え」); empty = the defaults.
    var sidebarDefaults: [SidebarDefaultOut] = []
    /// Server limits from bootstrap (max attachment size …); nil until the first one.
    var limits: Limits?
    /// M88 (MEMBERSHIP.md §3): the workspace's switches, from bootstrap and workspace.settings_updated. Not persisted:
    /// the defaults (both on) until the first bootstrap.
    private(set) var workspaceSettings = WorkspaceSettings.defaults
    /// M93: bootstrap's or workspace.settings_updated's `icon_version` (only when the server sends it): the saved entry follows.
    @ObservationIgnored var onWorkspaceIcon: ((String?) -> Void)?

    /// bootstrap (nil from a server before M88: the defaults) or workspace.settings_updated.
    func setWorkspaceSettings(_ settings: WorkspaceSettings?) {
        let next = settings ?? .defaults
        if next != workspaceSettings { workspaceSettings = next } // every reconnect bootstraps: unchanged redraws nothing
        if next.hasIconVersion { onWorkspaceIcon?(next.iconVersion) }
    }

    /// M117 (docs/CALLS.md §7): `409 calls_disabled`, the setting went off before its event came: the 📞 goes until the
    /// next bootstrap or workspace.settings_updated says otherwise.
    func callsTurnedOff() {
        workspaceSettings.callsEnabled = false
        workspaceSettings.meetingBaseUrl = nil
    }
    /// A conversation left the store (left, removed, made private); the engine forgets it as the open one.
    @ObservationIgnored var onChannelRemoved: ((String) -> Void)?
    /// L8 (TIMES_FEED.md §5, review #4): every server row given to the store (live events, the delta, pages, the answers
    /// to my own actions), my own poll part of an answer, and a parent's new thread counters: the Times feed, which keeps
    /// rows of its own, takes them from here as well as from the live events.
    @ObservationIgnored var onMessageTaken: ((MessageOut) -> Void)?
    @ObservationIgnored var onMyPart: ((MessageOut) -> Void)?
    @ObservationIgnored var onParentThread: ((ParentThread) -> Void)?
    /// §10: read positions this device reached that the server has not confirmed yet, by channel id or
    /// "thread:<parent id>". Persisted, so a mark made just before the app quit is still sent after reconnecting.
    @ObservationIgnored private(set) var unsentReads: [String: Int] = [:]
    private static let unsentReadsKey = "unsent_reads"

    func setUnsentRead(_ key: String, _ seq: Int?) {
        guard unsentReads[key] != seq else { return }
        unsentReads[key] = seq
        let encoded = unsentReads.isEmpty ? nil : (try? JSON.plainEncoder.encode(unsentReads)).flatMap { String(data: $0, encoding: .utf8) }
        persist { try $0.saveMeta(key: Self.unsentReadsKey, value: encoded) }
    }
    /// M15f: link bars of the conversations opened so far (not persisted).
    var channelLinks: [String: [ChannelLinkOut]] = [:]
    func setChannelLinks(_ channelId: String, _ links: [ChannelLinkOut]) { channelLinks[channelId] = links }
    func linksOf(_ channelId: String) -> [ChannelLinkOut] { channelLinks[channelId] ?? [] }
    /// M112 (docs/RESERVATIONS.md §6): the workspace's reservation pools as the server answered me (not persisted); nil
    /// until first read (after every bootstrap, then on reservation.updated) or with a server before M112.
    var reservationPools: [PoolOut]?
    func setReservationPools(_ pools: [PoolOut]?) { reservationPools = pools }
    /// One pool as an action answered it (replaced in place, or added at the end).
    func putReservationPool(_ pool: PoolOut) {
        var list = reservationPools ?? []
        if let index = list.firstIndex(where: { $0.id == pool.id }) { list[index] = pool } else { list.append(pool) }
        reservationPools = list
    }
    func dropReservationPool(_ poolId: String) { reservationPools = reservationPools?.filter { $0.id != poolId } }
    /// M140 (docs/PRESENCE.md §4): the 在室状況 board (not persisted); nil for guests, while it is off and from a server
    /// before M140. From the bootstrap, attendance.updated (one row) and GET /attendance (attendance.config_updated).
    private(set) var attendance: AttendanceBoardOut?
    func setAttendance(_ board: AttendanceBoardOut?) {
        let next = board?.enabled == true ? board : nil
        if next != attendance { attendance = next }  // every reconnect bootstraps: unchanged redraws nothing
    }
    /// M143 (docs/ACTIONS.md §7.1): the 操作ボタン I may press (not persisted); nil for guests, while the feature is off and
    /// from a server before M143. From the bootstrap and GET /actions (actions.updated).
    private(set) var actions: ActionListOut?
    func setActions(_ list: ActionListOut?) {
        let next = list?.enabled == true ? list : nil
        if next != actions { actions = next }
        if next == nil, !actionStatuses.isEmpty { actionStatuses = [:] }
    }
    /// M143 (docs/ACTIONS.md §12): the state of each group's devices by group key (ActionRules.statusKey: "g:<label>",
    /// or "a:<id>" for a button without a group). From GET /actions/status and actions.status_updated; not persisted.
    private(set) var actionStatuses: [String: ActionStatusOut] = [:]
    /// A whole answer of GET /actions/status (groups no longer in it are dropped).
    func setActionStatuses(_ list: ActionStatusListOut) {
        var next: [String: ActionStatusOut] = [:]
        if list.enabled {
            for status in list.statuses { next[ActionRules.statusKey(status.groupLabel, status.actionId)] = status }
        }
        if next != actionStatuses { actionStatuses = next }
    }
    /// One group's state (actions.status_updated): an answer older than the one held is ignored.
    func applyActionStatus(_ status: ActionStatusOut) {
        let key = ActionRules.statusKey(status.groupLabel, status.actionId)
        if let held = actionStatuses[key], ActionRules.isNewer(held.fetchedAt, than: status.fetchedAt) { return }
        if actionStatuses[key] != status { actionStatuses[key] = status }
    }
    /// One person's row (attendance.updated, or my own change answered). False when its state is not on the board held
    /// here (someone's new own state): the caller reads the board again.
    @discardableResult
    func applyAttendanceEntry(_ entry: AttendanceEntryOut) -> Bool {
        guard let board = attendance else { return true }
        let next = AttendanceRules.applying(entry, to: board)
        if next.board != board { attendance = next.board }
        return next.known
    }
    private var drafts: [String: Draft] = [:]
    private var uploads: [String: Int] = [:]

    /// M45 (CANVAS.md §4.6): the canvases of the conversations opened so far, without bodies, most recently updated
    /// first. Loaded when a conversation opens and after reconnecting; canvas.* events keep them current (the larger
    /// version wins). Not persisted (M74: when it cannot be loaded, the cached canvases stand in).
    private(set) var canvasLists: [String: [CanvasMeta]] = [:]
    /// nil: not loaded yet.
    func canvasesOf(_ channelId: String) -> [CanvasMeta]? { canvasLists[channelId] }
    func canvasMeta(_ canvasId: String) -> CanvasMeta? {
        for list in canvasLists.values { if let found = list.first(where: { $0.id == canvasId }) { return found } }
        return nil
    }

    /// Why the conversation's list could not be loaded (cleared when it loads): the tab shows it instead of a spinner.
    private(set) var canvasListFailures: [String: CanvasListFailure] = [:]
    func canvasListFailure(_ channelId: String) -> CanvasListFailure? { canvasListFailures[channelId] }
    func setCanvasListFailure(_ channelId: String, _ failure: CanvasListFailure?) {
        if canvasListFailures[channelId] != failure { canvasListFailures[channelId] = failure }
    }

    func setCanvases(_ channelId: String, _ list: [CanvasMeta]) {
        setCanvasListFailure(channelId, nil)
        let known = canvasLists[channelId] ?? []
        // A newer version from an event that overtook the list keeps its place.
        let merged = list.map { meta in known.first(where: { $0.id == meta.id }).flatMap { $0.version > meta.version ? $0 : nil } ?? meta }
        canvasLists[channelId] = Self.sortedCanvases(merged)
    }

    /// canvas.created / canvas.updated, or an answer of mine: the larger version wins.
    func applyCanvasMeta(_ meta: CanvasMeta) {
        guard let list = canvasLists[meta.channelId] else { return } // loaded with the list when the conversation opens
        if let existing = list.first(where: { $0.id == meta.id }), existing.version >= meta.version { return }
        var live = meta
        live.deletedAt = nil
        canvasLists[meta.channelId] = Self.sortedCanvases(list.filter { $0.id != meta.id } + [live])
    }

    func removeCanvas(channelId: String, canvasId: String) {
        guard let list = canvasLists[channelId], list.contains(where: { $0.id == canvasId }) else { return }
        canvasLists[channelId] = list.filter { $0.id != canvasId }
    }

    static func sortedCanvases(_ list: [CanvasMeta]) -> [CanvasMeta] {
        list.sorted { a, b in a.updatedAt != b.updatedAt ? a.updatedAt > b.updatedAt : a.id > b.id }
    }

    /// M45: unsaved canvas edits, kept in SQLite under "canvas:<id>", so a restart sends them (same key, §4.4).
    @ObservationIgnored private var canvasPending: [String: CanvasPendingState] = [:]
    private static let canvasPrefix = "canvas:"
    func pendingCanvas(_ canvasId: String) -> CanvasPendingState? { canvasPending[canvasId] }
    func pendingCanvases() -> [(id: String, state: CanvasPendingState)] {
        canvasPending.keys.sorted().compactMap { id in canvasPending[id].map { (id, $0) } }
    }

    func setPendingCanvas(_ canvasId: String, _ state: CanvasPendingState?) {
        if canvasPending[canvasId] == state { return }
        canvasPending[canvasId] = state
        let encoded = state.flatMap { try? JSON.plainEncoder.encode($0) }.flatMap { String(data: $0, encoding: .utf8) }
        persist { try $0.saveMeta(key: Self.canvasPrefix + canvasId, value: encoded) }
    }

    // MARK: M122 the wiki's kept state (docs/WIKI.md §10)

    /// What the wiki keeps on this device (WikiHub): the tree (`wiki:tree`), the pages read lately (`wiki:page:<id>`) and
    /// unsaved page edits (`wiki:pending:<id>`), as SQLite meta rows. Loaded with the rest at start; the hub decodes them.
    @ObservationIgnored private var wikiKept: [String: String] = [:]
    static let wikiPrefix = "wiki:"

    func wikiValue(_ key: String) -> String? { wikiKept[key] }

    /// The keys kept under `prefix` (one of the wiki's own).
    func wikiKeys(prefix: String) -> [String] { wikiKept.keys.filter { $0.hasPrefix(prefix) }.sorted() }

    func setWikiValue(_ key: String, _ value: String?) {
        guard key.hasPrefix(Self.wikiPrefix), wikiKept[key] != value else { return }
        wikiKept[key] = value
        persist { try $0.saveMeta(key: key, value: value) }
    }

    // MARK: M74 cached canvases (CANVAS.md §19.1)

    /// The canvases kept to read offline: their metadata here, their bodies in SQLite (in memory without persistence,
    /// the tests). Written whenever the server sends a canvas with its body (a read, a save's answer, a conflict's head).
    @ObservationIgnored private var canvasCache: [String: CachedCanvasEntry] = [:]
    @ObservationIgnored private var canvasCacheBodies: [String: String] = [:]

    func cachedCanvas(_ canvasId: String) -> CachedCanvas? {
        guard let entry = canvasCache[canvasId] else { return nil }
        let body: String?
        if let persistence {
            body = (try? persistence.loadCachedCanvasBody(id: canvasId)) ?? nil
        } else {
            body = canvasCacheBodies[canvasId]
        }
        guard let body else { return nil }
        let meta = entry.meta
        let canvas = CanvasOut(id: meta.id, channelId: meta.channelId, title: meta.title, version: meta.version, headRevId: meta.headRevId,
                               isChannelTab: meta.isChannelTab, editPolicy: meta.editPolicy, templateKey: meta.templateKey,
                               shareMessageId: meta.shareMessageId, taskTotal: meta.taskTotal, taskDone: meta.taskDone,
                               createdBy: meta.createdBy, updatedBy: meta.updatedBy, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
                               deletedAt: meta.deletedAt, body: body)
        return CachedCanvas(canvas: canvas, savedAt: entry.savedAt)
    }

    /// The cached canvases of a conversation (the tab's list when it cannot be loaded), most recently updated first.
    func cachedCanvases(of channelId: String) -> [CanvasMeta] {
        Self.sortedCanvases(canvasCache.values.filter { $0.meta.channelId == channelId }.map(\.meta))
    }

    var cachedCanvasIds: Set<String> { Set(canvasCache.keys) }
    func cachedCanvasMeta(_ canvasId: String) -> CanvasMeta? { canvasCache[canvasId]?.meta }

    /// The server's copy of a canvas: kept (an older version than the kept one is not), and the oldest past the cap go.
    func cacheCanvas(_ canvas: CanvasOut, now: Date = Date()) {
        guard channels[canvas.channelId]?.isMember == true, canvas.deletedAt == nil else { return }
        if let kept = canvasCache[canvas.id], kept.meta.version > canvas.version { return }
        var meta = canvas.meta
        meta.deletedAt = nil
        let entry = CachedCanvasEntry(meta: meta, savedAt: now)
        canvasCache[canvas.id] = entry
        if persistence == nil { canvasCacheBodies[canvas.id] = canvas.body }
        persist { try $0.saveCachedCanvas(entry, body: canvas.body) }
        trimCanvasCache()
    }

    /// A 304: the kept copy is still the current one, as of now.
    func touchCachedCanvas(_ canvasId: String, now: Date = Date()) {
        guard var entry = canvasCache[canvasId] else { return }
        entry.savedAt = now
        canvasCache[canvasId] = entry
        persist { try $0.saveCachedCanvas(entry, body: nil) }
    }

    func dropCachedCanvas(_ canvasId: String) {
        guard canvasCache.removeValue(forKey: canvasId) != nil else { return }
        canvasCacheBodies[canvasId] = nil
        persist { try $0.deleteCachedCanvas(id: canvasId) }
    }

    private func trimCanvasCache() {
        guard canvasCache.count > cachedCanvasLimit else { return }
        let oldest = canvasCache.values.sorted { a, b in a.savedAt != b.savedAt ? a.savedAt < b.savedAt : a.meta.id < b.meta.id }
        for entry in oldest.prefix(canvasCache.count - cachedCanvasLimit) { dropCachedCanvas(entry.meta.id) }
    }

    /// At start: the kept canvases of conversations still mine (one left while the app was closed goes).
    private func loadCanvasCache() {
        guard let persistence, let entries = try? persistence.loadCachedCanvasIndex() else { return }
        for entry in entries { canvasCache[entry.meta.id] = entry }
        for entry in entries where channels[entry.meta.channelId]?.isMember != true { dropCachedCanvas(entry.meta.id) }
        trimCanvasCache()
    }

    private func draftKey(_ channelId: String, _ parentId: String?) -> String { "draft:\(channelId):\(parentId ?? "")" }
    func draft(_ channelId: String, parentId: String? = nil) -> Draft { drafts[draftKey(channelId, parentId)] ?? Draft() }
    /// M15d: told about every local text change (the engine saves it on the server a moment later).
    @ObservationIgnored var onDraftEdited: ((_ channelId: String, _ parentId: String?) -> Void)?

    func setDraft(_ channelId: String, parentId: String? = nil, _ mutate: (inout Draft) -> Void) {
        let previous = draft(channelId, parentId: parentId)
        var value = previous
        mutate(&value)
        let edited = value.text != previous.text
        if edited { value.dirty = true }
        writeDraft(draftKey(channelId, parentId), value)
        if edited { onDraftEdited?(channelId, parentId) }
    }

    /// 「下書き」's 削除 (2026-10-09): the conversation's draft goes, as when its composer is emptied after sending — the
    /// engine deletes it on the server at once, so my other devices drop it too (M15d).
    func discardDraft(_ channelId: String, parentId: String? = nil) {
        setDraft(channelId, parentId: parentId) { $0 = Draft() }
    }

    private func writeDraft(_ key: String, _ value: Draft) {
        let keep = !value.text.isEmpty || !value.attachments.isEmpty || value.isDirty
        drafts[key] = keep ? value : nil
        let encoded = drafts[key].flatMap { try? JSON.plainEncoder.encode($0) }.flatMap { String(data: $0, encoding: .utf8) }
        persist { try $0.saveMeta(key: key, value: encoded) }
    }

    /// M15d: every stored draft, including emptied ones whose delete is not saved yet.
    func draftEntries() -> [DraftEntry] {
        drafts.keys.sorted().compactMap { key in
            let parts = key.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
            guard parts.count == 3, let draft = drafts[key] else { return nil }
            return DraftEntry(channelId: String(parts[1]), parentId: parts[2].isEmpty ? nil : String(parts[2]), draft: draft)
        }
    }

    /// M15d: a version from my other devices (`body` nil = deleted there); ignored while this device has unsaved edits.
    func applyRemoteDraft(_ channelId: String, parentId: String?, body: String?, updatedAt: String?) {
        let key = draftKey(channelId, parentId)
        let current = drafts[key]
        if current?.isDirty == true { return }
        let next = Draft(text: body ?? "", attachments: current?.attachments ?? [], dirty: nil, syncedAt: body == nil ? nil : updatedAt)
        if let current, current.text == next.text, current.syncedAt == next.syncedAt { return }
        if current == nil && next.text.isEmpty { return }
        writeDraft(key, next)
    }

    /// M15d: the server now holds `text` (no draft when `updatedAt` is nil), unless it was edited again meanwhile.
    func markDraftSaved(_ channelId: String, parentId: String?, text: String, updatedAt: String?) {
        let key = draftKey(channelId, parentId)
        guard var current = drafts[key], current.text == text else { return }
        current.dirty = nil
        current.syncedAt = updatedAt
        writeDraft(key, current)
    }

    func markDraftDirty(_ channelId: String, parentId: String?) {
        let key = draftKey(channelId, parentId)
        guard var current = drafts[key], !current.isDirty else { return }
        current.dirty = true
        writeDraft(key, current)
    }
    func uploading(_ channelId: String, parentId: String? = nil) -> Int { uploads[draftKey(channelId, parentId)] ?? 0 }

    /// A conversation with unsent text or attachments (M11h 「下書き」).
    struct DraftEntry: Identifiable {
        let channelId: String
        let parentId: String?
        let draft: Draft
        var id: String { "\(channelId):\(parentId ?? "")" }
    }

    /// Every draft with text or attachments, ordered by conversation.
    func listDrafts() -> [DraftEntry] {
        drafts.keys.sorted().compactMap { key in
            let parts = key.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
            guard parts.count == 3, let draft = drafts[key],
                  !draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !draft.attachments.isEmpty else { return nil }
            return DraftEntry(channelId: String(parts[1]), parentId: parts[2].isEmpty ? nil : String(parts[2]), draft: draft)
        }
    }
    func trackUpload(_ channelId: String, parentId: String? = nil, delta: Int) {
        let key = draftKey(channelId, parentId)
        uploads[key] = max(0, (uploads[key] ?? 0) + delta)
    }
    /// Each channel's messages in a bucket observed on its own (M20): storing a message in one channel no longer redraws
    /// a view showing another, and a view that asked for a channel's rows is told when that channel's bucket changes.
    @ObservationIgnored private var buckets: [String: ChannelMessages] = [:]

    /// The bucket of a channel, made on first use, so a view that asked before any row arrived is told when one does.
    private func bucket(_ channelId: String) -> ChannelMessages {
        if let existing = buckets[channelId] { return existing }
        let made = ChannelMessages()
        buckets[channelId] = made
        return made
    }
    private let persistence: Persistence?

    init(persistence: Persistence? = nil) {
        self.persistence = persistence
    }

    func load() {
        guard let persistence, let snapshot = try? persistence.loadAll() else { return }
        apply(snapshot)
        loadCanvasCache()
        noteDndEnds()
    }

    /// Sign-out: the database is closed before its files are deleted; later writes fail quietly.
    func close() { persistence?.close() }

    private func apply(_ snapshot: Snapshot) {
        for (key, value) in snapshot.meta where key.hasPrefix("draft:") {
            if let data = value.data(using: .utf8), let draft = try? JSON.plainDecoder.decode(Draft.self, from: data) { drafts[key] = draft }
        }
        for (key, value) in snapshot.meta where key.hasPrefix(Self.canvasPrefix) {
            if let data = value.data(using: .utf8), let state = try? JSON.plainDecoder.decode(CanvasPendingState.self, from: data) {
                canvasPending[String(key.dropFirst(Self.canvasPrefix.count))] = state
            }
        }
        applyPreviews(snapshot.meta)
        for (key, value) in snapshot.meta where key.hasPrefix(Self.wikiPrefix) { wikiKept[key] = value } // M122
        if let me = snapshot.meta["me"], let data = me.data(using: .utf8) { self.me = try? JSON.plainDecoder.decode(UserMe.self, from: data) }
        if let raw = snapshot.meta[Self.activityKey], let data = raw.data(using: .utf8) {
            activity = try? JSON.plainDecoder.decode(ActivitySummary.self, from: data) // corrupt: the next bootstrap brings it
        }
        if let raw = snapshot.meta[Self.unsentReadsKey], let data = raw.data(using: .utf8) {
            unsentReads = (try? JSON.plainDecoder.decode([String: Int].self, from: data)) ?? [:]
        }
        for user in snapshot.users { users[user.id] = user }
        for channel in snapshot.channels { channels[channel.id] = channel }
        for message in snapshot.messages { bucket(message.channelId).byId[message.id] = message }
        outbox = snapshot.outbox
        for channelId in Array(buckets.keys) { trimMessages(channelId) } // §7.7: the cap applies from the start
    }

    private func persist(_ work: (Persistence) throws -> Void) {
        guard let persistence else { return }
        do { try work(persistence) } catch { print("persist failed: \(error)") }
    }

    // MARK: me / users

    func setMe(_ me: UserMe?) {
        self.me = me
        noteDndEnd(me?.dndUntil)
        let encoded = me.flatMap { try? JSON.plainEncoder.encode($0) }.flatMap { String(data: $0, encoding: .utf8) }
        persist { try $0.saveMeta(key: "me", value: encoded) }
    }

    func upsertUser(_ user: UserPublic) {
        AvatarCache.shared.note(user)  // M14a
        users[user.id] = user
        noteDndEnd(user.dndUntil)
        persist { try $0.saveUser(user) }
    }

    // MARK: channels

    func channel(_ id: String) -> ChannelState? { channels[id] }

    /// Merge server fields into the local channel, keeping the local cursor. A read state (bootstrap) is the
    /// server's and replaces the local one as it is (SYNC_PROTOCOL.md §10: no max merge).
    /// `replacesLastMessage`: bootstrap, whose `last_message` null does mean "no message yet" (M49, §7.8).
    @discardableResult
    func upsertChannel(_ channel: ChannelOut, isMember: Bool? = nil, replacesLastMessage: Bool = false) -> ChannelState {
        let existing = channels[channel.id]
        let read = channel.readState
        var stripped = channel
        stripped.readState = nil
        // channel.updated events carry no per-user preference: keep the one we know.
        stripped.notification = channel.notification ?? existing?.channel.notification
        // Events and some responses carry no membership or count either (M11h): keep the last known ones.
        stripped.membership = channel.membership ?? existing?.channel.membership
        stripped.memberCount = channel.memberCount ?? existing?.channel.memberCount
        // M49: only answers to a member carry the preview; null elsewhere means "not said", so the one held stays.
        if !replacesLastMessage { stripped.lastMessage = channel.lastMessage ?? existing?.channel.lastMessage }
        let merged = ChannelState(
            channel: stripped,
            isMember: isMember ?? existing?.isMember ?? (channel.membership != nil),
            syncedSeq: existing?.syncedSeq,
            lastSeq: max(existing?.lastSeq ?? 0, channel.lastSeq),
            lastReadSeq: read?.lastReadSeq ?? existing?.lastReadSeq ?? 0,
            unreadCount: read?.unreadCount ?? existing?.unreadCount ?? 0,
            mentionCount: read?.mentionCount ?? existing?.mentionCount ?? 0,
            hasOlder: existing?.hasOlder ?? true,
            oldestLoadedSeq: existing?.oldestLoadedSeq,
            firstUnreadAt: read != nil ? read?.firstUnreadAt : existing?.firstUnreadAt
        )
        guard merged != existing else { return merged } // unchanged: nothing redraws (updateChannel)
        channels[channel.id] = merged
        persist { try $0.saveChannel(merged) }
        return merged
    }

    // MARK: the DM list's preview (M49, SYNC_PROTOCOL.md §7.8)

    /// A preview emptied by a deletion the rows held could not replace: the engine asks the server (GET /channels/{id}).
    @ObservationIgnored var onStalePreview: ((String) -> Void)?

    /// A timeline message of one of my conversations moves its preview, also without a timeline held (the DM list shows
    /// conversations never opened). A newer one takes its place; the one shown, edited, brings its new text; the one
    /// shown, deleted, falls back to the newest live row held below it. When the rows held cannot say (no timeline, or
    /// one that does not reach the start), the preview empties and `onStalePreview` asks the server. Thread-only
    /// replies, pending sends, older rows (history pages) and conversations I am not in leave it.
    func applyLastMessage(_ message: MessageState) {
        guard let seq = message.seq, !message.pending, message.inTimeline,
              let channel = channels[message.channelId], channel.isMember else { return }
        let current = channel.channel.lastMessage
        if message.deleted {
            guard current?.id == message.id else { return }
            // The loaded window is contiguous up to syncedSeq (§7.3): its newest live row below is the newest there is.
            let below = channel.syncedSeq == nil ? nil : messages(channel.id).last { ($0.seq ?? .max) < seq && !$0.deleted }
            updateChannel(channel.id) { $0.channel.lastMessage = below.map(lastMessage(of:)) }
            if below == nil && (channel.syncedSeq == nil || channel.hasOlder) { onStalePreview?(channel.id) }
            return
        }
        if let current, current.id != message.id, current.seq >= seq { return }
        let next = lastMessage(of: message)
        updateChannel(channel.id) { $0.channel.lastMessage = next } // unchanged (a reaction): no write
    }

    /// The server's preview fetched after such a deletion (GET /channels/{id}). A newer one that came in the meantime
    /// (an event after the answer was made) stays.
    func setFetchedLastMessage(_ channelId: String, _ last: LastMessageOut?) {
        if let current = channels[channelId]?.channel.lastMessage, last.map({ current.seq > $0.seq }) ?? true { return }
        updateChannel(channelId) { $0.channel.lastMessage = last }
    }

    /// A held or live row as `last_message` (what the server would send for it).
    func lastMessage(of row: MessageState) -> LastMessageOut {
        LastMessageOut(id: row.id, senderId: row.senderId, type: row.type, seq: row.seq ?? 0,
                       excerpt: Timeline.excerpt(row.body, attachments: row.attachments, users: users, groups: groups, limit: DMList.previewLength),
                       hasAttachments: !row.attachments.isEmpty, createdAt: row.createdAt)
    }

    /// Unread DMs + channel mentions + followed threads with an unread mention (PUSH_NOTIFICATIONS.md §4.2) + fired reminders (M12e).
    var badgeCount: Int { channels.values.reduce(0) { $0 + $1.badgeContribution } + threadSummary.mentionCount + firedReminderCount }

    // MARK: threads (THREADS.md §5)

    func setThreadSummary(_ summary: ThreadSummary) { threadSummary = summary }

    // MARK: link previews (M11g)

    static let previewPrefix = "preview:"
    /// url → its preview, or nil when the page gives none. Kept with the account, so a conversation opened again, even
    /// after a restart, lays its cards out at once: a card that came in late made the rows above it jump (testers,
    /// 2026-10-01). A failure that may pass (offline, rate limited) is only `sessionPreviewFailures`.
    private(set) var linkPreviews: [String: LinkPreviewOut?] = [:]
    @ObservationIgnored private var previewSavedAt: [String: Date] = [:]
    /// Links whose preview could not be asked for this session: no card, and not asked again until the next launch.
    private(set) var sessionPreviewFailures: Set<String> = []

    func setLinkPreview(_ url: String, _ preview: LinkPreviewOut?, at now: Date = Date()) {
        sessionPreviewFailures.remove(url)
        if linkPreviews[url] != .some(preview) { linkPreviews[url] = .some(preview) }
        previewSavedAt[url] = now
        let stored = StoredLinkPreview(preview: preview, savedAt: now.timeIntervalSince1970)
        let encoded = (try? JSON.plainEncoder.encode(stored)).flatMap { String(data: $0, encoding: .utf8) }
        persist { try $0.saveMeta(key: Self.previewPrefix + url, value: encoded) }
    }

    func setLinkPreviewFailed(_ url: String) { sessionPreviewFailures.insert(url) }

    /// Whether the row should ask the server: never asked, or kept longer than the server keeps it (LinkPreviewSlot.stale).
    func linkPreviewWanted(_ url: String, now: Date = Date()) -> Bool {
        if sessionPreviewFailures.contains(url) { return false }
        guard let known = linkPreviews[url] else { return true }
        return LinkPreviewSlot.stale(savedAt: previewSavedAt[url], ok: known != nil, now: now)
    }

    /// The stored previews, the newest `LinkPreviewSlot.kept` (older ones leave the database).
    private func applyPreviews(_ meta: [String: String]) {
        var rows: [(url: String, stored: StoredLinkPreview)] = []
        for (key, value) in meta where key.hasPrefix(Self.previewPrefix) {
            guard let data = value.data(using: .utf8), let stored = try? JSON.plainDecoder.decode(StoredLinkPreview.self, from: data) else { continue }
            rows.append((String(key.dropFirst(Self.previewPrefix.count)), stored))
        }
        rows.sort { $0.stored.savedAt > $1.stored.savedAt }
        for row in rows.prefix(LinkPreviewSlot.kept) {
            linkPreviews[row.url] = .some(row.stored.preview)
            previewSavedAt[row.url] = Date(timeIntervalSince1970: row.stored.savedAt)
        }
        for row in rows.dropFirst(LinkPreviewSlot.kept) { persist { try $0.saveMeta(key: Self.previewPrefix + row.url, value: nil) } }
    }

    // MARK: activity (M39, MOBILE_UI.md §7.2)

    static let activityKey = "activity"

    /// The server's activity summary (bootstrap `activity`, GET /activity/summary, PUT /activity/read). One behind the
    /// read position held is stale and dropped (ActivityRules.accepts); nil (a server before M39) leaves the tab at
    /// stage A.
    func setActivity(_ summary: ActivitySummary?) {
        guard ActivityRules.accepts(summary, over: activity), summary != activity else { return }
        activity = summary
        let encoded = summary.flatMap { try? JSON.plainEncoder.encode($0) }.flatMap { String(data: $0, encoding: .utf8) }
        persist { try $0.saveMeta(key: Self.activityKey, value: encoded) }
    }

    /// activity.read: my read position moved on another device (or by this one's PUT). The dots follow now; the count
    /// comes with the summary fetched after it.
    func advanceActivityRead(_ readAt: String) {
        guard var current = activity, ActivityRules.moves(readAt, readAt: current.readAt) else { return }
        current.readAt = readAt
        setActivity(current)
    }

    /// 2026-10-07 (MOBILE_UI.md §6.4 「開いたら既読」): the activity items I opened (a row tapped here, or
    /// activity.items_read from any of my devices), by the server's item id: when. An item is read while its `at` is not
    /// after that time (a reaction item with a newer reaction is unread again). Not kept: the next list's `read` says so.
    private(set) var openedActivityItems: [String: String] = [:]

    /// Activity items opened at `readAt` (each time only moves forward).
    func noteActivityItemsRead(_ itemIds: [String], readAt: String) {
        for id in itemIds where ActivityRules.moves(readAt, readAt: openedActivityItems[id]) {
            openedActivityItems[id] = readAt
        }
    }

    /// Review v0.1.22 #3 (CANVAS.md §20.8): activity.updated events received; the activity list on screen follows it.
    private(set) var activityUpdates = 0
    /// Their item ids not yet taken by the list (takeUpdatedActivityItems).
    @ObservationIgnored private var updatedActivityItems: Set<String> = []

    /// activity.updated: items I may hold changed in place (an erased canvas version blanked their excerpts).
    func activityItemsUpdated(_ itemIds: [String]) {
        updatedActivityItems.formUnion(itemIds)
        activityUpdates += 1
    }

    /// MOBILE_UI.md §6.4 (2026-10-06): a conversation's read position moved back (read.updated reason "set", 「ここから未読に
    /// する」): mentions there read before are unread again, so the activity lists held are read again.
    private(set) var activityReadsMovedBack = 0

    func activityReadPositionMovedBack() { activityReadsMovedBack += 1 }

    /// The item ids of the activity.updated events since the last call (the list applies them once).
    func takeUpdatedActivityItems() -> Set<String> {
        defer { updatedActivityItems = [] }
        return updatedActivityItems
    }

    /// A page of GET /threads. Rows merge so an open thread keeps its state across filter changes and
    /// refreshes; on a first page, rows the server would have listed but did not (unfollowed or deleted
    /// elsewhere) are dropped.
    func setThreadPage(filter: String, items: [ThreadItem], cursor: String?, append: Bool, pageSize: Int) {
        // A page for the filter the list has left (switched again while it was on its way): its rows are news, its
        // cursor and gaps are not.
        let stale = filter != threadsFilter
        if !append && !stale {
            let listed = Set(items.map(\.parent.id))
            let oldest = items.count >= pageSize ? (items.last?.state.lastReplyAt ?? "") : ""
            for (id, entry) in threads where !listed.contains(id) && entry.state.following {
                if filter == "unread" && entry.state.unreadCount == 0 { continue }
                if (entry.state.lastReplyAt ?? "") >= oldest { threads[id] = nil }
            }
        }
        for item in items {
            threads[item.parent.id] = ThreadEntry(parent: item.parent, state: item.state, latestReplies: item.latestReplies?.map { MessageState($0) })
        }
        if stale { return }
        threadsFilter = filter
        threadsLoaded = true
        threadsCursor = cursor
        threadsHasMore = items.count >= pageSize
    }

    /// 「すべて」/「未読」 tapped: the list filters the rows held here at once (`threadList`), and the first page of the
    /// new filter, fetched next, completes it. Before, the segment and the rows waited for that fetch (a network round
    /// trip, testers: slow). 「さらに表示」 waits for the new page's cursor.
    func selectThreadsFilter(_ filter: String) {
        guard filter != threadsFilter else { return }
        threadsFilter = filter
        threadsCursor = nil
        threadsHasMore = false
    }

    /// How many newest replies a threads-list card shows (the server's LATEST_REPLIES, THREADS.md §5).
    static let threadPreviewReplies = 2

    /// A reply of a listed thread arrived, changed or went (message.created / updated / deleted, my own sends' answers):
    /// the card keeps the newest `threadPreviewReplies` live replies without fetching the list again. A reply that left
    /// the card is replaced from the thread's replies held here, if any (else the list's next fetch fills it). Replies of
    /// people I blocked stay out, as the server leaves them out.
    private func applyThreadPreview(_ message: MessageState) {
        guard let parentId = message.parentId, message.seq != nil, var entry = threads[parentId], let shown = entry.latestReplies else { return }
        let held = shown.contains { $0.id == message.id }
        let visible = !message.deleted && !blockedUsers.contains(message.senderId)
        guard held || visible else { return }
        var next = shown.filter { $0.id != message.id }
        if visible { next.append(message) }
        if next.count < Self.threadPreviewReplies {
            let ids = Set(next.map(\.id)).union([message.id])
            next += replies(message.channelId, parentId: parentId).filter {
                $0.seq != nil && !$0.deleted && !blockedUsers.contains($0.senderId) && !ids.contains($0.id)
            }
        }
        next = Array(next.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }.suffix(Self.threadPreviewReplies))
        guard next != shown else { return }
        entry.latestReplies = next
        threads[parentId] = entry
    }

    /// thread.updated / a PUT response: replace the state; the badge moves with it when the old state is known.
    func applyThreadState(_ state: ThreadState, parent: MessageOut? = nil) {
        let before = threads[state.parentId]?.state
        if var entry = threads[state.parentId] {
            entry.state = state
            entry.parent.replyCount = state.replyCount
            entry.parent.lastReplyAt = state.lastReplyAt
            threads[state.parentId] = entry
        } else if var known = parent ?? buckets[state.channelId]?.byId[state.parentId].flatMap(MessageOut.init) {
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

    /// Thread roots known deleted while the app runs (a message.deleted, a catch-up tombstone, GET replies answering
    /// message_not_found): an open thread of one closes, or says its root is gone (ThreadRootWatch, THREADS.md).
    private(set) var deletedThreadRoots: Set<String> = []

    /// A top-level message is deleted: as a thread's root, the thread goes with it. Its row leaves 「スレッド」 (as the
    /// server's GET /threads leaves it out) and the local draft of a reply to it goes (the server hides and refuses it),
    /// so no composer or draft is left hanging. Idempotent; the root's row, if held, goes too.
    func threadRootDeleted(_ channelId: String, _ parentId: String) {
        if !deletedThreadRoots.contains(parentId) { deletedThreadRoots.insert(parentId) }
        if let gone = threads.removeValue(forKey: parentId)?.state {
            let unread = gone.following && gone.unreadCount > 0 ? 1 : 0
            let mention = gone.following && gone.mentionCount > 0 ? 1 : 0
            if unread + mention > 0 {
                threadSummary = ThreadSummary(unreadCount: max(0, threadSummary.unreadCount - unread),
                                              mentionCount: max(0, threadSummary.mentionCount - mention))
            }
        }
        let key = draftKey(channelId, parentId)
        if drafts[key] != nil { writeDraft(key, Draft()) }
        let rows = bucket(channelId)
        if rows.byId.removeValue(forKey: parentId) != nil { persist { try $0.deleteMessage(id: parentId) } }
    }

    // MARK: custom emoji (M12f)

    /// Review v0.1.37 #7: a bootstrap's list (after emoji.updated may have been missed offline) drops the images that no
    /// longer match, as `applyCustomEmoji` does for one event: removed emoji, and text pills whose look changed.
    func replaceCustomEmoji(_ rows: [CustomEmojiOut]) {
        let fresh = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
        for old in customEmoji.values where Self.drawnDiffers(old, fresh[old.id]) { dropEmojiImage(old.id) }
        // Not uniqueKeysWithValues, which traps when a name comes twice (the server keeps names unique; the app
        // should not depend on it): the last wins.
        customEmoji = Dictionary(rows.map { ($0.name, $0) }, uniquingKeysWith: { _, last in last })
    }

    func applyCustomEmoji(_ row: CustomEmojiOut, deleted: Bool) {
        if let old = customEmoji[row.name], Self.drawnDiffers(old, deleted || row.id != old.id ? nil : row) {
            dropEmojiImage(old.id)
        }
        if deleted { customEmoji.removeValue(forKey: row.name) } else { customEmoji[row.name] = row }
    }

    /// Whether an emoji's cached image no longer shows `new` (nil: it is gone): a text emoji's pill is drawn from its label
    /// and colour, so a changed one is drawn again; a changed kind swaps pill and picture. An image emoji's picture is kept
    /// by id while the app runs (docs/EMOJI.md).
    private static func drawnDiffers(_ old: CustomEmojiOut, _ new: CustomEmojiOut?) -> Bool {
        guard let new else { return true }
        return old.isText != new.isText || (old.isText && (old.label != new.label || old.color != new.color))
    }

    private func dropEmojiImage(_ id: String) {
        emojiImages.removeValue(forKey: id)
        emojiAnimations.removeValue(forKey: id)
    }

    // MARK: emoji packs (M100)

    func replaceEmojiPacks(_ rows: [EmojiPackOut]) {
        emojiPacks = Dictionary(rows.map { ($0.id, $0) }, uniquingKeysWith: { _, last in last })
    }

    /// emoji_pack.updated: a deleted pack's emoji become ungrouped (their emoji.updated come too).
    func applyEmojiPack(_ row: EmojiPackOut, deleted: Bool) {
        if deleted {
            emojiPacks.removeValue(forKey: row.id)
            for (name, emoji) in customEmoji where emoji.packId == row.id {
                var ungrouped = emoji
                ungrouped.packId = nil
                customEmoji[name] = ungrouped
            }
        } else {
            emojiPacks[row.id] = row
        }
    }

    /// The packs in tab order (position, then name).
    var sortedEmojiPacks: [EmojiPackOut] {
        emojiPacks.values.sorted { ($0.position, $0.name) < ($1.position, $1.name) }
    }

    // MARK: post templates (M30)

    func replaceTemplates(_ rows: [TemplateOut]) {
        templates = rows
    }

    func applyTemplate(_ row: TemplateOut, deleted: Bool) {
        templates.removeAll { $0.id == row.id }
        if !deleted { templates.append(row) }
    }

    // MARK: sidebar sections (M14f)

    func replaceSidebar(_ rows: [SidebarSectionOut]) { sidebarSections = rows.sorted { $0.position < $1.position } }
    func replaceSidebarDefaults(_ rows: [SidebarDefaultOut]) { sidebarDefaults = rows }
    /// A default section's sort and hand-made order.
    func defaultSort(_ key: String) -> SidebarDefaultOut {
        sidebarDefaults.first { $0.key == key } ?? SidebarDefaultOut(key: key, sort: SidebarOrder.defaultSorts[key] ?? "name")
    }

    /// The id of my section the conversation sits in, if any.
    func sectionOf(_ channelId: String) -> String? { sidebarSections.first { $0.channelIds.contains(channelId) }?.id }

    // MARK: user groups (M12k)

    func replaceGroups(_ rows: [GroupOut]) {
        groups = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
    }

    func applyGroup(_ row: GroupOut, deleted: Bool) {
        if deleted { groups.removeValue(forKey: row.id) } else { groups[row.id] = row }
    }

    // MARK: lab roster (M23)

    func replaceRoster(_ rows: [LabProfileOut]) {
        let next = Dictionary(rows.map { ($0.userId, $0) }, uniquingKeysWith: { _, last in last })
        if next != roster { roster = next } // every reconnect bootstraps: an unchanged roster redraws nothing
    }

    /// roster.updated (or my own save): the person's line, or nil when they left the roster.
    func applyRoster(_ userId: String, _ profile: LabProfileOut?) {
        if roster[userId] != profile { roster[userId] = profile }
    }

    // MARK: reminders (M12e)

    /// Fired first (newest nudge on top), then pending by time.
    func listReminders() -> [ReminderOut] {
        reminders.values.sorted { a, b in
            if a.status != b.status { return a.status == "fired" }
            return a.status == "fired" ? a.remindAt > b.remindAt : a.remindAt < b.remindAt
        }
    }

    var firedReminderCount: Int { reminders.values.filter { $0.status == "fired" }.count }

    func replaceReminders(_ rows: [ReminderOut]) {
        reminders = Dictionary(uniqueKeysWithValues: rows.filter { $0.status == "pending" || $0.status == "fired" }.map { ($0.id, $0) })
    }

    func applyReminder(_ row: ReminderOut) {
        if row.status == "pending" || row.status == "fired" { reminders[row.id] = row } else { reminders.removeValue(forKey: row.id) }
    }

    // MARK: scheduled messages (M12d)

    func listScheduled() -> [ScheduledOut] { scheduled.values.sorted { $0.sendAt < $1.sendAt } }

    func replaceScheduled(_ rows: [ScheduledOut]) {
        scheduled = Dictionary(uniqueKeysWithValues: rows.filter { Self.keepsScheduled($0) }.map { ($0.id, $0) })
    }

    /// scheduled.updated: a pending row is kept (created / edited), and a failed one (its time came and the send was
    /// refused: 「下書き」 shows why, with 「今すぐ送信」 and 「取り消し」, as on the web and Android); sent or cancelled drops it.
    func applyScheduled(_ row: ScheduledOut) {
        if Self.keepsScheduled(row) { scheduled[row.id] = row } else { scheduled.removeValue(forKey: row.id) }
    }

    nonisolated static func keepsScheduled(_ row: ScheduledOut) -> Bool { row.status == "pending" || row.status == "failed" }

    // MARK: favorites (M12a)

    func isFavorite(_ channelId: String) -> Bool { favorites.contains(channelId) }

    func setFavorite(_ channelId: String, on: Bool) {
        if on { favorites.insert(channelId) } else { favorites.remove(channelId) }
    }

    func replaceFavorites(_ ids: [String]) { favorites = Set(ids) }

    // MARK: pinned DMs (M118)

    func isDmPinned(_ channelId: String) -> Bool { dmPins.contains(channelId) }

    /// dm_pin.updated and my own tap: a new pin goes last (one already there keeps its place), an unpin drops it.
    func setDmPin(_ channelId: String, on: Bool) {
        if on {
            if !dmPins.contains(channelId) { dmPins.append(channelId) }
        } else {
            dmPins.removeAll { $0 == channelId }
        }
    }

    /// bootstrap's `dm_pins`; nil from a server before M118, which then offers no pinning.
    func replaceDmPins(_ ids: [String]?) {
        dmPinsSupported = ids != nil
        if dmPins != ids ?? [] { dmPins = ids ?? [] }
    }

    /// A refused tap undone (its rollback): the conversation back where it was in the pins (`place`), or out of them;
    /// the other pins stay as events may have changed them meanwhile.
    func restoreDmPin(_ channelId: String, at place: Int?) {
        let next = DmCloseRules.restoredPins(dmPins, channelId: channelId, place: place)
        if dmPins != next { dmPins = next }
    }

    // MARK: closed DMs (M141)

    func isDmClosed(_ channelId: String) -> Bool { closedDms.contains(channelId) }

    /// dm_close.updated, a new timeline message, my own close and open.
    func setDmClosed(_ channelId: String, closed: Bool) {
        if closed { closedDms.insert(channelId) } else if closedDms.contains(channelId) { closedDms.remove(channelId) }
    }

    /// Review v0.1.43 #7: the server's read state, asked again after a refused close, taken as it is (downwards too).
    func setReadState(_ channelId: String, _ state: ReadStateOut) {
        updateChannel(channelId) { row in
            row.lastReadSeq = state.lastReadSeq
            row.unreadCount = state.unreadCount
            row.mentionCount = state.mentionCount
            row.firstUnreadAt = state.firstUnreadAt
        }
    }

    /// bootstrap's `closed_dms`; nil from a server before M141, which then offers no closing.
    func replaceClosedDms(_ ids: [String]?) {
        closedDmsSupported = ids != nil
        let set = Set(ids ?? [])
        if closedDms != set { closedDms = set }
    }

    // MARK: blocks (M104)

    func isBlocked(_ userId: String) -> Bool { blockedUsers.contains(userId) }

    func setBlocked(_ userId: String, on: Bool) {
        if on { blockedUsers.insert(userId) } else { blockedUsers.remove(userId) }
    }

    func replaceBlocked(_ ids: [String]) { blockedUsers = Set(ids) }

    // MARK: bookmarks (M11c)

    func isBookmarked(_ messageId: String) -> Bool { bookmarks.contains(messageId) }

    func setBookmarked(_ messageId: String, on: Bool) {
        if on { bookmarks.insert(messageId) } else { bookmarks.remove(messageId) }
    }

    func replaceBookmarks(_ ids: [String]) { bookmarks = Set(ids) }

    // MARK: presence / typing (volatile, SYNC_PROTOCOL.md §5.2)

    /// What the person's dot shows (PRESENCE.md §11.5): "dnd" while their `dnd_until` is ahead (whatever the
    /// connection), else "online" / "away" / "offline". Lists that sort by the connection use `connectionOf`.
    func presenceOf(_ userId: String) -> String {
        _ = dndClock  // redraw when the soonest pause ends
        return PresenceRules.look(connection: connectionOf(userId), dndUntil: dndUntilOf(userId))
    }

    /// The `presence` frames' status alone (online / away / offline).
    func connectionOf(_ userId: String) -> String { presence[userId] ?? "offline" }

    /// Me with the newest public fields: the directory's copy wins when it is newer (user.updated from another of my
    /// devices arrives before GET /users/me answers, PRESENCE.md §11.6).
    var currentMe: UserMe? { PresenceRules.currentMe(me, shared: me.flatMap { users[$0.id] }) }

    private func dndUntilOf(_ userId: String) -> String? {
        if let me, me.id == userId { return currentMe?.dndUntil }
        return users[userId]?.dndUntil
    }

    /// PRESENCE.md §11.3: 取り込み中 ends by the clock, with no event. One timer for the soonest end among everyone;
    /// it bumps `dndClock` (every dot reads it) and arms the next. A far one re-arms after a day; the indefinite pause
    /// never ends by itself.
    private(set) var dndClock = 0
    @ObservationIgnored private var dndTimer: Task<Void, Never>?
    @ObservationIgnored private var dndTimerAt = Date.distantFuture

    func noteDndEnd(_ until: String?) {
        let now = Date()
        guard let at = PresenceRules.soonestEnd([until], now: now), at < dndTimerAt else { return }
        dndTimer?.cancel()
        dndTimerAt = at
        let delay = min(at.timeIntervalSince(now) + 0.05, 24 * 3600)
        dndTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled, let self else { return }
            self.dndTimer = nil
            self.dndTimerAt = .distantFuture
            self.dndClock += 1
            self.noteDndEnds()
        }
    }

    /// Arms the timer for everyone held (after a cache load, and when it fired).
    func noteDndEnds() {
        for user in users.values { noteDndEnd(user.dndUntil) }
        noteDndEnd(me?.dndUntil)
    }

    /// Whose status emoji to show for this user: my own profile as I last saved it for me (M38: my DM with myself), else
    /// the directory's.
    func statusUser(_ userId: String) -> UserPublic? {
        if let me, me.id == userId { return me.asPublic }
        return users[userId]
    }

    func setPresence(_ userId: String, status: String) {
        if status == "offline" { presence[userId] = nil } else { presence[userId] = status }
    }

    /// bootstrap: the full picture; everyone not listed is offline.
    func replacePresence(_ entries: [PresenceEntry]) {
        presence = Dictionary(entries.filter { $0.status != "offline" }.map { ($0.userId, $0.status) }, uniquingKeysWith: { _, latest in latest })
    }

    private func typingKey(_ channelId: String, _ parentId: String?) -> String { parentId.map { "\(channelId):\($0)" } ?? channelId }

    func noteTyping(_ channelId: String, parentId: String?, userId: String, until: Date) {
        typing[typingKey(channelId, parentId), default: [:]][userId] = until
    }

    /// The user posted: their indicator goes away at once.
    func clearTyping(_ channelId: String, parentId: String?, userId: String) {
        typing[typingKey(channelId, parentId)]?[userId] = nil
    }

    /// M73: a `canvas_presence` frame from someone else (true for 45 s unless refreshed, false ends it).
    func noteCanvasEditing(_ canvasId: String, userId: String, editing: Bool, section: String?, now: Date = Date()) {
        canvasEditing.note(canvasId, userId: userId, editing: editing, section: section, now: now)
    }

    func canvasEditors(_ canvasId: String, now: Date = Date()) -> [CanvasEditingUser] { canvasEditing.of(canvasId, now: now) }

    /// Users typing in this conversation right now (expired entries are skipped, not removed).
    func typingUsers(_ channelId: String, parentId: String?, now: Date = Date()) -> [String] {
        (typing[typingKey(channelId, parentId)] ?? [:]).filter { $0.value > now }.keys.sorted()
    }

    /// The rows of the threads view: followed, newest reply first, unread only when that filter is on.
    func threadList(filter: String? = nil) -> [ThreadEntry] {
        let filter = filter ?? threadsFilter
        return threads.values
            .filter { $0.state.following && (filter == "all" || $0.state.unreadCount > 0) }
            .sorted { ($0.state.lastReplyAt ?? "", $0.parent.seq) > ($1.state.lastReplyAt ?? "", $1.parent.seq) }
    }

    /// A PUT response or a notification_preference.updated event: level, both mutes and whether it follows the default.
    func setNotification(_ channelId: String, _ pref: NotificationPreferenceOut) {
        updateChannel(channelId) { state in
            state.channel.notification = pref
        }
    }

    /// L4: bumped when a channel's members change their role, so an open member list loads again.
    var memberListVersion: [String: Int] = [:]

    /// L4: my role in a channel changed (owner-only actions appear or go).
    func setMembershipRole(_ channelId: String, role: String) {
        updateChannel(channelId) { state in
            if let membership = state.channel.membership {
                state.channel.membership = MembershipOut(role: role, joinedAt: membership.joinedAt)
            }
        }
    }

    func updateChannel(_ id: String, _ mutate: (inout ChannelState) -> Void) {
        guard let old = channels[id] else { return }
        var state = old
        mutate(&state)
        // Unchanged: no write. Every write redraws each view reading the channels — the lists under the conversation
        // and in the other tabs too — and a send made five (the list stalled as the row came in, 2026-09-30).
        guard state != old else { return }
        channels[id] = state
        persist { try $0.saveChannel(state) }
    }

    func removeChannel(_ id: String) {
        channels[id] = nil
        buckets[id]?.byId = [:]
        // §4.6: its canvases and their unsaved edits leave this device too.
        canvasLists[id] = nil
        canvasListFailures[id] = nil
        for (canvasId, state) in canvasPending where state.channelId == id { setPendingCanvas(canvasId, nil) }
        for (canvasId, entry) in canvasCache where entry.meta.channelId == id { dropCachedCanvas(canvasId) } // M74
        persist {
            try $0.clearMessages(channelId: id)
            try $0.deleteChannel(id: id)
        }
        onChannelRemoved?(id)
    }

    // MARK: messages

    /// The channel timeline: top-level messages of the loaded window (seq >= oldest_loaded_seq, SYNC_PROTOCOL.md §7.3)
    /// by seq, then pending ones in creation order (§9). Older rows that arrived on their own are left out, so the
    /// window never shows a gap.
    func messages(_ channelId: String) -> [MessageState] {
        let floor = timelineFloor(channelId)
        let rows = bucket(channelId)
        let all = rows.byId // read through the observed property, also when the cache answers
        if let cached = rows.timeline, cached.floor == floor { return cached.rows }
        let ordered = ordered(all.values.filter { $0.inTimeline && ($0.seq.map { $0 >= floor } ?? true) })
        rows.timeline = (floor, ordered)
        return ordered
    }

    /// No page read yet: nothing but pending rows. A timeline stored before the window was tracked shows everything
    /// until its next catch_up reads it again.
    private func timelineFloor(_ channelId: String) -> Int {
        guard let channel = channels[channelId] else { return 0 }
        if let oldest = channel.oldestLoadedSeq { return oldest }
        return channel.syncedSeq == nil ? Int.max : 0
    }

    /// A thread: the replies of one parent, oldest first (pending ones last).
    func replies(_ channelId: String, parentId: String) -> [MessageState] {
        ordered(bucket(channelId).byId.values.filter { $0.parentId == parentId })
    }

    private func ordered(_ all: some Collection<MessageState>) -> [MessageState] {
        let confirmed = all.filter { $0.seq != nil }.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
        let pending = all.filter { $0.seq == nil }.sorted { $0.createdAt < $1.createdAt }
        return confirmed + pending
    }

    func message(_ channelId: String, _ id: String) -> MessageState? { bucket(channelId).byId[id] }
    func message(_ channelId: String, id: String) -> MessageState? { bucket(channelId).byId[id] }

    /// A reply moved the parent's counters (message.created / message.deleted with parent_thread).
    func applyParentThread(_ channelId: String, _ thread: ParentThread) {
        onParentThread?(thread)
        let rows = bucket(channelId)
        guard var parent = rows.byId[thread.id], thread.updatedSeq > parent.updatedSeq else { return }
        parent.replyCount = thread.replyCount
        parent.lastReplyAt = thread.lastReplyAt
        if let ids = thread.replyUserIds { parent.replyUserIds = ids } // C3: an older server sends none; keep what it had
        parent.updatedSeq = thread.updatedSeq
        rows.byId[parent.id] = parent // in place: no copy of the channel's rows
        persist { try $0.saveMessage(parent) }
    }

    /// The merge rule (SYNC_PROTOCOL.md §8): newer updated_seq wins; tombstones delete.
    @discardableResult
    func upsertMessage(_ message: MessageOut) -> Bool { upsertMessage(MessageState(message)) }

    /// `replacingSameVersion`: a change of this device's own at the version it has (a deletion shown before the server
    /// answers, or the row put back when it refuses).
    @discardableResult
    func upsertMessage(_ message: MessageState, replacingSameVersion: Bool = false) -> Bool {
        let rows = bucket(message.channelId)
        // In place (M20): copying the channel's rows out and back on every message grew with the channel.
        if let clientMsgId = message.clientMsgId {
            let placeholder = localPrefix + clientMsgId
            if rows.byId[placeholder] != nil {
                rows.byId.removeValue(forKey: placeholder)
                persist { try $0.deleteMessage(id: placeholder) }
            }
        }
        if let onMessageTaken, let out = MessageOut(message) { onMessageTaken(out) } // the feed merges by its own rows
        var message = message
        if let local = rows.byId[message.id] {
            if message.updatedSeq < local.updatedSeq { return false }
            if message.updatedSeq == local.updatedSeq && !replacingSameVersion {
                // §8 (M27, M53): my own poll votes and answers come only in a response to me; one that comes after the
                // event of the same change still brings them.
                guard let response = message.poll, let poll = local.poll?.withMyPart(of: response) else { return false }
                var kept = local
                kept.poll = poll
                rows.byId[message.id] = kept
                persist { try $0.saveMessage(kept) }
                return true
            }
            // An event (mine, my_answers, my_comment = nil) keeps the votes and answers of mine I knew of.
            if let poll = message.poll { message.poll = poll.keepingMyPart(of: local.poll) }
        }
        if message.deleted {
            rows.byId.removeValue(forKey: message.id)
            persist { try $0.deleteMessage(id: message.id) }
            // A thread's root (THREADS.md): not for the deletion shown before the server answers (hideMessage), which
            // a refusal puts back.
            if message.parentId == nil && !replacingSameVersion && message.seq != nil { threadRootDeleted(message.channelId, message.id) }
        } else {
            rows.byId[message.id] = message
            persist { try $0.saveMessage(message) }
        }
        applyLastMessage(message) // M49: events, catch-up pages and my own sends, edits and deletes alike
        applyThreadPreview(message)
        return true
    }

    /// The answer to my own vote or close (SYNC_PROTOCOL.md §8, M27), or to my answers, decision or its undoing (M53):
    /// its `mine` / `my_answers` / `my_comment` go in whatever the order. Another member's event may have come first with
    /// a newer updated_seq, and the merge then drops the answer.
    func setMyVotes(_ answer: MessageOut) {
        onMyPart?(answer)
        guard let response = answer.poll else { return }
        let rows = bucket(answer.channelId)
        guard var stored = rows.byId[answer.id], let poll = stored.poll?.withMyPart(of: response) else { return }
        stored.poll = poll
        rows.byId[answer.id] = stored
        persist { try $0.saveMessage(stored) }
    }

    func putPlaceholder(_ message: MessageState) {
        bucket(message.channelId).byId[message.id] = message
        persist { try $0.saveMessage(message) }
    }

    func markPlaceholderFailed(channelId: String, clientMsgId: String, failed: Bool) {
        let id = localPrefix + clientMsgId
        let rows = bucket(channelId)
        guard var message = rows.byId[id] else { return }
        message.failed = failed
        rows.byId[id] = message
        persist { try $0.saveMessage(message) }
    }

    /// Drops a channel's stored rows before its newest page is read again; unsent (pending) rows stay with their outbox items.
    func clearMessages(_ channelId: String) {
        let rows = bucket(channelId)
        let pending = rows.byId.filter { $0.value.pending }
        rows.byId = pending
        persist {
            try $0.clearMessages(channelId: channelId)
            for message in pending.values { try $0.saveMessage(message) }
        }
    }

    /// §7.7: keeps the newest `cachedMessagesPerChannel` rows with a seq (replies and rows outside the window count;
    /// pending ones are neither counted nor dropped) and deletes the older ones here and on disk. Only the old side goes,
    /// so the delta (§7.3) never has a hole to fill; the window then starts after the newest dropped row and pages in again
    /// from there. True when rows were dropped. The engine decides when (never for an open conversation or thread).
    @discardableResult
    func trimMessages(_ channelId: String) -> Bool {
        guard let rows = buckets[channelId] else { return false }
        let seqs = rows.byId.values.compactMap(\.seq)
        guard seqs.count > cachedMessagesPerChannel else { return false }
        let newestDropped = seqs.sorted(by: >)[cachedMessagesPerChannel]
        // In place, row by row (M20): the channel's rows are not copied out and back.
        let dropped = rows.byId.compactMap { ($0.value.seq ?? .max) <= newestDropped ? $0.key : nil }
        for id in dropped { rows.byId.removeValue(forKey: id) }
        persist { try $0.deleteOlderMessages(channelId: channelId, beforeSeq: newestDropped + 1) }
        if let oldest = channels[channelId]?.oldestLoadedSeq, oldest <= newestDropped {
            updateChannel(channelId) { $0.oldestLoadedSeq = newestDropped + 1; $0.hasOlder = true }
        }
        return true
    }

    /// Rows held for the channel (pending ones included): the engine trims once it passes the cap by a margin.
    func heldCount(_ channelId: String) -> Int { buckets[channelId]?.byId.count ?? 0 }

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
        for (id, state) in canvasPending {
            if let data = try? JSON.plainEncoder.encode(state) { snapshot.meta[Self.canvasPrefix + id] = String(data: data, encoding: .utf8) }
        }
        for (url, preview) in linkPreviews {
            let stored = StoredLinkPreview(preview: preview, savedAt: (previewSavedAt[url] ?? Date()).timeIntervalSince1970)
            if let data = try? JSON.plainEncoder.encode(stored) { snapshot.meta[Self.previewPrefix + url] = String(data: data, encoding: .utf8) }
        }
        for (key, value) in wikiKept { snapshot.meta[key] = value } // M122
        if let me, let data = try? JSON.plainEncoder.encode(me), let text = String(data: data, encoding: .utf8) { snapshot.meta["me"] = text }
        if let activity, let data = try? JSON.plainEncoder.encode(activity) { snapshot.meta[Self.activityKey] = String(data: data, encoding: .utf8) }
        if !unsentReads.isEmpty, let data = try? JSON.plainEncoder.encode(unsentReads) { snapshot.meta[Self.unsentReadsKey] = String(data: data, encoding: .utf8) }
        snapshot.users = Array(users.values)
        snapshot.channels = Array(channels.values)
        snapshot.messages = buckets.values.flatMap { $0.byId.values }
        snapshot.outbox = outbox
        return snapshot
    }

    static func fromSnapshot(_ snapshot: Snapshot, persistence: Persistence? = nil) -> Store {
        let store = Store(persistence: persistence)
        store.apply(snapshot)
        return store
    }
}


/// One channel's stored messages (M20): observed apart from the other channels, with the ordered timeline kept until
/// the rows change (a view asks for it many times per redraw; sorting every time grew with the channel).
@Observable
final class ChannelMessages {
    var byId: [String: MessageState] = [:] {
        didSet { timeline = nil }
    }
    /// The ordered timeline for a floor (the oldest loaded seq), dropped whenever a row changes.
    @ObservationIgnored var timeline: (floor: Int, rows: [MessageState])?
}

/// M141 「会話を閉じる」 (SYNC_PROTOCOL.md §7.9): the rules the three clients share (apps/shared/dm-close-rules.json).
enum DmCloseRules {
    /// The read marks a close sets and compares against (Review v0.1.43 #7, `read_fallback`).
    struct ReadMark: Equatable {
        var lastSeq: Int
        var lastReadSeq: Int
        var unreadCount: Int
        var mentionCount: Int
    }

    /// Review v0.1.43 #6 (`close_event`): whether a dm_close.updated is taken. An open always is; a close is not when this
    /// device already holds a timeline message newer than where it was closed (`lastMessageSeq`, the §7.8 last_message):
    /// that message reopened the conversation on the server too, it only reached this device first. No `closedSeq` (an
    /// older server): taken.
    static func takesEvent(closed: Bool, closedSeq: Int?, lastMessageSeq: Int?) -> Bool {
        guard closed, let closedSeq, let lastMessageSeq else { return true }
        return lastMessageSeq <= closedSeq
    }

    /// Review v0.1.43 #7 (`restore_pin`): a refused close puts back only its own pin, at `place` (its index before,
    /// clamped to the list as it is now), or leaves it out when it was not pinned; the other pins stay as events left them.
    static func restoredPins(_ pins: [String], channelId: String, place: Int?) -> [String] {
        var next = pins.filter { $0 != channelId }
        if let place { next.insert(channelId, at: min(place, next.count)) }
        return next
    }

    /// Review v0.1.43 #7 (`read_fallback`): when the read state could not be asked again either, the snapshot goes back
    /// only if nothing changed it since the close set it; otherwise what came meanwhile is kept for the next bootstrap.
    static func readFallbackTakesSnapshot(optimistic: ReadMark, now: ReadMark) -> Bool { optimistic == now }
}
