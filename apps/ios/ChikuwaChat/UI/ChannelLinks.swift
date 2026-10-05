import SwiftUI

/// M15f: rules shared by the link bar and its editor.
enum ChannelLinks {
    /// Only http(s) links (the server refuses the rest).
    static func validUrl(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.contains(where: \.isWhitespace), let url = URL(string: trimmed), let scheme = url.scheme?.lowercased() else { return false }
        return (scheme == "http" || scheme == "https") && !(url.host ?? "").isEmpty
    }
}

extension ChannelState {
    /// M15f: whether I may change this conversation's links (the server says the same).
    func canEditLinks(isAdmin: Bool, isGuest: Bool) -> Bool {
        isMember && !channel.archived && !isGuest && canPostTopLevel(isAdmin: isAdmin)
    }
}

/// M15f: the conversation's pinned links at the top (Slack's bookmarks bar); hidden while empty. A conversation I belong
/// to shows them in its tab row instead (ChannelTabsRow, M29).
struct ChannelLinksRow: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    let onAdd: () -> Void
    let onEdit: (ChannelLinkOut) -> Void

    var body: some View {
        if !controller.store.linksOf(channel.id).isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) { ChannelLinkChips(controller: controller, channel: channel, onAdd: onAdd, onEdit: onEdit) }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
            }
            Divider()
        }
    }
}

/// The links as chips (a tap opens one; a long press edits, moves or deletes it) and 「＋ リンク」 for those who may.
struct ChannelLinkChips: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    let onAdd: () -> Void
    let onEdit: (ChannelLinkOut) -> Void
    @Environment(\.openURL) private var openURL

    private var editable: Bool {
        channel.canEditLinks(isAdmin: controller.store.me?.role == "admin", isGuest: controller.store.me?.role == "guest")
    }

    var body: some View {
        let links = controller.store.linksOf(channel.id)
        ForEach(Array(links.enumerated()), id: \.element.id) { index, link in
            Button { if let url = URL(string: link.url) { openURL(url) } } label: {
                Label(link.title, systemImage: "link").font(.caption).lineLimit(1)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .contextMenu {
                if editable {
                    Button("編集", systemImage: "pencil") { onEdit(link) }
                    Button("左へ移動", systemImage: "arrow.left") {
                        Task { _ = await controller.updateChannelLink(channel.id, linkId: link.id, position: index - 1) }
                    }.disabled(index == 0)
                    Button("右へ移動", systemImage: "arrow.right") {
                        Task { _ = await controller.updateChannelLink(channel.id, linkId: link.id, position: index + 1) }
                    }.disabled(index == links.count - 1)
                    Button("削除", systemImage: "trash", role: .destructive) {
                        Task { _ = await controller.deleteChannelLink(channel.id, linkId: link.id) }
                    }
                }
            }
        }
        if editable {
            Button(action: onAdd) { Label("リンク", systemImage: "plus").font(.caption) }
                .buttonStyle(.borderless)
        }
    }
}

/// M29: what a conversation's body shows (Slack's tabs under the header).
enum ChannelTab: Hashable, CaseIterable {
    /// M45: the canvas second, as the desktop's phone width (CANVAS.md §4.1). M52: 「予定」 third (CALENDAR.md §7). M56:
    /// 「タスク」 after 「予定」 (TASKS.md §6).
    case messages, canvas, events, tasks, pins, files

    var title: String {
        switch self {
        case .messages: tr("メッセージ")
        case .canvas: tr("キャンバス")
        case .events: tr("予定")
        case .tasks: tr("タスク")
        case .pins: tr("ピン留め")
        case .files: tr("ファイル")
        }
    }

    /// The conversation's tabs: 「予定」 and 「タスク」 only in public and private channels (a DM has no shared calendar,
    /// CALENDAR.md §9 5., and no board, TASKS.md §2).
    static func tabs(for channel: ChannelState) -> [ChannelTab] {
        allCases.filter { ($0 != .events || AppController.hasCalendar(channel)) && ($0 != .tasks || TaskRules.hasBoard(channel)) }
    }

    /// The tab's name: 「予定 2」 while the channel has events today or tomorrow.
    func label(upcoming: Int) -> String { self == .events ? CalendarDates.eventsTabLabel(upcoming) : title }
}

/// M29: one row under the header: the tabs, then the conversation's links (the link bar moved in here).
struct ChannelTabsRow: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    @Binding var tab: ChannelTab
    /// M52: the channel's events today and tomorrow (「予定 N」).
    var upcoming = 0
    let onAddLink: () -> Void
    let onEditLink: (ChannelLinkOut) -> Void

    var body: some View {
        let hasLinks = !controller.store.linksOf(channel.id).isEmpty
            || channel.canEditLinks(isAdmin: controller.store.me?.role == "admin", isGuest: controller.store.me?.role == "guest")
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(ChannelTab.tabs(for: channel), id: \.self) { item in
                        Button { tab = item } label: {
                            Text(item.label(upcoming: upcoming))
                                .font(.subheadline.weight(tab == item ? .semibold : .regular))
                                .foregroundStyle(tab == item ? Color.primary : Color.secondary)
                                .padding(.horizontal, 6)
                                .frame(minHeight: 44)
                                .overlay(alignment: .bottom) {
                                    if tab == item { Capsule().fill(Color.accentColor).frame(height: 2) }
                                }
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityAddTraits(tab == item ? [.isSelected] : [])
                    }
                    if hasLinks {
                        Divider().frame(height: 20).padding(.horizontal, 4)
                        ChannelLinkChips(controller: controller, channel: channel, onAdd: onAddLink, onEdit: onEditLink)
                    }
                }
                .padding(.horizontal, 12)
            }
            Divider()
        }
    }
}

/// Add a link, or edit one (URL and title).
struct ChannelLinkEditor: View {
    @Bindable var controller: AppController
    let channelId: String
    let link: ChannelLinkOut?
    @Environment(\.dismiss) private var dismiss
    @State private var url = ""
    @State private var title = ""
    @State private var busy = false

    private var urlOk: Bool { ChannelLinks.validUrl(url) }
    private var trimmedTitle: String { title.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://", text: $url)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("名前（例：デザイン資料）", text: $title)
                } footer: {
                    if !url.isEmpty && !urlOk { Text("http:// か https:// で始まる URL を入れてください").foregroundStyle(.red) }
                }
            }
            .navigationTitle(link == nil ? "リンクを追加" : "リンクを編集")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(link == nil ? "追加" : "保存") {
                        busy = true
                        Task {
                            let value = url.trimmingCharacters(in: .whitespacesAndNewlines)
                            let ok = if let link {
                                await controller.updateChannelLink(channelId, linkId: link.id, title: trimmedTitle, url: value)
                            } else {
                                await controller.addChannelLink(channelId, title: trimmedTitle, url: value)
                            }
                            busy = false
                            if ok { dismiss() }
                        }
                    }
                    .disabled(busy || !urlOk || trimmedTitle.isEmpty)
                }
            }
            .onAppear {
                url = link?.url ?? ""
                title = link?.title ?? ""
            }
        }
        .presentationDetents([.medium])
    }
}
