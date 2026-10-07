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
        return List {
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
                                AttendanceStateLabel(controller: controller, state: state)
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
    }

    private func stateButton(_ state: AttendanceStateOut, mine: AttendanceEntryOut?) -> some View {
        let selected = AttendanceRules.isSelected(state, mine: mine)
        return Button {
            choose(state.id, note: AttendanceRules.noteForChoice(state, mine: mine))
        } label: {
            AttendanceStateLabel(controller: controller, state: state)
                .font(.body.weight(selected ? .semibold : .regular))
                .frame(maxWidth: .infinity, minHeight: 48)
                .padding(.horizontal, 8)
                .background(AttendancePalette.background(state.color, selected: selected), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(selected ? AttendancePalette.foreground(state.color) : Color(.separator), lineWidth: selected ? 2 : 1))
                .foregroundStyle(selected ? AttendancePalette.foreground(state.color) : Color.primary)
                .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
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

/// Which own state the form edits (nil = a new one).
struct OwnStateTarget: Identifiable {
    let state: AttendanceStateOut?
    var id: String { state?.id ?? "new" }
}

/// A state's emoji (a custom one as its image) and name.
struct AttendanceStateLabel: View {
    let controller: AppController
    let state: AttendanceStateOut

    var body: some View {
        HStack(spacing: 4) {
            if let emoji = state.emoji, !emoji.isEmpty { StatusGlyph(controller: controller, emoji: emoji, size: 16) }
            Text(state.label).lineLimit(1)
        }
    }
}

/// The text emoji palette's colours (apps/shared/text-emoji.json, CustomEmoji.textPalette), light and dark.
enum AttendancePalette {
    static func background(_ color: String, selected: Bool) -> Color {
        selected ? pair(color, \.bg) : Color(.secondarySystemGroupedBackground)
    }

    static func chipBackground(_ color: String) -> Color { pair(color, \.bg) }

    static func foreground(_ color: String) -> Color { pair(color, \.fg) }

    private static func pair(_ color: String, _ part: KeyPath<(bg: UInt32, fg: UInt32), UInt32>) -> Color {
        let colors = CustomEmoji.textPalette[color] ?? CustomEmoji.textPalette["gray"]!
        return Color(UIColor { traits in
            let rgb = (traits.userInterfaceStyle == .dark ? colors.dark : colors.light)[keyPath: part]
            return UIColor(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255, blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
        })
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
        AttendanceStateLabel(controller: controller, state: state)
            .font(large ? .subheadline.weight(.semibold) : .caption2.weight(.medium))
            .padding(.horizontal, large ? 7 : 5)
            .padding(.vertical, large ? 2 : 1)
            .foregroundStyle(AttendancePalette.foreground(state.color))
            .background(AttendancePalette.chipBackground(state.color), in: RoundedRectangle(cornerRadius: 5, style: .continuous))
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
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("例：会議", text: $label)
                        .onChange(of: label) { _, text in if text.count > 40 { label = String(text.prefix(40)) } }
                } header: { Text("名前") }
                Section {
                    TextField("🗣️", text: $emoji)
                        .onChange(of: emoji) { _, text in if text.count > 32 { emoji = String(text.prefix(32)) } }
                } header: { Text("絵文字（なくても可）") }
                Section {
                    Picker("色", selection: $color) {
                        ForEach(SectionLetterIcon.colors, id: \.key) { option in
                            HStack {
                                Circle().fill(AttendancePalette.chipBackground(option.key)).frame(width: 14, height: 14)
                                    .overlay(Circle().strokeBorder(AttendancePalette.foreground(option.key), lineWidth: 1))
                                Text(option.name)
                            }
                            .tag(option.key)
                        }
                    }
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
            }
        }
    }

    private func save() {
        let trimmedEmoji = emoji.trimmingCharacters(in: .whitespaces)
        let form = AttendanceStateForm(label: label.trimmingCharacters(in: .whitespaces), emoji: trimmedEmoji.isEmpty ? nil : trimmedEmoji,
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
