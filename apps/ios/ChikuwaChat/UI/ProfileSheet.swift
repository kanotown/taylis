import SwiftUI

/// The profile card (M11d) behind an avatar or a name: display name, @username, title, custom status,
/// presence, and a way to message the person.
struct ProfileSheet: View {
    @Bindable var controller: AppController
    let userId: String
    /// Called with the DM channel id when the person taps 「メッセージを送る」.
    var onOpenDm: ((String) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var editingStatus = false

    private var user: UserPublic? { controller.store.users[userId] }
    private var isMe: Bool { controller.store.me?.id == userId }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 14) {
                        AvatarView(id: userId, name: user?.displayName ?? "?", size: 64, presence: controller.store.presenceOf(userId))
                        VStack(alignment: .leading, spacing: 3) {
                            Text(user?.displayName ?? "?").font(.title3).bold()
                            Text("@\(user?.username ?? "")").font(.footnote).foregroundStyle(.secondary)
                            if let title = user?.title, !title.isEmpty { Text(title).font(.footnote).foregroundStyle(.secondary) }
                            Text(presenceLabel(controller.store.presenceOf(userId))).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
                if let status = activeStatus(user) {
                    Section("ステータス") {
                        HStack(spacing: 8) {
                            if !status.emoji.isEmpty { Text(status.emoji) }
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
            }
            .navigationTitle("プロフィール")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
            .sheet(isPresented: $editingStatus) { StatusEditorView(controller: controller) }
        }
    }
}

/// "まで 15:30" / "9月30日まで".
func expiryLabel(_ iso: String?) -> String? {
    guard let iso, let date = parseIsoDate(iso) else { return nil }
    if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) + " まで" }
    return date.formatted(.dateTime.month().day()) + "まで"
}

/// Custom status editor (M11d): emoji + text + expiry, quick presets, clear.
struct StatusEditorView: View {
    @Bindable var controller: AppController
    @Environment(\.dismiss) private var dismiss
    @State private var emoji = ""
    @State private var text = ""
    @State private var expiry: Expiry = .never
    @State private var busy = false

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

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        TextField("絵文字", text: $emoji).frame(width: 56).multilineTextAlignment(.center)
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
                    }
                }
            }
            .navigationTitle("ステータスを設定")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        let iso = expiry.date().map { ISO8601DateFormatter().string(from: $0) }
                        Task {
                            busy = true
                            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                            let e = emoji.trimmingCharacters(in: .whitespacesAndNewlines)
                            if await controller.updateProfile(statusText: .some(trimmed.isEmpty ? nil : trimmed), statusEmoji: .some(e.isEmpty ? nil : e), statusExpiresAt: .some(iso)) { dismiss() }
                            busy = false
                        }
                    }
                    .disabled(busy || (emoji.trimmingCharacters(in: .whitespaces).isEmpty && text.trimmingCharacters(in: .whitespaces).isEmpty))
                }
            }
            .onAppear {
                if let current { emoji = current.emoji; text = current.text }
            }
        }
    }
}

/// The status emoji next to a name when the person has an active custom status.
struct StatusEmojiView: View {
    let user: UserPublic?
    var body: some View {
        if let status = activeStatus(user), !status.emoji.isEmpty {
            Text(status.emoji).font(.caption).accessibilityLabel(status.text)
        }
    }
}
