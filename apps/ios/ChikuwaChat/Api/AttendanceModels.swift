import Foundation

/// M140 (docs/PRESENCE.md §3): a 在室状況 state — the workspace's (`ownerId` nil) or someone's own.
struct AttendanceStateOut: Codable, Equatable, Identifiable, Hashable {
    let id: String
    /// nil = the workspace's state; else the person whose own state it is.
    let ownerId: String?
    let label: String
    let emoji: String?
    /// A key of apps/shared/attendance-icons.json (PRESENCE.md §2.1), drawn as its SF Symbol; nil, or a key this app
    /// does not know: the emoji instead.
    var icon: String? = nil
    /// A key of the text emoji palette (apps/shared/text-emoji.json): gray red orange yellow green blue purple pink.
    let color: String
    /// in_room / on_site / off_site / gone.
    let kind: String
    let position: Int
    /// Deleted but still someone's current state (shown on the board, never offered as a button).
    var archived: Bool = false
}

/// One person's current 在室状況 (GET /attendance's `entries`, PUT /attendance/me, the attendance.updated event).
struct AttendanceEntryOut: Codable, Equatable {
    let userId: String
    let stateId: String
    /// When this state began (a note change does not move it).
    let since: String
    let note: String?
    /// app / admin / integration / auto.
    var source: String = "app"
}

/// GET /attendance and the bootstrap's `attendance` (nil for guests and while the board is off).
struct AttendanceBoardOut: Codable, Equatable {
    let enabled: Bool
    var states: [AttendanceStateOut]
    var entries: [AttendanceEntryOut]
    /// Whether I may add my own states.
    var canPersonalize: Bool = false
}

/// The fields of a personal state (POST / PATCH /attendance/my-states).
struct AttendanceStateForm: Equatable {
    var label: String
    /// nil = no icon (sent as null, which removes it).
    var icon: String? = nil
    var emoji: String?
    var color: String
    var kind: String

    var json: JSONValue {
        .object(["label": .string(label), "icon": icon.map(JSONValue.string) ?? .null, "emoji": emoji.map(JSONValue.string) ?? .null,
                 "color": .string(color), "kind": .string(kind)])
    }
}

/// M140: the board (ApiClient and the test fake).
@MainActor
protocol AttendanceApi: AnyObject {
    func attendance() async throws -> AttendanceBoardOut
}

extension ApiClient: AttendanceApi {
    // MARK: 在室状況 (M140, docs/PRESENCE.md §3)

    /// The board: states, everyone's current row, whether I may add my own states (`enabled: false` while off;
    /// 403 guest_restricted for a guest).
    func attendance() async throws -> AttendanceBoardOut { try await requestJSON("GET", "/api/v1/attendance") }

    /// My state and note (`note` nil = none). The same state and note again changes nothing.
    func setMyAttendance(stateId: String, note: String?) async throws -> AttendanceEntryOut {
        try await requestJSON("PUT", "/api/v1/attendance/me",
                          body: .object(["state_id": .string(stateId), "note": note.map(JSONValue.string) ?? .null]))
    }

    func createMyAttendanceState(_ form: AttendanceStateForm) async throws -> AttendanceStateOut {
        try await requestJSON("POST", "/api/v1/attendance/my-states", body: form.json)
    }

    func updateMyAttendanceState(id: String, _ form: AttendanceStateForm) async throws -> AttendanceStateOut {
        try await requestJSON("PATCH", "/api/v1/attendance/my-states/\(id)", body: form.json)
    }

    func deleteMyAttendanceState(id: String) async throws {
        try await requestNoContent("DELETE", "/api/v1/attendance/my-states/\(id)")
    }
}
