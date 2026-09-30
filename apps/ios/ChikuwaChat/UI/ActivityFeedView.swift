import SwiftUI
import UIKit

/// M39, the activity tab at stage B (MOBILE_UI.md §6.4): [すべて | メンション | スレッド | リアクション] over GET /activity.
/// The dots compare with the read position as it was when the tab came on screen, so they stay while looking; once the
/// newest row of 「すべて」 has been on screen a moment it counts as read (PUT /activity/read) and the badge clears. New
/// activity while looking (the badge rises) brings the first page again.
struct ActivityFeedView: View {
    @Bindable var controller: AppController
    /// A row opens its message (in its conversation, or its thread) on the activity tab's stack.
    let onOpen: (ActivityItem) -> Void

    /// Rows per GET /activity page.
    static let pageSize = 50
    /// How long the rows stay on screen before the activity counts as read up to the newest of them.
    static let readDelay: Duration = .milliseconds(1500)

    struct Page: Equatable {
        var items: [ActivityItem] = []
        var cursor: String?
        var loading = false
    }

    @Environment(\.scenePhase) private var scenePhase
    @State private var filter = "all"
    @State private var lists: [String: Page] = [:]
    @State private var failed = false
    /// The read position the dots compare with: taken when the view comes on screen, and by 「すべて既読」.
    @State private var seenFrom: String?
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

    private struct ReadKey: Equatable {
        let onScreen: Bool
        let filter: String
        let newest: String?
        let readAt: String?
    }

    var body: some View {
        let list = lists[filter]
        let items = list?.items ?? []
        let unread = store.activity?.unreadCount ?? 0
        let onScreen = visible && scenePhase == .active
        VStack(spacing: 0) {
            Picker("表示する項目", selection: $filter) {
                ForEach(ActivityRules.filters, id: \.self) { Text(ActivityRules.filterLabel($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            List {
                if list == nil || (items.isEmpty && list?.loading == true && !failed) {
                    ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
                } else if items.isEmpty {
                    if failed {
                        ContentUnavailableView {
                            Label("読み込めませんでした", systemImage: "exclamationmark.triangle")
                        } actions: {
                            Button("再読み込み") { Task { await load(filter) } }
                        }
                        .listRowSeparator(.hidden)
                    } else {
                        ContentUnavailableView(ActivityRules.emptyText(filter), systemImage: "bell")
                            .listRowSeparator(.hidden)
                    }
                } else {
                    ForEach(items) { item in
                        Button { onOpen(item) } label: {
                            ActivityRowView(controller: controller, item: item, unread: ActivityRules.isUnread(item, readAt: seenFrom))
                        }
                        .buttonStyle(.plain)
                        .listRowInsets(EdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 16))
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
                Menu {
                    Button("すべて既読", systemImage: "checkmark.circle") { Task { await markAllRead() } }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("アクティビティのメニュー")
            }
        }
        .onAppear {
            // On screen again: the dots start from the read position now (what was seen last time is read).
            seenFrom = store.activity?.readAt
            visible = true
        }
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
        // Being on screen reads the activity up to the newest row shown, on 「すべて」 only (ActivityRules.readsOnScreen);
        // the rows' dots stay until the view is left.
        .task(id: ReadKey(onScreen: onScreen, filter: filter, newest: ActivityRules.newest(items), readAt: store.activity?.readAt)) {
            let newest = ActivityRules.newest(items)
            guard onScreen, ActivityRules.readsOnScreen(filter: filter), ActivityRules.moves(newest, readAt: store.activity?.readAt), let newest else { return }
            try? await Task.sleep(for: Self.readDelay)
            guard !Task.isCancelled else { return }
            _ = await controller.markActivityRead(newest)
        }
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
            if seenFrom == nil { seenFrom = page.readAt }
            let held = more ? lists[which]?.items ?? [] : []
            lists[which] = Page(items: ActivityRules.append(held, page.items), cursor: page.nextCursor, loading: false)
        } catch {
            guard requests[which] == request else { return }
            lists[which, default: Page()].loading = false
            if !(error is CancellationError) {
                failed = true
                controller.error = controller.describe(error)
            }
        }
    }

    /// ⋯ 「すべて既読」: everything up to now (or the newest row held, if the clock is behind), on every filter.
    private func markAllRead() async {
        let newest = ActivityRules.newest(lists.values.flatMap(\.items)).flatMap(parseIsoDate) ?? .distantPast
        let at = ISO8601DateFormatter.activity.string(from: max(Date(), newest))
        if await controller.markActivityRead(at) { seenFrom = store.activity?.readAt ?? at }
    }
}

private extension ISO8601DateFormatter {
    static let activity: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
}

/// One item: who (their pictures) did what, where and when, and the message's opening words.
struct ActivityRowView: View {
    @Bindable var controller: AppController
    let item: ActivityItem
    let unread: Bool

    private var store: Store { controller.store }

    var body: some View {
        let nameOf: (String) -> String = { store.users[$0]?.displayName ?? (store.me?.id == $0 ? store.me?.displayName : nil) ?? "メンバー" }
        let (who, what) = ActivityRules.headline(item, nameOf: nameOf)
        let conversation = store.channel(item.message.channelId).map { channelTitle($0, store: store) } ?? ""
        let place = conversation.isEmpty ? "" : ActivityRules.whereText(item, conversation: conversation)
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(unread ? Color.accentColor : Color.clear)
                .frame(width: 8, height: 8)
                .padding(.top, 16)
            avatars(nameOf)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    HStack(spacing: 3) {
                        (Text(who).fontWeight(.semibold) + Text(what))
                            .lineLimit(1)
                        if item.kind == "reaction" {
                            ForEach(item.emojis, id: \.self) { SectionIcon(controller: controller, emoji: $0, size: 16) }
                        }
                    }
                    .font(.subheadline)
                    Spacer(minLength: 4)
                    Text(DMList.timeLabel(item.at) ?? "").font(.caption).foregroundStyle(.secondary)
                }
                if !place.isEmpty {
                    Text(place).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(item.kind == "reaction" ? "「\(excerpt)」" : excerpt)
                    .font(.subheadline)
                    .foregroundStyle(unread ? .primary : .secondary)
                    .lineLimit(2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([unread ? "未読" : nil, ActivityRules.headlineText(item, nameOf: nameOf), place.isEmpty ? nil : place,
                             DMList.timeLabel(item.at), excerpt].compactMap { $0 }.joined(separator: "、"))
        .accessibilityAddTraits(.isButton)
    }

    private var excerpt: String {
        let message = item.message
        if message.deleted { return "(削除されたメッセージ)" }
        if message.body.isEmpty && !message.attachments.isEmpty { return message.attachments.map(\.filename).joined(separator: ", ") }
        return Timeline.excerpt(message.body, hasAttachments: !message.attachments.isEmpty, users: store.users, groups: store.groups)
    }

    /// The first actor's picture, two overlapping for several, and the kind's small badge at the corner.
    private func avatars(_ nameOf: (String) -> String) -> some View {
        let actors = Array(item.actorIds.prefix(2))
        let first = actors.first ?? item.message.senderId
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

    private var kindBadge: some View {
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
