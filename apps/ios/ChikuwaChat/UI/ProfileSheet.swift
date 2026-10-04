import SwiftUI

/// The profile card (M11d) behind an avatar or a name: display name, @username, title, custom status,
/// presence, and a way to message the person. M23: the lab roster line (「M1 · 指導教員: …」 and the research topic).
struct ProfileSheet: View {
    @Bindable var controller: AppController
    let userId: String
    /// Called with the DM channel id when the person taps 「メッセージを送る」.
    var onOpenDm: ((String) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var editingStatus = false
    @State private var confirmingBlock = false

    private var user: UserPublic? { controller.store.users[userId] }
    private var blocked: Bool { controller.store.isBlocked(userId) }
    private var isMe: Bool { controller.store.me?.id == userId }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        AvatarView(id: userId, name: user?.displayName ?? "?", size: 64, presence: controller.store.presenceOf(userId))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(user?.displayName ?? "?").font(.title3).bold()
                            if user?.role == "guest" { Text("ゲスト (参加したチャンネルだけ見えます)").font(.caption).foregroundStyle(.secondary) }
                            if user?.role == "bot" { Text(controller.isAiBot(userId) ? "AI のボット" : "受信 Webhook の bot").font(.caption).foregroundStyle(.secondary) }
                            Text("@\(user?.username ?? "")").font(.footnote).foregroundStyle(.secondary)
                            // The roster label is the title too (LAB.md 「肩書と名簿」): 「M2 · 研究室長」.
                            if let title = Roster.displayTitle(user?.title, controller.store.roster[userId]) { Text(title).font(.footnote).foregroundStyle(.secondary) }
                            Text(presenceLabel(controller.store.presenceOf(userId))).font(.caption).foregroundStyle(.secondary)
                            if DND.isActive(user) {
                                Text("🔕 通知を一時停止中" + (user?.quietHours.map { " · " + DND.label($0) } ?? "")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
                // The label is in the title line above; the roster block keeps the supervisor and the topic.
                if let line = controller.store.roster[userId], Roster.supervisorLabel(line, users: controller.store.users) != nil || !(line.researchTopic ?? "").isEmpty {
                    Section {
                        VStack(alignment: .leading, spacing: 3) {
                            if let supervisor = Roster.supervisorLabel(line, users: controller.store.users) {
                                Text(supervisor).font(.subheadline).fontWeight(.medium)
                            }
                            if let topic = line.researchTopic, !topic.isEmpty {
                                Text("研究テーマ: \(topic)").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
                if let status = activeStatus(user) {
                    Section("ステータス") {
                        HStack(spacing: 8) {
                            if !status.emoji.isEmpty { StatusGlyph(controller: controller, emoji: status.emoji, size: 20) }
                            Text(status.text)
                            Spacer()
                            if let label = expiryLabel(user?.statusExpiresAt) { Text(label).font(.caption).foregroundStyle(.secondary) }
                        }
                    }
                }
                if user?.deactivatedAt != nil { Section { Text("無効化されたアカウント").foregroundStyle(.secondary) } }
                Section {
                    if isMe {
                        Button("ステータスを設定", systemImage: "face.smiling") { editingStatus = true }
                    } else if user?.deactivatedAt == nil {
                        Button("メッセージを送る", systemImage: "bubble.left") {
                            Task {
                                if let id = await controller.openDmWith(userId) { dismiss(); onOpenDm?(id) }
                            }
                        }
                    }
                }
                // M104 (MODERATION.md §4): private; the person is not told.
                if !isMe, user != nil {
                    Section {
                        if blocked {
                            Button("ブロックを解除", systemImage: "hand.raised.slash") { Task { await controller.setUserBlocked(userId, on: false) } }
                        } else {
                            Button("ブロック", systemImage: "hand.raised", role: .destructive) { confirmingBlock = true }
                        }
                    } footer: {
                        Text(blocked ? "ブロック中: メッセージは折りたたまれ、通知されません。" : "ブロックすると、この人のメッセージは折りたたまれ、通知も届かず、この人から 1 対 1 の DM を受け取りません。相手には知らされません。")
                    }
                }
            }
            .navigationTitle("プロフィール")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
            .sheet(isPresented: $editingStatus) { StatusEditorView(controller: controller) }
            .confirmationDialog("\(user?.displayName ?? "") をブロックしますか？", isPresented: $confirmingBlock, titleVisibility: .visible) {
                Button("ブロック", role: .destructive) { Task { await controller.setUserBlocked(userId, on: true) } }
                Button("キャンセル", role: .cancel) {}
            }
        }
    }
}

/// "まで 15:30" / "9月30日まで".
func expiryLabel(_ iso: String?) -> String? {
    guard let iso, let date = parseIsoDate(iso) else { return nil }
    if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) + " まで" }
    return date.formatted(.dateTime.month().day()) + "まで"
}

/// Custom status editor (M11d): emoji + text + expiry, quick presets, clear. M40: the status only (the pause and the
/// quiet hours have their own rows on the 自分 tab); a screen on that tab's stack, a sheet from my profile card.
struct StatusEditorView: View {
    @Bindable var controller: AppController
    /// M40: pushed on the 自分 tab (the back button instead of キャンセル).
    var pushed = false
    @Environment(\.dismiss) private var dismiss
    @State private var emoji = ""
    @State private var text = ""
    @State private var expiry: Expiry = .never
    @State private var busy = false
    /// The emoji is chosen from the picker: a text field there only brought up the keyboard (testers, 2026-09-30).
    @State private var pickingEmoji = false

    enum Expiry: String, CaseIterable, Identifiable {
        case never, halfHour, hour, fourHours, today, week
        var id: String { rawValue }
        var label: String {
            switch self {
            case .never: "消さない"
            case .halfHour: "30 分後"
            case .hour: "1 時間後"
            case .fourHours: "4 時間後"
            case .today: "今日の終わり"
            case .week: "今週の終わり"
            }
        }
        func date(from now: Date = Date()) -> Date? {
            let calendar = Calendar.current
            switch self {
            case .never: return nil
            case .halfHour: return now.addingTimeInterval(30 * 60)
            case .hour: return now.addingTimeInterval(3600)
            case .fourHours: return now.addingTimeInterval(4 * 3600)
            case .today: return calendar.date(bySettingHour: 23, minute: 59, second: 59, of: now)
            case .week:
                let weekday = calendar.component(.weekday, from: now) // 1 = Sunday
                let toSunday = (8 - weekday) % 7
                let day = calendar.date(byAdding: .day, value: toSunday, to: now) ?? now
                return calendar.date(bySettingHour: 23, minute: 59, second: 59, of: day)
            }
        }
    }

    static let presets: [(emoji: String, text: String)] = [
        ("📅", "会議中"), ("🚌", "移動中"), ("🤒", "体調不良"), ("🌴", "休暇中"), ("🏠", "在宅勤務"), ("🍱", "昼休み"),
    ]

    private var current: (emoji: String, text: String)? {
        activeStatus(controller.store.me.map { controller.store.users[$0.id] ?? $0.asPublic })
    }

    private var isEmpty: Bool {
        emoji.trimmingCharacters(in: .whitespaces).isEmpty && text.trimmingCharacters(in: .whitespaces).isEmpty
    }

    var body: some View {
        if pushed {
            form
        } else {
            NavigationStack {
                form.toolbar { ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } } }
            }
        }
    }

    private var form: some View {
        Form {
            Section {
                HStack {
                    Button { pickingEmoji = true } label: {
                        Group {
                            if emoji.isEmpty {
                                Image(systemName: "face.smiling").font(.title2).foregroundStyle(.secondary)
                            } else {
                                SectionIcon(controller: controller, emoji: emoji, size: 26)
                            }
                        }
                        .frame(width: 44, height: 44)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(emoji.isEmpty ? "絵文字を選ぶ" : "絵文字を変更")
                    .contextMenu { if !emoji.isEmpty { Button("絵文字を外す", systemImage: "xmark.circle") { emoji = "" } } }
                    TextField("今なにしてる？", text: $text)
                }
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Self.presets, id: \.text) { preset in
                            Button("\(preset.emoji) \(preset.text)") { emoji = preset.emoji; text = preset.text }
                                .buttonStyle(.bordered).controlSize(.small)
                        }
                    }
                }
            }
            Section("消えるタイミング") {
                Picker("消えるタイミング", selection: $expiry) {
                    ForEach(Expiry.allCases) { Text($0.label).tag($0) }
                }
                .pickerStyle(.menu)
            }
            if current != nil {
                Section {
                    Button("ステータスをクリア", role: .destructive) {
                        Task { busy = true; if await controller.updateProfile(statusText: .some(nil), statusEmoji: .some(nil), statusExpiresAt: .some(nil)) { dismiss() }; busy = false }
                    }
                    .disabled(busy)
                }
            }
        }
        .navigationTitle("ステータスを更新")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $pickingEmoji) {
            let store = controller.store
            EmojiPickerView(custom: Array(store.customEmoji.values), images: store.emojiImages, animations: store.emojiAnimations,
                            onNeedImage: { controller.loadEmojiImage($0) }, packs: store.sortedEmojiPacks,
                            packTabs: store.packTabImages, onNeedPackTab: { controller.loadPackTab($0) }) { glyph in emoji = glyph }
        }
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") {
                    let iso = expiry.date().map { ISO8601DateFormatter().string(from: $0) }
                    Task {
                        busy = true
                        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        let e = emoji.trimmingCharacters(in: .whitespaces)
                        let ok = await controller.updateProfile(
                            statusText: .some(trimmed.isEmpty ? nil : trimmed),
                            statusEmoji: .some(e.isEmpty ? nil : e),
                            statusExpiresAt: .some(iso)
                        )
                        if ok { dismiss() }
                        busy = false
                    }
                }
                .disabled(busy || isEmpty)
            }
        }
        .onAppear {
            if let current { emoji = current.emoji; text = current.text }
        }
    }
}

/// The status emoji next to a name when the person has an active custom status.
struct StatusEmojiView: View {
    let user: UserPublic?
    let controller: AppController
    var body: some View {
        let emoji = activeStatus(user)?.emoji ?? ""
        let quiet = DND.isActive(user)
        if !emoji.isEmpty || quiet {
            HStack(spacing: 2) {
                if !emoji.isEmpty { StatusGlyph(controller: controller, emoji: emoji, size: 15) }
                if quiet { Text("🔕") }
            }
            .font(.caption)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([activeStatus(user)?.text, quiet ? "通知を一時停止中" : nil].compactMap { $0 }.joined(separator: " · "))
        }
    }
}

/// A status emoji. Picked from the emoji picker since build 40, it can be a custom one (`:name:`): drawn from its image
/// as on a reaction chip (2026-10-02: it showed as its text), its `:name:` until the image is here. A standard emoji, or
/// a custom one this workspace does not have, is text in the surrounding font.
struct StatusGlyph: View {
    let controller: AppController
    let emoji: String
    /// The custom emoji image's height.
    var size: CGFloat = 16

    /// The custom emoji `emoji` is, when it is one that exists.
    static func custom(_ emoji: String, in custom: [String: CustomEmojiOut]) -> CustomEmojiOut? {
        CustomEmoji.name(of: emoji.trimmingCharacters(in: .whitespaces)).flatMap { custom[$0] }
    }

    /// A line with a status in it (the DM header, the directory): custom emoji as their images, as in a message.
    static func text(_ line: String, controller: AppController, height: CGFloat) -> Text {
        CustomEmoji.text(line, custom: controller.store.customEmoji, images: controller.store.emojiImages,
                         onNeed: { controller.loadEmojiImage($0) }, height: height)
    }

    var body: some View {
        let store = controller.store
        if let custom = Self.custom(emoji, in: store.customEmoji) {
            if let image = store.emojiImages[custom.id] {
                EmojiImage(still: image, animation: store.emojiAnimations[custom.id]).frame(width: size, height: size)
            } else {
                Text(emoji).lineLimit(1).onAppear { controller.loadEmojiImage(custom) }
            }
        } else {
            Text(emoji)
        }
    }
}
