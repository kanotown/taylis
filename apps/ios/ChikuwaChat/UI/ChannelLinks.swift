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
    /// M45: the canvas second, as the desktop's phone width (CANVAS.md §4.1). M56: 「タスク」 third (TASKS.md §6).
    /// M166 (docs/DRIVE.md §13.3): 「ドライブ」 after 「タスク」, as on the desktop.
    /// 2026-10-28 (CALENDAR.md §7): no 「予定」 tab any more (one calendar per workspace); the conversation's ⋯ and its
    /// details have 「このチャンネルの予定」, the workspace calendar filtered to the channel.
    case messages, canvas, tasks, drive, pins, files

    var title: String {
        switch self {
        case .messages: tr("メッセージ")
        case .canvas: tr("キャンバス")
        case .tasks: tr("タスク")
        case .drive: tr("ドライブ")
        case .pins: tr("ピン留め")
        case .files: tr("ファイル")
        }
    }

    /// The conversation's tabs: 「タスク」 only in public and private channels (a DM has no board, TASKS.md §2);
    /// 「ドライブ」 likewise (a DM has no drive, DRIVE.md §3.1), and only while the server has the drive (`drive`).
    static func tabs(for channel: ChannelState, drive: Bool = false) -> [ChannelTab] {
        allCases.filter { ($0 != .tasks || TaskRules.hasBoard(channel)) && ($0 != .drive || (drive && hasDrive(channel))) }
    }

    /// Public and private channels have a drive; DMs and group DMs do not.
    static func hasDrive(_ channel: ChannelState) -> Bool { channel.channel.type == "public" || channel.channel.type == "private" }
}

/// M29: one row under the header: the tabs, then the conversation's links (the link bar moved in here).
struct ChannelTabsRow: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    @Binding var tab: ChannelTab
    let onAddLink: () -> Void
    let onEditLink: (ChannelLinkOut) -> Void

    var body: some View {
        let hasLinks = !controller.store.linksOf(channel.id).isEmpty
            || channel.canEditLinks(isAdmin: controller.store.me?.role == "admin", isGuest: controller.store.me?.role == "guest")
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(ChannelTab.tabs(for: channel, drive: controller.drive?.available == true), id: \.self) { item in
                        Button { tab = item } label: {
                            Text(item.title)
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

/// A channel's topic with its links (2026-10-28, as Mattermost's channel header; the desktop's TopicText.tsx):
/// `[text](https://…)`, bare http(s) URLs and `[text](mailto:…)` are links, **bold**, _italic_, ~~strike~~ and `code`
/// keep their look, all on one line. Read through the message tokenizer's inline tokens (BodyTokenizer.tokenizeInline),
/// so only http(s) and mailto are ever links (`[x](javascript:…)` stays text). The topic is still edited as plain text.
/// A link on this server (`/m/`, `/c/`, `/p/`, `/e/`, `/d/`, `/eq/`) opens in the app, as in messages; any other one in
/// the system browser. The conversation's header shows `plain` (it is one button that opens the details, where the
/// links can be tapped).
enum TopicText {
    enum Piece: Equatable {
        case text(String), bold(String), italic(String), strike(String), code(String)
        case link(url: String, label: String?)
    }

    /// A link of this server, opened in the app.
    enum InternalLink: Equatable {
        case message(String), canvas(String), page(String), event(String), drive(String), equipment(String)
    }

    private static let mailto = try! NSRegularExpression(pattern: #"\[([^\]\n]+)\]\((mailto:[^\s()<>"]+@[^\s()<>"]+)\)"#)

    /// Only these schemes are ever links.
    static func allowed(_ url: String) -> Bool {
        let lower = url.lowercased()
        return lower.hasPrefix("http://") || lower.hasPrefix("https://") || lower.hasPrefix("mailto:")
    }

    /// The topic's pieces: the message dialect's inline tokens narrowed to these; mentions read as names, math as its
    /// text, line breaks as spaces.
    static func pieces(_ topic: String, nameOf: (String) -> String? = { _ in nil }) -> [Piece] {
        var out: [Piece] = []
        func text(_ value: String) {
            guard !value.isEmpty else { return }
            if case .text(let previous)? = out.last { out[out.count - 1] = .text(previous + value) } else { out.append(.text(value)) }
        }
        func mailtoSplit(_ value: String) {
            let ns = value as NSString
            var last = 0
            for match in mailto.matches(in: value, range: NSRange(location: 0, length: ns.length)) {
                text(ns.substring(with: NSRange(location: last, length: match.range.location - last)))
                out.append(.link(url: ns.substring(with: match.range(at: 2)), label: ns.substring(with: match.range(at: 1))))
                last = match.range.location + match.range.length
            }
            if last < ns.length { text(ns.substring(from: last)) }
        }
        let oneLine = topic.replacingOccurrences(of: #"\s*\n\s*"#, with: " ", options: .regularExpression)
        for token in BodyTokenizer.tokenizeInline(oneLine) {
            switch token {
            case .text(let value): mailtoSplit(value)
            case .bold(let value): out.append(.bold(value))
            case .italic(let value): out.append(.italic(value))
            case .strike(let value): out.append(.strike(value))
            case .code(let value): out.append(.code(value))
            case .codeBlock(let value, _): text(value)
            case .link(let url, let label):
                let lower = url.lowercased()
                if lower.hasPrefix("http://") || lower.hasPrefix("https://") { out.append(.link(url: url, label: label)) } else { text(label ?? url) }
            case .mention(let id): text("@" + (nameOf(id) ?? "unknown"))
            case .mentionGroup: text("@group")
            case .mentionAll(let target): text("@" + target)
            case .math(let tex, let display): text(display ? "$$\(tex)$$" : "$\(tex)$")
            case .newline: text(" ")
            }
        }
        return out
    }

    /// What the topic reads as without its markup (a link: its label): the conversation's header.
    static func plain(_ topic: String, nameOf: (String) -> String? = { _ in nil }) -> String {
        pieces(topic, nameOf: nameOf).map { piece in
            switch piece {
            case .text(let value), .bold(let value), .italic(let value), .strike(let value), .code(let value): value
            case .link(let url, let label): label ?? url
            }
        }.joined()
    }

    /// The pieces as one Text, the links tappable (`openURL`).
    static func text(_ pieces: [Piece]) -> Text {
        pieces.reduce(Text(verbatim: "")) { sum, piece in
            switch piece {
            case .text(let value): return sum + Text(verbatim: value)
            case .bold(let value): return sum + Text(verbatim: value).bold()
            case .italic(let value): return sum + Text(verbatim: value).italic()
            case .strike(let value): return sum + Text(verbatim: value).strikethrough()
            case .code(let value): return sum + MessageBodyView.inlineCode(value)
            case .link(let url, let label):
                var attributed = AttributedString(label ?? url)
                if allowed(url), let link = URL(string: url) { attributed.link = link }
                return sum + Text(attributed)
            }
        }
    }

    /// A link of this server (`base`), opened in the app; nil: the browser (or the mail app) opens it.
    static func internalLink(base: URL?, url: String) -> InternalLink? {
        guard base != nil, !url.lowercased().hasPrefix("mailto:") else { return nil }
        if let id = Permalink.messageId(base: base, url: url) { return .message(id) }
        if let id = CanvasLink.canvasId(base: base, url: url) { return .canvas(id) }
        if let id = PageLink.pageId(base: base, url: url) { return .page(id) }
        if let id = EventLink.eventId(base: base, url: url) { return .event(id) }
        if let id = DriveLink.itemId(base: base, url: url) { return .drive(id) }
        if let id = EquipmentLink.itemId(base: base, url: url) { return .equipment(id) }
        return nil
    }

    /// A tapped link of the topic: this server's in the app (as a message's), any other one by the system.
    @MainActor static func open(_ url: URL, controller: AppController) -> OpenURLAction.Result {
        guard allowed(url.absoluteString) else { return .discarded }
        switch internalLink(base: controller.api?.baseUrl, url: url.absoluteString) {
        case .message(let id)?: Task { await controller.openPermalink(id) }
        case .canvas(let id)?: controller.canvasLink = CanvasLinkTarget(id: id)
        case .page(let id)?: controller.pageLink = PageLinkTarget(id: id)
        case .event(let id)?: Task { await controller.openEventLink(id) }
        case .drive(let id)?:
            guard controller.drive != nil else { return .systemAction }
            Task { await controller.openDriveLink(id) }
        case .equipment(let id)?:
            if let web = controller.openEquipmentLink(id) { return .systemAction(web) }
        case nil: return .systemAction
        }
        return .handled
    }
}

/// The topic with its links (TopicText), for the channel's details.
struct TopicTextView: View {
    let controller: AppController
    let topic: String

    var body: some View {
        TopicText.text(TopicText.pieces(topic) { controller.store.users[$0]?.displayName })
            .environment(\.openURL, OpenURLAction { TopicText.open($0, controller: controller) })
    }
}
