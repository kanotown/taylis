import Foundation

/// M143 (docs/ACTIONS.md §7.1): a 操作ボタン I may press (no URL, key nor rights: those stay on the server).
struct ActionOut: Codable, Equatable, Identifiable, Hashable {
    let id: String
    /// The button's name (「開ける」).
    let name: String
    /// Buttons with the same group are drawn together under it (「研究室の鍵」); nil = no group (drawn last).
    var groupLabel: String? = nil
    /// A key of apps/shared/attendance-icons.json (its SF Symbol); nil, or a key this app does not know: the emoji.
    var icon: String? = nil
    /// The picture when there is no icon (🔓).
    var emoji: String? = nil
    /// Ask before sending; `confirmText` nil = this app's own sentence.
    var confirm: Bool = true
    var confirmText: String? = nil
    var position: Int = 0
}

/// GET /actions and the bootstrap's `actions` (nil for guests and while the feature is off).
struct ActionListOut: Codable, Equatable {
    let enabled: Bool
    /// Also on the 在室状況 page and in its quick switch (docs/ACTIONS.md D17).
    var showOnAttendance: Bool = false
    /// Only the ones I may press, in the administrator's order.
    var actions: [ActionOut] = []
}

/// POST /actions/{id}/invoke: what the relay answered (a failure of the relay is still HTTP 200, `ok: false`).
struct ActionInvokeOut: Codable, Equatable {
    let invokeId: String
    let actionId: String
    let ok: Bool
    /// succeeded / failed / pending.
    let status: String
    /// The relay's HTTP status (nil when nothing came back).
    var statusCode: Int? = nil
    /// timeout / network / relay_error / url_not_allowed / secret_missing / interrupted (nil on success or while pending).
    var error: String? = nil
    /// The relay's own `message` (plain text, at most 200 characters).
    var message: String? = nil
    let at: String
    /// An answer to a repeat of an earlier client_invoke_id (the relay was not called again).
    var repeated: Bool = false
}

/// M143: the buttons (ApiClient and the test fake).
@MainActor
protocol ActionsApi: AnyObject {
    func actions() async throws -> ActionListOut
    func invokeAction(id: String, clientInvokeId: String) async throws -> ActionInvokeOut
}

extension ApiClient: ActionsApi {
    // MARK: 操作ボタン (M143, docs/ACTIONS.md §7.1)

    /// The buttons I may press (`enabled: false` and none while off; none for a guest).
    func actions() async throws -> ActionListOut { try await requestJSON("GET", "/api/v1/actions") }

    /// One press: the server calls the relay once. The same `clientInvokeId` again answers the first result.
    func invokeAction(id: String, clientInvokeId: String) async throws -> ActionInvokeOut {
        try await requestJSON("POST", "/api/v1/actions/\(id)/invoke", body: .object(["client_invoke_id": .string(clientInvokeId)]))
    }
}
