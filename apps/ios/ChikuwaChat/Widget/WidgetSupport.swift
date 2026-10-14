import SwiftUI
import WidgetKit

/// The UI language: the app's (自分 → 表示 → 言語, left in the App Group), else the device's among ours (as the Share
/// Extension's ShareLanguage).
enum WidgetLanguage {
    static var current: String {
        if let chosen = SharedContainer.language(), ["ja", "en", "zh-Hans"].contains(chosen) { return chosen }
        for identifier in Locale.preferredLanguages {
            let id = identifier.lowercased()
            if id.hasPrefix("ja") { return "ja" }
            if id.hasPrefix("en") { return "en" }
            if id.hasPrefix("zh") { return "zh-Hans" }
        }
        return "ja"
    }

    static var locale: Locale { Locale(identifier: current) }
}

extension Color {
    /// A 0xRRGGBB colour.
    init(rgb: UInt32) {
        self.init(red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255)
    }
}

enum WidgetReload {
    /// Everything that shows my state (the control's change).
    static func all() {
        WidgetCenter.shared.reloadTimelines(ofKind: AttendanceWidgetStore.widgetKind)
        controls()
    }

    /// The control only (a widget button's change: the system reloads the widgets after it).
    static func controls() {
        if #available(iOS 18.0, *) { ControlCenter.shared.reloadControls(ofKind: AttendanceWidgetStore.controlKind) }
    }
}

/// A text of Localizable.xcstrings in the widget's UI language (outside SwiftUI's `Text("…")`). The widget's texts are
/// in both catalogs: the extension's (Widgets/Localizable.xcstrings) and the app's (the views are compiled into the app
/// too, for the tests).
func widgetText(_ resource: LocalizedStringResource) -> String {
    var resource = resource
    resource.locale = WidgetLanguage.locale
    return String(localized: resource)
}

/// The widget gallery's picture and the placeholder: the default four states (docs/PRESENCE.md §1), me 在室, three in
/// the room.
enum AttendanceWidgetSamples {
    static var snapshot: AttendanceWidgetSnapshot {
        let states = [
            AttendanceWidgetState(id: "s-in", ownerId: nil, label: widgetText("在室"), icon: "in_room", emoji: "🟢", color: "green", kind: "in_room", position: 0),
            AttendanceWidgetState(id: "s-on", ownerId: nil, label: widgetText("学内"), icon: "on_site", emoji: "🏫", color: "blue", kind: "on_site", position: 1),
            AttendanceWidgetState(id: "s-off", ownerId: nil, label: widgetText("学外"), icon: "off_site", emoji: "🚶", color: "purple", kind: "off_site", position: 2),
            AttendanceWidgetState(id: "s-gone", ownerId: nil, label: widgetText("帰宅"), icon: "gone", emoji: "🏠", color: "red", kind: "gone", position: 3),
        ]
        let entries = [
            AttendanceWidgetEntry(userId: "me", stateId: "s-in"),
            AttendanceWidgetEntry(userId: "u2", stateId: "s-in"),
            AttendanceWidgetEntry(userId: "u3", stateId: "s-in"),
            AttendanceWidgetEntry(userId: "u4", stateId: "s-gone"),
        ]
        return AttendanceWidgetSnapshot(
            serverUrl: "", account: "", workspaceName: "Taylis", userId: "me", available: true, states: states, entries: entries,
            symbols: ["in_room": "door.left.hand.open", "on_site": "building.2", "off_site": "mappin.and.ellipse", "gone": "house"],
            colors: ["green": 0x15803D, "blue": 0x2563EB, "purple": 0x7C3AED, "red": 0xDC2626, "gray": 0x4B5563],
            updatedAt: .distantFuture, problem: nil,
            people: [
                WidgetPerson(id: "me", name: widgetText("自分"), initials: "K", color: 0x5B5BD6),
                WidgetPerson(id: "u2", name: "Hanako", initials: "H", color: 0x2F9E6E),
                WidgetPerson(id: "u3", name: "Jiro", initials: "J", color: 0xC2410C),
                WidgetPerson(id: "u4", name: "Taro", initials: "T", color: 0x2F7FA8),
            ])
    }
}
