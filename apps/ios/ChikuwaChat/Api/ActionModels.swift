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
    /// M143 §12: this button's relay tells its group's state (one per group); nil from a server before the states.
    var providesStatus: Bool? = nil
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

/// M143 §12.2: one line of a state's details (「電池」「85%」).
struct ActionStatusDetail: Codable, Equatable, Hashable {
    let label: String
    let value: String
}

/// M143 §12.2: what the relay says the devices are like, cleaned by the server (plain text only).
struct ActionStatusValue: Codable, Equatable {
    /// 「施錠中・ドア閉・電池 85%」 (at most 80 characters).
    let text: String
    /// ok / warn / alert / neutral (another word: neutral).
    let tone: String
    /// A short machine word (`locked`…), or nil.
    var state: String? = nil
    var details: [ActionStatusDetail]? = nil
}

/// M143 §12.3: the state of one group (GET /actions/status, actions.status_updated).
struct ActionStatusOut: Codable, Equatable {
    /// The button that provides the state (maybe one I cannot press myself).
    let actionId: String
    /// The group it is the state of; nil = the button has no group and is its own.
    var groupLabel: String? = nil
    let ok: Bool
    var status: ActionStatusValue? = nil
    /// timeout / network / relay_error / invalid_answer / url_not_allowed / secret_missing (nil when ok).
    var error: String? = nil
    /// The relay's own message on a failure.
    var message: String? = nil
    /// When the relay answered (the server may answer from its short cache).
    let fetchedAt: String
}

/// GET /actions/status: one per group I may press something in (empty while off, for guests and bots).
struct ActionStatusListOut: Codable, Equatable {
    let enabled: Bool
    var statuses: [ActionStatusOut] = []
}

/// M143: the buttons (ApiClient and the test fake).
@MainActor
protocol ActionsApi: AnyObject {
    func actions() async throws -> ActionListOut
    func invokeAction(id: String, clientInvokeId: String) async throws -> ActionInvokeOut
    /// The groups' states; `refresh` asks the relays now (429 more often than every 5 seconds).
    func actionStatuses(refresh: Bool) async throws -> ActionStatusListOut
}

extension ApiClient: ActionsApi {
    // MARK: 操作ボタン (M143, docs/ACTIONS.md §7.1)

    /// The buttons I may press (`enabled: false` and none while off; none for a guest).
    func actions() async throws -> ActionListOut { try await requestJSON("GET", "/api/v1/actions") }

    /// One press: the server calls the relay once. The same `clientInvokeId` again answers the first result.
    func invokeAction(id: String, clientInvokeId: String) async throws -> ActionInvokeOut {
        try await requestJSON("POST", "/api/v1/actions/\(id)/invoke", body: .object(["client_invoke_id": .string(clientInvokeId)]))
    }

    /// The groups' states (docs/ACTIONS.md §12.3), from the server's 30-second cache unless `refresh`.
    func actionStatuses(refresh: Bool) async throws -> ActionStatusListOut {
        try await requestJSON("GET", refresh ? "/api/v1/actions/status?refresh=true" : "/api/v1/actions/status")
    }
}
