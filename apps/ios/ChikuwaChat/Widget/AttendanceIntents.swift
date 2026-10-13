import AppIntents
import WidgetKit

/// A widget button: my 在室状況 → this state (PUT /attendance/me; the note as the app's buttons keep it). Runs in the
/// extension with the tokens the app shares; a failure leaves the last known state with a hint.
struct SetAttendanceIntent: AppIntent {
    static var title: LocalizedStringResource = "在室状況を変える"
    static var isDiscoverable = false

    @Parameter(title: "状態") var stateId: String
    @Parameter(title: "アカウント") var account: String

    init() {}

    init(stateId: String, account: String) {
        self.stateId = stateId
        self.account = account
    }

    func perform() async throws -> some IntentResult {
        await AttendanceWidgetActions.setState(stateId, account: account)
        WidgetReload.all()
        return .result()
    }
}

/// The control's toggle (iOS 18): on = the first 「在室」-kind state, off = the first 「帰宅」-kind one, in the workspace
/// the widget shows.
@available(iOS 18.0, *)
struct ToggleInRoomIntent: SetValueIntent {
    static var title: LocalizedStringResource = "在室と帰宅を切り替える"
    static var isDiscoverable = false

    @Parameter(title: "在室") var value: Bool

    init() {}

    func perform() async throws -> some IntentResult {
        guard let snapshot = AttendanceWidgetStore.current(), snapshot.available,
              let target = AttendanceWidgetRules.firstChoice(snapshot, kind: value ? AttendanceWidgetRules.countedKind : AttendanceWidgetRules.goneKind)
        else { return .result() }
        await AttendanceWidgetActions.setState(target.id, account: snapshot.account)
        WidgetReload.all()
        return .result()
    }
}
