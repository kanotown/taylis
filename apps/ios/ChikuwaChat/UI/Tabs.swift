import SwiftUI

/// M34 (MOBILE_UI.md §5): the phone's four tabs, each with its own stack of screens.
enum MainTab: Hashable {
    case home, dms, activity, you
}

/// A screen on a tab's stack: a conversation (a channel or a DM, or a public channel's preview), or one of the lists
/// (its `selectionId`: threads, saved, files, drafts, reminders, mentions).
enum MainRoute: Hashable {
    case channel(String)
    case list(String)
}

/// The tab badges (the same rules on the three clients, IMPLEMENTATION_PLAN.md M34 (6)). Pure over the store's
/// conversations; the unread rule itself is ChannelState.hasUnread (unchanged).
enum TabBadges {
    /// DM: the conversations with someone (or myself) that count as unread.
    static func dms(_ channels: [ChannelState], meId: String?, now: Date = Date()) -> Int {
        channels.filter { $0.isMember && $0.channel.isDm && $0.hasUnread(meId: meId, now: now) }.count
    }

    /// Activity: followed threads with unread replies, plus channels (not DMs) where I am mentioned; red with a mention.
    static func activity(_ channels: [ChannelState], threads: ThreadSummary) -> (count: Int, mention: Bool) {
        let mentioned = channels.filter { $0.isMember && !$0.channel.isDm && $0.mentionCount > 0 }.count
        return (threads.unreadCount + mentioned, mentioned > 0 || threads.mentionCount > 0)
    }

    /// Home: a dot while a channel (not a DM) counts as unread.
    static func homeDot(_ channels: [ChannelState], meId: String?, now: Date = Date()) -> Bool {
        channels.contains { $0.isMember && !$0.channel.isDm && $0.hasUnread(meId: meId, now: now) }
    }
}

/// M34 (MOBILE_UI.md §6.3): the DM tab's list and its time labels.
enum DMList {
    /// My notes to self first, then the newest conversation first.
    static func ordered(_ channels: [ChannelState], meId: String?) -> [ChannelState] {
        channels.filter { $0.isMember && $0.channel.isDm }.sorted { a, b in
            let selfA = isNotesToSelf(a, meId: meId), selfB = isNotesToSelf(b, meId: meId)
            if selfA != selfB { return selfA }
            let lastA = a.channel.lastMessageAt ?? a.channel.createdAt, lastB = b.channel.lastMessageAt ?? b.channel.createdAt
            return lastA > lastB
        }
    }

    static func isNotesToSelf(_ channel: ChannelState, meId: String?) -> Bool {
        (channel.channel.dmUserIds ?? []).allSatisfy { $0 == meId }
    }

    /// 「14:32」 today, 「昨日」, 「火曜日」 within the week, 「9/3」 this year, 「2025/9/3」 before.
    static func timeLabel(_ iso: String?, now: Date = Date(), calendar: Calendar = .current) -> String? {
        guard let iso, let date = parseIsoDate(iso) else { return nil }
        let days = calendar.dateComponents([.day], from: calendar.startOfDay(for: date), to: calendar.startOfDay(for: now)).day ?? 0
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .weekday], from: date)
        switch days {
        case ...0: return String(format: "%d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        case 1: return "昨日"
        case 2...6: return ["日", "月", "火", "水", "木", "金", "土"][((parts.weekday ?? 1) - 1) % 7] + "曜日"
        default:
            let thisYear = calendar.component(.year, from: now)
            return parts.year == thisYear ? "\(parts.month ?? 1)/\(parts.day ?? 1)" : "\(parts.year ?? thisYear)/\(parts.month ?? 1)/\(parts.day ?? 1)"
        }
    }
}

/// The DM tab: my conversations with people, newest first, a name filter and 「新しいメッセージ」.
struct DMListView: View {
    @Bindable var controller: AppController
    let onOpen: (String) -> Void
    let onNew: () -> Void
    @State private var filter = ""

    private var store: Store { controller.store }

    var body: some View {
        let meId = store.me?.id
        let rows = DMList.ordered(Array(store.channels.values), meId: meId).filter { channel in
            let query = filter.trimmingCharacters(in: .whitespaces).lowercased()
            return query.isEmpty || channelTitle(channel, store: store).lowercased().contains(query)
        }
        List {
            if rows.isEmpty {
                ContentUnavailableView(filter.isEmpty ? "ダイレクトメッセージはまだありません" : "見つかりません", systemImage: "bubble.left.and.bubble.right",
                                       description: Text("右上の「新しいメッセージ」から始められます。"))
                    .listRowSeparator(.hidden)
            }
            ForEach(rows) { channel in
                Button { onOpen(channel.id) } label: { row(channel, meId: meId) }
                    .buttonStyle(.plain)
            }
        }
        .listStyle(.plain)
        .searchable(text: $filter, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "DM を絞り込む")
        .navigationTitle("DM")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: onNew) { Image(systemName: "square.and.pencil") }.accessibilityLabel("新しいメッセージ")
            }
        }
    }

    private func row(_ channel: ChannelState, meId: String?) -> some View {
        let others = (channel.channel.dmUserIds ?? []).filter { $0 != meId }
        let avatarId = others.first ?? meId ?? channel.id
        let unread = channel.hasUnread(meId: meId)
        let badge = channel.badgeContribution
        return HStack(spacing: 12) {
            AvatarView(id: avatarId, name: store.users[avatarId]?.displayName ?? store.me?.displayName ?? "?", size: 36,
                       presence: others.count == 1 ? store.presenceOf(avatarId) : nil)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(channelTitle(channel, store: store)).fontWeight(unread ? .semibold : .regular).lineLimit(1)
                    if others.count == 1 { StatusEmojiView(user: store.users[avatarId]) }
                    Spacer(minLength: 4)
                    if let time = DMList.timeLabel(channel.channel.lastMessageAt) {
                        Text(time).font(.caption).foregroundStyle(.secondary)
                    }
                }
                if others.count > 1 {
                    Text("\(others.count + 1) 人").font(.caption).foregroundStyle(.secondary)
                }
            }
            if unread && badge > 0 {
                Text("\(badge)").font(.caption2).bold().foregroundStyle(.white)
                    .padding(.horizontal, 7).padding(.vertical, 2)
                    .background(Color.accentColor, in: Capsule())
            }
        }
        .padding(.vertical, 6)
        .frame(minHeight: 56)
        .contentShape(Rectangle())
        .opacity(channel.isMuted && !unread ? 0.6 : 1)
    }
}

/// The activity tab, stage A (MOBILE_UI.md §6.4): mentions and followed threads, from the existing lists.
struct ActivityView: View {
    @Bindable var controller: AppController
    let onOpenMention: (MessageOut) -> Void
    @State private var segment = "mentions"

    var body: some View {
        VStack(spacing: 0) {
            Picker("表示", selection: $segment) {
                Text("メンション").tag("mentions")
                Text("スレッド").tag("threads")
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            if segment == "mentions" {
                MentionsView(controller: controller, onOpen: onOpenMention, embedded: true)
            } else {
                ThreadsListView(controller: controller, embedded: true)
            }
        }
        .navigationTitle("アクティビティ")
        .navigationBarTitleDisplayMode(.inline)
    }
}
