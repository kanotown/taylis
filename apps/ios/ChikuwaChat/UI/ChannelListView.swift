import SwiftUI

struct ChannelListView: View {
    @Bindable var controller: AppController
    @Binding var selection: String?
    @AppStorage("sidebar.unreadOnly") private var unreadOnly = false
    @State private var showBrowser = false
    /// M14f: naming a new section (optionally for a conversation) or renaming one.
    private enum Naming: Equatable { case create(String?), rename(String) }
    @State private var naming: Naming?
    @State private var nameText = ""

    private var channels: [ChannelState] { Array(controller.store.channels.values) }
    private var meId: String? { controller.store.me?.id ?? controller.me?.id }
    /// The unread filter keeps the open conversation so the selection never disappears.
    private func keep(_ channel: ChannelState) -> Bool { !unreadOnly || channel.id == selection || channel.hasUnread(meId: meId) }
    private func starred(_ channel: ChannelState) -> Bool { controller.store.favorites.contains(channel.id) }
    /// 「お気に入り」 (M12a): starred conversations, out of the other sections.
    private var favorites: [ChannelState] {
        channels.filter { $0.isMember && !$0.channel.archived && starred($0) && keep($0) }
            .sorted { channelTitle($0, store: controller.store) < channelTitle($1, store: controller.store) }
    }
    private func placed(_ channel: ChannelState) -> Bool { controller.store.sectionOf(channel.id) != nil }
    private var channelAndTimes: (channels: [ChannelState], times: [ChannelState]) {
        Self.channelSections(channels, meId: meId) { !starred($0) && !placed($0) && keep($0) }
    }
    /// M24: the row to make my times stays until I have one; guests cannot have one.
    private var canMakeTimes: Bool {
        guard let meId, !controller.isGuest else { return false }
        return !channels.contains { $0.channel.timesOwnerId == meId }
    }
    private var dms: [ChannelState] { channels.filter { $0.isMember && $0.channel.isDm && !starred($0) && !placed($0) && keep($0) }.sorted { ($0.channel.lastMessageAt ?? "") > ($1.channel.lastMessageAt ?? "") } }
    private var browse: [ChannelState] { unreadOnly ? [] : channels.filter { !$0.isMember && $0.channel.type == "public" && !$0.channel.archived }.sorted { ($0.channel.name ?? "") < ($1.channel.name ?? "") } }

    var body: some View {
        List(selection: $selection) {
            Section {
                Picker("表示", selection: $unreadOnly) {
                    Text("すべて").tag(false)
                    Text("未読").tag(true)
                }
                .pickerStyle(.segmented)
                .listRowBackground(Color.clear)
            }
            Section {
                threadsRow
                mentionsRow
                draftsRow
                remindersRow
                filesRow
                savedRow
            }
            if !favorites.isEmpty {
                Section("お気に入り") {
                    ForEach(favorites) { row($0) }
                }
            }
            customSections
            let sections = channelAndTimes
            Section("チャンネル") {
                ForEach(sections.channels) { row($0) }
                if sections.channels.isEmpty { hint(unreadOnly ? "未読のチャンネルはありません。" : "参加中のチャンネルはありません。＋ から作成できます。") }
                if !unreadOnly && !controller.isGuest { browseRow }
            }
            if !sections.times.isEmpty || (canMakeTimes && !unreadOnly) {
                Section("Times") {
                    ForEach(sections.times) { row($0) }
                    if canMakeTimes && !unreadOnly { makeTimesRow }
                }
            }
            Section("ダイレクトメッセージ") {
                ForEach(dms) { row($0) }
                if dms.isEmpty { hint(unreadOnly ? "未読の DM はありません。" : "＋ の「ダイレクトメッセージ」から相手を選べます。") }
            }
            if !browse.isEmpty {
                Section("参加できるチャンネル") {
                    ForEach(browse) { channel in
                        Button { join(channel.id) } label: {
                            HStack(spacing: 12) {
                                ChannelGlyph(channel: channel.channel)
                                Text(rowTitle(channel)).foregroundStyle(.primary)
                                Spacer()
                                Text("参加").font(.footnote).foregroundStyle(Color.accentColor)
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .alert(namingTitle, isPresented: Binding(get: { naming != nil }, set: { if !$0 { naming = nil } })) {
            TextField("セクション名", text: $nameText)
            Button("キャンセル", role: .cancel) { naming = nil }
            Button("OK") { submitName() }
        }
        .sheet(isPresented: $showBrowser) {
            ChannelBrowserView(controller: controller) { id in selection = id }
        }
    }

    /// The channels I am in, less those shown elsewhere (`include`): 「チャンネル」 by name, and 「Times」 (M24), where
    /// times channels go instead, mine first, then by name.
    nonisolated static func channelSections(_ all: [ChannelState], meId: String?,
                                include: (ChannelState) -> Bool) -> (channels: [ChannelState], times: [ChannelState]) {
        let rows = all.filter { $0.isMember && !$0.channel.isDm && !$0.channel.archived && include($0) }
        let byName = { (a: ChannelState, b: ChannelState) in (a.channel.name ?? "") < (b.channel.name ?? "") }
        let mine = { (channel: ChannelState) in channel.channel.timesOwnerId == meId }
        return (rows.filter { !$0.channel.isTimes }.sorted(by: byName),
                rows.filter(\.channel.isTimes).sorted { mine($0) != mine($1) ? mine($0) : byName($0, $1) })
    }

    // MARK: sidebar sections (M14f)

    private func members(of section: SidebarSectionOut) -> [ChannelState] {
        let rows = channels.filter { $0.isMember && !$0.channel.archived && !starred($0) && keep($0) && section.channelIds.contains($0.id) }
        let named = rows.filter { !$0.channel.isDm }.sorted { ($0.channel.name ?? "") < ($1.channel.name ?? "") }
        let direct = rows.filter { $0.channel.isDm }.sorted { ($0.channel.lastMessageAt ?? "") > ($1.channel.lastMessageAt ?? "") }
        return named + direct
    }

    @ViewBuilder
    private var customSections: some View {
        let sections = controller.store.sidebarSections
        ForEach(Array(sections.enumerated()), id: \.element.id) { index, section in
            Section {
                let rows = members(of: section)
                ForEach(rows) { row($0) }
                if rows.isEmpty && !unreadOnly { hint("会話を長押し →「セクションに移動」で追加できます。") }
            } header: {
                sectionHeader(section, index: index, count: sections.count)
            }
        }
    }

    private func sectionHeader(_ section: SidebarSectionOut, index: Int, count: Int) -> some View {
        HStack {
            Text(section.name)
            Spacer()
            Menu {
                Button("名前を変更", systemImage: "pencil") { nameText = section.name; naming = .rename(section.id) }
                Button("上へ", systemImage: "arrow.up") { Task { _ = await controller.moveSection(section.id, position: index - 1) } }.disabled(index == 0)
                Button("下へ", systemImage: "arrow.down") { Task { _ = await controller.moveSection(section.id, position: index + 1) } }.disabled(index == count - 1)
                Button("新しいセクション…", systemImage: "plus") { nameText = ""; naming = .create(nil) }
                Button("セクションを削除", systemImage: "trash", role: .destructive) { Task { _ = await controller.deleteSection(section.id) } }
            } label: {
                Image(systemName: "ellipsis").padding(.horizontal, 4)
            }
            .accessibilityLabel("\(section.name) のメニュー")
        }
    }

    @ViewBuilder
    private func rowMenu(_ channel: ChannelState) -> some View {
        let current = controller.store.sectionOf(channel.id)
        Button(starred(channel) ? "お気に入りから外す" : "お気に入りに追加", systemImage: starred(channel) ? "star.slash" : "star") {
            Task { await controller.toggleFavorite(channel.id) }
        }
        Menu("セクションに移動", systemImage: "folder") {
            ForEach(controller.store.sidebarSections) { section in
                Button(section.name) { Task { _ = await controller.moveToSection(channel.id, sectionId: section.id) } }
                    .disabled(current == section.id)
            }
            Button("新しいセクション…", systemImage: "plus") { nameText = ""; naming = .create(channel.id) }
        }
        if current != nil {
            Button("セクションから外す", systemImage: "folder.badge.minus") { Task { _ = await controller.moveToSection(channel.id, sectionId: nil) } }
        }
    }

    private var namingTitle: String {
        if case .rename = naming { return "セクション名を変更" }
        return "新しいセクション"
    }

    private func submitName() {
        let name = nameText.trimmingCharacters(in: .whitespaces)
        let target = naming
        naming = nil
        guard !name.isEmpty, let target else { return }
        Task {
            switch target {
            case .create(let channelId): _ = await controller.createSection(name, channelId: channelId)
            case .rename(let id): _ = await controller.renameSection(id, name: name)
            }
        }
    }

    /// 「メンション」 (M11h): messages that mention me or everyone.
    private var mentionsRow: some View {
        NavigationLink(value: MentionsView.selectionId) {
            HStack(spacing: 12) {
                Image(systemName: "at").font(.body).foregroundStyle(.secondary).frame(width: 28)
                Text("メンション")
            }
            .padding(.vertical, 2)
        }
    }

    /// 「下書き」 (M11h): listed only while something is unsent.
    @ViewBuilder
    private var draftsRow: some View {
        let count = controller.store.listDrafts().count + controller.store.scheduled.count
        if count > 0 {
            NavigationLink(value: DraftsView.selectionId) {
                HStack(spacing: 12) {
                    Image(systemName: "doc.text").font(.body).foregroundStyle(.secondary).frame(width: 28)
                    Text("下書き")
                    Spacer()
                    Text("\(count)").font(.caption).foregroundStyle(.secondary)
                }
                .padding(.vertical, 2)
            }
        }
    }

    /// 「チャンネルを探す」 (M11h): the browser with member counts, join / leave and create.
    private var browseRow: some View {
        Button { showBrowser = true } label: {
            HStack(spacing: 12) {
                Image(systemName: "safari").font(.body).foregroundStyle(.secondary).frame(width: 28)
                Text("チャンネルを探す").foregroundStyle(.primary)
            }
            .padding(.vertical, 2)
        }
    }

    /// 「自分の times を作る」 (M24): POST /times, then open it.
    private var makeTimesRow: some View {
        Button { makeTimes() } label: {
            HStack(spacing: 12) {
                Image(systemName: "plus").font(.body).foregroundStyle(.secondary).frame(width: 28)
                VStack(alignment: .leading, spacing: 1) {
                    Text("自分の times を作る").foregroundStyle(.primary)
                    Text("作業ログ用の公開チャンネル").font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 2)
        }
    }

    /// 「スレッド」 (THREADS.md §5): followed threads with unread replies; red when one mentions me.
    private var threadsRow: some View {
        let summary = controller.store.threadSummary
        let active = selection == ThreadsListView.selectionId
        let unread = summary.unreadCount > 0 && !active
        return NavigationLink(value: ThreadsListView.selectionId) {
            HStack(spacing: 12) {
                Image(systemName: "bubble.left.and.text.bubble.right")
                    .font(.body).foregroundStyle(.secondary).frame(width: 28)
                Text("スレッド").fontWeight(unread ? .semibold : .regular)
                Spacer()
                if unread {
                    Text("\(summary.unreadCount)")
                        .font(.caption2).bold().foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(summary.mentionCount > 0 ? Color.red : Color.accentColor, in: Capsule())
                }
            }
            .padding(.vertical, 2)
        }
    }

    /// 「リマインダー」 (M12e): listed while any is open; red when a nudge waits.
    @ViewBuilder
    private var remindersRow: some View {
        let count = controller.store.reminders.count
        let fired = controller.store.firedReminderCount
        if count > 0 {
            NavigationLink(value: RemindersView.selectionId) {
                HStack(spacing: 12) {
                    Image(systemName: "alarm").font(.body).foregroundStyle(.secondary).frame(width: 28)
                    Text("リマインダー").fontWeight(fired > 0 ? .semibold : .regular)
                    Spacer()
                    if fired > 0 {
                        Text("\(fired)").font(.caption2).bold().foregroundStyle(.white)
                            .padding(.horizontal, 7).padding(.vertical, 2).background(Color.red, in: Capsule())
                    } else {
                        Text("\(count)").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    /// 「ファイル」 (M11i): attachments in my channels.
    private var filesRow: some View {
        NavigationLink(value: FilesView.selectionId) {
            HStack(spacing: 12) {
                Image(systemName: "doc.on.doc").font(.body).foregroundStyle(.secondary).frame(width: 28)
                Text("ファイル")
            }
            .padding(.vertical, 2)
        }
    }

    /// 「保存済み」 (M11c): my bookmarked messages.
    private var savedRow: some View {
        let count = controller.store.bookmarks.count
        return NavigationLink(value: SavedView.selectionId) {
            HStack(spacing: 12) {
                Image(systemName: "bookmark").font(.body).foregroundStyle(.secondary).frame(width: 28)
                Text("保存済み")
                Spacer()
                if count > 0 { Text("\(count)").font(.caption).foregroundStyle(.secondary) }
            }
            .padding(.vertical, 2)
        }
    }

    /// The glyph already says "#", so rows show the bare channel name.
    private func rowTitle(_ channel: ChannelState) -> String {
        let title = channelTitle(channel, store: controller.store)
        return channel.channel.isDm ? title : String(title.drop(while: { $0 == "#" }))
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(.secondary)
    }

    private func join(_ id: String) {
        Task {
            guard let api = controller.api else { return }
            do {
                let joined = try await api.joinChannel(id: id)
                controller.store.upsertChannel(joined, isMember: true)
                selection = joined.id
            } catch { controller.error = controller.describe(error) }
        }
    }

    private func makeTimes() {
        Task { if let id = await controller.ensureTimes() { selection = id } }
    }

    private func row(_ channel: ChannelState) -> some View {
        let badge = channel.badgeContribution
        let muted = channel.isMuted
        let unread = channel.hasUnread(meId: meId) && channel.id != selection
        // M24: someone else's times with new posts but no mention: not bold, a faint dot (SYNC_PROTOCOL.md §10.5).
        let quietUnread = !unread && channel.id != selection && channel.unreadCount > 0 && channel.isQuiet(meId: meId)
        let store = controller.store
        return NavigationLink(value: channel.id) {
            HStack(spacing: 12) {
                if channel.channel.isDm {
                    let other = (channel.channel.dmUserIds ?? []).first { $0 != store.me?.id } ?? store.me?.id ?? channel.id
                    AvatarView(id: other, name: store.users[other]?.displayName ?? store.me?.displayName ?? "?", presence: store.presenceOf(other))
                } else {
                    ChannelGlyph(channel: channel.channel)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(rowTitle(channel)).fontWeight(unread ? .semibold : .regular).lineLimit(1)
                    if !channel.channel.isDm, let topic = channel.channel.topic, !topic.isEmpty {
                        Text(topic).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
                Spacer()
                if channel.channel.isDm, let other = (channel.channel.dmUserIds ?? []).first(where: { $0 != store.me?.id }) {
                    StatusEmojiView(user: store.users[other])
                }
                if muted { Image(systemName: "bell.slash").font(.caption).foregroundStyle(.secondary) }
                if unread && badge > 0 {
                    Text("\(badge)")
                        .font(.caption2).bold().foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(Color.accentColor, in: Capsule())
                } else if unread {
                    Circle().fill(Color.accentColor).frame(width: 8, height: 8)
                } else if quietUnread {
                    Circle().fill(Color.secondary.opacity(0.5)).frame(width: 6, height: 6)
                }
            }
            .padding(.vertical, 2)
            .opacity(muted && !unread ? 0.6 : 1)
        }
        .contextMenu { rowMenu(channel) }
        .swipeActions(edge: .leading) {
            Button(starred(channel) ? "お気に入りから外す" : "お気に入り", systemImage: starred(channel) ? "star.slash" : "star") {
                Task { await controller.toggleFavorite(channel.id) }
            }
            .tint(.yellow)
        }
    }
}
