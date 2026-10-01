import PhotosUI
import SwiftUI
import UserNotifications

/// The screens under the 自分 tab (M40, MOBILE_UI.md §6.5).
enum YouRoute: Hashable {
    case status, pause, quietHours, notifications, appearance, profile, account, password, workspaces, admin
}

/// M40: the 自分 tab as one list of rows that open screens — who I am, my status, the pause and the quiet hours at the
/// top, then 通知 / 表示 / プロフィールを編集 / アカウント / ワークスペース, and ログアウト at the end. The same screens
/// in a sheet (with 閉じる) where the settings are not a tab.
struct YouView: View {
    @Bindable var controller: AppController
    @Binding var path: [YouRoute]
    /// A sheet's 閉じる; nil on the tab.
    var onClose: (() -> Void)? = nil
    @AppStorage(AppTheme.storageKey) private var theme: AppTheme = .system
    @State private var confirmLogout = false

    private var me: UserMe? { controller.store.me ?? controller.me }
    private var mePublic: UserPublic? { me.map { controller.store.users[$0.id] ?? $0.asPublic } }
    private var logoutTitle: String {
        controller.workspaces.count > 1 ? "\(controller.workspaceName) からログアウト" : "ログアウト"
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if let me {
                    Section {
                        header(me)
                        NavigationLink(value: YouRoute.status) { statusRow }
                    }
                }
                Section {
                    NavigationLink(value: YouRoute.pause) {
                        YouRow(title: "通知を一時停止", symbol: "bell.slash", value: DND.pauseSummary(mePublic?.dndUntil))
                    }
                    NavigationLink(value: YouRoute.quietHours) {
                        YouRow(title: "おやすみ時間", symbol: "moon", value: DND.quietSummary(mePublic?.quietHours))
                    }
                }
                Section {
                    NavigationLink(value: YouRoute.notifications) { YouRow(title: "通知", symbol: "bell") }
                    NavigationLink(value: YouRoute.appearance) { YouRow(title: "表示", symbol: "circle.lefthalf.filled", value: theme.label) }
                    NavigationLink(value: YouRoute.profile) { YouRow(title: "プロフィールを編集", symbol: "person.crop.circle") }
                    NavigationLink(value: YouRoute.account) { YouRow(title: "アカウント", symbol: "lock") }
                    NavigationLink(value: YouRoute.workspaces) { YouRow(title: "ワークスペース", symbol: "square.stack", value: controller.workspaceName) }
                    if controller.store.me?.role == "admin" {
                        NavigationLink(value: YouRoute.admin) { YouRow(title: "管理", symbol: "shield") }
                    }
                }
                Section {
                    Button(logoutTitle, role: .destructive) { confirmLogout = true }
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .navigationTitle(onClose == nil ? "自分" : "設定")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let onClose { ToolbarItem(placement: .confirmationAction) { Button("閉じる", action: onClose) } }
            }
            .navigationDestination(for: YouRoute.self) { route in destination(route) }
            .alert("ログアウトしますか？", isPresented: $confirmLogout) {
                Button("キャンセル", role: .cancel) {}
                Button("ログアウト", role: .destructive) { Task { await controller.logout() } }
            } message: {
                Text("この端末に保存した \(controller.workspaceName) のメッセージと下書きを消します。サーバ上のデータは消えません。")
            }
        }
    }

    private func header(_ me: UserMe) -> some View {
        let user = mePublic
        let subtitle = "@\(me.username)" + ((user?.title ?? me.title).flatMap { $0.isEmpty ? nil : " · \($0)" } ?? "")
        return HStack(spacing: 14) {
            AvatarView(id: me.id, name: me.displayName, size: 64, presence: controller.store.presenceOf(me.id))
            VStack(alignment: .leading, spacing: 3) {
                Text(me.displayName).font(.title3.bold()).lineLimit(2)
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    /// 「ステータスを更新」, showing the status I have.
    private var statusRow: some View {
        let status = activeStatus(mePublic)
        return HStack(spacing: 12) {
            if let status, !status.emoji.isEmpty {
                Text(status.emoji).font(.title3).frame(width: 28)
            } else {
                Image(systemName: "face.smiling").font(.title3).foregroundStyle(Color.accentColor).frame(width: 28)
            }
            VStack(alignment: .leading, spacing: 2) {
                if let status, !status.text.isEmpty {
                    Text(status.text)
                    if let label = expiryLabel(mePublic?.statusExpiresAt) { Text(label).font(.caption).foregroundStyle(.secondary) }
                } else {
                    Text("ステータスを更新").foregroundStyle(status == nil ? .secondary : .primary)
                }
            }
        }
        .accessibilityLabel(status.map { "ステータス: \($0.emoji) \($0.text)" } ?? "ステータスを更新")
    }

    @ViewBuilder
    private func destination(_ route: YouRoute) -> some View {
        switch route {
        case .status: StatusEditorView(controller: controller, pushed: true)
        case .pause: PauseNotificationsView(controller: controller)
        case .quietHours: QuietHoursView(controller: controller)
        case .notifications: NotificationSettingsView(controller: controller)
        case .appearance: AppearanceView(controller: controller)
        case .profile: ProfileEditView(controller: controller)
        case .account: AccountView(controller: controller)
        case .password: PasswordChangeView(controller: controller)
        case .workspaces:
            WorkspaceListView(controller: controller) { onClose?() }
                .navigationTitle("ワークスペース")
                .navigationBarTitleDisplayMode(.inline)
        case .admin:
            AdminInfoView(serverUrl: controller.activeServerUrl)
        }
    }
}

/// A row of the 自分 list: icon, title, and the current value on the right.
struct YouRow: View {
    let title: String
    let symbol: String
    var value: String? = nil

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).foregroundStyle(Color.accentColor).frame(width: 28)
            Text(title)
            Spacer(minLength: 8)
            if let value { Text(value).foregroundStyle(.secondary).lineLimit(1) }
        }
    }
}

// MARK: - 通知を一時停止

/// 30 分 / 1 時間 / 2 時間 / 明日 8:00 / 日時を指定, and 再開 while paused (`dnd_until`). A choice applies at once.
struct PauseNotificationsView: View {
    @Bindable var controller: AppController
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var picking = false
    @State private var custom = Date().addingTimeInterval(3600)

    private var dndUntil: String? {
        guard let me = controller.store.me else { return nil }
        return (controller.store.users[me.id] ?? me.asPublic).dndUntil
    }
    private var paused: Bool { DND.paused(dndUntil) }

    var body: some View {
        Form {
            Section {
                LabeledContent("今の状態", value: paused ? "\(DND.pauseSummary(dndUntil))止めています" : "オフ")
            } footer: {
                Text("止めている間はプッシュ通知が届きません。メッセージと未読はそのまま届きます。")
            }
            Section("止める時間") {
                ForEach(DND.Pause.allCases) { pause in
                    Button(pause.label) { apply(.preset(pause)) }.disabled(busy)
                }
                Button("日時を指定") { withAnimation { picking.toggle() } }.disabled(busy)
                if picking {
                    DatePicker("終わり", selection: $custom, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    Button("この日時まで止める") { apply(.custom(custom)) }.disabled(busy || custom <= Date())
                }
            }
            if paused {
                Section {
                    Button("通知を再開") { apply(.resume) }.disabled(busy)
                }
            }
        }
        .navigationTitle("通知を一時停止")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func apply(_ choice: DND.PauseChoice) {
        Task {
            busy = true
            if await controller.updateProfile(dndUntil: .some(DND.dndUntil(choice))) { dismiss() }
            busy = false
        }
    }
}

// MARK: - おやすみ時間

/// The daily quiet hours (M12c): on or off, start, end, days, in this device's time zone; saved with 保存.
struct QuietHoursView: View {
    @Bindable var controller: AppController
    @Environment(\.dismiss) private var dismiss
    @State private var on = false
    @State private var start = Date()
    @State private var end = Date()
    @State private var days: Set<Int> = Set(0..<7)
    @State private var loaded = false
    @State private var busy = false

    private var existing: QuietHours? {
        guard let me = controller.store.me else { return nil }
        return (controller.store.users[me.id] ?? me.asPublic).quietHours
    }
    private var draft: QuietHours? {
        guard on else { return nil }
        let calendar = Calendar.current
        let from = calendar.component(.hour, from: start) * 60 + calendar.component(.minute, from: start)
        let to = calendar.component(.hour, from: end) * 60 + calendar.component(.minute, from: end)
        return QuietHours(start: DND.hhmm(from), end: DND.hhmm(to), days: days.sorted(), tz: TimeZone.current.identifier)
    }
    private var changed: Bool {
        if on != (existing != nil) { return true }
        guard let draft, let existing else { return false }
        return draft.start != existing.start || draft.end != existing.end || Set(draft.days) != Set(existing.days) || draft.tz != existing.tz
    }

    var body: some View {
        Form {
            Section {
                Toggle("おやすみ時間", isOn: $on)
            } footer: {
                Text("毎日この時間帯は通知を止めます。日付をまたぐ時間帯は、始まる日の曜日で数えます。")
            }
            if on {
                Section {
                    DatePicker("開始", selection: $start, displayedComponents: .hourAndMinute)
                    DatePicker("終了", selection: $end, displayedComponents: .hourAndMinute)
                }
                Section {
                    HStack(spacing: 6) {
                        ForEach(0..<7, id: \.self) { day in
                            Button(DND.dayLabels[day]) {
                                if days.contains(day) { days.remove(day) } else { days.insert(day) }
                            }
                            .buttonStyle(.bordered).controlSize(.small)
                            .tint(days.contains(day) ? .accentColor : .secondary)
                            .accessibilityAddTraits(days.contains(day) ? .isSelected : [])
                        }
                    }
                } header: {
                    Text("曜日")
                } footer: {
                    Text("タイムゾーン: \(TimeZone.current.identifier)")
                }
            }
        }
        .navigationTitle("おやすみ時間")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") {
                    Task {
                        busy = true
                        if await controller.updateProfile(quietHours: .some(draft)) { dismiss() }
                        busy = false
                    }
                }
                .disabled(busy || !changed || (on && days.isEmpty))
            }
        }
        .onAppear(perform: load)
    }

    private func load() {
        guard !loaded else { return }
        loaded = true
        let calendar = Calendar.current
        func time(_ minutes: Int) -> Date { calendar.date(bySettingHour: minutes / 60, minute: minutes % 60, second: 0, of: Date()) ?? Date() }
        if let hours = existing {
            on = true
            start = time(DND.minutes(hours.start))
            end = time(DND.minutes(hours.end))
            days = Set(hours.days.isEmpty ? Array(0..<7) : hours.days)
        } else {
            start = time(22 * 60)
            end = time(7 * 60)
        }
    }
}

// MARK: - 通知

/// What notifies me (M35), reaction banners (M39), keywords (M12g), and whether iOS lets this app notify at all.
struct NotificationSettingsView: View {
    @Bindable var controller: AppController
    @Environment(\.scenePhase) private var scenePhase
    @State private var keywords = ""
    @State private var saved = false
    @State private var busy = false
    @State private var permission: UNAuthorizationStatus?

    private var me: UserMe? { controller.store.me ?? controller.me }
    private var parsedKeywords: [String] {
        Array(keywords.split(whereSeparator: { $0 == "," || $0 == "、" || $0 == "\n" }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.prefix(20))
    }
    private var keywordsChanged: Bool { parsedKeywords != (me?.notifyKeywords ?? []) }

    var body: some View {
        Form {
            // M35: what conversations without a level of their own notify me of (pushes only, not unread).
            Section {
                Picker("通知するもの", selection: Binding(get: { me?.overallNotification ?? "mentions" }, set: { value in
                    Task { _ = await controller.updateProfile(notificationDefault: value) }
                })) {
                    Text(NotificationRules.overallLabel("all")).tag("all")
                    Text(NotificationRules.overallLabel("mentions")).tag("mentions")
                    Text(NotificationRules.overallLabel("none")).tag("none")
                }
            } footer: {
                Text("チャンネルごとの設定が優先されます。DM は「なし」以外なら常に通知されます。")
            }
            // M39: reactions to my messages as banners; a server before M39 has no such setting.
            if let notifyReactions = me?.notifyReactions {
                Section {
                    Toggle("リアクションのバナー", isOn: Binding(get: { notifyReactions }, set: { on in
                        Task { _ = await controller.updateProfile(notifyReactions: on) }
                    }))
                } footer: {
                    Text("オフでもアクティビティに表示されます")
                }
            }
            // M56 (TASKS.md §5): task assignments and due dates; a server before M55 has no tasks.
            if let notifyTasks = me?.notifyTasks {
                Section {
                    Toggle("タスク (割り当て・期限)", isOn: Binding(get: { notifyTasks }, set: { on in
                        Task { _ = await controller.updateProfile(notifyTasks: on) }
                    }))
                } footer: {
                    Text("担当に加えられたときと、担当のタスクの期限の日の朝 8 時に通知します")
                }
            }
            // M12g: words that notify me like a mention, edited as a comma-separated line.
            Section {
                TextField("例: リリース, 締切", text: $keywords, axis: .vertical)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .onChange(of: keywords) { _, _ in saved = false }
                HStack {
                    Button("キーワードを保存") {
                        Task {
                            busy = true
                            saved = await controller.updateProfile(notifyKeywords: parsedKeywords)
                            busy = false
                        }
                    }
                    .disabled(busy || !keywordsChanged)
                    if saved { Spacer(); Text("保存しました").font(.footnote).foregroundStyle(.secondary) }
                }
            } header: {
                Text("通知キーワード")
            } footer: {
                Text("コンマ区切りで 20 個まで。含むメッセージはメンションと同じように通知されます。")
            }
            Section {
                LabeledContent("この端末の通知", value: permissionLabel)
                if permission == .notDetermined {
                    Button("通知を許可する") {
                        PushCenter.shared.requestAuthorizationAndRegister()
                        Task { try? await Task.sleep(for: .seconds(1)); await refreshPermission() }
                    }
                } else {
                    Button("設定アプリで変更") {
                        if let url = URL(string: UIApplication.openNotificationSettingsURLString) { UIApplication.shared.open(url) }
                    }
                }
            } header: {
                Text("端末")
            } footer: {
                if permission == .denied {
                    Text("この端末では通知がオフになっています。届くようにするには、設定アプリで通知を許可してください。")
                }
            }
        }
        .navigationTitle("通知")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { keywords = (me?.notifyKeywords ?? []).joined(separator: ", ") }
        .task { await refreshPermission() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { Task { await refreshPermission() } } // back from the Settings app
        }
    }

    private var permissionLabel: String {
        guard let permission else { return "確認中…" }
        switch permission {
        case .authorized: return "許可されています"
        case .provisional: return "目立たない形で許可されています"
        case .ephemeral: return "一時的に許可されています"
        case .denied: return "オフになっています"
        case .notDetermined: return "まだ選んでいません"
        @unknown default: return "不明"
        }
    }

    private func refreshPermission() async {
        permission = await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }
}

// MARK: - 表示

/// 端末に合わせる / ライト / ダーク, on this device only; the whole app follows it (RootView). M50: the long-press quick
/// reactions, for all my devices.
struct AppearanceView: View {
    @Bindable var controller: AppController
    @AppStorage(AppTheme.storageKey) private var theme: AppTheme = .system
    @AppStorage(Timeline.groupingKey) private var grouping = false
    @AppStorage(EmojiUsage.recentKey) private var recentRaw = ""
    /// The slot whose emoji the picker is choosing.
    @State private var slot: Int?

    private var me: UserMe? { controller.store.me ?? controller.me }
    /// What the long-press sheet shows now: my choice, or the recent-first rule's six.
    private var quickRow: [String] { QuickReactions.row(chosen: me?.quickReactions.chosen, recent: recentRaw) }

    var body: some View {
        Form {
            // M50: a server before M50 leaves `quick_reactions` out of UserMe; it could not keep the choice, so no section.
            themeAndMessages
            if let setting = me?.quickReactions, setting.isSupported { quickReactionsSection(setting) }
        }
        .navigationTitle("表示")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: Binding(get: { slot != nil }, set: { if !$0 { slot = nil } })) {
            // Standard emoji only (no custom list; 「よく使う」 then leaves custom ones out), and choosing is not using.
            EmojiPickerView(countsUse: false) { glyph in
                guard let index = slot, CustomEmoji.name(of: glyph) == nil else { return }
                let row = QuickReactions.replacing(quickRow, slot: index, with: glyph)
                Task { _ = await controller.setQuickReactions(row) }
            }
        }
    }

    private func quickReactionsSection(_ setting: QuickReactionsSetting) -> some View {
        let row = quickRow
        return Section {
            HStack(spacing: 0) {
                ForEach(0..<QuickReactions.count, id: \.self) { index in
                    let glyph = index < row.count ? row[index] : nil
                    Button { slot = index } label: {
                        Group {
                            if let glyph { Text(glyph).font(.system(size: 26)) } else { Image(systemName: "plus").font(.system(size: 18)).foregroundStyle(.secondary) }
                        }
                        .frame(width: 44, height: 44)
                        .background(Color(.tertiarySystemFill), in: Circle())
                    }
                    .buttonStyle(.plain)
                    .frame(maxWidth: .infinity)
                    .accessibilityLabel(glyph.map { "候補 \(index + 1): \($0)" } ?? "候補 \(index + 1): 空き")
                    .accessibilityHint("タップして絵文字を選びます")
                }
            }
            .padding(.vertical, 4)
            Button("元に戻す") { Task { _ = await controller.setQuickReactions(nil) } }
                .disabled(setting == .unset)
        } header: {
            Text("リアクションの候補")
        } footer: {
            Text("長押しのメニューに並ぶ絵文字です。すべての端末で同じになります。" + (setting == .unset ? "選ぶまでは最近使った絵文字が先に並びます。" : ""))
        }
    }

    @ViewBuilder
    private var themeAndMessages: some View {
        Section {
            Picker("テーマ", selection: $theme) {
                ForEach(AppTheme.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.inline)
            .labelsHidden()
        } header: {
            Text("テーマ")
        } footer: {
            Text("この端末だけの設定です。")
        }
        // M47: this device only, off by default; open conversations and threads follow at once (they read it too).
        Section {
            Toggle("連続した投稿をまとめる", isOn: $grouping)
        } header: {
            Text("メッセージ")
        } footer: {
            Text("オフ: 投稿ごとにアイコンと名前を表示します。オン: 同じ人の続けての投稿をまとめます (チャンネル・DM・スレッド)。この端末だけの設定です。")
        }
    }
}

// MARK: - プロフィールを編集

/// Photo (M14a / M16g), display name, title, my own roster fields (M23), and hiding my presence (L4).
struct ProfileEditView: View {
    @Bindable var controller: AppController
    @State private var displayName = ""
    @State private var title = ""
    // M23: my research topic and reading, when an administrator has put me on the lab roster (the rest of the line is
    // theirs). Trimmed and empty-as-nil, as the server stores them.
    @State private var topic = ""
    @State private var reading = ""
    @State private var saved = false
    @State private var busy = false
    @State private var avatarItem: PhotosPickerItem?
    // M16g: a picked photo loads (large ones take a moment), then its square is chosen in the crop screen.
    @State private var loadingPhoto = false
    @State private var cropping: PickedPhoto?

    private var me: UserMe? { controller.store.me ?? controller.me }
    private var rosterLine: LabProfileOut? { me.flatMap { controller.store.roster[$0.id] } }
    private static func cleaned(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    private var lineChanged: Bool {
        guard let line = rosterLine else { return false }
        return Self.cleaned(topic) != line.researchTopic || Self.cleaned(reading) != line.reading
    }
    private var trimmedName: String { displayName.trimmingCharacters(in: .whitespaces) }
    private var newTitle: String? { Self.cleaned(title) }
    private var changed: Bool {
        guard let me else { return false }
        return trimmedName != me.displayName || newTitle != me.title || lineChanged
    }

    var body: some View {
        Form {
            if let me {
                Section {
                    HStack {
                        Spacer()
                        AvatarView(id: me.id, name: me.displayName, size: 88)
                        Spacer()
                    }
                    .listRowBackground(Color.clear)
                    .accessibilityHidden(true)
                }
                Section {
                    PhotosPicker(selection: $avatarItem, matching: .images) {
                        if loadingPhoto {
                            HStack(spacing: 8) { ProgressView(); Text("写真を読み込んでいます…") }
                        } else {
                            Label("写真を選ぶ", systemImage: "photo")
                        }
                    }
                    .disabled(loadingPhoto)
                    if me.avatarUpdatedAt != nil {
                        Button("写真を削除", systemImage: "trash", role: .destructive) { Task { _ = await controller.deleteAvatar() } }
                    }
                }
                Section {
                    LabeledContent("表示名") {
                        TextField("必須", text: $displayName).multilineTextAlignment(.trailing)
                            .onChange(of: displayName) { _, _ in saved = false }
                    }
                    LabeledContent("肩書") {
                        TextField("任意", text: $title).multilineTextAlignment(.trailing)
                            .onChange(of: title) { _, _ in saved = false }
                    }
                    if rosterLine != nil {
                        // Labelled: a filled よみ alone ("たなか") would not say what it is. The server's limits
                        // (MyLabProfileUpdate): 200 and 80 characters.
                        LabeledContent("研究テーマ") {
                            TextField("任意", text: $topic).multilineTextAlignment(.trailing)
                                .onChange(of: topic) { _, value in saved = false; if value.count > 200 { topic = String(value.prefix(200)) } }
                        }
                        LabeledContent("よみ") {
                            TextField("任意、名簿の並び順に使います", text: $reading).multilineTextAlignment(.trailing)
                                .onChange(of: reading) { _, value in saved = false; if value.count > 80 { reading = String(value.prefix(80)) } }
                        }
                    }
                } footer: {
                    if saved { Text("保存しました") }
                }
                // L4 (M31): nobody else sees whether I am here.
                Section {
                    Toggle("在席を隠す", isOn: Binding(get: { controller.store.me?.presenceHidden ?? false }, set: { on in
                        Task { _ = await controller.updateProfile(presenceHidden: on) }
                    }))
                } footer: {
                    Text("ほかの人からは常にオフラインに見えます。")
                }
            }
        }
        .navigationTitle("プロフィールを編集")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("保存") { Task { await save() } }
                    .disabled(busy || trimmedName.isEmpty || !changed)
            }
        }
        .onChange(of: avatarItem) { _, item in
            guard let item else { return }
            loadingPhoto = true
            Task {
                // Any photo the library holds (HEIC included), decoded small and upright for the crop screen;
                // what gets uploaded is the chosen square as a 512 px JPEG.
                let data = try? await item.loadTransferable(type: Data.self)
                let image = await Task.detached(priority: .userInitiated) { data.flatMap { ImageUpload.downsampled($0) } }.value
                if let image {
                    cropping = PickedPhoto(image: image)
                } else {
                    controller.error = ErrorMessages.byCode["avatar_not_image"] ?? ErrorMessages.unknown
                }
                loadingPhoto = false
                avatarItem = nil
            }
        }
        .fullScreenCover(item: $cropping) { photo in
            AvatarCropView(image: photo.image, onCancel: { cropping = nil }) { jpeg in
                cropping = nil
                Task { _ = await controller.uploadAvatar(data: jpeg, contentType: "image/jpeg") }
            }
        }
        .onAppear {
            displayName = me?.displayName ?? ""; title = me?.title ?? ""
            topic = rosterLine?.researchTopic ?? ""; reading = rosterLine?.reading ?? ""
        }
        .onChange(of: rosterLine) { old, new in
            // The line came with a later bootstrap or changed on another device: a field not edited here follows it,
            // so saving the rest of the profile never writes an old value back.
            if Self.cleaned(topic) == old?.researchTopic { topic = new?.researchTopic ?? "" }
            if Self.cleaned(reading) == old?.reading { reading = new?.reading ?? "" }
        }
    }

    private func save() async {
        guard let me else { return }
        busy = true
        var ok = true
        if trimmedName != me.displayName { ok = await controller.updateDisplayName(trimmedName) }
        if ok, newTitle != me.title { ok = await controller.updateProfile(title: .some(newTitle)) }
        if ok, lineChanged { ok = await controller.updateMyRosterLine(researchTopic: Self.cleaned(topic), reading: Self.cleaned(reading)) }
        saved = ok
        busy = false
    }
}

// MARK: - アカウント

/// Password, two-factor authentication (M12i) and the devices signed in to my account (GET / DELETE /auth/sessions).
struct AccountView: View {
    @Bindable var controller: AppController
    @State private var totp: TotpStatusOut?
    @State private var totpSheet: TotpSheet?
    @State private var sessions: [SessionOut]?
    @State private var sessionsError: String?
    @State private var ending: SessionOut?

    /// M48: an account made by Google sign-in has no password, so neither its change nor 2FA (SSO.md §4).
    private var hasPassword: Bool { controller.me?.passwordSet ?? true }

    var body: some View {
        Form {
            if hasPassword { passwordSections }
            sessionsSection
        }
        .navigationTitle("アカウント")
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $totpSheet) { sheet in
            switch sheet {
            case .setup: TotpSetupView(controller: controller) { totpSheet = nil; Task { totp = await controller.totpStatus() } }
            case .disable: TotpDisableView(controller: controller) { totpSheet = nil; Task { totp = await controller.totpStatus() } }
            }
        }
        .alert(ending.map { "「\(SessionList.name($0))」をログアウトしますか？" } ?? "",
               isPresented: Binding(get: { ending != nil }, set: { if !$0 { ending = nil } }),
               presenting: ending) { session in
            Button("キャンセル", role: .cancel) {}
            Button("ログアウト", role: .destructive) {
                Task { if await controller.revokeSession(session.id) { await loadSessions() } }
            }
        } message: { _ in
            Text("その端末では、もう一度ログインするまでメッセージを読めず、通知も届かなくなります。")
        }
        .task {
            if hasPassword { totp = await controller.totpStatus() }
            await loadSessions()
        }
        .refreshable { await loadSessions() }
    }

    @ViewBuilder
    private var passwordSections: some View {
        Section {
            NavigationLink(value: YouRoute.password) { Label("パスワードを変更", systemImage: "key") }
        }
        Section("2 要素認証") {
            if let totp {
                HStack {
                    Image(systemName: totp.enabled ? "checkmark.shield.fill" : "shield").foregroundStyle(totp.enabled ? Color.green : Color.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(totp.enabled ? "有効" : "無効").font(.body)
                        Text(totp.enabled ? "ログイン時に認証アプリのコードが必要です · 回復コード残り \(totp.recoveryCodesLeft)" : "パスワードだけでログインできます").font(.footnote).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Button(totp.enabled ? "無効にする" : "有効にする") { totpSheet = totp.enabled ? .disable : .setup }
                        .buttonStyle(.borderless)
                }
            } else {
                Text("確認中…").foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var sessionsSection: some View {
        Section {
            if let sessions {
                ForEach(sessions) { session in sessionRow(session) }
            } else if let sessionsError {
                VStack(alignment: .leading, spacing: 6) {
                    Text(sessionsError).font(.footnote).foregroundStyle(.secondary)
                    Button("再試行") { Task { await loadSessions() } }.buttonStyle(.borderless)
                }
            } else {
                HStack(spacing: 8) { ProgressView(); Text("読み込んでいます…").foregroundStyle(.secondary) }
            }
        } header: {
            Text(sessions.map { "ログイン中の端末 (\($0.count))" } ?? "ログイン中の端末")
        } footer: {
            Text("心当たりのない端末はログアウトさせてください。この端末からのログアウトは「自分」の一番下から行います。")
        }
    }

    private func sessionRow(_ session: SessionOut) -> some View {
        HStack(spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: SessionList.symbol(session.device.platform)).foregroundStyle(.secondary).frame(width: 24)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(SessionList.name(session)).lineLimit(1)
                        if session.current {
                            Text("この端末").font(.caption2.bold()).foregroundStyle(.white)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Color.accentColor, in: Capsule())
                        }
                    }
                    Text(SessionList.lastUsed(session.lastUsedAt) + (session.device.appVersion.map { " · \($0)" } ?? ""))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .accessibilityElement(children: .combine)
            Spacer(minLength: 8)
            if !session.current {
                // Its own element (not combined with the row), so VoiceOver reaches it.
                Button("ログアウト", role: .destructive) { ending = session }
                    .buttonStyle(.borderless)
                    .font(.subheadline)
                    .accessibilityLabel("\(SessionList.name(session)) をログアウト")
            }
        }
    }

    private func loadSessions() async {
        do {
            sessions = try await controller.loadSessions()
            sessionsError = nil
        } catch {
            if sessions == nil { sessionsError = controller.describe(error) } else { controller.error = controller.describe(error) }
        }
    }
}

/// Changing my password while signed in (the forced change at login is ChangePasswordView).
struct PasswordChangeView: View {
    @Bindable var controller: AppController
    @State private var current = ""
    @State private var next = ""
    @State private var repeated = ""
    @State private var message: String?
    @State private var busy = false

    var body: some View {
        Form {
            Section {
                SecureField("現在のパスワード", text: $current).textContentType(.password)
                SecureField("新しいパスワード (8 文字以上)", text: $next).textContentType(.newPassword)
                SecureField("新しいパスワード (確認)", text: $repeated).textContentType(.newPassword)
            } footer: {
                if let message {
                    Text(message).foregroundStyle(message.hasSuffix("しました") ? Color.secondary : Color.red)
                }
            }
            Section {
                Button("変更する") {
                    guard next == repeated else { message = "新しいパスワードが一致しません"; return }
                    Task {
                        busy = true
                        let error = await controller.changePasswordInSession(current: current, new: next)
                        busy = false
                        message = error ?? "パスワードを変更しました"
                        if error == nil { current = ""; next = ""; repeated = "" }
                    }
                }
                .disabled(busy || current.isEmpty || next.count < 8)
            }
        }
        .navigationTitle("パスワードを変更")
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// 「管理」 (admins, M40): the administration (users, roster, groups, invites, webhooks, channels, emoji) is the web and
/// desktop clients' 管理 dialog; the iPhone app has none of its own, so this opens the web client, as on Android.
private struct AdminInfoView: View {
    let serverUrl: String?

    var body: some View {
        Form {
            Section {
                Text("ユーザー・名簿・グループ・招待・Webhook・チャンネル・絵文字の管理は、Web 版とデスクトップ版の「管理」で行います。")
                if let serverUrl, let url = URL(string: serverUrl) {
                    Link("ブラウザで開く", destination: url)
                }
            }
        }
        .navigationTitle("管理")
        .navigationBarTitleDisplayMode(.inline)
    }
}
