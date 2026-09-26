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

    var isDm: Bool { type == "dm" || type == "group_dm" }
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
