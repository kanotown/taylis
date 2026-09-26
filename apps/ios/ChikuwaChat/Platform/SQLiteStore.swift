import Foundation
import SQLite3

/// A tiny wrapper over the system SQLite3 C API (no third-party dependency, CLAUDE.md).
final class SQLiteDatabase {
    private var handle: OpaquePointer?
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    struct SQLiteError: Error { let message: String }

    init(path: String) throws {
        if sqlite3_open(path, &handle) != SQLITE_OK {
            throw SQLiteError(message: String(cString: sqlite3_errmsg(handle)))
        }
        try exec("PRAGMA journal_mode = WAL")
    }

    deinit { sqlite3_close(handle) }

    func exec(_ sql: String, _ params: [Any?] = []) throws {
        _ = try query(sql, params)
    }

    /// Runs a statement; rows come back as dictionaries keyed by column name.
    func query(_ sql: String, _ params: [Any?] = []) throws -> [[String: Any]] {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else {
            throw SQLiteError(message: String(cString: sqlite3_errmsg(handle)))
        }
        defer { sqlite3_finalize(statement) }
        for (index, param) in params.enumerated() {
            let position = Int32(index + 1)
            switch param {
            case nil: sqlite3_bind_null(statement, position)
            case let value as Int: sqlite3_bind_int64(statement, position, Int64(value))
            case let value as Int64: sqlite3_bind_int64(statement, position, value)
            case let value as Double: sqlite3_bind_double(statement, position, value)
            case let value as String: sqlite3_bind_text(statement, position, value, -1, Self.transient)
            default: throw SQLiteError(message: "unsupported parameter \(String(describing: param))")
            }
        }
        var rows: [[String: Any]] = []
        while true {
            let step = sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw SQLiteError(message: String(cString: sqlite3_errmsg(handle))) }
            var row: [String: Any] = [:]
            for column in 0..<sqlite3_column_count(statement) {
                let name = String(cString: sqlite3_column_name(statement, column))
                switch sqlite3_column_type(statement, column) {
                case SQLITE_INTEGER: row[name] = Int(sqlite3_column_int64(statement, column))
                case SQLITE_FLOAT: row[name] = sqlite3_column_double(statement, column)
                case SQLITE_TEXT: row[name] = String(cString: sqlite3_column_text(statement, column))
                default: row[name] = nil
                }
            }
            rows.append(row)
        }
        return rows
    }
}

/// Write-through persistence per server + user, same layout as the desktop client.
final class SQLitePersistence: Persistence {
    private let db: SQLiteDatabase
    private static let schema = [
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)",
        "CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, json TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS channels (id TEXT PRIMARY KEY, json TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, seq INTEGER, json TEXT NOT NULL)",
        "CREATE INDEX IF NOT EXISTS messages_channel_seq ON messages (channel_id, seq)",
        "CREATE TABLE IF NOT EXISTS outbox (client_msg_id TEXT PRIMARY KEY, created_at TEXT NOT NULL, json TEXT NOT NULL)",
    ]

    init(db: SQLiteDatabase) throws {
        self.db = db
        for statement in Self.schema { try db.exec(statement) }
    }

    static func open(profile: String) throws -> SQLitePersistence {
        let safe = profile.replacingOccurrences(of: "[^a-zA-Z0-9]+", with: "-", options: .regularExpression).prefix(80)
        let directory = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let path = directory.appendingPathComponent("chikuwa-\(safe).db").path
        return try SQLitePersistence(db: SQLiteDatabase(path: path))
    }

    private func encode<T: Encodable>(_ value: T) -> String {
        (try? String(data: JSON.plainEncoder.encode(value), encoding: .utf8)) ?? "{}"
    }

    private func decodeRows<T: Decodable>(_ sql: String, as type: T.Type) throws -> [T] {
        try db.query(sql).compactMap { row in
            guard let json = row["json"] as? String else { return nil }
            return try? JSON.plainDecoder.decode(T.self, from: Data(json.utf8))
        }
    }

    func loadAll() throws -> Snapshot {
        var snapshot = Snapshot()
        for row in try db.query("SELECT key, value FROM meta") {
            if let key = row["key"] as? String, let value = row["value"] as? String { snapshot.meta[key] = value }
        }
        snapshot.users = try decodeRows("SELECT json FROM users", as: UserPublic.self)
        snapshot.channels = try decodeRows("SELECT json FROM channels", as: ChannelState.self)
        snapshot.messages = try decodeRows("SELECT json FROM messages", as: MessageState.self)
        snapshot.outbox = try decodeRows("SELECT json FROM outbox ORDER BY created_at", as: OutboxItem.self)
        return snapshot
    }

    func saveMeta(key: String, value: String?) throws {
        if let value {
            try db.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value])
        } else {
            try db.exec("DELETE FROM meta WHERE key = ?", [key])
        }
    }

    func saveUser(_ user: UserPublic) throws {
        try db.exec("INSERT INTO users (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json", [user.id, encode(user)])
    }

    func saveChannel(_ channel: ChannelState) throws {
        try db.exec("INSERT INTO channels (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json", [channel.id, encode(channel)])
    }

    func deleteChannel(id: String) throws {
        try db.exec("DELETE FROM channels WHERE id = ?", [id])
    }

    func saveMessage(_ message: MessageState) throws {
        try db.exec("INSERT INTO messages (id, channel_id, seq, json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, json = excluded.json",
                    [message.id, message.channelId, message.seq, encode(message)])
    }

    func deleteMessage(id: String) throws {
        try db.exec("DELETE FROM messages WHERE id = ?", [id])
    }

    func clearMessages(channelId: String) throws {
        try db.exec("DELETE FROM messages WHERE channel_id = ?", [channelId])
    }

    func saveOutbox(_ item: OutboxItem) throws {
        try db.exec("INSERT INTO outbox (client_msg_id, created_at, json) VALUES (?, ?, ?) ON CONFLICT(client_msg_id) DO UPDATE SET json = excluded.json",
                    [item.clientMsgId, item.createdAt, encode(item)])
    }

    func deleteOutbox(clientMsgId: String) throws {
        try db.exec("DELETE FROM outbox WHERE client_msg_id = ?", [clientMsgId])
    }
}
