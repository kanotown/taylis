import SwiftUI

/// 在室状況 (docs/PRESENCE.md §2.1, §9.1): the states' icons. A copy of apps/shared/attendance-icons.json — the keys in
/// the picker's order, their SF Symbols names and the meanings' names in the three UI languages (AttendanceIconsTests
/// compares them with the file). Desktop / Web draw the same meanings with lucide, Android with Material icons.
///
/// A state whose icon this app does not know (a key added later) or that has none shows its emoji instead, or only its
/// name.
enum AttendanceIcons {
    struct Icon: Equatable, Identifiable {
        let key: String
        /// The SF Symbols name (iOS 17).
        let sf: String
        /// ja / en / zh-Hans.
        let label: [String: String]
        var id: String { key }
    }

    static let catalogue: [Icon] = [
        Icon(key: "in_room", sf: "door.left.hand.open", label: ["ja": "在室", "en": "In the room", "zh-Hans": "在室"]),  // i18n-ignore
        Icon(key: "on_site", sf: "building.2", label: ["ja": "建物内", "en": "On site", "zh-Hans": "楼内"]),  // i18n-ignore
        Icon(key: "off_site", sf: "mappin.and.ellipse", label: ["ja": "外出", "en": "Out", "zh-Hans": "外出"]),  // i18n-ignore
        Icon(key: "gone", sf: "house", label: ["ja": "帰宅", "en": "Gone home", "zh-Hans": "回家"]),  // i18n-ignore
        Icon(key: "meeting", sf: "person.2", label: ["ja": "会議", "en": "Meeting", "zh-Hans": "会议"]),  // i18n-ignore
        Icon(key: "class", sf: "rectangle.inset.filled.and.person.filled", label: ["ja": "授業・発表", "en": "Class / talk", "zh-Hans": "上课/报告"]),  // i18n-ignore
        Icon(key: "remote", sf: "laptopcomputer", label: ["ja": "リモート", "en": "Remote", "zh-Hans": "远程"]),  // i18n-ignore
        Icon(key: "lunch", sf: "fork.knife", label: ["ja": "食事", "en": "Lunch", "zh-Hans": "用餐"]),  // i18n-ignore
        Icon(key: "trip", sf: "airplane", label: ["ja": "出張・移動", "en": "Trip", "zh-Hans": "出差"]),  // i18n-ignore
        Icon(key: "away", sf: "clock", label: ["ja": "少し離席", "en": "Away", "zh-Hans": "暂离"]),  // i18n-ignore
        Icon(key: "busy", sf: "minus.circle", label: ["ja": "取り込み中", "en": "Busy", "zh-Hans": "忙碌"]),  // i18n-ignore
        Icon(key: "sick", sf: "thermometer.medium", label: ["ja": "体調不良", "en": "Sick", "zh-Hans": "生病"]),  // i18n-ignore
        Icon(key: "vacation", sf: "beach.umbrella", label: ["ja": "休暇", "en": "Vacation", "zh-Hans": "休假"]),  // i18n-ignore
        Icon(key: "lab", sf: "flask", label: ["ja": "実験", "en": "Lab work", "zh-Hans": "实验"]),  // i18n-ignore
        Icon(key: "library", sf: "books.vertical", label: ["ja": "図書館", "en": "Library", "zh-Hans": "图书馆"]),  // i18n-ignore
        Icon(key: "other", sf: "circle", label: ["ja": "その他", "en": "Other", "zh-Hans": "其他"]),  // i18n-ignore
    ]

    /// The icon of each kind's default state: a new state's icon until one is picked (the file's `defaults`).
    static let defaults: [String: String] = ["in_room": "in_room", "on_site": "on_site", "off_site": "off_site", "gone": "gone"]

    private static let byKey = Dictionary(uniqueKeysWithValues: catalogue.map { ($0.key, $0) })

    /// The SF Symbols name of a key, or nil (none, or a key this app does not know).
    static func symbol(_ key: String?) -> String? {
        key.flatMap { byKey[$0]?.sf }
    }

    /// The meaning's name in the UI language (the picker's cells, VoiceOver).
    static func label(_ key: String, language: AppLanguage = UILanguage.shared.effective) -> String {
        guard let icon = byKey[key] else { return key }
        return icon.label[language.rawValue] ?? icon.label["ja"] ?? key
    }

    /// What a state's picture is: its icon, else its emoji, else nothing.
    enum Glyph: Equatable {
        case symbol(String)
        case emoji(String)
        case none
    }

    static func glyph(icon: String?, emoji: String?) -> Glyph {
        if let symbol = symbol(icon) { return .symbol(symbol) }
        if let emoji, !emoji.trimmingCharacters(in: .whitespaces).isEmpty { return .emoji(emoji) }
        return .none
    }

    static func glyph(_ state: AttendanceStateOut) -> Glyph { glyph(icon: state.icon, emoji: state.emoji) }

    /// The width of a symbol's box at `size`: the same for every symbol (wide enough for the widest, a little wider
    /// than tall), so switching between states never changes a badge's or the pill's width by its icon.
    static func boxWidth(_ size: CGFloat) -> CGFloat { (size * 1.2).rounded(.up) }
}

/// A state's picture (its icon, else its emoji — a custom one as its image —, else nothing). Decorative: the name is
/// always beside it or in a label.
struct AttendanceGlyph: View {
    let controller: AppController
    let icon: String?
    let emoji: String?
    var size: CGFloat = 16

    init(controller: AppController, state: AttendanceStateOut, size: CGFloat = 16) {
        self.controller = controller
        icon = state.icon
        emoji = state.emoji
        self.size = size
    }

    init(controller: AppController, icon: String?, emoji: String?, size: CGFloat = 16) {
        self.controller = controller
        self.icon = icon
        self.emoji = emoji
        self.size = size
    }

    var body: some View {
        switch AttendanceIcons.glyph(icon: icon, emoji: emoji) {
        case .symbol(let name):
            // A fixed box: the symbols differ in width, and a state switch with a name of the same length must not move
            // anything (the home header's pill, 2026-10-07).
            Image(systemName: name)
                .font(.system(size: size * 0.9, weight: .semibold))
                .frame(width: AttendanceIcons.boxWidth(size), height: size)
                .accessibilityHidden(true)
        case .emoji(let emoji):
            StatusGlyph(controller: controller, emoji: emoji, size: size)
                .font(.system(size: size * 0.9))
                .accessibilityHidden(true)
        case .none:
            EmptyView()
        }
    }
}

/// The quick switch (PRESENCE.md §7.1, §9.1): a small pill with my state (its icon, colour and name; 「在室状況」 with
/// an outline while I have none) in the home header beside the workspace's name and at the top of 「自分」. It opens a
/// sheet with my states as one-tap rows, the note and 「在室状況を開く」. Only while the board is on and I am no guest.
struct AttendancePill: View {
    @Bindable var controller: AppController
    /// Only the icon (a narrow header; the name stays for VoiceOver).
    var iconOnly = false
    let onOpenBoard: () -> Void
    @State private var sheetShown = false

    var body: some View {
        let state = AttendanceRules.myState(controller.store.attendance, controller.store.me?.id ?? controller.me?.id)
        Button { sheetShown = true } label: { AttendancePillFace(controller: controller, state: state, iconOnly: iconOnly) }
            .buttonStyle(.plain)
            .accessibilityLabel(AttendanceRules.pillAccessibilityLabel(state))
            .accessibilityHint("在室状況を変えます")
            .sheet(isPresented: $sheetShown) {
                AttendanceQuickSheet(controller: controller) {
                    sheetShown = false
                    onOpenBoard()
                }
            }
    }
}

/// The pill's look (also measured, whole, by the home header).
struct AttendancePillFace: View {
    let controller: AppController
    let state: AttendanceStateOut?
    var iconOnly = false

    var body: some View {
        HStack(spacing: 5) {
            if let state {
                if AttendanceIcons.glyph(state) == .none {
                    Circle().fill(AttendancePalette.onSolid).frame(width: 8, height: 8)
                } else {
                    AttendanceGlyph(controller: controller, state: state, size: 14)
                }
            } else {
                Image(systemName: "circle.dashed").font(.system(size: 13, weight: .semibold))
            }
            if !iconOnly {
                Text(state.map { AttendanceRules.pillText($0.label) } ?? tr("在室状況"))
                    .font(.footnote.weight(.semibold))
                    .lineLimit(1)
                    .contentTransition(.identity)
            }
        }
        .padding(.horizontal, iconOnly ? 0 : 10)
        .frame(minWidth: 28, minHeight: 28)
        .foregroundStyle(state == nil ? Color.secondary : AttendancePalette.onSolid)
        .background {
            if let state {
                Capsule().fill(AttendancePalette.solid(state.color))
            } else {
                Capsule().strokeBorder(Color(.separator), lineWidth: 1)
            }
        }
        .contentShape(Capsule())
        .fixedSize()
        // A switch redraws in place: no cross-fade nor size animation (it read as a jiggle in the header).
        .transaction { $0.animation = nil }
    }
}

/// The quick switch's sheet: my states (the workspace's, then mine) as rows — one tap changes my state and closes —,
/// the note (while I have a state) and 「在室状況を開く」.
struct AttendanceQuickSheet: View {
    @Bindable var controller: AppController
    let onOpenBoard: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var note = ""
    @State private var busy = false
    @FocusState private var noteFocused: Bool
    /// The sheet's height for its whole content (AttendanceRules.quickSheetHeight), measured once; nil until then.
    @State private var fitted: CGFloat?
    @State private var detent: PresentationDetent = .medium

    private var meId: String? { controller.store.me?.id ?? controller.me?.id }

    var body: some View {
        let board = controller.store.attendance
        let mine = AttendanceRules.entry(board, meId)
        NavigationStack {
            List {
                if let board {
                    Section {
                        ForEach(AttendanceRules.myChoices(board, me: meId)) { state in row(state, mine: mine) }
                    }
                    if let mine {
                        Section {
                            HStack(spacing: 8) {
                                TextField("メモ（例：〇〇室、15 時に戻ります）", text: $note)
                                    .focused($noteFocused)
                                    .submitLabel(.done)
                                    .onSubmit { saveNote(mine) }
                                    .onChange(of: note) { _, text in if text.count > 100 { note = String(text.prefix(100)) } }
                                Button("保存") { saveNote(mine) }
                                    .buttonStyle(.borderless)
                                    .disabled(busy || AttendanceRules.cleanNote(note) == mine.note.flatMap(AttendanceRules.cleanNote))
                            }
                        } header: {
                            Text("メモ")
                        }
                    }
                }
                Section {
                    Button("在室状況を開く", systemImage: "door.left.hand.open", action: onOpenBoard)
                }
            }
            .navigationTitle("在室状況を変える")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
            }
            .onAppear { note = mine?.note ?? "" }
            .onChange(of: board == nil) { _, off in if off { dismiss() } }  // turned off meanwhile
            .modifier(ContentHeightProbe { height in
                // Once, as the sheet opens (a later change would move it under the reader's finger), and only with the
                // board loaded (its rows are the content).
                guard fitted == nil, board != nil, height > 0 else { return }
                fitted = height
                detent = .height(height)
            })
        }
        // Tall enough for every row down to 「在室状況を開く」: at .medium it was under the edge with 4 states and the note
        // (2026-10-07). Taller than the screen (many states, large text, a small iPhone), the system keeps it to the
        // large detent and the rows scroll. iOS 17 (no scroll geometry) keeps medium / large.
        .presentationDetents(fitted.map { [.height($0), .large] } ?? [.medium, .large], selection: $detent)
    }

    private func row(_ state: AttendanceStateOut, mine: AttendanceEntryOut?) -> some View {
        let current = AttendanceRules.isSelected(state, mine: mine)
        return Button { choose(state) } label: {
            HStack(spacing: 12) {
                AttendanceGlyph(controller: controller, state: state, size: 17)
                    .foregroundStyle(AttendancePalette.onSolid)
                    .frame(width: 32, height: 32)
                    .background(AttendancePalette.solid(state.color), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                Text(state.label).fontWeight(current ? .semibold : .regular).lineLimit(1)
                if state.ownerId != nil { Text("自分用").font(.caption).foregroundStyle(.secondary) }
                Spacer(minLength: 0)
                if current { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Color.accentColor) }
            }
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .foregroundStyle(Color.primary)
        .disabled(busy)
        .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(state.ownerId == nil ? state.label : state.label + tr("（自分用）"))
        .accessibilityAddTraits(current ? [.isButton, .isSelected] : .isButton)
    }

    private func choose(_ state: AttendanceStateOut) {
        guard !busy else { return }
        busy = true
        Task {
            let ok = await controller.switchMyAttendance(to: state)
            busy = false
            if ok { dismiss() }
        }
    }

    private func saveNote(_ mine: AttendanceEntryOut) {
        guard !busy else { return }
        noteFocused = false
        busy = true
        Task {
            let ok = await controller.setMyAttendance(stateId: mine.stateId, note: AttendanceRules.cleanNote(note))
            busy = false
            if ok { dismiss() }
        }
    }
}

/// The height a sheet needs for its list's whole content (AttendanceRules.quickSheetHeight), from the list's scroll
/// geometry (iOS 18; nothing on iOS 17).
private struct ContentHeightProbe: ViewModifier {
    let measured: (CGFloat) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: CGFloat.self, of: { geometry in
                AttendanceRules.quickSheetHeight(contentHeight: geometry.contentSize.height,
                                                 topInset: geometry.contentInsets.top, bottomInset: geometry.contentInsets.bottom)
            }, action: { _, height in measured(height) })
        } else {
            content
        }
    }
}

/// The home header's title (PRESENCE.md §9.1): the workspace (WorkspaceTitle) and, while the board is on for me, the
/// pill right beside it. It never wraps nor pushes the name off: the whole pill while the row has room, else only its
/// icon (the name cut down to 4 characters at least), else no pill (the home tile still opens 在室状況).
struct HomeHeaderTitle: View {
    @Bindable var controller: AppController
    /// The title's room (pt; AttendanceRules.headerRoom): a principal toolbar item is sized to its content, so it
    /// cannot measure its own room.
    let room: CGFloat
    let onSwitch: () -> Void
    let onOpenBoard: () -> Void
    @State private var titleWidth: CGFloat = 0
    @State private var nameWidth: CGFloat = 0
    @State private var pillWidth: CGFloat = 0

    private static let nameFont: CGFloat = 17  // .headline

    var body: some View {
        if AttendanceRules.pillVisible(board: controller.store.attendance, role: controller.store.me?.role ?? controller.me?.role) {
            let mode = AttendanceRules.pillMode(room: room, nameNatural: titleWidth,
                                                nameMin: titleWidth - nameWidth + min(nameWidth, CGFloat(AttendanceRules.nameMinCharacters) * Self.nameFont),
                                                full: pillWidth)
            HStack(spacing: AttendanceRules.pillGap) {
                WorkspaceTitle(controller: controller, onSwitch: onSwitch)
                if mode != .hidden {
                    AttendancePill(controller: controller, iconOnly: mode == .icon, onOpenBoard: onOpenBoard)
                        .layoutPriority(1)
                }
            }
            .frame(maxWidth: room > 0 ? room : nil)
            .background {
                // The whole title and the whole pill, measured out of sight.
                ZStack {
                    WorkspaceTitle(controller: controller, onSwitch: {}).fixedSize()
                        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { titleWidth = $0 }
                    Text(controller.activeWorkspace?.name ?? controller.workspaceName).font(.headline).lineLimit(1).fixedSize()
                        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { nameWidth = $0 }
                    AttendancePillFace(controller: controller,
                                       state: AttendanceRules.myState(controller.store.attendance, controller.store.me?.id ?? controller.me?.id))
                        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { pillWidth = $0 }
                }
                .hidden()
                .accessibilityHidden(true)
            }
        } else {
            WorkspaceTitle(controller: controller, onSwitch: onSwitch)
        }
    }
}

/// The own-state form's icon picker: 「なし」 and the 16 icons with their meanings' names.
struct AttendanceIconPicker: View {
    @Binding var selection: String?
    let color: String

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 68), spacing: 6)], spacing: 6) {
            cell(nil, label: tr("なし")) { Image(systemName: "nosign").font(.system(size: 17)) }
            ForEach(AttendanceIcons.catalogue) { icon in
                cell(icon.key, label: AttendanceIcons.label(icon.key)) { Image(systemName: icon.sf).font(.system(size: 18, weight: .medium)) }
            }
        }
        .padding(.vertical, 4)
    }

    private func cell(_ key: String?, label: String, @ViewBuilder image: () -> some View) -> some View {
        let selected = selection == key
        return Button { selection = key } label: {
            VStack(spacing: 3) {
                image().frame(height: 24)
                Text(label).font(.caption2).lineLimit(1).minimumScaleFactor(0.7)
            }
            .frame(maxWidth: .infinity, minHeight: 56)
            .foregroundStyle(selected ? AttendancePalette.onSolid : Color.primary)
            .background(selected ? AttendancePalette.solid(color) : Color(.tertiarySystemFill),
                        in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// The own-state form's 8 colour swatches (the text emoji palette).
struct AttendanceColorSwatches: View {
    @Binding var selection: String

    var body: some View {
        HStack(spacing: 0) {
            ForEach(SectionLetterIcon.colors, id: \.key) { option in
                let selected = selection == option.key
                Button { selection = option.key } label: {
                    // The solid shade the badge will have; the chosen one has a ring around it and a white check.
                    Circle()
                        .fill(AttendancePalette.solid(option.key))
                        .frame(width: 26, height: 26)
                        .overlay {
                            if selected { Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(AttendancePalette.onSolid) }
                        }
                        .padding(3)
                        .overlay(Circle().strokeBorder(selected ? AttendancePalette.solid(option.key) : Color.clear, lineWidth: 2))
                        .frame(width: 34, height: 34)
                        .frame(maxWidth: .infinity, minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.name)
                .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
            }
        }
    }
}

extension AppController {
    /// The quick switch's tap: my state at once — the note kept when it is my current state, none for another one.
    /// True when the sheet may close.
    func switchMyAttendance(to state: AttendanceStateOut) async -> Bool {
        let mine = AttendanceRules.entry(store.attendance, store.me?.id ?? me?.id)
        return await setMyAttendance(stateId: state.id, note: AttendanceRules.noteForChoice(state, mine: mine))
    }
}
