import SwiftUI

/// The home tab's first screen (M37, MOBILE_UI.md §6.1): 「移動・検索」, the tiles, then the sections.
struct ChannelListView: View {
    @Bindable var controller: AppController
    @Binding var selection: String?
    /// M37: 「移動・検索」 and 「すべての DM」 (the DM tab), which MainView shows.
    var onJump: () -> Void = {}
    var onAllDms: () -> Void = {}
    /// The iPad's sidebar (MOBILE_UI.md §13): the row of what the detail column shows, highlighted.
    var current: String? = nil
    /// The iPad's sidebar: 「アクティビティ」 as a row (the phone has its tab).
    var activity: SidebarActivity? = nil
    struct SidebarActivity {
        let count: Int
        let mention: Bool
        let selected: Bool
        let open: () -> Void
    }
    /// M37 「未読をまとめる」 (replaces M12's 「未読だけ」 filter): unread conversations gather in a section of their own.
    @AppStorage(Self.groupUnreadKey) private var groupUnread = false
    static let groupUnreadKey = "home.groupUnread"
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

    private var channels: [ChannelState] { Array(controller.store.channels.values) }
    private var meId: String? { controller.store.me?.id ?? controller.me?.id }
    private func starred(_ channel: ChannelState) -> Bool { controller.store.favorites.contains(channel.id) }
    /// M24: the row to make my times stays until I have one; guests cannot have one.
    private var canMakeTimes: Bool {
        guard let meId, !controller.isGuest else { return false }
        return !channels.contains { $0.channel.timesOwnerId == meId }
    }
    @State private var openingNotes = false

    private var layout: HomeSections.Layout {
        let store = controller.store
        return HomeSections.build(HomeSections.Input(channels: channels, meId: meId, favorites: store.favorites, sections: store.sidebarSections,
                                                     groupUnread: groupUnread, folded: folded, title: { channelTitle($0, store: store) }))
    }

    var body: some View {
        let layout = layout
        // M34: a tap sets the selection, which the home tab turns into a screen on its stack (MainView).
        List {
            jumpBar
                .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 6, trailing: 16))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            if let activity { activityRow(activity) }
            tiles
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 8, trailing: 0))
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            // MOBILE_POLISH.md H1: a section's title is its first row, not the List's header. A plain List pins its
            // headers, and scrolled down 「チャンネル」 stuck under the translucent navigation bar over the rows going
            // behind it. As rows they go up with the list, as Slack's do.
            if !layout.unread.isEmpty {
                Section {
                    headerRow(plainHeader("未読"))
                    ForEach(layout.unread) { row($0) }
                }
            }
            // M26: a folded section keeps its unread rows; its hints and actions go.
            if !layout.favorites.isEmpty {
                let fold = folded.contains("favorites")
                Section {
                    headerRow(foldHeader("お気に入り", folded: fold) { toggleFold("favorites") })
                    ForEach(layout.favorites.rows) { row($0) }
                }
            }
            customSections(layout.custom)
            let channelsFolded = folded.contains("channels")
            Section {
                headerRow(foldHeader("チャンネル", folded: channelsFolded) { toggleFold("channels") })
                ForEach(layout.channels.rows) { row($0) }
                if !channelsFolded {
                    if layout.channels.isEmpty && !groupUnread { hint("参加中のチャンネルはありません。") }
                    if !controller.isGuest { addChannelRow }
                }
            }
            if !layout.times.isEmpty || canMakeTimes {
                let timesFolded = folded.contains("times")
                Section {
                    headerRow(HStack(spacing: 8) {
                        foldHeader("Times", folded: timesFolded) { toggleFold("times") }
                        timesFeedButton
                    })
                    ForEach(layout.times.rows) { row($0) }
                    if canMakeTimes && !timesFolded { makeTimesRow }
                }
            }
            let dmsFolded = folded.contains("dms")
            Section {
                headerRow(foldHeader("ダイレクトメッセージ", folded: dmsFolded) { toggleFold("dms") })
                if layout.notesRow { notesRow }
                ForEach(layout.dms.rows) { row($0) }
                if !dmsFolded {
                    if layout.dms.isEmpty && !layout.notesRow && !groupUnread { hint("右下の ✏️ から相手を選べます。") }
                    if layout.moreDms { allDmsRow }
                }
            }
            // Room under the last row for the ✏️ button.
            Color.clear.frame(height: 64)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .accessibilityHidden(true)
        }
        // Plain and compact like Slack's; a row is 44 pt, a finger's target (MOBILE_UI.md §6.1).
        .listStyle(.plain)
        .environment(\.defaultMinListRowHeight, 44)
        // M37 (5): the engine's resync (bootstrap, and the open conversation's catch-up); the protocol keeps things right.
        .refreshable { await controller.engine?.resync() }
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

    /// 「未読」: gathered while 「未読をまとめる」 is on, never folded (it holds only what is unread).
    private func plainHeader(_ title: String) -> some View {
        Text(title)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.top, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityAddTraits(.isHeader)
    }

    /// A section's title as the section's first row (H1): it scrolls with the rows and has the list's own background.
    private func headerRow(_ title: some View) -> some View {
        title
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 0, trailing: 16))
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
    }

    // MARK: 移動・検索 and the tiles (M37)

    /// Opens the full-screen jump view (MOBILE_UI.md §6.2).
    private var jumpBar: some View {
        Button(action: onJump) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                Text("移動・検索…").foregroundStyle(.secondary)
                Spacer(minLength: 0)
            }
            .font(.body)
            .padding(.horizontal, 12)
            .frame(minHeight: 40)
            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("移動・検索")
        .accessibilityHint("会話や人に移動するか、メッセージを検索します")
    }

    private var tiles: some View {
        let store = controller.store
        let row = HomeTile.tiles(threads: store.threadSummary, drafts: store.listDrafts().count + store.scheduled.count,
                                 saved: store.bookmarks.count, firedReminders: store.firedReminderCount)
        return ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(row) { tile in
                    Button { selection = tile.selectionId } label: { tileLabel(tile, selected: current == tile.selectionId) }
                        .buttonStyle(.plain)
                        .hoverEffect(.highlight)
                        .accessibilityLabel(tile.title)
                        .accessibilityValue(tile.accessibilityValue)
                }
            }
            .padding(.horizontal, 16)
        }
    }

    /// An icon over the name, the number beside the icon (red for a mention or a fired reminder).
    private func tileLabel(_ tile: HomeTile, selected: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: tile.icon).font(.system(size: 17, weight: .medium)).frame(height: 22)
                if let count = tile.count, count > 0 {
                    Text(count > 99 ? "99+" : "\(count)")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(tile.alert ? Color.white : Color.primary)
                        .padding(.horizontal, tile.alert ? 6 : 0)
                        .padding(.vertical, tile.alert ? 1 : 0)
                        .background(tile.alert ? Color.red : Color.clear, in: Capsule())
                }
            }
            Text(tile.title).font(.subheadline.weight(.medium)).lineLimit(1)
        }
        .foregroundStyle(Color.primary)
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .frame(minWidth: 84, alignment: .leading)
        .background(selected ? Color.accentColor.opacity(0.18) : Color(.secondarySystemFill), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .opacity(tile.dimmed && !selected ? 0.5 : 1)
        .contentShape(Rectangle())
    }

    // MARK: sidebar sections (M14f)

    @ViewBuilder
    private func customSections(_ sections: [HomeSections.Custom]) -> some View {
        ForEach(Array(sections.enumerated()), id: \.element.section.id) { index, entry in
            Section {
                headerRow(sectionHeader(entry.section, index: index, count: sections.count))
                ForEach(entry.rows.rows) { row($0) }
                if entry.rows.isEmpty && !groupUnread && !entry.section.collapsed { hint("会話を長押し →「セクションに移動」で追加できます。") }
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
                Image(systemName: "ellipsis").padding(.horizontal, 4).frame(minWidth: 32, minHeight: 32)
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

    /// An action at the end of a section: a glyph where the rows have theirs, and a name.
    private func actionRow(_ title: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon).font(.system(size: 16, weight: .medium)).foregroundStyle(.secondary).frame(width: 22)
                Text(title).foregroundStyle(Color.primary.opacity(0.72))
                Spacer(minLength: 0)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .listRowInsets(Self.rowInsets)
        .listRowSeparator(.hidden)
    }

    /// 「チャンネルを追加」: the browser (M11h), where a channel is joined or created.
    private var addChannelRow: some View {
        actionRow("チャンネルを追加", icon: "plus") { showBrowser = true }
    }

    /// 「すべての DM」: the home shows the newest few, the DM tab all of them.
    private var allDmsRow: some View {
        actionRow("すべての DM", icon: "chevron.right", action: onAllDms)
            .accessibilityHint("DM タブを開きます")
    }

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
                AvatarView(id: meId ?? "", name: controller.store.me?.displayName ?? "?", size: 22,
                           presence: meId.map { controller.store.presenceOf($0) })
                Text(controller.store.me?.displayName ?? "…").foregroundStyle(Color.primary.opacity(0.72)).lineLimit(1)
                Spacer(minLength: 4)
                StatusEmojiView(user: controller.store.me?.asPublic, controller: controller) // M38: mine too, as on the others' rows
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(openingNotes)
        .listRowInsets(Self.rowInsets)
        .listRowSeparator(.hidden)
    }

    /// L8 (TIMES_FEED.md §7): the Times feed, from the right of the section's title (folded or not). In the header's
    /// grey like the title beside it: a borderless button took the accent tint and looked selected all the time
    /// (testers, 2026-10-02).
    private var timesFeedButton: some View {
        Button { selection = TimesFeedView.selectionId } label: {
            HStack(spacing: 4) {
                Image(systemName: "newspaper").imageScale(.small)
                Text("フィード")
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .padding(.top, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Times フィード")
    }

    /// 「自分の times を作る」 (M24): POST /times, then open it.
    private var makeTimesRow: some View {
        actionRow("自分の times を作る (作業ログ)", icon: "plus") { makeTimes() }
    }

    /// The glyph already says "#", so rows show the bare channel name.
    private func rowTitle(_ channel: ChannelState) -> String {
        let title = channelTitle(channel, store: controller.store)
        return channel.channel.isDm ? title : String(title.drop(while: { $0 == "#" }))
    }

    private func hint(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(.secondary).listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            .listRowSeparator(.hidden)
    }

    /// The sidebar's open row: a tinted rounded rectangle (as a selected List row); other rows keep the list's own.
    private var currentBackground: some View {
        RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.accentColor.opacity(0.18)).padding(.horizontal, 8)
    }

    /// The sidebar's 「アクティビティ」 (the phone's tab), with its badge: red with a mention among its items.
    private func activityRow(_ activity: SidebarActivity) -> some View {
        Button(action: activity.open) {
            HStack(spacing: 10) {
                Image(systemName: "bell").font(.system(size: 16, weight: .medium)).foregroundStyle(.secondary).frame(width: 22)
                Text("アクティビティ").fontWeight(activity.count > 0 ? .semibold : .regular)
                Spacer(minLength: 4)
                if activity.count > 0 {
                    Text(activity.count > 99 ? "99+" : "\(activity.count)")
                        .font(.caption2).bold().foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(activity.mention ? Color.red : Color.accentColor, in: Capsule())
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .hoverEffect(.highlight)
        .accessibilityLabel("アクティビティ")
        .accessibilityValue(activity.count > 0 ? "未読 \(activity.count) 件" : "")
        .accessibilityAddTraits(activity.selected ? .isSelected : [])
        .listRowInsets(Self.rowInsets)
        .listRowSeparator(.hidden)
        .listRowBackground(activity.selected ? currentBackground : nil)
    }

    /// A row's insets: the row itself is 44 pt high (MOBILE_UI.md §6.1: one line, no topic).
    static let rowInsets = EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16)

    private func makeTimes() {
        Task { if let id = await controller.ensureTimes() { selection = id } }
    }

    private func row(_ channel: ChannelState) -> some View {
        let badge = channel.badgeContribution
        let muted = channel.isMuted
        let open = channel.id == selection || channel.id == current
        let unread = channel.hasUnread(meId: meId) && !open
        // M24: someone else's times with new posts but no mention: not bold, a faint dot (SYNC_PROTOCOL.md §10.5).
        let quietUnread = !unread && !open && channel.unreadCount > 0 && channel.isQuiet(meId: meId)
        let store = controller.store
        return Button { selection = channel.id } label: {
            HStack(spacing: 10) {
                if channel.channel.isDm {
                    let other = (channel.channel.dmUserIds ?? []).first { $0 != store.me?.id } ?? store.me?.id ?? channel.id
                    AvatarView(id: other, name: store.users[other]?.displayName ?? store.me?.displayName ?? "?", size: 22, presence: store.presenceOf(other))
                } else {
                    Image(systemName: channel.channel.type == "private" ? "lock" : "number")
                        .font(.system(size: 16, weight: .medium)).foregroundStyle(.secondary)
                        .frame(width: 22).accessibilityHidden(true)
                }
                Text(rowTitle(channel))
                    .fontWeight(unread ? .semibold : .regular)
                    .foregroundStyle(unread ? Color.primary : Color.primary.opacity(0.72))
                    .lineLimit(1)
                Spacer(minLength: 4)
                // The (first) other person's status; M38: mine in my DM with myself.
                if channel.channel.isDm, let statusId = (channel.channel.dmUserIds ?? []).first(where: { $0 != store.me?.id }) ?? store.me?.id {
                    StatusEmojiView(user: store.statusUser(statusId), controller: controller)
                }
                if muted { Image(systemName: "bell.slash").font(.caption).foregroundStyle(.secondary).accessibilityLabel("ミュート中") }
                if unread && badge > 0 {
                    Text("\(badge)")
                        .font(.caption2).bold().foregroundStyle(.white)
                        .padding(.horizontal, 7).padding(.vertical, 2)
                        .background(channel.channel.isDm ? Color.accentColor : Color.red, in: Capsule())
                        .accessibilityLabel(channel.channel.isDm ? "未読 \(badge) 件" : "メンション \(badge) 件")
                } else if unread {
                    Circle().fill(Color.accentColor).frame(width: 8, height: 8).accessibilityLabel("未読")
                } else if quietUnread {
                    Circle().fill(Color.secondary.opacity(0.5)).frame(width: 6, height: 6).accessibilityHidden(true)
                }
            }
            .opacity(muted && !unread ? 0.55 : 1)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(channel.id == current ? .isSelected : [])
        .hoverEffect(.highlight)
        .listRowInsets(Self.rowInsets)
        .listRowSeparator(.hidden)
        .listRowBackground(channel.id == current ? currentBackground : nil)
        .contextMenu { rowMenu(channel) }
        .swipeActions(edge: .leading) {
            Button(starred(channel) ? "お気に入りから外す" : "お気に入り", systemImage: starred(channel) ? "star.slash" : "star") {
                Task { await controller.toggleFavorite(channel.id) }
            }
            .tint(.yellow)
        }
    }
}
