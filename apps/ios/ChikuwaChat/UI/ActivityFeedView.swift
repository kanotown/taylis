import SwiftUI
import UIKit

/// M39, the activity tab at stage B (MOBILE_UI.md §6.4): [すべて | メンション | スレッド | リアクション] over GET /activity.
/// Since 2026-10-07 (「開いたら既読」, like Slack) looking reads nothing: an item stays unread (bold, a dot, a tinted row,
/// counted in 「未読 n 件」 and the badge) until it is opened (a tap: PUT /activity/items/read), read in its conversation
/// (a mention, a reply), done (a reservation to-do) or 「すべて既読にする」 (PUT /activity/read). A server before it (items
/// without `id`) is read the same way less the tap: its rows wait for the read position. New activity while looking
/// (the badge rises) brings the first page again.
struct ActivityFeedView: View {
    @Bindable var controller: AppController
    /// A row opens its message (in its conversation, or its thread) on the activity tab's stack.
    let onOpen: (ActivityItem) -> Void

    /// Rows per GET /activity page.
    static let pageSize = 50

    struct Page: Equatable {
        var items: [ActivityItem] = []
        var cursor: String?
        var loading = false
    }

    @State private var filter = "all"
    @State private var lists: [String: Page] = [:]
    @State private var failed = false
    /// 「未読のみ」: the rows held, less the read ones (an opened row leaves the list).
    @State private var unreadOnly = false
    @State private var visible = false
    /// Numbers each list's loads, so an older answer never replaces a newer one.
    @State private var requests: [String: Int] = [:]

    private var store: Store { controller.store }
    private var online: Bool { controller.engine?.status == .online }

    private struct LoadKey: Equatable {
        let filter: String
        let visible: Bool
        let online: Bool
    }

    var body: some View {
        let list = lists[filter]
        let unread = store.activity?.unreadCount ?? 0
        let items = ActivityRules.shown(list?.items ?? [], unreadOnly: unreadOnly, isUnread: isUnread)
        VStack(spacing: 0) {
            Picker("表示する項目", selection: $filter) {
                ForEach(ActivityRules.filters, id: \.self) { Text(ActivityRules.filterLabel($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            header(unread)
            List {
                if list == nil || (items.isEmpty && list?.loading == true && !failed) {
                    ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
                } else if items.isEmpty && !(unreadOnly && list?.cursor != nil) {
                    if failed {
                        ContentUnavailableView {
                            Label("読み込めませんでした", systemImage: "exclamationmark.triangle")
                        } actions: {
                            Button("再読み込み") { Task { await load(filter) } }
                        }
                        .listRowSeparator(.hidden)
                    } else {
                        ContentUnavailableView(unreadOnly ? tr("未読のアクティビティはありません") : ActivityRules.emptyText(filter), systemImage: "bell")
                            .listRowSeparator(.hidden)
                    }
                } else {
                    ForEach(items) { item in
                        let unread = isUnread(item)
                        Button { open(item) } label: {
                            ActivityRowView(controller: controller, item: item, unread: unread)
                        }
                        .buttonStyle(.plain)
                        .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 16))
                        .listRowBackground(unread && item.reservation?.done != true ? Color.accentColor.opacity(0.08) : nil)
                    }
                    if list?.cursor != nil {
                        Button("さらに読み込む") { Task { await load(filter, more: true) } }
                            .disabled(list?.loading == true)
                            .frame(maxWidth: .infinity)
                    }
                }
            }
            .listStyle(.plain)
            .refreshable { await load(filter) }
        }
        .navigationTitle("アクティビティ")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                // 「すべて既読にする」 (MOBILE_UI.md §6.4, 2026-10-07): in the header, not behind ⋯; nothing to read at 0.
                Button { Task { await markAllRead() } } label: {
                    Label("すべて既読にする", systemImage: "checkmark.circle")
                        .labelStyle(.titleOnly)
                }
                .disabled(unread == 0)
            }
        }
        .onAppear { visible = true }
        .onDisappear { visible = false }
        // The first page of the list on screen: when it comes on screen, on another filter and after reconnecting …
        .task(id: LoadKey(filter: filter, visible: visible, online: online)) {
            guard visible, online else { return }
            await load(filter)
        }
        // … and when new activity arrives while it is looked at (the badge rises; reading it lowers it, which loads
        // nothing).
        .onChange(of: unread) { before, now in
            if now > before, visible, online { Task { await load(filter) } }
        }
        // Review v0.1.22 #3 (CANVAS.md §20.8): activity.updated: the excerpts it names go from every list held at once,
        // and the list on screen is read again (an answer already on its way is superseded by it).
        .onChange(of: store.activityUpdates) {
            let ids = store.takeUpdatedActivityItems()
            for (key, page) in lists { lists[key]?.items = ActivityRules.blankingExcerpts(page.items, itemIds: ids) }
            if visible, online { Task { await load(filter) } }
        }
        // MOBILE_UI.md §6.4 (2026-10-06): a conversation's read position moved back (「ここから未読にする」): the mentions
        // there are unread again; the lists held are read again (the dots of moves forward follow the positions held).
        .onChange(of: store.activityReadsMovedBack) {
            lists = lists.filter { $0.key == filter }
            if visible, online { Task { await load(filter) } }
        }
    }

    /// 「未読 n 件」 (「未読はありません」 at 0) and the 「未読のみ」 switch.
    private func header(_ unread: Int) -> some View {
        HStack(spacing: 8) {
            Text(ActivityRules.unreadHeader(unread))
                .font(.footnote.weight(unread > 0 ? .semibold : .regular))
                .foregroundStyle(unread > 0 ? Color.accentColor : .secondary)
                .lineLimit(1)
            Spacer(minLength: 8)
            Button { unreadOnly.toggle() } label: {
                HStack(spacing: 5) {
                    Circle().fill(unreadOnly ? Color.accentColor : Color.secondary).frame(width: 6, height: 6)
                    Text("未読のみ")
                }
                .font(.footnote.weight(.medium))
                .foregroundStyle(unreadOnly ? Color.accentColor : .secondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(unreadOnly ? Color.accentColor.opacity(0.12) : Color.clear, in: Capsule())
                .overlay(Capsule().stroke(unreadOnly ? Color.accentColor : Color(.separator), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(unreadOnly ? .isSelected : [])
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }

    private func load(_ which: String, more: Bool = false) async {
        guard let api = controller.api else { return }
        let cursor = more ? lists[which]?.cursor : nil
        if more && cursor == nil { return }
        let request = (requests[which] ?? 0) + 1
        requests[which] = request
        lists[which, default: Page()].loading = true
        do {
            let page = try await api.listActivity(filter: which, cursor: cursor, limit: Self.pageSize)
            guard requests[which] == request else { return } // a newer load of this list answers instead
            failed = false
            let held = more ? lists[which]?.items ?? [] : []
            let items = ActivityRules.markingServerReads(page.items, readAt: page.readAt)
            lists[which] = Page(items: ActivityRules.append(held, items), cursor: page.nextCursor, loading: false)
        } catch {
            guard requests[which] == request else { return }
            lists[which, default: Page()].loading = false
            if !(error is CancellationError) {
                failed = true
                controller.error = controller.describe(error)
            }
        }
    }

    /// The row's dot (ActivityRules.isUnread): against the read position held now, the items opened here or on another
    /// device, and this device's read positions in the conversations. A to-do done has none.
    private func isUnread(_ item: ActivityItem) -> Bool {
        guard item.reservation?.done != true else { return false }
        return ActivityRules.isUnread(item, readAt: store.activity?.readAt, conversationRead: readInConversation(item),
                                      openedAt: item.itemId.flatMap { store.openedActivityItems[$0] })
    }

    /// MOBILE_UI.md §6.4 (2026-10-06): this device's read positions cover the item's message (read here, or read.updated
    /// / thread.updated from another device), so its dot goes at once, before the server's next page says so. A server
    /// before the rule (no `read`) keeps the dots to the read position, as its badge does.
    private func readInConversation(_ item: ActivityItem) -> Bool {
        guard item.read != nil else { return false }
        let message = item.message
        return ActivityRules.conversationRead(item, channelReadSeq: message.flatMap { store.channel($0.channelId)?.lastReadSeq },
                                              threadReadSeq: message?.parentId.flatMap { store.threads[$0]?.state.lastReadSeq })
    }

    /// A row opened is read until it happens again (MOBILE_UI.md §6.4, 2026-10-07): its dot goes now (up to the row's own
    /// `at`), PUT /activity/items/read gives the badge, then the row opens its message, canvas, page or reservations.
    private func open(_ item: ActivityItem) {
        for opened in ActivityRules.openable([item]) { store.noteActivityItemsRead([opened.id], readAt: opened.at) }
        Task { await controller.markActivityItemsRead([item]) }
        onOpen(item)
    }

    /// 「すべて既読にする」: everything up to now (or the newest row held, if the clock is behind), on every filter.
    private func markAllRead() async {
        let newest = ActivityRules.newest(lists.values.flatMap(\.items)).flatMap(parseIsoDate) ?? .distantPast
        let at = ISO8601DateFormatter.activity.string(from: max(Date(), newest))
        _ = await controller.markActivityRead(at)
    }
}

private extension ISO8601DateFormatter {
    static let activity: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

/// One item: who (their pictures) did what, where and when, and the message's opening words. Unread (§6.4): bold with a
/// dot (the list tints its background); read: plain.
struct ActivityRowView: View {
    @Bindable var controller: AppController
    let item: ActivityItem
    let unread: Bool

    private var store: Store { controller.store }

    var body: some View {
        let nameOf: (String) -> String = { store.users[$0]?.displayName ?? (store.me?.id == $0 ? store.me?.displayName : nil) ?? tr("メンバー") }
        let (who, what) = ActivityRules.headline(item, nameOf: nameOf)
        let conversation = item.channelId.flatMap { store.channel($0) }.map { channelTitle($0, store: store) } ?? ""
        let place = conversation.isEmpty && item.page == nil ? "" : ActivityRules.whereText(item, conversation: conversation)
        // M112: a to-do another operator handled (or no longer needed) is done: dimmed, 「対応済み」.
        let done = item.reservation?.done == true
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(unread && !done ? Color.accentColor : Color.clear)
                .frame(width: 8, height: 8)
                .padding(.top, 16)
            if item.reservation != nil {
                Text("🎫").font(.system(size: 20)).frame(width: 40, height: 40)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            } else {
                avatars(nameOf)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    HStack(spacing: 3) {
                        // §6.4 (2026-10-07): unread bold, read plain (the name medium, as the desktop's rows).
                        (Text(who).fontWeight(unread ? .bold : .medium) + Text(what).fontWeight(unread ? .semibold : .regular))
                            .foregroundStyle(unread ? Color.primary : Color.primary.opacity(0.75))
                            .lineLimit(item.kind == "canvas_mention" || item.page != nil ? 2 : 1) // the title in it
                        if item.kind == "reaction" {
                            ForEach(item.emojis, id: \.self) { ReactionGlyph(controller: controller, emoji: $0, height: 16) }
                        }
                    }
                    .font(.subheadline)
                    Spacer(minLength: 4)
                    if done { Text("対応済み").font(.caption).foregroundStyle(.secondary) }
                    Text(DMList.timeLabel(item.at) ?? "").font(.caption).foregroundStyle(.secondary)
                }
                if !place.isEmpty {
                    Text(place).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                // An empty excerpt (a canvas version's body erased, CANVAS.md §20.8) shows no line.
                if !excerpt.isEmpty {
                    CustomEmoji.excerpt(excerpt, controller: controller)
                        .font(.subheadline)
                        .foregroundStyle(unread ? .primary : .secondary)
                        .lineLimit(item.reservation != nil ? 3 : 2)
                        .strikethrough(done)
                }
            }
        }
        .opacity(done ? 0.6 : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([unread ? tr("未読") : nil, ActivityRules.headlineText(item, nameOf: nameOf), done ? tr("対応済み") : nil, place.isEmpty ? nil : place,
                             DMList.timeLabel(item.at), excerpt.isEmpty ? nil : excerpt].compactMap { $0 }.joined(separator: tr("、")))
        .accessibilityAddTraits(.isButton)
    }

    private var excerpt: String { ActivityRules.excerpt(item, users: store.users, groups: store.groups) }

    /// The first actor's picture, two overlapping for several, and the kind's small badge at the corner.
    private func avatars(_ nameOf: (String) -> String) -> some View {
        let actors = Array(item.actorIds.prefix(2))
        let first = actors.first ?? item.message?.senderId ?? ""
        return ZStack(alignment: .bottomTrailing) {
            if actors.count > 1 {
                ZStack(alignment: .topLeading) {
                    AvatarView(id: actors[0], name: nameOf(actors[0]), size: 28)
                    AvatarView(id: actors[1], name: nameOf(actors[1]), size: 28)
                        .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2).padding(-1))
                        .offset(x: 12, y: 12)
                }
                .frame(width: 40, height: 40, alignment: .topLeading)
            } else {
                AvatarView(id: first, name: nameOf(first), size: 40)
            }
            kindBadge.offset(x: 4, y: 4)
        }
        .frame(width: 40, height: 40)
    }

    @ViewBuilder
    private var kindBadge: some View {
        if item.kind == "canvas_mention" || item.page != nil {
            // M77: 📝, where a message's mention has its @ (M122: 📄 for a page).
            Text(item.page != nil ? "📄" : "📝")
                .font(.system(size: 10))
                .frame(width: 18, height: 18)
                .background(Color(.secondarySystemBackground), in: Circle())
                .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
        } else {
            symbolBadge
        }
    }

    private var symbolBadge: some View {
        let (symbol, color): (String, Color) = switch item.kind {
        case "mention": ("at", .red)
        case "thread_reply": ("bubble.left.and.bubble.right.fill", .accentColor)
        default: ("face.smiling", .orange)
        }
        return Image(systemName: symbol)
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(.white)
            .frame(width: 18, height: 18)
            .background(color, in: Circle())
            .overlay(Circle().stroke(Color(.systemBackground), lineWidth: 2))
    }
}

/// M39: the activity tab's badge is red only with a mention among its items (else gray, as on the web). SwiftUI's
/// `.badge` has no color, so the tab bar item's is set here (UIKit's badgeColor) whenever the badge changes.
struct TabBadgeTint: UIViewRepresentable {
    let index: Int
    let count: Int
    let mention: Bool

    func makeUIView(context: Context) -> UIView {
        let view = UIView()
        view.isUserInteractionEnabled = false
        return view
    }

    func updateUIView(_ view: UIView, context: Context) {
        let color: UIColor = mention ? .systemRed : .systemGray
        let index = self.index
        // After SwiftUI has applied this update's badge to the tab bar.
        DispatchQueue.main.async {
            guard let tabs = Self.tabBarController(from: view.window?.rootViewController),
                  let items = tabs.tabBar.items, items.indices.contains(index) else { return }
            if items[index].badgeColor != color { items[index].badgeColor = color }
        }
    }

    private static func tabBarController(from controller: UIViewController?) -> UITabBarController? {
        guard let controller else { return nil }
        if let tabs = controller as? UITabBarController { return tabs }
        for child in controller.children {
            if let found = tabBarController(from: child) { return found }
        }
        return nil
    }
}
