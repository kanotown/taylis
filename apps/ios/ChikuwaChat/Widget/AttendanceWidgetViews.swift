import AppIntents
import SwiftUI
import WidgetKit

// The 在室状況 widget's faces (Widgets/AttendanceWidget.swift configures it). Compiled into the app too, so the tests
// render them (AttendanceWidgetTests); the buttons run SetAttendanceIntent in the extension.

/// One moment of the widget: the snapshot it draws (nil: nothing to show — nobody signed in yet, or the chosen
/// workspace signed out) and the workspace's row for the header.
struct AttendanceTimelineEntry: TimelineEntry {
    let date: Date
    let snapshot: AttendanceWidgetSnapshot?
    var workspace: Workspace? = nil
}

/// The widget for one family.
struct AttendanceWidgetView: View {
    let entry: AttendanceTimelineEntry
    let family: WidgetFamily

    var body: some View {
        content
            .widgetURL(AttendanceWidgetLink.url(serverUrl: entry.snapshot?.serverUrl ?? entry.workspace?.serverUrl))
            .environment(\.locale, WidgetLanguage.locale)
            .dynamicTypeSize(...DynamicTypeSize.xLarge)
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
        case .systemMedium: AttendanceHomeView(snapshot: entry.snapshot, workspace: entry.workspace, medium: true)
        default: AttendanceHomeView(snapshot: entry.snapshot, workspace: entry.workspace, medium: false)
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

/// My state as a tinted badge: the state's colour softly behind its icon and name (an outline 「未設定」 while I have
/// none).
struct AttendanceWidgetBadge: View {
    let snapshot: AttendanceWidgetSnapshot
    var height: CGFloat = 30
    @WidgetFullColor private var fullColor
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        if let state = AttendanceWidgetRules.myState(snapshot) {
            let rgb = AttendanceWidgetRules.color(state, colors: snapshot.colors)
            HStack(spacing: 5) {
                AttendanceWidgetGlyph(state: state, symbols: snapshot.symbols, size: height * 0.5).widgetAccentable()
                Text(verbatim: state.label)
                    .font(.headline)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .contentTransition(.identity)
            }
            .foregroundStyle(fullColor ? Color.widgetInk(rgb, dark: scheme == .dark) : Color.primary)
            .padding(.horizontal, 11)
            .frame(height: height)
            .background(Capsule().fill(fullColor ? Color(rgb: rgb).opacity(scheme == .dark ? 0.3 : 0.14) : Color.primary.opacity(0.16)))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text("在室状況：\(state.label)"))
        } else {
            Text("未設定")
                .font(.headline)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 11)
                .frame(height: height)
                .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.5), lineWidth: 1))
        }
    }
}

/// One state as a button (SetAttendanceIntent). `wide` (the small widget's one button): filled with the state's
/// colour, white icon and name — what pressing turns me into. Otherwise a tile of the medium widget's grid, icon over
/// name: my current state filled, the others softly tinted with the icon in their colour. In the tinted modes the fills
/// become soft primary ones (a colour fill would turn into a blank blob).
struct AttendanceWidgetButton: View {
    let state: AttendanceWidgetState
    let snapshot: AttendanceWidgetSnapshot
    var wide = false
    var height: CGFloat = 36
    @WidgetFullColor private var fullColor
    @Environment(\.colorScheme) private var scheme

    private var selected: Bool { AttendanceWidgetRules.myEntry(snapshot)?.stateId == state.id }
    private var rgb: UInt32 { AttendanceWidgetRules.color(state, colors: snapshot.colors) }
    private var filled: Bool { wide || selected }

    var body: some View {
        Button(intent: SetAttendanceIntent(stateId: state.id, account: snapshot.account)) {
            label
                .frame(maxWidth: .infinity)
                .frame(height: height)
                .background(background)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: state.label))
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    @ViewBuilder
    private var label: some View {
        let glyph = AttendanceWidgetGlyph(state: state, symbols: snapshot.symbols, size: wide ? 15 : 17)
            .foregroundStyle(glyphStyle)
            .widgetAccentable()
        let name = Text(verbatim: state.label)
            .font(wide ? .subheadline.weight(.bold) : .caption.weight(filled ? .bold : .semibold))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
            .foregroundStyle(filled && fullColor ? Color.white : Color.primary)
            // No cross-fade between entries: on the simulator a press left the old name half faded in (2026-10-13).
            .contentTransition(.identity)
        if wide {
            HStack(spacing: 6) { glyph; name }.padding(.horizontal, 8)
        } else {
            VStack(spacing: 3) { glyph; name }.padding(.horizontal, 4)
        }
    }

    private var glyphStyle: Color {
        guard fullColor else { return .primary }
        return filled ? .white : Color.widgetInk(rgb, dark: scheme == .dark)
    }

    @ViewBuilder
    private var background: some View {
        let shape = RoundedRectangle(cornerRadius: wide ? 12 : 13, style: .continuous)
        if fullColor {
            shape.fill(filled ? Color(rgb: rgb) : Color(rgb: rgb).opacity(scheme == .dark ? 0.2 : 0.1))
        } else {
            shape.fill(Color.primary.opacity(filled ? 0.26 : 0.1))
                .overlay(shape.strokeBorder(Color.primary.opacity(selected ? 0.7 : 0), lineWidth: 1.5))
        }
    }
}

/// Who is in the room: their faces and 「在室 n 人」 (the problem's words instead, when the last try needs the user).
struct AttendanceWidgetPeople: View {
    let snapshot: AttendanceWidgetSnapshot
    var limit = 3
    var size: CGFloat = 22

    var body: some View {
        let people = AttendanceWidgetRules.inRoomPeople(snapshot).map(\.person)
        HStack(spacing: 6) {
            if !people.isEmpty { WidgetFacePile(people: people, limit: limit, size: size) }
            Text("在室 \(AttendanceWidgetRules.inRoomCount(snapshot)) 人")
                .font(.caption.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("在室 \(AttendanceWidgetRules.inRoomCount(snapshot)) 人"))
    }
}

/// The home screen's small and medium widgets.
struct AttendanceHomeView: View {
    let snapshot: AttendanceWidgetSnapshot?
    var workspace: Workspace? = nil
    let medium: Bool

    var body: some View {
        Group {
            if let snapshot {
                if !snapshot.available {
                    message(snapshot, symbol: "door.left.hand.closed", Text("在室状況はオフです"))
                } else if AttendanceWidgetRules.isLoading(snapshot) {
                    message(snapshot, symbol: snapshot.problem == nil ? "arrow.triangle.2.circlepath" : "wifi.exclamationmark",
                            Text(snapshot.problem?.words ?? "読み込み中"))
                } else {
                    board(snapshot)
                }
            } else {
                WidgetMessageFace.signIn(workspace, compact: !medium)
            }
        }
        .containerBackground(for: .widget) { Color(.systemBackground) }
    }

    private func headerRow(_ snapshot: AttendanceWidgetSnapshot) -> Workspace {
        workspace ?? Workspace(serverUrl: snapshot.serverUrl, name: snapshot.workspaceName, username: "")
    }

    private func header(_ snapshot: AttendanceWidgetSnapshot) -> some View {
        WidgetHeader(workspace: headerRow(snapshot), name: snapshot.workspaceName) {
            if let problem = snapshot.problem { WidgetProblemIcon(problem: problem) }
        }
    }

    private func message(_ snapshot: AttendanceWidgetSnapshot, symbol: String, _ text: Text) -> some View {
        WidgetMessageFace(workspace: headerRow(snapshot), name: snapshot.workspaceName, symbol: symbol, text: text, compact: !medium)
    }

    @ViewBuilder
    private func board(_ snapshot: AttendanceWidgetSnapshot) -> some View {
        if medium {
            VStack(alignment: .leading, spacing: 0) {
                header(snapshot)
                Spacer(minLength: WidgetMetrics.gapUnderHeader)
                HStack(alignment: .center, spacing: 12) {
                    summary(snapshot).frame(maxWidth: .infinity, alignment: .leading)
                    grid(snapshot).frame(width: 176)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        } else {
            VStack(alignment: .leading, spacing: 0) {
                header(snapshot)
                Spacer(minLength: 8)
                AttendanceWidgetBadge(snapshot: snapshot, height: 32)
                Spacer(minLength: 6)
                if let problem = snapshot.problem, problem != .offline {
                    AttendanceWidgetProblemLine(problem: problem)
                } else {
                    AttendanceWidgetPeople(snapshot: snapshot, limit: 3, size: 22)
                }
                Spacer(minLength: 8)
                if let target = AttendanceWidgetRules.toggleTarget(snapshot) {
                    AttendanceWidgetButton(state: target, snapshot: snapshot, wide: true, height: 36)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }

    /// My state, the faces in the room, their count and names (or why the board may be old).
    private func summary(_ snapshot: AttendanceWidgetSnapshot) -> some View {
        let people = AttendanceWidgetRules.inRoomPeople(snapshot).map(\.person)
        return VStack(alignment: .leading, spacing: 8) {
            AttendanceWidgetBadge(snapshot: snapshot, height: 30)
            if !people.isEmpty { WidgetFacePile(people: people, limit: 5, size: 24) }
            VStack(alignment: .leading, spacing: 1) {
                Text("在室 \(people.count) 人")
                    .font(.caption.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                if let problem = snapshot.problem {
                    AttendanceWidgetProblemLine(problem: problem)
                } else if !people.isEmpty {
                    Text(verbatim: people.map { $0.name.isEmpty ? "?" : $0.name }.joined(separator: "・"))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .privacySensitive()
                }
            }
        }
    }

    /// My first four states, two by two.
    private func grid(_ snapshot: AttendanceWidgetSnapshot) -> some View {
        let buttons = AttendanceWidgetRules.mediumButtons(snapshot)
        return LazyVGrid(columns: [GridItem(.flexible(), spacing: 8), GridItem(.flexible(), spacing: 8)], spacing: 8) {
            ForEach(buttons) { state in AttendanceWidgetButton(state: state, snapshot: snapshot, height: 52) }
        }
    }
}

/// 「更新できません」 (offline, a temporary error), 「サインインし直してください」, 「変更できませんでした」.
struct AttendanceWidgetProblemLine: View {
    let problem: AttendanceWidgetProblem

    var body: some View {
        Label {
            Text(problem.words)
        } icon: {
            Image(systemName: problem == .offline ? "wifi.exclamationmark" : "exclamationmark.triangle.fill")
        }
        .font(.caption2.weight(.semibold))
        .foregroundStyle(.orange)
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
}

/// Lock screen, round: my state's icon over 「在室」's count.
struct AttendanceCircularView: View {
    let snapshot: AttendanceWidgetSnapshot?

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                if let snapshot, snapshot.available, let state = AttendanceWidgetRules.myState(snapshot) {
                    AttendanceWidgetGlyph(state: state, symbols: snapshot.symbols, size: 17).widgetAccentable()
                } else {
                    Image(systemName: "door.left.hand.open").font(.system(size: 15, weight: .semibold)).widgetAccentable()
                }
                if let snapshot, snapshot.available {
                    Text(verbatim: "\(AttendanceWidgetRules.inRoomCount(snapshot))")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .minimumScaleFactor(0.7)
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

/// Lock screen, rectangle: my state, 「在室 n 人」 with who, and the workspace.
struct AttendanceRectangularView: View {
    let snapshot: AttendanceWidgetSnapshot?

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            if let snapshot, snapshot.available, !AttendanceWidgetRules.isLoading(snapshot) {
                HStack(spacing: 4) {
                    if let state = AttendanceWidgetRules.myState(snapshot) {
                        AttendanceWidgetGlyph(state: state, symbols: snapshot.symbols, size: 15).widgetAccentable()
                        Text(verbatim: state.label).font(.headline).lineLimit(1)
                    } else {
                        Text("未設定").font(.headline)
                    }
                }
                let people = AttendanceWidgetRules.inRoomPeople(snapshot).map(\.person)
                HStack(spacing: 4) {
                    Text("在室 \(people.count) 人").font(.caption.weight(.semibold)).monospacedDigit()
                    if !people.isEmpty {
                        Text(verbatim: people.map { $0.name.isEmpty ? "?" : $0.name }.joined(separator: "・"))
                            .font(.caption)
                            .lineLimit(1)
                            .privacySensitive()
                    }
                }
                if snapshot.problem != nil {
                    Text("更新できません").font(.caption2).foregroundStyle(.secondary)
                } else {
                    Text(verbatim: snapshot.workspaceName).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                }
            } else {
                Label { Text("在室状況") } icon: { Image(systemName: "door.left.hand.open") }
                    .font(.headline)
                    .widgetAccentable()
                Text(snapshot == nil ? "Taylis を開いてサインインしてください" : snapshot?.available == false ? "在室状況はオフです" : "読み込み中")
                    .font(.caption)
                    .lineLimit(2)
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
