import SwiftUI

struct ChannelListView: View {
    @Bindable var controller: AppController
    @Binding var selection: String?
    @AppStorage("sidebar.unreadOnly") private var unreadOnly = false
    @State private var showBrowser = false
    /// M26: making (no section) or editing one of my sections; the conversation a long-press 「新しいセクション…」 ticks.
    private struct SectionFormTarget: Identifiable {
        let id = UUID()
        let section: SidebarSectionOut?
        var preselected: [String] = []
    }
    @State private var sectionForm: SectionFormTarget?
    /// M26: the default sections folded on this device; my own sections fold on all my devices through the server.
    @AppStorage("sidebar.folded") private var foldedRaw = ""
    /// What the list shows, changed inside an animation (a change of the stored value itself was not animated: the
    /// section snapped shut, testers 2026-09-29); the stored value follows for the next launch.
    @State private var foldedShown: Set<String>?
    private var folded: Set<String> { foldedShown ?? Self.foldedKeys(foldedRaw) }
    /// The folds as stored, before the first change (so that change is animated from a value already on screen).
    private func loadFolds() { if foldedShown == nil { foldedShown = Self.foldedKeys(foldedRaw) } }
    private func toggleFold(_ key: String) {
        let next = Self.toggledFold(foldedRaw, key: key)
        withAnimation(.easeInOut(duration: 0.3)) { foldedShown = Self.foldedKeys(next) }
        foldedRaw = next
    }
    private func shown(_ rows: [ChannelState], _ collapsed: Bool) -> [ChannelState] {
        Self.shown(rows, collapsed: collapsed, meId: meId, selection: selection)
    }

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
    /// My DM with myself first (as in Slack), then the newest.
    private var dms: [ChannelState] {
        channels.filter { $0.isMember && $0.channel.isDm && !starred($0) && !placed($0) && keep($0) }.sorted { a, b in
            let selfA = DMList.isNotesToSelf(a, meId: meId), selfB = DMList.isNotesToSelf(b, meId: meId)
            if selfA != selfB { return selfA }
            return (a.channel.lastMessageAt ?? "") > (b.channel.lastMessageAt ?? "")
        }
    }
    /// Until my DM with myself exists, its row stands first all the same; a tap makes it.
    private var showsNotesRow: Bool { !unreadOnly && DMList.notesMissing(channels, meId: meId) }
    @State private var openingNotes = false
    private var browse: [ChannelState] { unreadOnly ? [] : channels.filter { !$0.isMember && $0.channel.type == "public" && !$0.channel.archived }.sorted { ($0.channel.name ?? "") < ($1.channel.name ?? "") } }

    var body: some View {
        // M34: a tap sets the selection, which the home tab turns into a screen on its stack (MainView).
        List {
            // The unread filter and the lists (threads, mentions, drafts, reminders, files, saved) in one row of chips
            // (testers, 2026-09-29: the home screen took a lot of room before the first channel).
            shortcutChips
                .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 10, trailing: 0))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            // M26: a folded section keeps its unread rows (and the open one); its hints and actions go.
            if !favorites.isEmpty {
                let fold = folded.contains("favorites")
                Section {
                    ForEach(shown(favorites, fold)) { row($0) }
                } header: { foldHeader("お気に入り", folded: fold) { toggleFold("favorites") } }
            }
            customSections
            let sections = channelAndTimes
            let channelsFolded = folded.contains("channels")
            Section {
                ForEach(shown(sections.channels, channelsFolded)) { row($0) }
                if !channelsFolded {
                    if sections.channels.isEmpty { hint(unreadOnly ? "未読のチャンネルはありません。" : "参加中のチャンネルはありません。＋ から作成できます。") }
                    if !unreadOnly && !controller.isGuest { browseRow }
                }
            } header: { foldHeader("チャンネル", folded: channelsFolded) { toggleFold("channels") } }
            if !sections.times.isEmpty || (canMakeTimes && !unreadOnly) {
                let timesFolded = folded.contains("times")
                Section {
                    ForEach(shown(sections.times, timesFolded)) { row($0) }
                    if canMakeTimes && !unreadOnly && !timesFolded { makeTimesRow }
                } header: { foldHeader("Times", folded: timesFolded) { toggleFold("times") } }
            }
            let dmsFolded = folded.contains("dms")
            Section {
                if showsNotesRow && !dmsFolded { notesRow }
                ForEach(shown(dms, dmsFolded)) { row($0) }
                if dms.isEmpty && !dmsFolded && !showsNotesRow { hint(unreadOnly ? "未読の DM はありません。" : "＋ の「ダイレクトメッセージ」から相手を選べます。") }
            } header: { foldHeader("ダイレクトメッセージ", folded: dmsFolded) { toggleFold("dms") } }
            if !browse.isEmpty {
                Section("参加できるチャンネル") {
                    ForEach(browse) { channel in
                        // M27: a tap reads the channel first (Slack); 「参加」 joins at once.
                        HStack(spacing: 10) {
                            Button { selection = channel.id } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "number").font(.system(size: 15, weight: .medium)).foregroundStyle(.secondary).frame(width: 22)
                                    Text(rowTitle(channel)).foregroundStyle(Color.primary.opacity(0.72))
                                    Spacer()
                                }
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.borderless)
                            Button("参加") { join(channel.id) }
                                .font(.footnote)
                                .buttonStyle(.borderless)
                                .frame(minWidth: 44, minHeight: 40) // a finger's target (audit 2026-09-29)
                        }
                        .listRowInsets(Self.rowInsets)
                        .listRowSeparator(.hidden)
                    }
                }
            }
        }
        // Plain and compact like Slack's (testers, 2026-09-29: widely spaced rows were hard to scan with many channels).
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 40)
        .onAppear(perform: loadFolds)
        .sheet(item: $sectionForm) { target in
            SectionFormView(controller: controller, section: target.section, preselected: target.preselected)
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

    /// M26 (Slack): a folded section still shows what is unread, and the open conversation.
    nonisolated static func shown(_ rows: [ChannelState], collapsed: Bool, meId: String?, selection: String?, now: Date = Date()) -> [ChannelState] {
        collapsed ? rows.filter { $0.id == selection || $0.hasUnread(meId: meId, now: now) } : rows
    }

    /// M26: the default sections (favorites, channels, times, dms) folded on this device, kept as one line of keys.
    nonisolated static func foldedKeys(_ raw: String) -> Set<String> { Set(raw.split(separator: " ").map(String.init)) }

    nonisolated static func toggledFold(_ raw: String, key: String) -> String {
        var keys = foldedKeys(raw)
        if keys.remove(key) == nil { keys.insert(key) }
        return keys.sorted().joined(separator: " ")
    }

    /// A section title that folds (M26): a chevron, the icon of one of my sections, and the name.
    private func foldHeader(_ title: String, icon: String? = nil, folded: Bool, toggle: @escaping () -> Void) -> some View {
        Button(action: toggle) {
            HStack(spacing: 6) {
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
                    .rotationEffect(.degrees(folded ? -90 : 0))
                SectionIcon(controller: controller, emoji: icon, size: 16)
                Text(title)
            }
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.top, 6)
            // The whole header row folds it, not only the title (the row is as wide as the list).
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(folded ? "折りたたみ中" : "展開中")
        .accessibilityHint(folded ? "開きます" : "折りたたみます")
        .accessibilityAddTraits(.isHeader)
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
                ForEach(shown(rows, section.collapsed)) { row($0) }
                if rows.isEmpty && !unreadOnly && !section.collapsed { hint("会話を長押し →「セクションに移動」で追加できます。") }
            } header: {
                sectionHeader(section, index: index, count: sections.count)
            }
        }
    }

    private func sectionHeader(_ section: SidebarSectionOut, index: Int, count: Int) -> some View {
        HStack {
            foldHeader(section.name, icon: section.emoji, folded: section.collapsed) {
                // Folds as smoothly as the default sections (testers, 2026-09-29: it opened and closed at once).
                Task { _ = await controller.setSectionCollapsed(section.id, collapsed: !section.collapsed) { change in withAnimation(.easeInOut(duration: 0.25)) { change() } } }
            }
            Spacer()
            Menu {
                Button("名前とアイコンを変更…", systemImage: "pencil") { sectionForm = SectionFormTarget(section: section) }
                Button("上へ", systemImage: "arrow.up") { Task { _ = await controller.moveSection(section.id, position: index - 1) } }.disabled(index == 0)
                Button("下へ", systemImage: "arrow.down") { Task { _ = await controller.moveSection(section.id, position: index + 1) } }.disabled(index == count - 1)
                Button("新しいセクション…", systemImage: "plus") { sectionForm = SectionFormTarget(section: nil) }
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
                // A menu shows text only: a plain emoji icon goes before the name, a custom one is left out.
                let icon = section.emoji.flatMap { CustomEmoji.name(of: $0) == nil ? "\($0) " : nil } ?? ""
                Button(icon + section.name) { Task { _ = await controller.moveToSection(channel.id, sectionId: section.id) } }
                    .disabled(current == section.id)
            }
            Button("新しいセクション…", systemImage: "plus") { sectionForm = SectionFormTarget(section: nil, preselected: [channel.id]) }
        }
        if current != nil {
            Button("セクションから外す", systemImage: "folder.badge.minus") { Task { _ = await controller.moveToSection(channel.id, sectionId: nil) } }
        }
        // M35: muted until unmuted; the level and a timed mute stay.
        if channel.channel.notification?.muted ?? false {
            Button("ミュート解除", systemImage: "bell") { Task { _ = await controller.setMuted(channel, false) } }
        } else {
            Button("ミュート", systemImage: "bell.slash") { Task { _ = await controller.setMuted(channel, true) } }
        }
    }

    /// 「チャンネルを探す」 (M11h): the browser with member counts, join / leave and create.
    private var browseRow: some View {
        Button { showBrowser = true } label: {
            HStack(spacing: 10) {
                Image(systemName: "safari").font(.system(size: 15)).foregroundStyle(.secondary).frame(width: 22)
                Text("チャンネルを探す").foregroundStyle(Color.primary.opacity(0.72))
            }
        }
        .listRowInsets(Self.rowInsets)
        .listRowSeparator(.hidden)
    }

    /// 「自分の times を作る」 (M24): POST /times, then open it.
    /// My DM with myself before it exists, like a DM row: my picture and my name.
    private var notesRow: some View {
        Button {
            guard let meId, !openingNotes else { return }
            openingNotes = true
            Task {
                if let id = await controller.openDmWith(meId) { selection = id }
                openingNotes = false
            }
        } label: {
            HStack(spacing: 10) {
                AvatarView(id: meId ?? "", name: controller.store.me?.displayName ?? "?", size: 22)
                Text(controller.store.me?.displayName ?? "…").foregroundStyle(Color.primary.opacity(0.72)).lineLimit(1)
                Spacer(minLength: 4)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(openingNotes)
        .listRowInsets(Self.rowInsets)
        .listRowSeparator(.hidden)
    }

    private var makeTimesRow: some View {
        Button { makeTimes() } label: {
            HStack(spacing: 10) {
                Image(systemName: "plus").font(.system(size: 15)).foregroundStyle(.secondary).frame(width: 22)
                Text("自分の times を作る (作業ログ)").foregroundStyle(Color.primary.opacity(0.72))
            }
        }
        .listRowInsets(Self.rowInsets)
        .listRowSeparator(.hidden)
    }

    /// One chip of the top row: an icon, a name and a count or a badge; `active` fills it.
    private func chip(_ title: String, icon: String, count: Int = 0, badge: Int = 0, alert: Bool = false, active: Bool = false,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: icon).font(.footnote.weight(.semibold))
                Text(title).font(.subheadline.weight(badge > 0 ? .semibold : .regular))
                if badge > 0 {
                    Text("\(badge)").font(.caption2.bold()).foregroundStyle(.white)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(alert ? Color.red : Color.accentColor, in: Capsule())
                } else if count > 0 {
                    Text("\(count)").font(.caption).foregroundStyle(.secondary)
                }
            }
            .foregroundStyle(active ? Color.white : Color.primary)
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(active ? Color.accentColor : Color(.secondarySystemFill), in: Capsule())
        }
        .buttonStyle(.plain)
    }

    /// The top row: the unread filter, then スレッド, メンション, 下書き and リマインダー (while any), ファイル, 保存済み.
    private var shortcutChips: some View {
        let store = controller.store
        let threads = store.threadSummary
        let drafts = store.listDrafts().count + store.scheduled.count
        let reminders = store.reminders.count, fired = store.firedReminderCount
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                chip("未読", icon: "line.3.horizontal.decrease", active: unreadOnly) { unreadOnly.toggle() }
                    .accessibilityValue(unreadOnly ? "オン" : "オフ")
                chip("スレッド", icon: "bubble.left.and.text.bubble.right",
                     badge: selection == ThreadsListView.selectionId ? 0 : threads.unreadCount, alert: threads.mentionCount > 0) {
                    selection = ThreadsListView.selectionId
                }
                // M34: mentions moved to the activity tab.
                if drafts > 0 { chip("下書き", icon: "doc.text", count: drafts) { selection = DraftsView.selectionId } }
                if reminders > 0 {
                    chip("リマインダー", icon: "alarm", count: fired > 0 ? 0 : reminders, badge: fired, alert: true) { selection = RemindersView.selectionId }
                }
                chip("ファイル", icon: "doc.on.doc") { selection = FilesView.selectionId }
                chip("保存済み", icon: "bookmark", count: store.bookmarks.count) { selection = SavedView.selectionId }
            }
            .padding(.horizontal, 16)
        }
    }

    /// The glyph already says "#", so rows show the bare channel name.
    private func rowTitle(_ channel: ChannelState) -> String {
        let title = channelTitle(channel, store: controller.store)
        return channel.channel.isDm ? title : String(title.drop(while: { $0 == "#" }))
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(.secondary).listRowInsets(Self.rowInsets).listRowSeparator(.hidden)
    }

    /// A compact row, like Slack's sidebar (a little more room than at first: testers found 34 pt too tight).
    static let rowInsets = EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16)

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
        return Button { selection = channel.id } label: {
            HStack(spacing: 10) {
                if channel.channel.isDm {
                    let other = (channel.channel.dmUserIds ?? []).first { $0 != store.me?.id } ?? store.me?.id ?? channel.id
                    AvatarView(id: other, name: store.users[other]?.displayName ?? store.me?.displayName ?? "?", size: 22, presence: store.presenceOf(other))
                } else {
                    Image(systemName: channel.channel.type == "private" ? "lock" : "number")
                        .font(.system(size: 15, weight: .medium)).foregroundStyle(.secondary)
                        .frame(width: 22).accessibilityHidden(true)
                }
                Text(rowTitle(channel))
                    .fontWeight(unread ? .semibold : .regular)
                    .foregroundStyle(unread ? Color.primary : Color.primary.opacity(0.72))
                    .lineLimit(1)
                Spacer(minLength: 4)
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
            .opacity(muted && !unread ? 0.6 : 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(Self.rowInsets)
        .listRowSeparator(.hidden)
        .contextMenu { rowMenu(channel) }
        .swipeActions(edge: .leading) {
            Button(starred(channel) ? "お気に入りから外す" : "お気に入り", systemImage: starred(channel) ? "star.slash" : "star") {
                Task { await controller.toggleFavorite(channel.id) }
            }
            .tint(.yellow)
        }
    }
}
