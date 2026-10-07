import SwiftUI

/// M140 (docs/PRESENCE.md §9): 「在室状況」 on the phone — my one-tap state buttons, a note, my own states (when the
/// administrator's rule allows them) and the board grouped by state. Settings and integrations are on Desktop / Web only.
struct AttendanceView: View {
    static let selectionId = "attendance"
    @Bindable var controller: AppController
    @State private var note = ""
    @FocusState private var noteFocused: Bool
    @State private var busy = false
    @State private var editing: OwnStateTarget?
    @State private var deleting: AttendanceStateOut?
    @State private var profileUserId: String?
    /// M143: the 操作ボタン on top (when the workspace shows them here).
    @State private var actionPresser = ActionPresser()
    @State private var actionStatusFeed = ActionStatusFeed()

    private var store: Store { controller.store }
    private var meId: String? { store.me?.id ?? controller.me?.id }

    var body: some View {
        Group {
            if let board = store.attendance, !controller.isGuest {
                content(board)
            } else {
                ContentUnavailableView("在室状況はオフになっています", systemImage: "door.left.hand.closed",
                                       description: Text("管理者が Desktop / Web で有効にできます"))
            }
        }
        .navigationTitle("在室状況")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let board = store.attendance, !controller.isGuest {
                ToolbarItem(placement: .topBarTrailing) {
                    Text("在室 \(AttendanceRules.inRoomCount(board, users: store.users.values)) 人")
                        .font(.subheadline).foregroundStyle(.secondary)
                }
            }
        }
        .refreshable { await controller.engine?.loadAttendance() }
        .task { await controller.engine?.loadAttendance() }
        .onChange(of: AttendanceRules.entry(store.attendance, meId)?.note, initial: true) { _, current in
            // Another device (or an outside system) changed my note: shown unless I am typing.
            if !noteFocused { note = current ?? "" }
        }
        .sheet(item: $editing) { target in
            OwnStateForm(controller: controller, state: target.state)
        }
        .sheet(item: Binding(get: { profileUserId.map { ProfileTarget(id: $0) } }, set: { profileUserId = $0?.id })) { target in
            ProfileSheet(controller: controller, userId: target.id) { id in
                NotificationCenter.default.post(name: .chikuwaOpenChannel, object: nil, userInfo: ["id": id])
            }
        }
        .alert("「\(deleting?.label ?? "")」を削除しますか？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
               presenting: deleting) { state in
            Button("キャンセル", role: .cancel) {}
            Button("削除", role: .destructive) { Task { await controller.deleteMyAttendanceState(state.id) } }
        } message: { _ in Text("今この状態の人はそのまま残ります。") }
    }

    private func content(_ board: AttendanceBoardOut) -> some View {
        let mine = AttendanceRules.entry(board, meId)
        let own = AttendanceRules.myOwnStates(board, me: meId)
        let actions = ActionRules.onAttendance(store.actions)
        return List {
            // M143 (docs/ACTIONS.md D17): the 操作ボタン first, when the workspace says so.
            if !actions.isEmpty {
                ActionButtonSections(controller: controller, actions: actions, presser: actionPresser, heading: actionsTitle, feed: actionStatusFeed)
            }
            Section {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 104), spacing: 8)], spacing: 8) {
                    ForEach(AttendanceRules.myChoices(board, me: meId)) { state in
                        stateButton(state, mine: mine)
                    }
                }
                .padding(.vertical, 4)
                if let mine {
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
                }
            } header: {
                Text("自分の状態")
            } footer: {
                if mine == nil { Text("まだ状態を選んでいません。上のボタンで選べます") }
            }

            if board.canPersonalize {
                Section {
                    if own.isEmpty {
                        Text("自分用の状態はまだありません（例：会議、出張）").font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(own) { state in
                        Button { editing = OwnStateTarget(state: state) } label: {
                            HStack(spacing: 8) {
                                AttendanceChip(controller: controller, state: state, large: true)
                                Spacer()
                                Text(AttendanceRules.kindLabel(state.kind)).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .foregroundStyle(Color.primary)
                        .accessibilityHint("編集します")
                        .swipeActions(edge: .trailing) {
                            Button("削除", role: .destructive) { deleting = state }
                        }
                        .contextMenu {
                            Button("編集", systemImage: "pencil") { editing = OwnStateTarget(state: state) }
                            Button("削除", systemImage: "trash", role: .destructive) { deleting = state }
                        }
                    }
                    Button("自分用の状態を追加", systemImage: "plus") { editing = OwnStateTarget(state: nil) }
                        .disabled(own.count >= 10)
                } header: {
                    Text("自分用の状態")
                }
            }

            ForEach(AttendanceRules.groups(board, users: store.users.values)) { group in
                Section {
                    ForEach(group.people, id: \.user.id) { person in personRow(person) }
                } header: {
                    HStack(spacing: 6) {
                        if let state = group.state {
                            AttendanceChip(controller: controller, state: state, large: true)
                        } else {
                            Text("未設定")
                        }
                        Text("\(group.people.count) 人").font(.caption).foregroundStyle(.secondary)
                    }
                    .textCase(nil)
                    .accessibilityElement(children: .combine)
                }
            }
        }
        .listStyle(.insetGrouped)
        .actionConfirmation(actionPresser, controller: controller)
        .actionStatusPolling(controller, feed: actionStatusFeed, active: !actions.isEmpty)
    }

    private func stateButton(_ state: AttendanceStateOut, mine: AttendanceEntryOut?) -> some View {
        let selected = AttendanceRules.isSelected(state, mine: mine)
        return Button {
            choose(state.id, note: AttendanceRules.noteForChoice(state, mine: mine))
        } label: {
            AttendanceStateButtonFace(controller: controller, state: state, selected: selected)
        }
        .buttonStyle(.plain)
        .disabled(busy)
        .accessibilityLabel(state.ownerId == nil ? state.label : state.label + tr("（自分用）"))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    private func personRow(_ person: AttendanceRules.Person) -> some View {
        let user = person.user
        return Button { profileUserId = user.id } label: {
            HStack(spacing: 10) {
                AvatarView(id: user.id, name: user.displayName, size: 32, presence: store.presenceOf(user.id))
                VStack(alignment: .leading, spacing: 1) {
                    Text(user.id == meId ? user.displayName + " " + tr("（自分）") : user.displayName).lineLimit(1)
                    if let entry = person.entry {
                        Text([entry.note, AttendanceRules.sinceLabel(entry.since)].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · "))
                            .font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                    }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func choose(_ stateId: String, note: String?) {
        guard !busy else { return }
        busy = true
        Task {
            _ = await controller.setMyAttendance(stateId: stateId, note: note)
            busy = false
        }
    }

    private func saveNote(_ mine: AttendanceEntryOut) {
        noteFocused = false
        choose(mine.stateId, note: AttendanceRules.cleanNote(note))
    }
}

/// A state button's face: selected, the solid badge (white icon and name on the state's shade); unselected, outlined,
/// only the icon in the state's colour.
struct AttendanceStateButtonFace: View {
    let controller: AppController
    let state: AttendanceStateOut
    let selected: Bool

    var body: some View {
        AttendanceStateLabel(controller: controller, state: state, glyphSize: 17, solid: selected)
            .font(.body.weight(selected ? .semibold : .regular))
            .frame(maxWidth: .infinity, minHeight: 48)
            .padding(.horizontal, 8)
            .background(selected ? AttendancePalette.solid(state.color) : Color(.secondarySystemGroupedBackground),
                        in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(selected ? Color.clear : Color(.separator), lineWidth: 1))
            .foregroundStyle(selected ? AttendancePalette.onSolid : Color.primary)
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// Which own state the form edits (nil = a new one).
struct OwnStateTarget: Identifiable {
    let state: AttendanceStateOut?
    var id: String { state?.id ?? "new" }
}

/// A state's picture (its icon, else its emoji — a custom one as its image) and name. `solid`: on the solid badge, the
/// icon and the name in white (`onSolid`); otherwise (an unselected button) the icon in the state's colour and the name in
/// the primary colour.
///
/// Both colours are set here, never left to inherit: `.foregroundStyle(.foreground)` on the icon resolved to the default
/// foreground (black in light) instead of the badge's white, so the chips' and the selected button's icons were black
/// while their names were white (2026-10-08).
struct AttendanceStateLabel: View {
    let controller: AppController
    let state: AttendanceStateOut
    var glyphSize: CGFloat = 16
    var solid = true

    var body: some View {
        HStack(spacing: glyphSize < 14 ? 3 : 5) {
            AttendanceGlyph(controller: controller, state: state, size: glyphSize)
                .foregroundStyle(solid ? AttendancePalette.onSolid : AttendancePalette.tint(state.color))
            Text(state.label).lineLimit(1)
                .foregroundStyle(solid ? AttendancePalette.onSolid : Color.primary)
        }
    }
}

/// The states' colours (PRESENCE.md §2.2). A badge is solid: the colour key's shade (apps/shared/attendance-badge-colors.json,
/// the same in light and dark) with white text and icon. `tint` is only for an icon on the page's background (an unselected
/// button): the shade in light, the text emoji palette's light foreground in dark (the shades are too dark there).
enum AttendancePalette {
    /// The copy of apps/shared/attendance-badge-colors.json (AttendanceBadgePaletteTests compares it and the contrast).
    static let badgeColors: [String: UInt32] = [
        "gray": 0x4B5563,
        "red": 0xDC2626,
        "orange": 0xC2410C,
        "yellow": 0xA16207,
        "green": 0x15803D,
        "blue": 0x2563EB,
        "purple": 0x7C3AED,
        "pink": 0xBE185D,
    ]
    static let badgeForeground: UInt32 = 0xFFFFFF

    /// A colour key's solid shade (an unknown key = gray).
    static func solidRGB(_ color: String) -> UInt32 { badgeColors[color] ?? badgeColors["gray"]! }

    static func solid(_ color: String) -> Color { Color(uiColor(solidRGB(color))) }

    /// The text and icon on a solid badge.
    static let onSolid = Color(uiColor(badgeForeground))

    static func tint(_ color: String) -> Color {
        let shade = solidRGB(color)
        let dark = (CustomEmoji.textPalette[color] ?? CustomEmoji.textPalette["gray"]!).dark.fg
        return Color(UIColor { traits in uiColor(traits.userInterfaceStyle == .dark ? dark : shade) })
    }

    /// WCAG 2.x contrast ratio of two 0xRRGGBB colours (1…21).
    static func contrast(_ a: UInt32, _ b: UInt32) -> Double {
        func linear(_ channel: UInt32) -> Double {
            let c = Double(channel & 0xFF) / 255
            return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4)
        }
        func luminance(_ rgb: UInt32) -> Double {
            let r: Double = linear(rgb >> 16)
            let g: Double = linear(rgb >> 8)
            let b: Double = linear(rgb)
            return 0.2126 * r + 0.7152 * g + 0.0722 * b
        }
        let (x, y) = (luminance(a), luminance(b))
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }

    private static func uiColor(_ rgb: UInt32) -> UIColor {
        UIColor(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }
}

/// The small 「在室状況」 chip (the profile card, member lists, the board's headings): the state's emoji and name in its
/// colour (AttendanceUserChip: a person's).
struct AttendanceChip: View {
    let controller: AppController
    let state: AttendanceStateOut
    var note: String? = nil
    var large = false

    var body: some View {
        AttendanceStateLabel(controller: controller, state: state, glyphSize: large ? 14 : 11)
            .font(large ? .subheadline.weight(.semibold) : .caption2.weight(.medium))
            .padding(.horizontal, large ? 8 : 5)
            .padding(.vertical, large ? 3 : 1.5)
            .foregroundStyle(AttendancePalette.onSolid)
            .background(AttendancePalette.solid(state.color), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            .fixedSize()
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(tr("在室状況：") + AttendanceRules.stateText(state) + (note.map { " · " + $0 } ?? ""))
    }
}

/// The chip of one person (nothing while the board is off, for a guest, or when the person has no state).
struct AttendanceUserChip: View {
    let controller: AppController
    let userId: String

    var body: some View {
        if !controller.isGuest, let chip = AttendanceRules.chip(controller.store.attendance, userId) {
            AttendanceChip(controller: controller, state: chip.state, note: chip.entry.note)
        }
    }
}

/// My own state: name, emoji, colour, kind (POST / PATCH /attendance/my-states).
struct OwnStateForm: View {
    @Bindable var controller: AppController
    let state: AttendanceStateOut?
    @Environment(\.dismiss) private var dismiss
    @State private var label = ""
    @State private var emoji = ""
    @State private var color = "gray"
    @State private var kind = "on_site"
    /// nil = not picked yet (a new state follows its kind's default icon); `.some(nil)` = 「なし」.
    @State private var pickedIcon: String?? = nil
    @State private var busy = false

    private var icon: String? { AttendanceRules.formIcon(picked: pickedIcon, kind: kind) }

    /// The badge as it will look.
    private var preview: AttendanceStateOut {
        let name = label.trimmingCharacters(in: .whitespaces)
        let trimmedEmoji = emoji.trimmingCharacters(in: .whitespaces)
        return AttendanceStateOut(id: "preview", ownerId: nil, label: name.isEmpty ? tr("例：会議") : name, emoji: trimmedEmoji.isEmpty ? nil : trimmedEmoji,
                                  icon: icon, color: color, kind: kind, position: 0)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        Spacer()
                        AttendanceChip(controller: controller, state: preview, large: true)
                        Spacer()
                    }
                    .padding(.vertical, 4)
                } header: { Text("見た目") }
                Section {
                    TextField("例：会議", text: $label)
                        .onChange(of: label) { _, text in if text.count > 40 { label = String(text.prefix(40)) } }
                } header: { Text("名前") }
                Section {
                    AttendanceIconPicker(selection: Binding(get: { icon }, set: { pickedIcon = .some($0) }), color: color)
                } header: { Text("アイコン") }
                Section {
                    AttendanceColorSwatches(selection: $color)
                } header: { Text("色") }
                Section {
                    TextField("🗣️", text: $emoji)
                        .onChange(of: emoji) { _, text in if text.count > 32 { emoji = String(text.prefix(32)) } }
                } header: {
                    Text("絵文字（なくても可）")
                } footer: {
                    Text("絵文字はアイコンを表示できない古いアプリでの代わりです")
                }
                Section {
                    Picker("分類", selection: $kind) {
                        ForEach(AttendanceRules.kinds, id: \.self) { kind in Text(AttendanceRules.kindLabel(kind)).tag(kind) }
                    }
                } footer: {
                    Text("分類はボードの並びと「在室 n 人」の数え方に使います")
                }
            }
            .navigationTitle(state == nil ? "自分用の状態を追加" : "自分用の状態を編集")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(state == nil ? "追加" : "保存") { save() }
                        .disabled(busy || label.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
            .onAppear {
                guard let state else { return }
                label = state.label
                emoji = state.emoji ?? ""
                color = state.color
                kind = state.kind
                pickedIcon = .some(state.icon)
            }
        }
    }

    private func save() {
        let trimmedEmoji = emoji.trimmingCharacters(in: .whitespaces)
        let form = AttendanceStateForm(label: label.trimmingCharacters(in: .whitespaces), icon: icon, emoji: trimmedEmoji.isEmpty ? nil : trimmedEmoji,
                                       color: color, kind: kind)
        busy = true
        Task {
            if await controller.saveMyAttendanceState(id: state?.id, form) { dismiss() }
            busy = false
        }
    }
}

/// M140: my state and my own states (errors go to the banner).
extension AppController {
    /// My state and note; the answer is my row on the board at once (the event follows).
    @discardableResult
    func setMyAttendance(stateId: String, note: String?) async -> Bool {
        guard let api else { return false }
        do {
            let entry = try await api.setMyAttendance(stateId: stateId, note: note)
            if !store.applyAttendanceEntry(entry) { await engine?.loadAttendance() }
            return true
        } catch {
            self.error = describe(error)
            return false
        }
    }

    /// Adds (`id` nil) or changes one of my own states, then reads the board again (the buttons and the board).
    func saveMyAttendanceState(id: String?, _ form: AttendanceStateForm) async -> Bool {
        guard let api else { return false }
        do {
            if let id { _ = try await api.updateMyAttendanceState(id: id, form) } else { _ = try await api.createMyAttendanceState(form) }
            await engine?.loadAttendance()
            return true
        } catch {
            self.error = describe(error)
            return false
        }
    }

    /// Deletes one of my own states (kept as archived while it is my current state).
    func deleteMyAttendanceState(_ id: String) async {
        guard let api else { return }
        do {
            try await api.deleteMyAttendanceState(id: id)
            await engine?.loadAttendance()
        } catch {
            self.error = describe(error)
        }
    }
}
