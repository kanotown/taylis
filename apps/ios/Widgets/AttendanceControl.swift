import AppIntents
import SwiftUI
import WidgetKit

/// Control Center and the lock screen (iOS 18): one toggle between 在室 and 帰宅 (the small widget's button). On while
/// my state is of the 在室 kind.
@available(iOS 18.0, *)
struct AttendanceControl: ControlWidget {
    var body: some ControlWidgetConfiguration {
        StaticControlConfiguration(kind: AttendanceWidgetStore.controlKind, provider: Provider()) { value in
            ControlWidgetToggle(isOn: value.isOn, action: ToggleInRoomIntent()) {
                Label(value.title, systemImage: value.isOn ? value.onSymbol : value.offSymbol)
            } valueLabel: { isOn in
                Text(isOn ? value.onLabel : value.offLabel)
            }
            .tint(Color(rgb: value.onColor))
        }
        .displayName("在室状況")
        .description("在室と帰宅を切り替えます")
    }

    struct Value {
        var isOn: Bool
        /// The workspace's name (Taylis without one).
        var title: String
        var onLabel: String
        var offLabel: String
        var onSymbol: String
        var offSymbol: String
        var onColor: UInt32
    }

    struct Provider: ControlValueProvider {
        var previewValue: Value {
            Value(isOn: true, title: "Taylis", onLabel: widgetText("在室"), offLabel: widgetText("帰宅"), onSymbol: "door.left.hand.open",
                  offSymbol: "house", onColor: 0x15803D)
        }

        func currentValue() async throws -> Value {
            guard let snapshot = AttendanceWidgetStore.current(), snapshot.available else {
                return Value(isOn: false, title: "Taylis", onLabel: widgetText("在室"), offLabel: widgetText("在室状況はオフです"),
                             onSymbol: "door.left.hand.open", offSymbol: "door.left.hand.closed", onColor: 0x15803D)
            }
            let on = AttendanceWidgetRules.firstChoice(snapshot, kind: AttendanceWidgetRules.countedKind)
            let off = AttendanceWidgetRules.firstChoice(snapshot, kind: AttendanceWidgetRules.goneKind)
            func symbol(_ state: AttendanceWidgetState?, _ fallback: String) -> String {
                guard let state, case .symbol(let name) = AttendanceWidgetRules.glyph(state, symbols: snapshot.symbols) else { return fallback }
                return name
            }
            return Value(isOn: AttendanceWidgetRules.isInRoom(snapshot), title: snapshot.workspaceName,
                         onLabel: on?.label ?? widgetText("在室"), offLabel: off?.label ?? widgetText("帰宅"),
                         onSymbol: symbol(on, "door.left.hand.open"), offSymbol: symbol(off, "house"),
                         onColor: on.map { AttendanceWidgetRules.color($0, colors: snapshot.colors) } ?? 0x15803D)
        }
    }
}
