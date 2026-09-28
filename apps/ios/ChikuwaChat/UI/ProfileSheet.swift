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
                            if user?.role == "guest" { Text("ゲスト (参加したチャンネルだけ見えます)").font(.caption).foregroundStyle(.secondary) }
                            if user?.role == "bot" { Text("受信 Webhook の bot").font(.caption).foregroundStyle(.secondary) }
                            Text("@\(user?.username ?? "")").font(.footnote).foregroundStyle(.secondary)
                            if let title = user?.title, !title.isEmpty { Text(title).font(.footnote).foregroundStyle(.secondary) }
                            Text(presenceLabel(controller.store.presenceOf(userId))).font(.caption).foregroundStyle(.secondary)
                            if DND.isActive(user) {
                                Text("🔕 通知を一時停止中" + (user?.quietHours.map { " · " + DND.label($0) } ?? "")).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
                if let line = controller.store.roster[userId] {
                    Section {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(Roster.summary(line, users: controller.store.users)).font(.subheadline).fontWeight(.medium)
                            if let topic = line.researchTopic, !topic.isEmpty {
                                Text("研究テーマ: \(topic)").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
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
    // M12c: a pause applies at once; quiet hours are saved with the form.
    @State private var quietOn = false
    @State private var quietStart = Date()
    @State private var quietEnd = Date()
    @State private var quietDays: Set<Int> = Set(0..<7)
    @State private var quietLoaded = false

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

    private var meNow: UserPublic? { controller.store.me.map { controller.store.users[$0.id] ?? $0.asPublic } }
    private var pausedUntil: String? {
        guard let raw = meNow?.dndUntil, let until = parseIsoDate(raw), until > Date() else { return nil }
        return raw
    }
    private var quietDraft: QuietHours? {
        guard quietOn else { return nil }
        let calendar = Calendar.current
        let start = calendar.component(.hour, from: quietStart) * 60 + calendar.component(.minute, from: quietStart)
        let end = calendar.component(.hour, from: quietEnd) * 60 + calendar.component(.minute, from: quietEnd)
        return QuietHours(start: DND.hhmm(start), end: DND.hhmm(end), days: quietDays.sorted(), tz: TimeZone.current.identifier)
    }
    private var quietChanged: Bool {
        let existing = meNow?.quietHours
        if quietOn != (existing != nil) { return true }
        guard let draft = quietDraft, let existing else { return false }
        return draft.start != existing.start || draft.end != existing.end || Set(draft.days) != Set(existing.days) || draft.tz != existing.tz
    }
    private func loadQuiet() {
        guard !quietLoaded else { return }
        quietLoaded = true
        let calendar = Calendar.current
        if let hours = meNow?.quietHours {
            quietOn = true
            quietStart = calendar.date(bySettingHour: DND.minutes(hours.start) / 60, minute: DND.minutes(hours.start) % 60, second: 0, of: Date()) ?? Date()
            quietEnd = calendar.date(bySettingHour: DND.minutes(hours.end) / 60, minute: DND.minutes(hours.end) % 60, second: 0, of: Date()) ?? Date()
            quietDays = Set(hours.days.isEmpty ? Array(0..<7) : hours.days)
        } else {
            quietStart = calendar.date(bySettingHour: 22, minute: 0, second: 0, of: Date()) ?? Date()
            quietEnd = calendar.date(bySettingHour: 7, minute: 0, second: 0, of: Date()) ?? Date()
        }
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
                Section("通知を一時停止") {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(DND.Pause.allCases) { pause in
                                Button(pause.label) {
                                    Task { busy = true; _ = await controller.updateProfile(dndUntil: .some(ISO8601DateFormatter().string(from: pause.until()))); busy = false }
                                }
                                .buttonStyle(.bordered).controlSize(.small).disabled(busy)
                            }
                        }
                    }
                    if let pausedUntil {
                        Button("🔕 \(expiryLabel(pausedUntil) ?? "") · 解除") {
                            Task { busy = true; _ = await controller.updateProfile(dndUntil: .some(nil)); busy = false }
                        }
                        .disabled(busy)
                    }
                }
                Section("おやすみ時間") {
                    Toggle("毎日この時間帯は通知を止める", isOn: $quietOn)
                    if quietOn {
                        DatePicker("開始", selection: $quietStart, displayedComponents: .hourAndMinute)
                        DatePicker("終了", selection: $quietEnd, displayedComponents: .hourAndMinute)
                        HStack(spacing: 6) {
                            ForEach(0..<7, id: \.self) { day in
                                Button(DND.dayLabels[day]) {
                                    if quietDays.contains(day) { quietDays.remove(day) } else { quietDays.insert(day) }
                                }
                                .buttonStyle(.bordered).controlSize(.small)
                                .tint(quietDays.contains(day) ? .accentColor : .secondary)
                            }
                        }
                        Text("タイムゾーン: \(TimeZone.current.identifier)").font(.caption).foregroundStyle(.secondary)
                    }
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
                            let e = emoji.trimmingCharacters(in: .whitespaces)
                            let hasStatus = !trimmed.isEmpty || !e.isEmpty
                            let quiet: QuietHours?? = quietChanged ? .some(quietDraft) : nil
                            let ok = await controller.updateProfile(
                                statusText: hasStatus ? .some(trimmed.isEmpty ? nil : trimmed) : nil,
                                statusEmoji: hasStatus ? .some(e.isEmpty ? nil : e) : nil,
                                statusExpiresAt: hasStatus ? .some(iso) : nil,
                                quietHours: quiet
                            )
                            if ok { dismiss() }
                            busy = false
                        }
                    }
                    .disabled(busy || (emoji.trimmingCharacters(in: .whitespaces).isEmpty && text.trimmingCharacters(in: .whitespaces).isEmpty && !quietChanged))
                }
            }
            .onAppear {
                if let current { emoji = current.emoji; text = current.text }
                loadQuiet()
            }
        }
    }
}

/// The status emoji next to a name when the person has an active custom status.
struct StatusEmojiView: View {
    let user: UserPublic?
    var body: some View {
        let status = activeStatus(user)
        let quiet = DND.isActive(user)
        if (status != nil && !status!.emoji.isEmpty) || quiet {
            Text((status?.emoji ?? "") + (quiet ? "🔕" : "")).font(.caption)
                .accessibilityLabel([status?.text, quiet ? "通知を一時停止中" : nil].compactMap { $0 }.joined(separator: " · "))
        }
    }
}
