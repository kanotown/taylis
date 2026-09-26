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
            List(users, selection: $selected) { user in
                HStack {
                    Text(user.displayName)
                    Text("@\(user.username)").foregroundStyle(.secondary).font(.footnote)
                }
            }
            .environment(\.editMode, .constant(.active))
            .navigationTitle("ダイレクトメッセージ")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("開く") {
                        Task {
                            guard let api = controller.api else { return }
                            do {
                                let channel = try await api.createDm(userIds: Array(selected))
                                controller.store.upsertChannel(channel, isMember: true)
                                onOpen(channel.id)
                                dismiss()
                            } catch { self.error = controller.describe(error) }
                        }
                    }
                    .disabled(selected.isEmpty || selected.count > 8)
                }
            }
            if let error { Text(error).foregroundStyle(.red).font(.footnote).padding() }
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

    private var channel: ChannelState? { controller.store.channel(channelId) }

    private func loadMembers() async {
        guard let api = controller.api else { return }
        do { members = try await api.members(channelId: channelId) } catch { controller.error = controller.describe(error) }
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
                            ForEach(members.sorted { (store.users[$0.userId]?.displayName ?? "") < (store.users[$1.userId]?.displayName ?? "") }, id: \.userId) { member in
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
            .task { await loadMembers() }
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
    @State private var nameSaved = false
    @State private var editingStatus = false
    @State private var current = ""
    @State private var next = ""
    @State private var repeated = ""
    @State private var passwordMessage: String?
    @State private var busy = false

    private var me: UserMe? { controller.store.me ?? controller.me }

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
                        HStack {
                            Button("プロフィールを保存") {
                                Task {
                                    busy = true
                                    let name = displayName.trimmingCharacters(in: .whitespaces)
                                    let newTitle = title.trimmingCharacters(in: .whitespaces)
                                    var ok = true
                                    if name != me.displayName { ok = await controller.updateDisplayName(name) }
                                    if ok, (newTitle.isEmpty ? nil : newTitle) != me.title { ok = await controller.updateProfile(title: .some(newTitle.isEmpty ? nil : newTitle)) }
                                    nameSaved = ok
                                    busy = false
                                }
                            }
                            .disabled(busy || displayName.trimmingCharacters(in: .whitespaces).isEmpty || (displayName.trimmingCharacters(in: .whitespaces) == me.displayName && (title.trimmingCharacters(in: .whitespaces).isEmpty ? nil : title.trimmingCharacters(in: .whitespaces)) == me.title))
                            if nameSaved { Spacer(); Text("保存しました").font(.footnote).foregroundStyle(.secondary) }
                        }
                    }
                }
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
                Section {
                    Button("ログアウト", role: .destructive) { Task { await controller.logout() } }
                }
            }
            .navigationTitle("設定")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("閉じる") { dismiss() } } }
            .sheet(isPresented: $editingStatus) { StatusEditorView(controller: controller) }
            .onAppear { displayName = me?.displayName ?? ""; title = me?.title ?? "" }
        }
    }
}


struct ProfileTarget: Identifiable {
    let id: String
}
