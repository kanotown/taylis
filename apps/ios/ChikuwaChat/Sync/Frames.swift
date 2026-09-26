import Foundation

/// WebSocket frames (SYNC_PROTOCOL.md §5.2). Decoded with the plain decoder so payload keys survive.
struct EventFrame: Decodable, Equatable {
    let id: Int
    let event: String
    let ts: String
    let channelId: String?
    let seq: Int?
    let data: JSONValue

    enum CodingKeys: String, CodingKey {
        case id, event, ts, seq, data
        case channelId = "channel_id"
    }
}

enum ServerFrame: Equatable {
    case hello(sessionId: String, heartbeatIntervalSec: Int)
    case pong
    case error(code: String, message: String)
    case event(EventFrame)
    /// Volatile (M11b): shown for a few seconds, never stored.
    case typing(channelId: String, parentId: String?, userId: String)
    case presence(userId: String, status: String)

    private struct Head: Decodable {
        let type: String
        let session_id: String?
        let heartbeat_interval_sec: Int?
        let code: String?
        let message: String?
        let channel_id: String?
        let parent_id: String?
        let user_id: String?
        let status: String?
    }

    static func parse(_ text: String) -> ServerFrame? {
        let data = Data(text.utf8)
        guard let head = try? JSON.plainDecoder.decode(Head.self, from: data) else { return nil }
        switch head.type {
        case "hello": return .hello(sessionId: head.session_id ?? "", heartbeatIntervalSec: head.heartbeat_interval_sec ?? 30)
        case "pong": return .pong
        case "error": return .error(code: head.code ?? "error", message: head.message ?? "")
        case "event": return (try? JSON.plainDecoder.decode(EventFrame.self, from: data)).map(ServerFrame.event)
        case "typing":
            guard let channelId = head.channel_id, let userId = head.user_id else { return nil }
            return .typing(channelId: channelId, parentId: head.parent_id, userId: userId)
        case "presence":
            guard let userId = head.user_id, let status = head.status else { return nil }
            return .presence(userId: userId, status: status)
        default: return nil
        }
    }
}

enum ClientFrame {
    static func auth(token: String) -> String { encode(["type": .string("auth"), "token": .string(token)]) }
    static func ping(active: Bool) -> String { encode(["type": .string("ping"), "active": .bool(active)]) }
    static func typing(channelId: String, parentId: String?) -> String {
        var object: [String: JSONValue] = ["type": .string("typing"), "channel_id": .string(channelId)]
        if let parentId { object["parent_id"] = .string(parentId) }
        return encode(object)
    }

    private static func encode(_ object: [String: JSONValue]) -> String {
        String(data: (try? JSON.plainEncoder.encode(JSONValue.object(object))) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
    }
}

let closeReconnect = 4000
let closeAuthFailed = 4001
let closeSessionRevoked = 4003
