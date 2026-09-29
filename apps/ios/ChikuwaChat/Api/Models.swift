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
    /// M14a: when the profile picture changed (nil = no picture); the cache key.
    var avatarUpdatedAt: String? = nil
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
    /// M12g: words that make a message count as a mention of me.
    var notifyKeywords: [String]? = nil
    var avatarUpdatedAt: String? = nil
    /// L4 (M31): others always see me as offline.
    var presenceHidden: Bool? = nil

    var asPublic: UserPublic {
        UserPublic(id: id, username: username, displayName: displayName, role: role, deactivatedAt: deactivatedAt, createdAt: createdAt, updatedAt: updatedAt,
                   title: title, statusText: statusText, statusEmoji: statusEmoji, statusExpiresAt: statusExpiresAt,
                   dndUntil: dndUntil, quietHours: quietHours, avatarUpdatedAt: avatarUpdatedAt)
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
    /// Changes when a channel is converted between public and private (M15b).
    var type: String
    let name: String?
    let topic: String?
    let purpose: String?
    var archived: Bool
    let createdBy: String?
    let lastSeq: Int
    /// Moved locally by top-level message.created events (SYNC_PROTOCOL.md §7.4) so the DM list reorders at once.
    var lastMessageAt: String?
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
    /// M15a: "owners" = an announcement channel (only owners and admins start top-level posts).
    var postingPolicy: String? = nil
    /// M24: whose times (work log) this is; nil for other channels, and from servers before M24 that omit it.
    var timesOwnerId: String? = nil

    var isDm: Bool { type == "dm" || type == "group_dm" }
    var isAnnouncement: Bool { postingPolicy == "owners" }
    var isTimes: Bool { timesOwnerId != nil }
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
    /// M17: created_at of the oldest message counted in unread_count (nil when nothing is unread, or an older server).
    var firstUnreadAt: String? = nil
}

/// A poll on a message (M14b): who voted for each option; counts and "mine" are derived here.
struct PollOut: Codable, Equatable {
    let question: String
    let options: [String]
    var multiple: Bool = false
    var closedAt: String? = nil
    /// Who voted for each option (empty lists in an anonymous poll).
    var votes: [[String]] = []
    /// M27: nobody sees who voted. The next three are absent from a server before M27.
    var anonymous: Bool? = nil
    /// How many voted for each option.
    var counts: [Int]? = nil
    /// The options I voted for, in a response to me; nil in events, which keep what was known (SYNC_PROTOCOL.md §8).
    var mine: [Int]? = nil

    var isAnonymous: Bool { anonymous ?? false }

    /// Who voted for option `index` (none in an anonymous poll).
    func voters(_ index: Int) -> [String] { index < votes.count ? votes[index] : [] }

    func count(_ index: Int) -> Int {
        if let counts, index < counts.count { return counts[index] }
        return voters(index).count
    }

    var total: Int { options.indices.reduce(0) { $0 + count($1) } }

    /// Whether I voted for option `index`. A named poll's voters come with every change, events too (a kept `mine` can be
    /// a vote taken back on another device); an anonymous poll has only what the server told me.
    func votedByMe(_ index: Int, me: String?) -> Bool {
        if !isAnonymous { return me.map(voters(index).contains) ?? false }
        return mine?.contains(index) ?? false
    }
}

/// A body an edit replaced (M14c); the current body is the message's own.
struct MessageRevisionOut: Codable, Equatable {
    let body: String
    let writtenAt: String
    let replacedAt: String
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
    var isVideo: Bool { contentType.hasPrefix("video/") }
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
    /// M15c: a reply shown in the channel timeline as well as in its thread.
    var alsoInChannel: Bool = false
    var replyCount: Int = 0
    var lastReplyAt: String? = nil
    var attachments: [AttachmentOut] = []
    /// Pinned in the channel (M11c); both nil when not pinned.
    var pinnedAt: String? = nil
    var pinnedBy: String? = nil
    /// M14b: the poll, when the message carries one.
    var poll: PollOut? = nil
    /// M15e: "important" / "urgent", and who acknowledged a message that asked for it (oldest first).
    var priority: String? = nil
    var ackRequested: Bool = false
    var acks: [AckOut] = []

    enum CodingKeys: String, CodingKey {
        case id, channelId, senderId, seq, updatedSeq, clientMsgId, body, createdAt, editedAt, deleted
        case type, mentionedUserIds, mentionAll, reactions, parentId, alsoInChannel, replyCount, lastReplyAt, attachments, pinnedAt, pinnedBy, poll
        case priority, ackRequested, acks
    }

    func mentions(_ userId: String) -> Bool { mentionAll || mentionedUserIds.contains(userId) }
    /// Addressed to me (SYNC_PROTOCOL.md §7.4): @channel, my name or group, or one of my notification keywords (M12g).
    /// The server keeps keyword hits to itself (they would show my keywords to everyone), so they are found here.
    func mentionsMe(_ me: UserMe) -> Bool { mentions(me.id) || NotifyKeywords.matches(body, me.notifyKeywords) }
    var isReply: Bool { parentId != nil }
}

/// M12g: the server's keyword rule, case-insensitive and anywhere in the body (the sender's own posts are left out
/// by the callers).
enum NotifyKeywords {
    static func matches(_ body: String, _ keywords: [String]?) -> Bool {
        guard let keywords, !keywords.isEmpty else { return false }
        let text = body.lowercased()
        return keywords.contains { !$0.isEmpty && text.contains($0.lowercased()) }
    }

    /// A text run cut where the keywords occur (case-insensitively, the longest first), each piece with whether it is
    /// one: the body highlights them, as on the web (M28d).
    static func pieces(_ text: String, _ keywords: [String]?) -> [(text: String, hit: Bool)] {
        let words = (keywords ?? []).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            .sorted { $0.count > $1.count }
        guard !words.isEmpty, !text.isEmpty else { return [(text, false)] }
        var pieces: [(String, Bool)] = []
        var rest = text[...]
        while !rest.isEmpty {
            var first: (Range<Substring.Index>, String)?
            for word in words {
                if let range = rest.range(of: word, options: [.caseInsensitive]), first.map({ range.lowerBound < $0.0.lowerBound }) ?? true {
                    first = (range, word)
                }
            }
            guard let (range, _) = first else {
                pieces.append((String(rest), false))
                break
            }
            if range.lowerBound > rest.startIndex { pieces.append((String(rest[..<range.lowerBound]), false)) }
            pieces.append((String(rest[range]), true))
            rest = rest[range.upperBound...]
        }
        return pieces
    }
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
        alsoInChannel = try c.decodeIfPresent(Bool.self, forKey: .alsoInChannel) ?? false
        replyCount = try c.decodeIfPresent(Int.self, forKey: .replyCount) ?? 0
        lastReplyAt = try c.decodeIfPresent(String.self, forKey: .lastReplyAt)
        attachments = try c.decodeIfPresent([AttachmentOut].self, forKey: .attachments) ?? []
        pinnedAt = try c.decodeIfPresent(String.self, forKey: .pinnedAt)
        pinnedBy = try c.decodeIfPresent(String.self, forKey: .pinnedBy)
        poll = try c.decodeIfPresent(PollOut.self, forKey: .poll)
        priority = try c.decodeIfPresent(String.self, forKey: .priority)
        ackRequested = try c.decodeIfPresent(Bool.self, forKey: .ackRequested) ?? false
        acks = try c.decodeIfPresent([AckOut].self, forKey: .acks) ?? []
    }
}

/// M15e: one member's 「確認しました」.
struct AckOut: Codable, Equatable {
    let userId: String
    let ackedAt: String
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
    /// Custom emoji (M12f): the whole table; changes arrive as emoji.updated.
    var customEmoji: [CustomEmojiOut]? = nil
    /// Post templates (M30): the workspace's, then mine; changes arrive as template.updated.
    var templates: [TemplateOut]? = nil
    /// User groups (M12k): every group with its members; changes arrive as group.updated.
    var groups: [GroupOut]? = nil
    /// The lab roster (M23) in roster order; changes arrive as roster.updated. Missing from older servers.
    var roster: [LabProfileOut]? = nil
    /// My sidebar sections (M14f); changes arrive as sidebar.updated.
    var sidebarSections: [SidebarSectionOut]? = nil
    /// My drafts shared by my devices (M15d); changes arrive as draft.updated.
    var drafts: [DraftOut]? = nil
}

/// A link pinned to the top of a conversation (M15f).
struct ChannelLinkOut: Codable, Equatable, Identifiable {
    let id: String
    let title: String
    let url: String
    let position: Int
    let createdBy: String
    let createdAt: String
}

/// A draft saved on the server (M15d): text only, one per composer.
struct DraftOut: Codable, Equatable {
    let channelId: String
    var parentId: String? = nil
    let body: String
    let updatedAt: String
}

/// draft.updated (M15d): saved or deleted (then `body` is empty) on one of my devices.
struct DraftUpdated: Codable, Equatable {
    let channelId: String
    var parentId: String? = nil
    let body: String
    let updatedAt: String
    let deleted: Bool
}

/// One of my sidebar sections (M14f); `channelIds` are the conversations placed in it. M26: `emoji` is its icon (an
/// emoji or a custom `:name:`), `collapsed` folds it up on all my devices.
struct SidebarSectionOut: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let position: Int
    var channelIds: [String] = []
    var emoji: String? = nil
    var collapsed = false
}

extension SidebarSectionOut {
    /// The M26 fields are missing from a server before M26 and from rows saved by an older app.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        position = try c.decode(Int.self, forKey: .position)
        channelIds = try c.decodeIfPresent([String].self, forKey: .channelIds) ?? []
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji)
        collapsed = try c.decodeIfPresent(Bool.self, forKey: .collapsed) ?? false
    }
}

/// A named set of members that `@name` notifies (M12k).
struct GroupOut: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    var description: String? = nil
    var memberIds: [String] = []
    let createdBy: String
    let createdAt: String
    let updatedAt: String
    /// M23: kept from the lab roster by the server (faculty, students, m1 …); administrators cannot edit it by hand.
    var managed: Bool = false

    enum CodingKeys: String, CodingKey { case id, name, description, memberIds, createdBy, createdAt, updatedAt, managed }
}

extension GroupOut {
    /// `managed` (M23) is missing from older servers; a synthesized decoder would reject the whole bootstrap for it.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        description = try c.decodeIfPresent(String.self, forKey: .description)
        memberIds = try c.decodeIfPresent([String].self, forKey: .memberIds) ?? []
        createdBy = try c.decode(String.self, forKey: .createdBy)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        updatedAt = try c.decode(String.self, forKey: .updatedAt)
        managed = try c.decodeIfPresent(Bool.self, forKey: .managed) ?? false
    }
}

/// One line of the lab roster (M23, DATA_MODEL.md lab_profiles): for display and grouping only, never for permissions.
/// `affiliation` (faculty | student | alumni | other), `rank` (faculty only) and `grade` (students only) stay strings so
/// a value a newer server adds still decodes; Roster sorts it after the known ones.
struct LabProfileOut: Codable, Equatable {
    let userId: String
    let affiliation: String
    var rank: String? = nil
    var grade: String? = nil
    /// The supervising teacher (someone on the roster as faculty).
    var supervisorId: String? = nil
    /// 研究テーマ and よみ: the person edits these on their own line (PATCH /lab/roster/me).
    var researchTopic: String? = nil
    var reading: String? = nil
    let updatedAt: String
}

/// A workspace emoji (M12f) used as `:name:` in text and reactions.
struct CustomEmojiOut: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let name: String
    let contentType: String
    let width: Int
    let height: Int
    let createdBy: String
    let createdAt: String
}

/// A post template (M30, DATA_MODEL.md message_templates): the workspace's (scope "workspace") or my own ("user").
struct TemplateOut: Codable, Identifiable, Equatable, Hashable {
    let id: String
    let scope: String
    var ownerId: String? = nil
    let name: String
    let body: String
    let suggestIn: String
    let position: Int
    let createdAt: String
    let updatedAt: String
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
    var firstUnreadAt: String? = nil
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

/// A personal reminder about a message (M12e); `status` is pending | fired | done | cancelled.
struct ReminderOut: Codable, Identifiable, Equatable {
    let id: String
    let messageId: String
    let channelId: String
    let note: String?
    let preview: String
    let remindAt: String
    let status: String
    let firedAt: String?
    let createdAt: String
    /// L4 (M31): "ack" when a message's author asked me to acknowledge it; "personal" (or missing) otherwise.
    var kind: String? = nil
}

/// A message the server posts later (M12d); `status` is pending | sent | failed | cancelled.
struct ScheduledOut: Codable, Identifiable, Equatable {
    let id: String
    let channelId: String
    let parentId: String?
    let clientMsgId: String
    let body: String
    let attachments: [AttachmentOut]
    let sendAt: String
    let status: String
    let error: String?
    let sentMessageId: String?
    let createdAt: String
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

/// What an invite link offers before any account exists (M12h).
struct InvitePreviewOut: Codable, Equatable {
    let invitedBy: String
    let role: String
    let channels: [String]
    let expiresAt: String
    var passwordMinLength: Int = 8
}

/// Two-factor authentication (M12i).
struct TotpStatusOut: Codable, Equatable {
    let enabled: Bool
    var enabledAt: String? = nil
    var recoveryCodesLeft: Int = 0
}

struct TotpSetupOut: Codable, Equatable {
    let secret: String
    let otpauthUri: String
    let qrPngBase64: String
}

struct TotpEnabledOut: Codable, Equatable {
    let recoveryCodes: [String]
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
    /// Typed modifiers that named nothing the caller can see; the server then returns no hits.
    var unresolved: [String]? = nil
    /// M15h: the has: flags (file, link, pin, reaction, poll) and is:thread the server understood.
    var has: [String]? = nil
    var isThread: Bool? = nil
}

struct SearchOut: Codable {
    let hits: [SearchHit]
    let keywords: [String]
    var filters: SearchFilters? = nil
    let limit: Int
    let offset: Int
    let hasMore: Bool
    /// M16b: how many messages match; the server stops counting at 1,000 (`totalCapped`).
    var total: Int? = nil
    var totalCapped: Bool? = nil
}

/// GET /server (M16c): what the address serves; `product` is "chikuwachat" for a ChikuwaChat server.
struct ServerInfoOut: Codable, Equatable {
    var product: String? = nil
    let workspaceId: String
    let name: String
    var apiVersion: String? = nil
}

/// GET /sync/summary (M16c): the badge and unread flag of a workspace that is not open.
struct UnreadSummaryOut: Codable, Equatable {
    let badge: Int
    let hasUnread: Bool
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
