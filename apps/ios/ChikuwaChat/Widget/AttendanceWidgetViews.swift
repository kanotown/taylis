import AppIntents
import SwiftUI
import WidgetKit

// The 在室状況 widget's faces (Widgets/AttendanceWidget.swift configures it). Compiled into the app too, so the tests
// render them (AttendanceWidgetTests); the buttons run SetAttendanceIntent in the extension.

/// One moment of the widget: the snapshot it draws (nil: the app has written none — nobody signed in yet).
struct AttendanceTimelineEntry: TimelineEntry {
    let date: Date
    let snapshot: AttendanceWidgetSnapshot?
}

/// The widget for one family.
struct AttendanceWidgetView: View {
    let entry: AttendanceTimelineEntry
    let family: WidgetFamily

    var body: some View {
        content
            .widgetURL(AttendanceWidgetLink.url(serverUrl: entry.snapshot?.serverUrl))
            .environment(\.locale, WidgetLanguage.locale)
            // A new state is drawn at once, without WidgetKit's animation between entries: on the simulator the
            // pressed widget sometimes kept parts of the old face (2026-10-13).
            .transaction { $0.animation = nil }
            .contentTransition(.identity)
    }

    @ViewBuilder
    private var content: some View {
        switch family {
        case .accessoryCircular: AttendanceCircularView(snapshot: entry.snapshot)
        case .accessoryRectangular: AttendanceRectangularView(snapshot: entry.snapshot)
        case .accessoryInline: AttendanceInlineView(snapshot: entry.snapshot)
        case .systemMedium: AttendanceHomeView(snapshot: entry.snapshot, medium: true)
        default: AttendanceHomeView(snapshot: entry.snapshot, medium: false)
        }
    }
}

/// A state's picture: its SF Symbol in a fixed box (as the app's AttendanceGlyph), else its emoji, else nothing.
struct AttendanceWidgetGlyph: View {
    let state: AttendanceWidgetState
    let symbols: [String: String]
    var size: CGFloat = 14

    var body: some View {
        switch AttendanceWidgetRules.glyph(state, symbols: symbols) {
        case .symbol(let name):
            Image(systemName: name)
                .font(.system(size: size * 0.9, weight: .semibold))
                .frame(width: (size * 1.2).rounded(.up), height: size)
                .accessibilityHidden(true)
        case .emoji(let emoji):
            Text(verbatim: emoji).font(.system(size: size * 0.9)).accessibilityHidden(true)
        case .none:
            EmptyView()
        }
    }
}

/// My state as the app's badge (docs/PRESENCE.md §2.2): the state's solid colour, white icon and name; 「未設定」 with
/// an outline while I have none.
struct AttendanceWidgetBadge: View {
    let snapshot: AttendanceWidgetSnapshot
    var font: Font = .subheadline.weight(.bold)

    var body: some View {
        if let state = AttendanceWidgetRules.myState(snapshot) {
            HStack(spacing: 4) {
                AttendanceWidgetGlyph(state: state, symbols: snapshot.symbols, size: 15)
                Text(verbatim: state.label).font(font).lineLimit(1).minimumScaleFactor(0.8).contentTransition(.identity)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color(rgb: AttendanceWidgetRules.color(state, colors: snapshot.colors))))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("在室状況：\(state.label)"))
        } else {
            Text("未設定")
                .font(font)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 9)
                .padding(.vertical, 5)
                .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(.secondary.opacity(0.5)))
        }
    }
}

/// One state as a button: my current state solid (white icon and name), the others outlined with the icon in the
/// state's colour (the app's buttons, §2.2). Pressing switches my state (SetAttendanceIntent).
struct AttendanceWidgetButton: View {
    let state: AttendanceWidgetState
    let snapshot: AttendanceWidgetSnapshot
    var height: CGFloat = 40

    private var selected: Bool { AttendanceWidgetRules.myEntry(snapshot)?.stateId == state.id }
    private var color: Color { Color(rgb: AttendanceWidgetRules.color(state, colors: snapshot.colors)) }

    var body: some View {
        Button(intent: SetAttendanceIntent(stateId: state.id, account: snapshot.account)) {
            HStack(spacing: 4) {
                AttendanceWidgetGlyph(state: state, symbols: snapshot.symbols, size: 14)
                    .foregroundStyle(selected ? Color.white : color)
                Text(verbatim: state.label)
                    .font(.footnote.weight(selected ? .bold : .medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .foregroundStyle(selected ? Color.white : Color.primary)
                    // No cross-fade between entries: on the simulator a press left the old name half faded in (2026-10-13).
                    .contentTransition(.identity)
            }
            .padding(.horizontal, 6)
            .frame(maxWidth: .infinity, minHeight: height)
            .background {
                let shape = RoundedRectangle(cornerRadius: 10, style: .continuous)
                if selected {
                    shape.fill(color)
                } else {
                    shape.fill(Color.primary.opacity(0.04)).overlay(shape.strokeBorder(Color.primary.opacity(0.18), lineWidth: 1))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: state.label))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// The home screen's small and medium widgets.
struct AttendanceHomeView: View {
    let snapshot: AttendanceWidgetSnapshot?
    let medium: Bool

    var body: some View {
        Group {
            if let snapshot {
                if snapshot.available { board(snapshot) } else { message(snapshot.workspaceName, Text("在室状況はオフです")) }
            } else {
                message("Taylis", Text("Taylis を開いてサインインしてください"))
            }
        }
        .containerBackground(for: .widget) { Color(.systemBackground) }
    }

    @ViewBuilder
    private func board(_ snapshot: AttendanceWidgetSnapshot) -> some View {
        if medium {
            HStack(alignment: .top, spacing: 12) {
                summary(snapshot)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                let buttons = AttendanceWidgetRules.mediumButtons(snapshot)
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
                    ForEach(buttons) { state in AttendanceWidgetButton(state: state, snapshot: snapshot, height: 44) }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
            }
        } else {
            VStack(alignment: .leading, spacing: 0) {
                summary(snapshot)
                Spacer(minLength: 6)
                if let target = AttendanceWidgetRules.toggleTarget(snapshot) {
                    AttendanceWidgetButton(state: target, snapshot: snapshot, height: 38)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    /// The workspace, my state, 「在室 n 人」 and, after a failed refresh or change, why the state may be old.
    private func summary(_ snapshot: AttendanceWidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: snapshot.workspaceName)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .lineLimit(1)
            AttendanceWidgetBadge(snapshot: snapshot)
            HStack(spacing: 4) {
                Image(systemName: "person.2.fill").font(.caption2).foregroundStyle(.secondary).accessibilityHidden(true)
                Text("在室 \(AttendanceWidgetRules.inRoomCount(snapshot)) 人")
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
            }
            if let problem = snapshot.problem { AttendanceWidgetProblemLine(problem: problem) }
        }
    }

    private func message(_ title: String, _ text: Text) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: title).font(.caption2.weight(.semibold)).foregroundStyle(.secondary).lineLimit(1)
            Image(systemName: "door.left.hand.open").font(.title2).foregroundStyle(.secondary).accessibilityHidden(true)
            text.font(.footnote).foregroundStyle(.secondary).lineLimit(3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

/// 「更新できません」 (offline, a temporary error), 「サインインし直してください」, 「変更できませんでした」.
struct AttendanceWidgetProblemLine: View {
    let problem: AttendanceWidgetProblem

    var body: some View {
        Label {
            switch problem {
            case .offline: Text("更新できません")
            case .signedOut: Text("サインインし直してください")
            case .refused: Text("変更できませんでした")
            }
        } icon: {
            Image(systemName: problem == .offline ? "wifi.exclamationmark" : "exclamationmark.triangle.fill")
        }
        .font(.caption2)
        .foregroundStyle(.orange)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
}

/// Lock screen, round: my state's icon and 「在室」's count.
struct AttendanceCircularView: View {
    let snapshot: AttendanceWidgetSnapshot?

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 1) {
                if let snapshot, snapshot.available, let state = AttendanceWidgetRules.myState(snapshot) {
                    AttendanceWidgetGlyph(state: state, symbols: snapshot.symbols, size: 16)
                } else {
                    Image(systemName: "door.left.hand.open").font(.system(size: 14, weight: .semibold))
                }
                if let snapshot, snapshot.available {
                    Text(verbatim: "\(AttendanceWidgetRules.inRoomCount(snapshot))").font(.system(size: 15, weight: .bold)).monospacedDigit()
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
        .containerBackground(for: .widget) { Color.clear }
    }

    private var accessibility: Text {
        guard let snapshot, snapshot.available else { return Text("在室状況") }
        return Text("在室 \(AttendanceWidgetRules.inRoomCount(snapshot)) 人")
    }
}

/// Lock screen, rectangle: my state, 「在室 n 人」 and the workspace.
struct AttendanceRectangularView: View {
    let snapshot: AttendanceWidgetSnapshot?

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let snapshot, snapshot.available {
                HStack(spacing: 4) {
                    if let state = AttendanceWidgetRules.myState(snapshot) {
                        AttendanceWidgetGlyph(state: state, symbols: snapshot.symbols, size: 15)
                        Text(verbatim: state.label).font(.headline).lineLimit(1)
                    } else {
                        Text("未設定").font(.headline)
                    }
                }
                Text("在室 \(AttendanceWidgetRules.inRoomCount(snapshot)) 人").font(.subheadline)
                if snapshot.problem != nil {
                    Text("更新できません").font(.caption).foregroundStyle(.secondary)
                } else {
                    Text(verbatim: snapshot.workspaceName).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            } else {
                Text("在室状況").font(.headline)
                Text(snapshot == nil ? "Taylis を開いてサインインしてください" : "在室状況はオフです").font(.caption).lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .containerBackground(for: .widget) { Color.clear }
    }
}

/// Lock screen, one line above the clock: 「在室 · 在室 3 人」.
struct AttendanceInlineView: View {
    let snapshot: AttendanceWidgetSnapshot?

    var body: some View {
        if let snapshot, snapshot.available {
            let count = AttendanceWidgetRules.inRoomCount(snapshot)
            if let state = AttendanceWidgetRules.myState(snapshot) {
                Label {
                    Text("\(state.label) · 在室 \(count) 人")
                } icon: {
                    if case .symbol(let name) = AttendanceWidgetRules.glyph(state, symbols: snapshot.symbols) { Image(systemName: name) }
                }
            } else {
                Text("在室 \(count) 人")
            }
        } else {
            Text("在室状況")
        }
    }
}
