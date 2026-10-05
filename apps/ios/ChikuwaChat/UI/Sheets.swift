import SwiftUI

struct NewDmView: View {
    @Bindable var controller: AppController
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var selected = Set<String>()
    @State private var error: String?

    /// People by name, then the AI bots (no other bot: apps/shared/jump-match.json `pick`).
    private var users: [UserPublic] {
        let all = Array(controller.store.users.values), meId = controller.store.me?.id
        let ids = JumpMatch.destinationPeople("", users: all, meId: meId).filter { $0 != meId }
            + JumpMatch.bots("", users: all, aiBotIds: controller.aiHub?.botUserIds ?? [])
        return ids.compactMap { controller.store.users[$0] }
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
                                    Text(controller.store.me?.displayName ?? "…")
                                    Text("メモや下書きに使える、自分だけの DM").foregroundStyle(.secondary).font(.footnote)
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

@MainActor @Observable
final class MemberListLoader {
    var members: Set<String>?
    var error: String?
    private var request = UUID()

    func load(fetch: () async throws -> [MemberOut], describe: (Error) -> String) async {
        let current = UUID()
        request = current
        members = nil
        error = nil
        do {
            let list = try await fetch()
            try Task.checkCancellation()
            guard request == current else { return }
            members = Set(list.map(\.userId))
        } catch {
            guard !Task.isCancelled, request == current else { return }
            self.error = describe(error)
        }
    }
}

struct AddMemberView: View {
    @Bindable var controller: AppController
    let channelId: String
    @Environment(\.dismiss) private var dismiss
    @State private var loader = MemberListLoader()
    @State private var attempt = 0
    @State private var adding = false
    @State private var selected = Set<String>()
    @State private var error: String?

    private var candidates: [UserPublic] {
        controller.store.users.values
            .filter { $0.id != controller.store.me?.id && $0.deactivatedAt == nil && !(loader.members?.contains($0.id) ?? true) }
            .sorted { $0.displayName < $1.displayName }
    }

    var body: some View {
        NavigationStack {
            Group {
                if let loadError = loader.error {
                    ContentUnavailableView {
                        Label("メンバー一覧を読み込めませんでした", systemImage: "wifi.exclamationmark")
                    } description: {
                        Text(loadError)
                    } actions: {
                        Button("再試行") { attempt += 1 }.buttonStyle(.bordered)
                    }
                } else if loader.members == nil {
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
                        guard loader.members != nil, !adding, !selected.isEmpty else { return }
                        adding = true
                        error = nil
                        Task {
                            defer { adding = false }
                            guard let api = controller.api else { return }
                            do {
                                // M89: one request for them all (one 「追加しました」 line); 1 by 1 on a server before M88.
                                let userIds = candidates.map(\.id).filter(selected.contains)
                                for member in try await api.addMembers(channelId: channelId, userIds: userIds) {
                                    loader.members?.insert(member.userId)
                                    selected.remove(member.userId)
                                }
                                dismiss()
                            } catch { self.error = controller.describe(error) }
                        }
                    }
                    .disabled(loader.members == nil || selected.isEmpty || adding)
                }
            }
            .task(id: "\(channelId):\(attempt)") {
                selected = []
                error = nil
                await loader.load(fetch: {
                    guard let api = controller.api else { throw URLError(.notConnectedToInternet) }
                    return try await api.members(channelId: channelId)
                }, describe: controller.describe)
            }
            if let error { Text(error).foregroundStyle(.red).font(.footnote).padding() }
        }
    }
}

/// Channel info: the header (name, topic, round buttons; D1), topic and purpose (editable by members), members with
/// roles, the notifications as one row, and the owner / admin actions.
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
    /// M28d: the member an owner or admin is about to take out of the channel (a swipe on the row).
    @State private var removing: MemberOut?
    @State private var confirmArchive = false
    @State private var confirmConvert = false
    @State private var addingLink = false
    /// D1: 「検索」 opens the message search narrowed to this conversation.
    @State private var searching = false
    /// M66: the 「要約」 sheet's request.
    @State private var aiSummary: AiSummaryRequest?

    private var channel: ChannelState? { controller.store.channel(channelId) }
    /// Owners and admins manage the channel (rename / archive); every member may leave.
    private var canManage: Bool {
        guard let channel else { return false }
        return channel.channel.membership?.role == "owner" || controller.store.me?.role == "admin"
    }
    private var isAdmin: Bool { controller.store.me?.role == "admin" }

    /// One member: the profile on a tap; a swipe takes them out (M28d, parity with the web) for owners and admins, not
    /// oneself and not in a DM. Its own function: inside the list the type-checker gave up on it.
    private func memberRow(_ member: MemberOut) -> some View {
        let store = controller.store
        let user = store.users[member.userId]
        let presence = store.presenceOf(member.userId)
        let removable = canManage && member.userId != store.me?.id && !(channel?.channel.isDm ?? true)
        return Button { profileUserId = member.userId } label: {
            HStack(spacing: 10) {
                AvatarView(id: member.userId, name: user?.displayName ?? "?", size: 28, presence: presence)
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 6) {
                        Text(user?.displayName ?? "?")
                        StatusEmojiView(user: user, controller: controller)
                    }
                    Text("@\(user?.username ?? "")" + (Roster.titleExtra(user?.title, store.roster[member.userId]).map { " · \($0)" } ?? "")).font(.footnote).foregroundStyle(.secondary)
                }
                Spacer()
                if presence != "offline" { Text(presenceLabel(presence)).font(.caption).foregroundStyle(.secondary) }
                if let line = store.roster[member.userId] { RosterBadge(profile: line) }
                if member.role == "owner" { Text("オーナー").font(.caption).foregroundStyle(.secondary) }
            }
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing) {
            if removable { Button("外す", role: .destructive) { removing = member } }
        }
        .contextMenu {
            // L4: owners and admins make a member an owner (a teacher of #お知らせ) or take it back.
            if canManage && !(channel?.channel.isDm ?? true) {
                if member.role == "owner" {
                    Button("オーナーから外す", systemImage: "person.badge.minus") { Task { await setRole(member, "member") } }
                } else if let user, user.role != "guest" && user.role != "bot" {
                    Button("オーナーにする", systemImage: "person.badge.key") { Task { await setRole(member, "owner") } }
                }
            }
        }
    }

    private func setRole(_ member: MemberOut, _ role: String) async {
        if let updated = await controller.setMemberRole(channelId: channelId, userId: member.userId, role: role) {
            members = members?.map { $0.userId == updated.userId ? updated : $0 }
        }
    }

    private func remove(_ member: MemberOut) async {
        guard let api = controller.api else { return }
        do {
            try await api.removeMember(channelId: channelId, userId: member.userId)
            members?.removeAll { $0.userId == member.userId } // channel.member_removed confirms the count
        } catch { controller.error = controller.describe(error) }
    }

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
        channel?.channel.type == "public" ? tr("非公開チャンネルに変換しますか？") : tr("公開チャンネルに変換しますか？")
    }

    private var convertMessage: String {
        if channel?.channel.type == "public" {
            return tr("メンバー以外はこのチャンネルを見つけられなくなり、参加には招待が必要になります。これまでのメッセージもメンバーだけが読めます。")
                + (isAdmin ? "" : tr("公開に戻せるのは管理者だけです。"))
        }
        return tr("ゲスト以外の全員がこのチャンネルを見つけて参加し、これまでのメッセージを含めて読めるようになります。")
    }

    private func notificationValue(_ channel: ChannelState) -> String {
        let pref = channel.channel.notification
        return NotificationRules.rowValue(level: channel.pushLevel(overall: controller.store.me?.overallNotification ?? "mentions", meId: controller.store.me?.id),
                                          muted: pref?.muted ?? false, timedMute: Timeline.muteLabel(pref?.mutedUntil))
    }

    /// MOBILE_POLISH.md D1 / MOBILE_UI.md §6.8: the conversation's name large (a DM's picture), its topic and members,
    /// then a row of round buttons (お気に入り・通知・検索・メンバー追加) — Slack's top of the details.
    private func header(_ channel: ChannelState) -> some View {
        let store = controller.store
        let others = (channel.channel.dmUserIds ?? []).filter { $0 != store.me?.id }
        let canAdd = !channel.channel.isDm && channel.isMember && !channel.channel.archived
        let muted = isMuted(channel)
        return Section {
            VStack(spacing: 16) {
                VStack(spacing: 6) {
                    if channel.channel.isDm {
                        let face = others.first ?? store.me?.id ?? ""
                        AvatarView(id: face, name: store.users[face]?.displayName ?? "?", size: 64)
                    } else {
                        Image(systemName: channel.channel.type == "private" ? "lock.fill" : "number")
                            .font(.system(size: 28, weight: .semibold))
                            .foregroundStyle(Color.accentColor)
                            .frame(width: 64, height: 64)
                            .background(Color.accentColor.opacity(0.14), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                            .accessibilityHidden(true)
                    }
                    Text(channelTitle(channel, store: store))
                        .font(.title2.bold())
                        .multilineTextAlignment(.center)
                        .lineLimit(2)
                        .accessibilityAddTraits(.isHeader)
                    if let topic = channel.channel.topic, !topic.isEmpty {
                        Text(topic).font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center).lineLimit(3)
                    }
                    if let members, !channel.channel.isDm || others.count > 1 {
                        Text("メンバー \(members.count) 人").font(.footnote).foregroundStyle(.secondary)
                    }
                }
                HStack(alignment: .top, spacing: 6) {
                    if channel.isMember {
                        let starred = store.isFavorite(channelId)
                        DetailButton(title: starred ? tr("お気に入り済み") : tr("お気に入り"), systemImage: starred ? "star.fill" : "star", on: starred) {
                            Task { await controller.toggleFavorite(channelId) }
                        }
                        Menu {
                            NotificationLevelPicker(controller: controller, channel: channel)
                            Divider()
                            NotificationMuteControls(controller: controller, channel: channel, withIcons: true)
                        } label: {
                            DetailButtonFace(title: muted ? tr("ミュート中") : tr("通知"), systemImage: muted ? "bell.slash" : "bell", on: muted)
                        }
                        .accessibilityLabel("通知設定")
                    }
                    DetailButton(title: tr("検索"), systemImage: "magnifyingglass") { searching = true }
                    if canAdd {
                        DetailButton(title: tr("メンバー追加"), systemImage: "person.badge.plus") { showAddMember = true }
                    }
                }
                .buttonStyle(.plain)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8))
        }
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
                // M15a: an announcement channel; thread replies stay open to everyone. In a times (M24) the same
                // policy reads as what it means there.
                Toggle(isOn: Binding(get: { channel.channel.isAnnouncement }, set: { on in
                    Task { _ = await controller.setPostingPolicy(channelId, policy: on ? "owners" : "everyone") }
                })) {
                    Label(channel.channel.isTimes ? "他の人はスレッドでだけ返信できるようにする" : "投稿をオーナーと管理者に限る", systemImage: "megaphone")
                }
            }
            if channel.canEditLinks(isAdmin: isAdmin, isGuest: controller.store.me?.role == "guest") {
                Button("リンクを追加", systemImage: "link") { addingLink = true }  // M15f
            }
            // M15b: making a channel public shows its whole history, so that direction is for admins only.
            if canManage && channel.channel.type == "public" {
                Button("非公開チャンネルに変換", systemImage: "lock") { confirmConvert = true }
            }
            // L4: only an admin who is a member makes a private channel public (the server says the same).
            if isAdmin && channel.isMember && channel.channel.type == "private" {
                Button("公開チャンネルに変換", systemImage: "number") { confirmConvert = true }
            }
            Button("チャンネルを退出", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive) { confirmLeave = true }
        }
    }

    var body: some View {
        // M29: pushed from the conversation's header (a page, Slack), not a sheet.
        Form {
            if let channel {
                let store = controller.store
                let isChannel = !channel.channel.isDm
                let canEdit = channel.isMember && !channel.channel.archived
                header(channel)
                AiChannelSection(channelId: channelId,
                                 notice: AiRules.notice(controller.aiHub?.agents(among: (members ?? []).map(\.userId)) ?? []),
                                 canSummarize: controller.canSummarize(channelId),
                                 target: controller.aiHub?.target(channelId)) { request in
                    aiSummary = request
                    controller.summarize(request)
                }
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
                Section(members.map { "メンバー (\($0.count))" } ?? "メンバー") {
                    if let members {
                        ForEach(sortedMembers(members), id: \.userId) { member in memberRow(member) }
                    } else {
                        ProgressView()
                    }
                    if isChannel && canEdit {
                        Button("メンバーを追加", systemImage: "person.badge.plus") { showAddMember = true }
                    }
                }
                if channel.isMember {
                    // D1: one row with what the conversation notifies me of; the choices are a page of their own.
                    Section {
                        NavigationLink {
                            ChannelNotificationsView(controller: controller, channelId: channelId)
                        } label: {
                            LabeledContent {
                                Text(notificationValue(channel))
                            } label: {
                                Label("通知", systemImage: isMuted(channel) ? "bell.slash" : "bell")
                            }
                        }
                    }
                }
                if isChannel {
                    // M95: the workflows the channel offers (read when the page opens); running only.
                    Section {
                        NavigationLink {
                            WorkflowListView(controller: controller, channelId: channelId) { workflow in
                                controller.runWorkflow(workflow, here: channelId)
                            }
                        } label: {
                            Label("ワークフロー", systemImage: "bolt")
                        }
                    }
                }
                if isChannel && channel.isMember {
                    RecurringPostsSection(controller: controller, channel: channel)  // L6 (M60)
                    manageSection(channel)
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
        .alert("名前を変更", isPresented: $renaming) {
            TextField("新しい名前", text: $newName).textInputAutocapitalization(.never).autocorrectionDisabled()
            Button("変更") { Task { _ = await controller.renameChannel(channelId, name: newName) } }
            Button("キャンセル", role: .cancel) {}
        }
        // Yes / no questions are alerts in the middle of the screen (MessageActions: the dialogs pointed from odd places).
        .alert("メンバーから外しますか？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
               presenting: removing) { member in
            Button("キャンセル", role: .cancel) {}
            Button("外す", role: .destructive) { Task { await remove(member) } }
        } message: { member in Text("\(controller.store.users[member.userId]?.displayName ?? "?") さんをこのチャンネルから外します。") }
        .alert("このチャンネルを退出しますか？", isPresented: $confirmLeave) {
            Button("キャンセル", role: .cancel) {}
            Button("退出", role: .destructive) { Task { if await controller.leaveChannel(channelId) { dismiss() } } }
        } message: { Text("公開チャンネルなら、あとから「チャンネルを探す」で再び参加できます。") }
        .alert("このチャンネルをアーカイブしますか？", isPresented: $confirmArchive) {
            Button("キャンセル", role: .cancel) {}
            Button("アーカイブ", role: .destructive) { Task { if await controller.archiveChannel(channelId) { dismiss() } } }
        } message: { Text("アーカイブしたチャンネルは読み取り専用になります。") }
        .alert(convertTitle, isPresented: $confirmConvert) {
            let toPrivate = channel?.channel.type == "public"
            Button("キャンセル", role: .cancel) {}
            Button(toPrivate ? "非公開にする" : "公開にする", role: .destructive) {
                Task { _ = await controller.convertChannel(channelId, to: toPrivate ? "private" : "public") }
            }
        } message: { Text(convertMessage) }
        .task(id: controller.store.memberListVersion[channelId, default: 0]) { await loadMembers() }  // L4: roles change
        .aiSummarySheet(controller, request: $aiSummary)
        .loadsSummaryTarget(controller, channelId: channelId)
        .sheet(isPresented: $addingLink) { ChannelLinkEditor(controller: controller, channelId: channelId, link: nil) }
        .sheet(isPresented: $searching) { SearchView(controller: controller, initial: SearchParams(channelId: channelId)) }
        .sheet(isPresented: $showAddMember, onDismiss: { Task { await loadMembers() } }) {
            AddMemberView(controller: controller, channelId: channelId)
        }
    }
}

/// D1: a round button of the channel details' header, its words under it.
private struct DetailButton: View {
    let title: String
    let systemImage: String
    var on = false
    let action: () -> Void

    var body: some View {
        Button(action: action) { DetailButtonFace(title: title, systemImage: systemImage, on: on) }
            .accessibilityLabel(title)
    }
}

private struct DetailButtonFace: View {
    let title: String
    let systemImage: String
    var on = false

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: systemImage)
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(on ? Color.accentColor : Color.primary)
                .frame(width: 52, height: 52)
                .background(Color(.secondarySystemGroupedBackground), in: Circle())
            Text(title).font(.caption).foregroundStyle(.primary).lineLimit(1).minimumScaleFactor(0.8)
        }
        .frame(width: 78)
        .contentShape(Rectangle())
    }
}

/// D1: a conversation's notifications on a page of their own (the details show them as one row): the level (既定 or
/// its own), 「ミュート」 until unmuted and the timed mute (M35).
struct ChannelNotificationsView: View {
    @Bindable var controller: AppController
    let channelId: String

    var body: some View {
        Form {
            if let channel = controller.store.channel(channelId) {
                let level = channel.pushLevel(overall: controller.store.me?.overallNotification ?? "mentions", meId: controller.store.me?.id)
                Section("通知するメッセージ") {
                    NotificationLevelPicker(controller: controller, channel: channel)
                        .pickerStyle(.inline)
                        .labelsHidden()
                }
                Section {
                    NotificationMuteControls(controller: controller, channel: channel)
                } footer: {
                    Text(isMuted(channel) ? "ミュート中: 通知せず、メンションだけを未読にします。" : "この会話の通知: \(NotificationRules.levelLabel(level))")
                }
            }
        }
        .navigationTitle("通知")
        .navigationBarTitleDisplayMode(.inline)
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
