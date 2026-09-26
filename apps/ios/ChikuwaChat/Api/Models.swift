import Foundation

// Models mirror the shared OpenAPI document (openapi/openapi.json); keys are snake_case on the wire.

struct UserPublic: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let username: String
    let displayName: String
    let role: String
    let deactivatedAt: String?
    let createdAt: String
    let updatedAt: String
    /// Profile card (M11d); the server reports an expired status as nil.
    var title: String? = nil
    var statusText: String? = nil
    var statusEmoji: String? = nil
    var statusExpiresAt: String? = nil
    /// Do not disturb (M12c): a manual pause and the daily quiet hours (public, for 🔕 next to the name).
    var dndUntil: String? = nil
    var quietHours: QuietHours? = nil
}

/// A daily window (in the user's zone) during which pushes are held back (M12c).
struct QuietHours: Codable, Equatable, Hashable {
    var start: String
    var end: String
    var days: [Int]
    var tz: String
}

struct UserMe: Codable, Equatable {
    let id: String
    let username: String
    let displayName: String
    let role: String
    let deactivatedAt: String?
    let createdAt: String
    let updatedAt: String
    let email: String?
    let mustChangePassword: Bool
    var title: String? = nil
    var statusText: String? = nil
    var statusEmoji: String? = nil
    var statusExpiresAt: String? = nil
    var dndUntil: String? = nil
    var quietHours: QuietHours? = nil

    var asPublic: UserPublic {
        UserPublic(id: id, username: username, displayName: displayName, role: role, deactivatedAt: deactivatedAt, createdAt: createdAt, updatedAt: updatedAt,
                   title: title, statusText: statusText, statusEmoji: statusEmoji, statusExpiresAt: statusExpiresAt,
                   dndUntil: dndUntil, quietHours: quietHours)
    }
}

/// A custom status (M11d) that has not expired: (emoji, text); nil otherwise.
func activeStatus(_ user: UserPublic?, now: Date = Date()) -> (emoji: String, text: String)? {
    guard let user else { return nil }
    let emoji = user.statusEmoji ?? ""
    let text = user.statusText ?? ""
    if emoji.isEmpty && text.isEmpty { return nil }
    if let expires = user.statusExpiresAt, let date = parseIsoDate(expires), date <= now { return nil }
    return (emoji, text)
}

struct DeviceOut: Codable, Equatable {
    let id: String
    let platform: String
    let deviceName: String?
    let appVersion: String?
    let enabled: Bool
    let disabledReason: String?
    let lastSeenAt: String?
    let createdAt: String
    let updatedAt: String
}

struct TokenResponse: Codable, Equatable {
    let accessToken: String
    let refreshToken: String
    let tokenType: String
    let expiresIn: Int
    let sessionId: String
    let device: DeviceOut
    let user: UserMe
}

struct MembershipOut: Codable, Equatable {
    let role: String
    let joinedAt: String
}

struct ChannelOut: Codable, Identifiable, Equatable {
    let id: String
    let type: String
    let name: String?
    let topic: String?
    let purpose: String?
    let archived: Bool
    let createdBy: String?
    let lastSeq: Int
    let lastMessageAt: String?
    let createdAt: String
    let updatedAt: String
    var membership: MembershipOut?
    let dmUserIds: [String]?
    /// Filled by bootstrap for the requesting user (M8b); nil elsewhere.
    var readState: ReadStateOut? = nil
    /// Per-user notification preference; filled by bootstrap, kept locally across channel.updated events.
    var notification: NotificationPreferenceOut? = nil
    /// How many members the channel has (M11h); lists, single-channel responses and channel events carry it.
    var memberCount: Int? = nil

    var isDm: Bool { type == "dm" || type == "group_dm" }
}

struct NotificationPreferenceOut: Codable, Equatable {
    let channelId: String
    let level: String
    let mutedUntil: String?
}

struct ReadStateOut: Codable, Equatable {
    let lastReadSeq: Int
    let unreadCount: Int
    let mentionCount: Int
}

struct ReactionOut: Codable, Equatable {
    let emoji: String
    let count: Int
    let userIds: [String]
}

struct AttachmentOut: Codable, Equatable, Identifiable {
    let id: String
    let filename: String
    let contentType: String
    let sizeBytes: Int64
    let width: Int?
    let height: Int?
    let hasThumbnail: Bool
    let status: String
    let createdAt: String

    var isImage: Bool { hasThumbnail }
}

struct MessageOut: Codable, Identifiable, Equatable {
    let id: String
    let channelId: String
    let senderId: String
    let seq: Int
    let updatedSeq: Int
    let clientMsgId: String?
    let body: String
    let createdAt: String
    let editedAt: String?
    let deleted: Bool
    var type: String = "user"
    var mentionedUserIds: [String] = []
    var mentionAll: Bool = false
    var reactions: [ReactionOut] = []
    var parentId: String? = nil
    var replyCount: Int = 0
    var lastReplyAt: String? = nil
    var attachments: [AttachmentOut] = []
    /// Pinned in the channel (M11c); both nil when not pinned.
    var pinnedAt: String? = nil
    var pinnedBy: String? = nil

    enum CodingKeys: String, CodingKey {
        case id, channelId, senderId, seq, updatedSeq, clientMsgId, body, createdAt, editedAt, deleted
        case type, mentionedUserIds, mentionAll, reactions, parentId, replyCount, lastReplyAt, attachments, pinnedAt, pinnedBy
    }

    func mentions(_ userId: String) -> Bool { mentionAll || mentionedUserIds.contains(userId) }
    var isReply: Bool { parentId != nil }
}

/// The parent's thread fields after a reply changed them (SYNC_PROTOCOL.md §6).
struct ParentThread: Codable, Equatable {
    let id: String
    let replyCount: Int
    let lastReplyAt: String?
    let updatedSeq: Int
    var participantIds: [String] = []

    enum CodingKeys: String, CodingKey { case id, replyCount, lastReplyAt, updatedSeq, participantIds }

    init(id: String, replyCount: Int, lastReplyAt: String?, updatedSeq: Int, participantIds: [String] = []) {
        self.id = id
        self.replyCount = replyCount
        self.lastReplyAt = lastReplyAt
        self.updatedSeq = updatedSeq
        self.participantIds = participantIds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        replyCount = try c.decode(Int.self, forKey: .replyCount)
        lastReplyAt = try c.decodeIfPresent(String.self, forKey: .lastReplyAt)
        updatedSeq = try c.decode(Int.self, forKey: .updatedSeq)
        participantIds = try c.decodeIfPresent([String].self, forKey: .participantIds) ?? []
    }
}

extension MessageOut {
    /// The M8a fields are optional on the wire for older servers and in persisted rows.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        channelId = try c.decode(String.self, forKey: .channelId)
        senderId = try c.decode(String.self, forKey: .senderId)
        seq = try c.decode(Int.self, forKey: .seq)
        updatedSeq = try c.decode(Int.self, forKey: .updatedSeq)
        clientMsgId = try c.decodeIfPresent(String.self, forKey: .clientMsgId)
        body = try c.decode(String.self, forKey: .body)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        editedAt = try c.decodeIfPresent(String.self, forKey: .editedAt)
        deleted = try c.decode(Bool.self, forKey: .deleted)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "user"
        mentionedUserIds = try c.decodeIfPresent([String].self, forKey: .mentionedUserIds) ?? []
        mentionAll = try c.decodeIfPresent(Bool.self, forKey: .mentionAll) ?? false
        reactions = try c.decodeIfPresent([ReactionOut].self, forKey: .reactions) ?? []
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        replyCount = try c.decodeIfPresent(Int.self, forKey: .replyCount) ?? 0
        lastReplyAt = try c.decodeIfPresent(String.self, forKey: .lastReplyAt)
        attachments = try c.decodeIfPresent([AttachmentOut].self, forKey: .attachments) ?? []
        pinnedAt = try c.decodeIfPresent(String.self, forKey: .pinnedAt)
        pinnedBy = try c.decodeIfPresent(String.self, forKey: .pinnedBy)
    }
}

struct HistoryOut: Codable {
    let channelLastSeq: Int
    let messages: [MessageOut]
    let hasMore: Bool
}

struct DeltaOut: Codable {
    let messages: [MessageOut]
    let nextSinceSeq: Int
    let hasMore: Bool
}

struct Limits: Codable {
    let maxMessageLength: Int
    let maxAttachmentBytes: Int
    let maxAttachmentsPerMessage: Int
}

struct BootstrapOut: Codable {
    let serverTime: String
    let me: UserMe
    let users: [UserPublic]
    let channels: [ChannelOut]
    let limits: Limits
    /// Followed threads with unread replies / mentions (THREADS.md §3); the 「スレッド」 badge.
    var threads: ThreadSummary? = nil
    /// Who is connected right now (SYNC_PROTOCOL.md §5.2 presence); users not listed are offline.
    var presence: [PresenceEntry]? = nil
    /// My saved messages (M11c): ids only, newest first; the list itself is GET /bookmarks.
    var bookmarks: [String]? = nil
    /// My starred channels (M12a) among `channels`.
    var favorites: [String]? = nil
}

/// PUT / DELETE /channels/{id}/favorite (M12a).
struct FavoriteStateOut: Codable, Equatable {
    let channelId: String
    let favorite: Bool
}

/// One row of POST /channels/read-all (M12a).
struct ChannelReadStateOut: Codable, Equatable {
    let channelId: String
    let lastReadSeq: Int
    let unreadCount: Int
    let mentionCount: Int
}

struct BookmarkStateOut: Codable, Equatable {
    let messageId: String
    let bookmarked: Bool
}

struct BookmarkItem: Codable, Equatable {
    let message: MessageOut
    let createdAt: String
}

struct BookmarkListOut: Codable {
    let items: [BookmarkItem]
    let nextCursor: String?
}

/// GET /files (M11i): one attached file and where it was posted.
struct FileItem: Codable, Identifiable {
    let attachment: AttachmentOut
    let messageId: String
    let channelId: String
    let parentId: String?
    let uploaderId: String
    let attachedAt: String

    var id: String { attachment.id }
}

struct FileListOut: Codable {
    let items: [FileItem]
    let nextCursor: String?
}

/// GET /mentions (M11h): messages that mention me or everyone, newest first.
struct MentionListOut: Codable {
    let items: [MessageOut]
    let nextCursor: String?
}

struct PresenceEntry: Codable, Equatable {
    let userId: String
    let status: String
}

/// My relation to one thread (THREADS.md §3).
struct ThreadState: Codable, Equatable {
    let parentId: String
    let channelId: String
    var following: Bool
    var lastReadSeq: Int
    var unreadCount: Int
    var mentionCount: Int
    var replyCount: Int
    var lastReplyAt: String?
    /// Current followers: who gets thread.updated and the reply's push.
    var participantIds: [String]
}

struct ThreadItem: Codable, Equatable {
    let parent: MessageOut
    let state: ThreadState
}

struct ThreadSummary: Codable, Equatable {
    var unreadCount: Int
    var mentionCount: Int
}

struct ThreadListOut: Codable {
    let items: [ThreadItem]
    /// Pass back as `cursor` for the next page; nil when the page was empty.
    let nextCursor: String?
    let summary: ThreadSummary
}

struct MemberOut: Codable, Equatable {
    let userId: String
    let role: String
    let joinedAt: String
}

struct DeviceInfo: Encodable {
    let platform: String
    let deviceName: String?
    let appVersion: String?
}

struct ErrorEnvelope: Decodable {
    struct Inner: Decodable {
        let code: String
        let message: String
    }
    let error: Inner
}

struct SearchHit: Codable, Identifiable {
    let message: MessageOut
    let score: Double

    var id: String { message.id }
}

/// What the server understood from the query's modifiers (from: in: before: after: on:).
struct SearchFilters: Codable, Equatable {
    let text: String
    let fromUsername: String?
    let inChannel: String?
    let after: String?
    let before: String?
    var unresolved: [String] = []
}

struct SearchOut: Codable {
    let hits: [SearchHit]
    let keywords: [String]
    var filters: SearchFilters? = nil
    let limit: Int
    let offset: Int
    let hasMore: Bool
}

/// Open Graph data for a link (M11g); `status == "failed"` means the page gave nothing usable.
struct LinkPreviewOut: Codable, Equatable {
    let url: String
    let status: String
    let title: String?
    let description: String?
    let imageUrl: String?
    let siteName: String?
    let fetchedAt: String
}
