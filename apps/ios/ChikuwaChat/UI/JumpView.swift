import SwiftUI

/// Everyone the jump view and the new-message picker can offer: the people the store knows, and me.
@MainActor
private func everyone(_ store: Store) -> [String: UserPublic] {
    var users = store.users
    if let me = store.me { users[me.id] = users[me.id] ?? me.asPublic }
    return users
}

/// A text field in a rounded box, as the jump bar looks on the home (the keyboard's key says 検索).
private struct JumpField: View {
    let prompt: String
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    var onSubmit: () -> Void = {}

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).accessibilityHidden(true)
            TextField(prompt, text: $text)
                .focused(focused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onSubmit(onSubmit)
            if !text.isEmpty {
                Button { text = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("入力を消す")
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 40)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// One conversation in the jump view and the picker: its glyph or picture, its name, what is unread.
struct ConversationLabel: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    var note: String? = nil
    var rowHeight: CGFloat = 44

    var body: some View {
        let store = controller.store
        let meId = store.me?.id
        let unread = channel.hasUnread(meId: meId)
        let badge = channel.badgeContribution
        let title = channelTitle(channel, store: store)
        HStack(spacing: 10) {
            if channel.channel.isDm {
                let other = (channel.channel.dmUserIds ?? []).first { $0 != meId } ?? meId ?? channel.id
                AvatarView(id: other, name: store.users[other]?.displayName ?? store.me?.displayName ?? "?", size: 24,
                           presence: store.presenceOf(other))
            } else {
                Image(systemName: channel.channel.type == "private" ? "lock" : "number")
                    .font(.system(size: 16, weight: .medium)).foregroundStyle(.secondary).frame(width: 24)
            }
            Text(channel.channel.isDm ? title : String(title.drop { $0 == "#" }))
                .fontWeight(unread ? .semibold : .regular)
                .lineLimit(1)
            if let note { Text(note).font(.footnote).foregroundStyle(.secondary).lineLimit(1) }
            Spacer(minLength: 4)
            if unread && badge > 0 {
                Text("\(badge)").font(.caption2.bold()).foregroundStyle(.white)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(channel.channel.isDm ? Color.accentColor : Color.red, in: Capsule())
            } else if unread {
                Circle().fill(Color.accentColor).frame(width: 8, height: 8)
            }
        }
        .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(channel.channel.isDm ? "DM: \(title)" : "チャンネル：\(String(title.drop { $0 == "#" }))")
        .accessibilityValue([note, unread ? (badge > 0 ? tr("未読 \(badge) 件") : tr("未読あり")) : nil].compactMap { $0 }.joined(separator: tr("、")))
    }
}

/// One person: picture, display name, username; 「自分」 for me.
struct PersonLabel: View {
    @Bindable var controller: AppController
    let user: UserPublic
    var subtitle: String? = nil
    var rowHeight: CGFloat = 44

    var body: some View {
        let isMe = user.id == controller.store.me?.id
        HStack(spacing: 10) {
            AvatarView(id: user.id, name: user.displayName, size: 24, presence: controller.store.presenceOf(user.id))
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(user.displayName).lineLimit(1)
                    Text("@\(user.username)").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                    if isMe { Text("（自分）").font(.footnote).foregroundStyle(.secondary) }
                }
                if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
            }
            Spacer(minLength: 4)
        }
        .frame(maxWidth: .infinity, minHeight: rowHeight, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// M37 「移動・検索」 (MOBILE_UI.md §6.2), over the whole screen. Empty: the conversations last opened on this device
/// and the recent searches. Typing: the matching conversations, then people (a tap opens the DM), then 「"語" を
/// メッセージ検索」, the existing results screen.
struct JumpView: View {
    /// Rows tighter than the home's 44 pt: a list to pick from, read at a glance (tester, 2026-09-30).
    static let rowHeight: CGFloat = 36

    @Bindable var controller: AppController
    /// A conversation to open (MainView routes it: a DM on the DM tab, a channel on the home tab).
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @FocusState private var focused: Bool
    @State private var recent: [String] = []
    @State private var recentSearches: [SearchParams] = []
    /// The message search on screen instead of the jump list.
    @State private var searching: SearchParams?
    @State private var opening = false

    private var store: Store { controller.store }
    private var query: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        if let searching {
            SearchView(controller: controller, initial: searching)
        } else {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    JumpField(prompt: tr("会話や人に移動、メッセージを検索"), text: $text, focused: $focused) { searchMessages() }
                    Button("キャンセル") { dismiss() }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                List {
                    if query.isEmpty { emptyRows } else { matchRows }
                }
                .listStyle(.plain)
                .environment(\.defaultMinListRowHeight, Self.rowHeight)
                .scrollDismissesKeyboard(.immediately)
            }
            .background(Color(.systemBackground))
            .onAppear {
                recent = RecentConversations.read(key: controller.recentConversationKey)
                recentSearches = RecentSearches.read(key: controller.recentSearchKey)
                focused = true
            }
        }
    }

    @ViewBuilder
    private var emptyRows: some View {
        let conversations = recent.compactMap { store.channel($0) }
        if !conversations.isEmpty {
            Section {
                ForEach(conversations) { channel in
                    Button { open(channel.id) } label: { ConversationLabel(controller: controller, channel: channel, rowHeight: Self.rowHeight) }
                        .buttonStyle(.plain)
                        .listRowSeparator(.hidden)
                        .listRowInsets(ChannelListView.rowInsets)
                }
            } header: { header(tr("最近の会話")) }
        }
        if !recentSearches.isEmpty {
            Section {
                ForEach(recentSearches, id: \.self) { params in
                    Button { searching = params } label: {
                        HStack(spacing: 10) {
                            Image(systemName: "clock").foregroundStyle(.secondary).frame(width: 24)
                            Text(describe(params)).lineLimit(1)
                            Spacer(minLength: 0)
                        }
                        .frame(maxWidth: .infinity, minHeight: Self.rowHeight, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .listRowSeparator(.hidden)
                    .listRowInsets(ChannelListView.rowInsets)
                    .accessibilityLabel("最近の検索：\(describe(params))")
                }
            } header: { header(tr("最近の検索")) }
        }
        if conversations.isEmpty && recentSearches.isEmpty {
            Text("会話や人の名前を入力すると移動できます。メッセージの検索もここから始められます。")
                .font(.footnote).foregroundStyle(.secondary)
                .listRowSeparator(.hidden)
        }
    }

    @ViewBuilder
    private var matchRows: some View {
        let users = everyone(store)
        let conversations = JumpMatch.conversations(query, channels: Array(store.channels.values), users: users, me: store.me?.asPublic)
            .compactMap { store.channel($0) }
        let people = JumpMatch.people(query, users: Array(users.values)).compactMap { users[$0] }
        let bots = JumpMatch.bots(query, users: Array(users.values), aiBotIds: controller.aiHub?.botUserIds ?? [], limit: 10)
            .compactMap { users[$0] }
        if !conversations.isEmpty {
            Section {
                ForEach(conversations) { channel in
                    Button { open(channel.id) } label: { ConversationLabel(controller: controller, channel: channel, rowHeight: Self.rowHeight) }
                        .buttonStyle(.plain)
                        .listRowSeparator(.hidden)
                        .listRowInsets(ChannelListView.rowInsets)
                }
            } header: { header(tr("会話")) }
        }
        if !people.isEmpty {
            Section {
                ForEach(people) { user in
                    Button { openDm(user.id) } label: { PersonLabel(controller: controller, user: user, rowHeight: Self.rowHeight) }
                        .buttonStyle(.plain)
                        .listRowSeparator(.hidden)
                        .listRowInsets(ChannelListView.rowInsets)
                        .disabled(opening)
                        .accessibilityHint("ダイレクトメッセージを開きます")
                }
            } header: { header(tr("人")) }
        }
        if !bots.isEmpty {
            Section {
                ForEach(bots) { user in
                    Button { openDm(user.id) } label: { PersonLabel(controller: controller, user: user, rowHeight: Self.rowHeight) }
                        .buttonStyle(.plain)
                        .listRowSeparator(.hidden)
                        .listRowInsets(ChannelListView.rowInsets)
                        .disabled(opening)
                        .accessibilityHint("ダイレクトメッセージを開きます")
                }
            } header: { header(tr("ボット")) }
        }
        Section {
            Button { searchMessages() } label: {
                HStack(spacing: 10) {
                    Image(systemName: "text.magnifyingglass").foregroundStyle(.secondary).frame(width: 24)
                    Text("\"\(Text(query).bold())\" をメッセージ検索").lineLimit(1)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: Self.rowHeight, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .listRowSeparator(.hidden)
            .listRowInsets(ChannelListView.rowInsets)
            .accessibilityLabel("「\(query)」をメッセージ検索")
        }
    }

    private func header(_ title: String) -> some View {
        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
    }

    private func describe(_ params: SearchParams) -> String {
        SearchLogic.describe(params, userName: { store.users[$0]?.displayName },
                             channelTitle: { id in store.channel(id).map { channelTitle($0, store: store) } })
    }

    private func open(_ id: String) {
        focused = false
        onOpen(id)
    }

    /// A person: the DM with them (with myself alone for me), made when there is none yet.
    private func openDm(_ userId: String) {
        opening = true
        Task {
            if let id = await controller.openDmWith(userId) { open(id) }
            opening = false
        }
    }

    private func searchMessages() {
        guard !query.isEmpty else { return }
        focused = false
        searching = SearchParams(q: query)
    }
}

/// M37 (6) 「新しいメッセージ」 (the ✏️ button): one field finds a channel (mine first, then public ones to join) or
/// people; several people make a group DM, me alone my DM with myself. The chosen conversation opens with its input
/// ready (MOBILE_UI.md §6.1).
struct NewMessageView: View {
    static let rowHeight = JumpView.rowHeight

    @Bindable var controller: AppController
    /// The conversation to open; `focus`: its input takes the keyboard (a channel I can post in, a DM).
    let onOpen: (_ channelId: String, _ focus: Bool) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @FocusState private var focused: Bool
    @State private var selected: [String] = []
    @State private var busy = false
    @State private var error: String?

    /// POST /dms takes up to eight others (as the DM sheet).
    static let maxPeople = 8

    private var store: Store { controller.store }
    private var meId: String? { store.me?.id }

    var body: some View {
        let users = everyone(store)
        NavigationStack {
            VStack(spacing: 0) {
                VStack(alignment: .leading, spacing: 8) {
                    if !selected.isEmpty { chips(users) }
                    JumpField(prompt: tr("チャンネルか人の名前"), text: $text, focused: $focused)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                if let error { Text(error).font(.footnote).foregroundStyle(.red).padding(.horizontal, 16) }
                List {
                    if selected.isEmpty { channelRows }
                    peopleRows(users)
                }
                .listStyle(.plain)
                .environment(\.defaultMinListRowHeight, Self.rowHeight)
                .scrollDismissesKeyboard(.immediately)
            }
            .navigationTitle("新しいメッセージ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("開く") { openPeople(selected) }
                        .disabled(selected.isEmpty || selected.count > Self.maxPeople || busy)
                }
            }
            .onAppear { focused = true }
        }
    }

    @ViewBuilder
    private var channelRows: some View {
        let ids = JumpMatch.destinationChannels(text, channels: Array(store.channels.values), joinable: !controller.isGuest)
        let rows = ids.compactMap { store.channel($0) }
        if !rows.isEmpty {
            Section {
                ForEach(rows) { channel in
                    Button { openChannel(channel) } label: {
                        ConversationLabel(controller: controller, channel: channel, note: channel.isMember ? nil : tr("未参加"), rowHeight: Self.rowHeight)
                    }
                    .buttonStyle(.plain)
                    .listRowSeparator(.hidden)
                    .listRowInsets(ChannelListView.rowInsets)
                }
            } header: { header(tr("チャンネル")) }
        }
    }

    @ViewBuilder
    private func peopleRows(_ users: [String: UserPublic]) -> some View {
        let ids = JumpMatch.destinationPeople(text, users: Array(users.values), meId: meId).filter { $0 != meId || selected.isEmpty }
        let bots = JumpMatch.bots(text, users: Array(users.values), aiBotIds: controller.aiHub?.botUserIds ?? [])
        personSection(ids.compactMap { users[$0] }, title: selected.isEmpty ? tr("人") : tr("人（\(selected.count) 人を選択中）"))
        personSection(bots.compactMap { users[$0] }, title: tr("ボット"))
    }

    @ViewBuilder
    private func personSection(_ rows: [UserPublic], title: String) -> some View {
        if !rows.isEmpty {
            Section {
                ForEach(rows) { user in
                    let isMe = user.id == meId
                    let isSelected = selected.contains(user.id)
                    Button { tap(user.id) } label: {
                        HStack(spacing: 8) {
                            PersonLabel(controller: controller, user: user, subtitle: isMe ? tr("メモや下書きに使える、自分だけの DM") : nil, rowHeight: Self.rowHeight)
                            if !isMe {
                                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                                    .font(.title3)
                                    .foregroundStyle(isSelected ? Color.accentColor : Color.secondary)
                                    .accessibilityHidden(true)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .listRowSeparator(.hidden)
                    .listRowInsets(ChannelListView.rowInsets)
                    .disabled(busy)
                    .accessibilityAddTraits(isSelected ? .isSelected : [])
                    .accessibilityHint(isMe ? "自分だけの DM を開きます" : isSelected ? "宛先から外します" : "宛先に加えます")
                }
            } header: { header(title) }
        }
    }

    /// The people chosen so far, each with a way to take them out.
    private func chips(_ users: [String: UserPublic]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(selected, id: \.self) { id in
                    Button { selected.removeAll { $0 == id } } label: {
                        HStack(spacing: 4) {
                            Text(users[id]?.displayName ?? "?").font(.subheadline)
                            Image(systemName: "xmark").font(.caption2.weight(.bold))
                        }
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Color.accentColor.opacity(0.15), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(users[id]?.displayName ?? "?") を宛先から外す")
                }
            }
        }
    }

    private func header(_ title: String) -> some View {
        Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary).accessibilityAddTraits(.isHeader)
    }

    /// Me: my DM with myself at once. Someone else: in or out of the chosen people.
    private func tap(_ userId: String) {
        if userId == meId {
            openPeople([userId])
        } else if let index = selected.firstIndex(of: userId) {
            selected.remove(at: index)
        } else {
            selected.append(userId)
            text = ""
        }
    }

    private func openChannel(_ channel: ChannelState) {
        // A public channel I am not in opens its preview (M27), where 「参加」 joins it.
        let canPost = channel.isMember && !channel.channel.archived && channel.canPostTopLevel(isAdmin: store.me?.role == "admin")
        onOpen(channel.id, canPost)
        dismiss()
    }

    /// One person (or me): the DM between us, found or made; more: a group DM.
    private func openPeople(_ userIds: [String]) {
        guard !userIds.isEmpty, !busy else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            let id: String?
            if userIds.count == 1 {
                id = await controller.openDmWith(userIds[0])
            } else {
                guard let api = controller.api else { return }
                do {
                    let channel = try await api.createDm(userIds: userIds)
                    store.upsertChannel(channel, isMember: true)
                    id = channel.id
                } catch {
                    self.error = controller.describe(error)
                    return
                }
            }
            guard let id else { return }
            onOpen(id, true)
            dismiss()
        }
    }
}
