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
    let membership: MembershipOut?
    let dmUserIds: [String]?
    /// Filled by bootstrap for the requesting user (M8b); nil elsewhere.
    var readState: ReadStateOut? = nil

    var isDm: Bool { type == "dm" || type == "group_dm" }
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

    enum CodingKeys: String, CodingKey {
        case id, channelId, senderId, seq, updatedSeq, clientMsgId, body, createdAt, editedAt, deleted
        case type, mentionedUserIds, mentionAll, reactions, parentId, replyCount, lastReplyAt, attachments
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

struct SearchOut: Codable {
    let hits: [SearchHit]
    let keywords: [String]
    let limit: Int
    let offset: Int
    let hasMore: Bool
}
