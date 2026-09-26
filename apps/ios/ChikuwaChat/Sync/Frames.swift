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

    private struct Head: Decodable {
        let type: String
        let session_id: String?
        let heartbeat_interval_sec: Int?
        let code: String?
        let message: String?
    }

    static func parse(_ text: String) -> ServerFrame? {
        let data = Data(text.utf8)
        guard let head = try? JSON.plainDecoder.decode(Head.self, from: data) else { return nil }
        switch head.type {
        case "hello": return .hello(sessionId: head.session_id ?? "", heartbeatIntervalSec: head.heartbeat_interval_sec ?? 30)
        case "pong": return .pong
        case "error": return .error(code: head.code ?? "error", message: head.message ?? "")
        case "event": return (try? JSON.plainDecoder.decode(EventFrame.self, from: data)).map(ServerFrame.event)
        default: return nil
        }
    }
}

enum ClientFrame {
    static func auth(token: String) -> String { encode(["type": .string("auth"), "token": .string(token)]) }
    static func ping(active: Bool) -> String { encode(["type": .string("ping"), "active": .bool(active)]) }

    private static func encode(_ object: [String: JSONValue]) -> String {
        String(data: (try? JSON.plainEncoder.encode(JSONValue.object(object))) ?? Data("{}".utf8), encoding: .utf8) ?? "{}"
    }
}

let closeReconnect = 4000
let closeAuthFailed = 4001
let closeSessionRevoked = 4003
