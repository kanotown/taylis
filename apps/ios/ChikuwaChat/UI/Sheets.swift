import PhotosUI
import SwiftUI

struct NewDmView: View {
    @Bindable var controller: AppController
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selected = Set<String>()
    @State private var error: String?

    private var users: [UserPublic] {
        controller.store.users.values.filter { $0.id != controller.store.me?.id && $0.deactivatedAt == nil }.sorted { $0.displayName < $1.displayName }
    }

    var body: some View {
        NavigationStack {
            List(selection: $selected) {
                // A DM with only myself: notes to self (as in Slack).
                if let me = controller.store.me?.id {
                    Section {
                        Button { open([me]) } label: {
                            Label {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("自分へのメモ")
                                    Text("自分だけが見られる DM").foregroundStyle(.secondary).font(.footnote)
                                }
                            } icon: { Image(systemName: "square.and.pencil") }
                        }
                    }
                }
                Section {
                    ForEach(users) { user in
                        HStack {
                            Text(user.displayName)
                            Text("@\(user.username)").foregroundStyle(.secondary).font(.footnote)
                        }
                    }
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle("ダイレクトメッセージ")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("開く") { open(Array(selected)) }
                        .disabled(selected.isEmpty || selected.count > 8)
                }
            }
            if let error { Text(error).foregroundStyle(.red).font(.footnote).padding() }
        }
    }

    private func open(_ userIds: [String]) {
        Task {
            guard let api = controller.api else { return }
            do {
                let channel = try await api.createDm(userIds: userIds)
                controller.store.upsertChannel(channel, isMember: true)
                onOpen(channel.id)
                dismiss()
            } catch { self.error = controller.describe(error) }
        }
    }
}

struct NewChannelView: View {
    @Bindable var controller: AppController
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var isPrivate = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("名前 (例: general)", text: $name).textInputAutocapitalization(.never).autocorrectionDisabled()
                Toggle("プライベート", isOn: $isPrivate)
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
            .navigationTitle("チャンネルを作成")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("作成") {
                        Task {
                            guard let api = controller.api else { return }
                            do {
                                let channel = try await api.createChannel(name: name.trimmingCharacters(in: .whitespaces), type: isPrivate ? "private" : "public")
                                controller.store.upsertChannel(channel, isMember: true)
                                onOpen(channel.id)
                                dismiss()
                            } catch { self.error = controller.describe(error) }
                        }
                    }
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
    }
}

struct AddMemberView: View {
    @Bindable var controller: AppController
    let channelId: String
    @Environment(\.dismiss) private var dismiss
    @State private var members: Set<String>?
    @State private var selected = Set<String>()
    @State private var error: String?

    private var candidates: [UserPublic] {
        controller.store.users.values
            .filter { $0.id != controller.store.me?.id && $0.deactivatedAt == nil && !(members?.contains($0.id) ?? true) }
            .sorted { $0.displayName < $1.displayName }
    }

    var body: some View {
        NavigationStack {
            Group {
                if members == nil {
                    ProgressView()
                } else if candidates.isEmpty {
                    Text("追加できるユーザーはいません").foregroundStyle(.secondary)
                } else {
                    List(candidates, selection: $selected) { user in Text(user.displayName) }
                        .environment(\.editMode, .constant(.active))
                }
            }
            .navigationTitle("メンバーを追加")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("追加") {
                        Task {
                            guard let api = controller.api else { return }
                            do {
                                for userId in selected { _ = try await api.addMember(channelId: channelId, userId: userId) }
                                dismiss()
                            } catch { self.error = controller.describe(error) }
                        }
                    }
                    .disabled(selected.isEmpty)
                }
            }
            .task {
                let list = (try? await controller.api?.members(channelId: channelId)) ?? []
                members = Set(list.map(\.userId))
            }
            if let error { Text(error).foregroundStyle(.red).font(.footnote).padding() }
        }
    }
}

/// Channel info: topic (editable by members), notification level, members with roles.
struct ChannelInfoView: View {
    @Bindable var controller: AppController
    let channelId: String
    @Environment(\.dismiss) private var dismiss
    @State private var members: [MemberOut]?
    @State private var topic = ""
    @State private var editingTopic = false
    @State private var profileUserId: String?
    @State private var showAddMember = false
    @State private var purpose = ""
    @State private var editingPurpose = false
    @State private var renaming = false
    @State private var newName = ""
    @State private var confirmLeave = false
    @State private var confirmArchive = false
    @State private var confirmConvert = false
    @State private var addingLink = false

    private var channel: ChannelState? { controller.store.channel(channelId) }
    /// Owners and admins manage the channel (rename / archive); every member may leave.
    private var canManage: Bool {
        guard let channel else { return false }
        return channel.channel.membership?.role == "owner" || controller.store.me?.role == "admin"
    }
    private var isAdmin: Bool { controller.store.me?.role == "admin" }

    private func loadMembers() async {
        guard let api = controller.api else { return }
        do { members = try await api.members(channelId: channelId) } catch { controller.error = controller.describe(error) }
    }

    /// M23: roster order when either person is on the lab roster, else by name (members not in the store go last).
    private func sortedMembers(_ members: [MemberOut]) -> [MemberOut] {
        let store = controller.store
        let known = Roster.sorted(members.compactMap { store.users[$0.userId] }, store.roster) { $0.displayName < $1.displayName }
        let byId = Dictionary(members.map { ($0.userId, $0) }, uniquingKeysWith: { first, _ in first })
        return known.compactMap { byId[$0.id] } + members.filter { store.users[$0.userId] == nil }
    }

    private var convertTitle: String {
        channel?.channel.type == "public" ? "非公開チャンネルに変換しますか？" : "公開チャンネルに変換しますか？"
    }

    private var convertMessage: String {
        if channel?.channel.type == "public" {
            return "メンバー以外はこのチャンネルを見つけられなくなり、参加には招待が必要になります。これまでのメッセージもメンバーだけが読めます。"
                + (isAdmin ? "" : "公開に戻せるのは管理者だけです。")
        }
        return "ゲスト以外の全員がこのチャンネルを見つけて参加し、これまでのメッセージを含めて読めるようになります。"
    }

    /// M11h: the channel's purpose, editable by members.
    @ViewBuilder
    private func purposeSection(_ channel: ChannelState, canEdit: Bool) -> some View {
        Section("説明") {
            if editingPurpose {
                TextField("例: デザインレビューの依頼と結果を共有する", text: $purpose)
                HStack {
                    Button("保存") { Task { if await controller.updatePurpose(channelId, purpose: purpose) { editingPurpose = false } } }
                    Spacer()
                    Button("キャンセル", role: .cancel) { editingPurpose = false }
                }
            } else {
                if let current = channel.channel.purpose, !current.isEmpty {
                    Text(current)
                } else {
                    Text("未設定").foregroundStyle(.secondary)
                }
                if canEdit { Button("編集") { purpose = channel.channel.purpose ?? ""; editingPurpose = true } }
            }
        }
    }

    /// M11i: this channel's files; a row reveals its message and closes the sheet.
    private var filesSection: some View {
        Section {
            NavigationLink {
                FilesView(controller: controller, channelId: channelId) { messageId, channelId, parentId in
                    Task {
                        if await controller.revealMessage(id: messageId, channelId: channelId, parentId: parentId) {
                            NotificationCenter.default.post(name: .chikuwaOpenChannel, object: nil, userInfo: ["id": channelId, "parentId": parentId as Any])
                            dismiss()
                        }
                    }
                }
            } label: {
                Label("ファイル", systemImage: "doc.on.doc")
            }
        }
    }

    /// M11h: leave for every member; rename / archive for owners and admins.
    private func manageSection(_ channel: ChannelState) -> some View {
        Section {
            if canManage && !channel.channel.archived {
                Button("名前を変更", systemImage: "pencil") { newName = channel.channel.name ?? ""; renaming = true }
                Button("アーカイブ", systemImage: "archivebox", role: .destructive) { confirmArchive = true }
            }
            if canManage && channel.channel.archived {
                Button("アーカイブを解除", systemImage: "archivebox") { Task { _ = await controller.unarchiveChannel(channelId) } }
            }
            if canManage && !channel.channel.archived {
                // M15a: an announcement channel; thread replies stay open to everyone.
                Toggle(isOn: Binding(get: { channel.channel.isAnnouncement }, set: { on in
                    Task { _ = await controller.setPostingPolicy(channelId, policy: on ? "owners" : "everyone") }
                })) {
                    Label("投稿をオーナーと管理者に限る", systemImage: "megaphone")
                }
            }
            if channel.canEditLinks(isAdmin: isAdmin, isGuest: controller.store.me?.role == "guest") {
                Button("リンクを追加", systemImage: "link") { addingLink = true }  // M15f
            }
            // M15b: making a channel public shows its whole history, so that direction is for admins only.
            if canManage && channel.channel.type == "public" {
                Button("非公開チャンネルに変換", systemImage: "lock") { confirmConvert = true }
            }
            if isAdmin && channel.channel.type == "private" {
                Button("公開チャンネルに変換", systemImage: "number") { confirmConvert = true }
            }
            Button("チャンネルを退出", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { confirmLeave = true }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let channel {
                    let store = controller.store
                    let isChannel = !channel.channel.isDm
                    let canEdit = channel.isMember && !channel.channel.archived
                    if isChannel {
                        Section("トピック") {
                            if editingTopic {
                                TextField("例: 週次の進捗共有", text: $topic)
                                HStack {
                                    Button("保存") { Task { if await controller.updateTopic(channelId, topic: topic) { editingTopic = false } } }
                                    Spacer()
                                    Button("キャンセル", role: .cancel) { editingTopic = false }
                                }
                            } else {
                                if let current = channel.channel.topic, !current.isEmpty {
                                    Text(current)
                                } else {
                                    Text("未設定").foregroundStyle(.secondary)
                                }
                                if canEdit { Button("編集") { topic = channel.channel.topic ?? ""; editingTopic = true } }
                            }
                        }
                        purposeSection(channel, canEdit: canEdit)
                    }
                    if channel.isMember {
                        let level = channel.channel.notification?.level ?? (isChannel ? "mentions" : "all")
                        Section("通知") {
                            Picker("通知", selection: Binding(get: { level }, set: { value in
                                Task { await controller.setNotification(channelId, level: value, mutedUntil: channel.channel.notification?.mutedUntil) }
                            })) {
                                Text("すべてのメッセージ").tag("all")
                                Text("メンションのみ").tag("mentions")
                                Text("通知しない").tag("none")
                            }
                            .pickerStyle(.inline)
                            .labelsHidden()
                            if let mute = Timeline.muteLabel(channel.channel.notification?.mutedUntil) {
                                Button("ミュート解除 (\(mute))") { Task { await controller.setNotification(channelId, level: level, mutedUntil: nil) } }
                            } else {
                                Button("8 時間ミュート") {
                                    let until = ISO8601DateFormatter().string(from: Date().addingTimeInterval(8 * 3600))
                                    Task { await controller.setNotification(channelId, level: level, mutedUntil: until) }
                                }
                            }
                        }
                    }
                    Section(members.map { "メンバー (\($0.count))" } ?? "メンバー") {
                        if let members {
                            ForEach(sortedMembers(members), id: \.userId) { member in
                                let user = store.users[member.userId]
                                let presence = store.presenceOf(member.userId)
                                Button { profileUserId = member.userId } label: {
                                    HStack(spacing: 10) {
                                        AvatarView(id: member.userId, name: user?.displayName ?? "?", size: 28, presence: presence)
                                        VStack(alignment: .leading, spacing: 0) {
                                            HStack(spacing: 6) {
                                                Text(user?.displayName ?? "?")
                                                StatusEmojiView(user: user)
                                            }
                                            Text("@\(user?.username ?? "")" + ((user?.title).map { " · \($0)" } ?? "")).font(.footnote).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        if presence != "offline" { Text(presenceLabel(presence)).font(.caption).foregroundStyle(.secondary) }
                                        if let line = store.roster[member.userId] { RosterBadge(profile: line) }
                                        if member.role == "owner" { Text("オーナー").font(.caption).foregroundStyle(.secondary) }
                                    }
                                }
                                .buttonStyle(.plain)
                            }
                        } else {
                            ProgressView()
                        }
                        if isChannel && canEdit {
                            Button("メンバーを追加", systemImage: "person.badge.plus") { showAddMember = true }
                        }
                    }
                    if channel.isMember { filesSection }
                    if isChannel && channel.isMember { manageSection(channel) }
                } else {
                    Text("チャンネルが見つかりません").foregroundStyle(.secondary)
                }
            }
            .sheet(item: Binding(get: { profileUserId.map { ProfileTarget(id: $0) } }, set: { profileUserId = $0?.id })) { target in
                ProfileSheet(controller: controller, userId: target.id) { id in
                    NotificationCenter.default.post(name: .chikuwaOpenChannel, object: nil, userInfo: ["id": id])
                    dismiss()
                }
            }
            .navigationTitle(channel.map { channelTitle($0, store: controller.store) } ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("閉じる") { dismiss() } } }
            .alert("名前を変更", isPresented: $renaming) {
                TextField("新しい名前", text: $newName).textInputAutocapitalization(.never).autocorrectionDisabled()
                Button("変更") { Task { _ = await controller.renameChannel(channelId, name: newName) } }
                Button("キャンセル", role: .cancel) {}
            }
            .confirmationDialog("このチャンネルを退出しますか？", isPresented: $confirmLeave, titleVisibility: .visible) {
                Button("退出", role: .destructive) { Task { if await controller.leaveChannel(channelId) { dismiss() } } }
            } message: { Text("公開チャンネルなら、あとから「チャンネルを探す」で再び参加できます。") }
            .confirmationDialog("このチャンネルをアーカイブしますか？", isPresented: $confirmArchive, titleVisibility: .visible) {
                Button("アーカイブ", role: .destructive) { Task { if await controller.archiveChannel(channelId) { dismiss() } } }
            } message: { Text("アーカイブしたチャンネルは読み取り専用になります。") }
            .confirmationDialog(convertTitle, isPresented: $confirmConvert, titleVisibility: .visible) {
                let toPrivate = channel?.channel.type == "public"
                Button(toPrivate ? "非公開にする" : "公開にする", role: .destructive) {
                    Task { _ = await controller.convertChannel(channelId, to: toPrivate ? "private" : "public") }
                }
            } message: { Text(convertMessage) }
            .task { await loadMembers() }
            .sheet(isPresented: $addingLink) { ChannelLinkEditor(controller: controller, channelId: channelId, link: nil) }
            .sheet(isPresented: $showAddMember, onDismiss: { Task { await loadMembers() } }) {
                AddMemberView(controller: controller, channelId: channelId)
            }
        }
    }
}

/// Profile (display name), password change and logout.
struct SettingsView: View {
    @Bindable var controller: AppController
    @Environment(\.dismiss) private var dismiss
    @State private var displayName = ""
    @State private var title = ""
    // M12g: notification keywords, edited as a comma-separated line.
    @State private var keywords = ""
    private var parsedKeywords: [String] {
        Array(keywords.split(whereSeparator: { $0 == "," || $0 == "、" || $0 == "\n" }).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }.prefix(20))
    }
    private var keywordsChanged: Bool { parsedKeywords != (controller.store.me?.notifyKeywords ?? []) }
    // M23: my research topic and reading, when an administrator has put me on the lab roster (the rest of the line is
    // theirs). Trimmed and empty-as-nil, as the server stores them.
    @State private var topic = ""
    @State private var reading = ""
    private var rosterLine: LabProfileOut? { me.flatMap { controller.store.roster[$0.id] } }
    private static func cleaned(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
    private var lineChanged: Bool {
        guard let line = rosterLine else { return false }
        return Self.cleaned(topic) != line.researchTopic || Self.cleaned(reading) != line.reading
    }
    @State private var nameSaved = false
    @State private var editingStatus = false
    @State private var avatarItem: PhotosPickerItem?
    // M16g: a picked photo loads (large ones take a moment), then its square is chosen in the crop screen.
    @State private var loadingPhoto = false
    @State private var cropping: PickedPhoto?
    @State private var current = ""
    @State private var next = ""
    @State private var repeated = ""
    @State private var passwordMessage: String?
    @State private var busy = false
    // M12i: whether my account asks for an authenticator code, and the setup / disable sheets.
    @State private var totp: TotpStatusOut?
    @State private var totpSheet: TotpSheet?

    private var me: UserMe? { controller.store.me ?? controller.me }

    @ViewBuilder
    private var totpSection: some View {
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
                }
            } else {
                Text("確認中…").foregroundStyle(.secondary)
            }
        }
    }

    var body: some View {
        NavigationStack {
            Form {
                if let me {
                    Section {
                        HStack(spacing: 12) {
                            AvatarView(id: me.id, name: me.displayName, size: 44)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(me.displayName).font(.headline)
                                Text("@\(me.username)").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                        // M14a: profile picture
                        PhotosPicker(selection: $avatarItem, matching: .images) {
                            if loadingPhoto {
                                HStack(spacing: 8) { ProgressView(); Text("写真を読み込んでいます…") }
                            } else {
                                Label("写真を選ぶ", systemImage: "photo")
                            }
                        }
                        .disabled(loadingPhoto)
                        if me.avatarUpdatedAt != nil {
                            Button("写真を削除", role: .destructive) { Task { _ = await controller.deleteAvatar() } }
                        }
                    }
                    Section("ステータス") {
                        let status = activeStatus(controller.store.users[me.id] ?? me.asPublic)
                        Button {
                            editingStatus = true
                        } label: {
                            HStack {
                                if let status {
                                    Text("\(status.emoji) \(status.text)".trimmingCharacters(in: .whitespaces))
                                    Spacer()
                                    if let label = expiryLabel((controller.store.users[me.id] ?? me.asPublic).statusExpiresAt) { Text(label).font(.caption).foregroundStyle(.secondary) }
                                } else {
                                    Text("ステータスを設定").foregroundStyle(Color.accentColor)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    Section("プロフィール") {
                        TextField("表示名", text: $displayName)
                            .onChange(of: displayName) { _, _ in nameSaved = false }
                        TextField("肩書 (任意)", text: $title)
                            .onChange(of: title) { _, _ in nameSaved = false }
                        if rosterLine != nil {
                            // Labelled: a filled よみ alone ("たなか") would not say what it is. The server's limits
                            // (MyLabProfileUpdate): 200 and 80 characters.
                            LabeledContent("研究テーマ") {
                                TextField("任意", text: $topic)
                                    .onChange(of: topic) { _, value in nameSaved = false; if value.count > 200 { topic = String(value.prefix(200)) } }
                            }
                            LabeledContent("よみ") {
                                TextField("任意、名簿の並び順に使います", text: $reading)
                                    .onChange(of: reading) { _, value in nameSaved = false; if value.count > 80 { reading = String(value.prefix(80)) } }
                            }
                        }
                        TextField("通知キーワード (任意、コンマ区切り)", text: $keywords)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                            .onChange(of: keywords) { _, _ in nameSaved = false }
                        HStack {
                            Button("プロフィールを保存") {
                                Task {
                                    busy = true
                                    let name = displayName.trimmingCharacters(in: .whitespaces)
                                    let newTitle = title.trimmingCharacters(in: .whitespaces)
                                    var ok = true
                                    if name != me.displayName { ok = await controller.updateDisplayName(name) }
                                    if ok, (newTitle.isEmpty ? nil : newTitle) != me.title { ok = await controller.updateProfile(title: .some(newTitle.isEmpty ? nil : newTitle)) }
                                    if ok, keywordsChanged { ok = await controller.updateProfile(notifyKeywords: parsedKeywords) }
                                    if ok, lineChanged { ok = await controller.updateMyRosterLine(researchTopic: Self.cleaned(topic), reading: Self.cleaned(reading)) }
                                    nameSaved = ok
                                    busy = false
                                }
                            }
                            .disabled(busy || displayName.trimmingCharacters(in: .whitespaces).isEmpty || (displayName.trimmingCharacters(in: .whitespaces) == me.displayName && (title.trimmingCharacters(in: .whitespaces).isEmpty ? nil : title.trimmingCharacters(in: .whitespaces)) == me.title && !keywordsChanged && !lineChanged))
                            if nameSaved { Spacer(); Text("保存しました").font(.footnote).foregroundStyle(.secondary) }
                        }
                    }
                }
                totpSection
                Section("パスワードの変更") {
                    SecureField("現在のパスワード", text: $current)
                    SecureField("新しいパスワード (8 文字以上)", text: $next)
                    SecureField("新しいパスワード (確認)", text: $repeated)
                    if let passwordMessage {
                        Text(passwordMessage).font(.footnote).foregroundStyle(passwordMessage.hasSuffix("しました") ? .secondary : Color.red)
                    }
                    Button("変更する") {
                        guard next == repeated else { passwordMessage = "新しいパスワードが一致しません"; return }
                        Task {
                            busy = true
                            let error = await controller.changePasswordInSession(current: current, new: next)
                            busy = false
                            passwordMessage = error ?? "パスワードを変更しました"
                            if error == nil { current = ""; next = ""; repeated = "" }
                        }
                    }
                    .disabled(busy || current.isEmpty || next.count < 8)
                }
                // M16c: the workspace on screen, and the way to others (switch, add, sign out).
                Section("ワークスペース") {
                    if let workspace = controller.activeWorkspace {
                        HStack(spacing: 12) {
                            WorkspaceTile(workspace: workspace, size: 32)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(workspace.name)
                                Text("\(workspace.username) @ \(workspace.host)").font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    NavigationLink {
                        WorkspaceListView(controller: controller) { dismiss() }
                            .navigationTitle("ワークスペース")
                            .navigationBarTitleDisplayMode(.inline)
                    } label: {
                        Label(controller.workspaces.count > 1 ? "ワークスペースを切り替え・追加" : "ワークスペースを追加", systemImage: "square.stack")
                    }
                }
                Section {
                    Button(controller.workspaces.count > 1 ? "\(controller.workspaceName) からログアウト" : "ログアウト", role: .destructive) {
                        Task { await controller.logout() }
                    }
                }
            }
            .navigationTitle("設定")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("閉じる") { dismiss() } } }
            .sheet(isPresented: $editingStatus) { StatusEditorView(controller: controller) }
            .sheet(item: $totpSheet) { sheet in
                switch sheet {
                case .setup: TotpSetupView(controller: controller) { totpSheet = nil; Task { totp = await controller.totpStatus() } }
                case .disable: TotpDisableView(controller: controller) { totpSheet = nil; Task { totp = await controller.totpStatus() } }
                }
            }
            .task { totp = await controller.totpStatus() }
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
                displayName = me?.displayName ?? ""; title = me?.title ?? ""; keywords = (me?.notifyKeywords ?? []).joined(separator: ", ")
                topic = rosterLine?.researchTopic ?? ""; reading = rosterLine?.reading ?? ""
            }
            .onChange(of: rosterLine) { old, new in
                // The line came with a later bootstrap or changed on another device: a field not edited here follows it,
                // so saving the rest of the profile never writes an old value back.
                if Self.cleaned(topic) == old?.researchTopic { topic = new?.researchTopic ?? "" }
                if Self.cleaned(reading) == old?.reading { reading = new?.reading ?? "" }
            }
        }
    }
}


struct ProfileTarget: Identifiable {
    let id: String
}

/// Which 2FA sheet the settings show (M12i).
enum TotpSheet: String, Identifiable {
    case setup, disable
    var id: String { rawValue }
}
