import SwiftUI
import UIKit

// M185 (docs/LINK_PREVIEWS.md): the cards under a message. A link to another message on this server (`<server>/m/<id>`)
// is a card with that message as I may see it (its author, conversation, time, first lines and a photo): the server
// answers per reader (POST /messages/previews), so whoever cannot read it sees only 「表示できないメッセージ」 and nothing
// of it. A tap opens the message (the app's permalink action). The external link's Open Graph card (M11g) follows. The
// sender (or an administrator) removes a card for everyone from the message's long press, with 「元に戻す」 in the toast.

// MARK: which cards (§2, §4.1; the cases in apps/shared/link-cards.json)

enum MessageLinkCards {
    /// At most this many message cards under one message (§2 2.).
    static let messageMax = 3
    /// Lines of the excerpt a card shows (the server sends at most 6).
    static let lines = 4

    struct MessageCard: Equatable {
        /// The linked message (lower case).
        let id: String
        /// The body's first link to it, as written (what removing the card sends).
        let url: String
    }

    struct Selection: Equatable {
        /// The linked messages, each once, in the body's order, at most `messageMax`.
        var messages: [MessageCard] = []
        /// The link whose Open Graph card shows (M11g), or nil.
        var external: String? = nil
    }

    private static let keyPattern = try! NSRegularExpression(pattern: #"^(https?)://([^/?#\s]+)([^#\s]*)(#\S*)?$"#, options: [.caseInsensitive])

    /// §4.1: the key a removed card is kept under (`MessageOut.hidden_previews`): scheme and host in lower case, the
    /// fragment dropped, "/" before an empty path, the rest as written. Plain string work, the same on the server and the
    /// other clients; nil for anything but an http(s) URL.
    static func previewKey(_ url: String) -> String? {
        let text = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let ns = text as NSString
        guard let match = keyPattern.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        let scheme = ns.substring(with: match.range(at: 1)).lowercased()
        let host = ns.substring(with: match.range(at: 2)).lowercased()
        let rest = ns.substring(with: match.range(at: 3))
        return "\(scheme)://\(host)\(rest.hasPrefix("/") ? rest : "/" + rest)"
    }

    /// §2: the cards a body shows. A link to a message on `base` is a message card: up to `messageMax` distinct messages,
    /// not the message itself (`selfId`). The first other link that is not a drive link (its own card, M166), nor a
    /// canvas, event or page link of this server (they open in the app and never had an Open Graph card here), gets the
    /// Open Graph card, unless the message announces a call (M117: its card stands for the link). A card whose link's key
    /// is in `hidden` is left out, and nothing takes its place.
    static func of(body: String, base: URL?, selfId: String? = nil, hidden: [String] = [], call: Bool = false) -> Selection {
        let hidden = Set(hidden)
        func shown(_ url: String) -> Bool { !hidden.contains(previewKey(url) ?? url) }
        let me = selfId?.lowercased()
        var seen: [String] = []
        var messages: [MessageCard] = []
        var external: String?
        for url in Links.all(in: body) {
            if let id = Permalink.messageId(base: base, url: url) {
                if id == me || seen.contains(id) { continue }
                seen.append(id)
                if seen.count <= messageMax { messages.append(MessageCard(id: id, url: url)) }
                continue
            }
            if external == nil, !isAppLink(url, base: base) { external = url }
        }
        return Selection(messages: messages.filter { shown($0.url) },
                         external: external.flatMap { !call && shown($0) ? $0 : nil })
    }

    /// The cards of a row: none while it is being sent, once deleted, or without text.
    static func of(_ message: MessageState, base: URL?) -> Selection {
        guard !message.pending, !message.deleted, !message.isSystem, !message.body.isEmpty else { return Selection() }
        return of(body: message.body, base: base, selfId: message.id, hidden: message.hiddenPreviews, call: message.call != nil)
    }

    /// A link of this server with a card or chip of its own (not an Open Graph card).
    private static func isAppLink(_ url: String, base: URL?) -> Bool {
        DriveLink.itemId(base: base, url: url) != nil || CanvasLink.canvasId(base: base, url: url) != nil
            || EventLink.eventId(base: base, url: url) != nil || PageLink.pageId(base: base, url: url) != nil
    }

    /// §4.3: who may remove a message's cards (for everyone): its sender or an administrator, once it is sent, not in a
    /// channel read before joining (M27). The server checks the same (and that the conversation is not archived).
    static func canRemove(_ message: MessageState, meId: String?, isAdmin: Bool, readOnly: Bool) -> Bool {
        guard !readOnly, !message.pending, !message.failed, message.seq != nil, !message.deleted, !message.isSystem else { return false }
        return (meId != nil && message.senderId == meId) || isAdmin
    }

    // MARK: what a card shows (§5)

    /// The excerpt as the card shows it: each line as plain text (as a one-line preview: markers dropped, mentions as
    /// names), blank lines left out, at most `lines` of them, 「…」 when anything was left out.
    static func excerptText(_ excerpt: String, truncated: Bool, users: [String: UserPublic], groups: [String: GroupOut] = [:],
                            lines: Int = lines) -> String {
        let rows = excerpt.components(separatedBy: "\n")
            .map { Timeline.plainText(Mentions.toNames($0, users: users, groups: groups), limit: 400) }
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        let text = rows.prefix(lines).joined(separator: "\n")
        return !text.isEmpty && (truncated || rows.count > lines) ? text + "…" : text
    }

    /// The card's text: the excerpt, or what was sent (「画像を送信しました」) without one. `live`: the linked message as
    /// this device holds it (its conversation loaded), so an edit shows at once.
    static func cardText(_ preview: MessagePreviewOut, live: MessageState?, users: [String: UserPublic], groups: [String: GroupOut] = [:]) -> String {
        if let live {
            let text = excerptText(live.body, truncated: false, users: users, groups: groups)
            return text.isEmpty ? Timeline.attachmentText(live.attachments) : text
        }
        let text = excerptText(preview.excerpt, truncated: preview.excerptTruncated, users: users, groups: groups)
        return text.isEmpty ? Timeline.attachmentText(contentTypes: preview.attachmentTypes, count: preview.attachmentCount) : text
    }

    /// The server's rule for the thumbnail (§3.2), for a message held here: the first photo or video poster not moved
    /// out of the channel's drive.
    static func thumbnail(_ attachments: [AttachmentOut]) -> String? {
        attachments.first { ($0.hasThumbnail || $0.hasPoster) && ($0.drive == nil || $0.drive?.state == "available") }?.id
    }

    /// Where the linked message is: `#name` for a channel (the server's name: a public channel I have not joined is not
    /// in my list), the other people for a DM from my list (I am in it), else 「ダイレクトメッセージ」; 「#name のスレッド」
    /// for a thread reply.
    @MainActor
    static func conversation(_ preview: MessagePreviewOut, channel: ChannelState?, store: Store) -> String {
        let name: String
        if preview.channelType == "public" || preview.channelType == "private" {
            name = "#" + (preview.channelName ?? channel?.channel.name ?? "")
        } else if let channel {
            name = channelTitle(channel, store: store)
        } else {
            name = directMessageLabel
        }
        return preview.parentId != nil ? tr("\(name) のスレッド") : name
    }

    static var directMessageLabel: String {
        tr(LocalizedStringResource("linkCards.directMessage", defaultValue: "ダイレクトメッセージ"))  // i18n-ignore: keyed (linkCards.directMessage)
    }

    static var undoLabel: String {
        tr(LocalizedStringResource("linkCards.undo", defaultValue: "元に戻す"))  // i18n-ignore: keyed (linkCards.undo)
    }

    /// 「今日 10:24」, 「昨日 9:05」, 「9月26日 (金) 14:05」: the day separator's words and a 24-hour time, as the desktop's.
    static func timeLabel(_ iso: String?, now: Date = Date(), calendar: Calendar = .current) -> String? {
        guard let iso, let date = parseIsoDate(iso) else { return nil }
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return Timeline.dayLabel(date, now: now, calendar: calendar) + " " + String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
}

// MARK: asking the server (§3.3)

/// What the server said of each linked message this session, and when. A card asks when its row comes on screen: the
/// ids asked within `gather` go in one POST /messages/previews, `batch` at a time. An answer is fresh for `freshFor` (an
/// edit of the linked message shows when the card is drawn after that; meanwhile the old card stays); a failure (offline,
/// 429) shows no card and is not asked again for `retryAfter`. Kept by the account's Store.
@MainActor
@Observable
final class MessagePreviews {
    static let batch = 20
    static let gather: Duration = .milliseconds(30)
    static let freshFor: TimeInterval = 5 * 60
    static let retryAfter: TimeInterval = 60

    struct Entry: Equatable {
        /// The last answer; nil when only a failure is known.
        var preview: MessagePreviewOut?
        var at: Date
        /// The last request failed then.
        var failedAt: Date? = nil
    }

    private(set) var entries: [String: Entry] = [:]
    @ObservationIgnored private var queue: [String] = []
    @ObservationIgnored private var asking: Set<String> = []
    @ObservationIgnored private var flushing: Task<Void, Never>?
    @ObservationIgnored private var api: ApiClient?
    /// The clock (a test moves it).
    @ObservationIgnored var now: () -> Date = { Date() }

    /// Whether the card should be asked for: never answered, answered `freshFor` ago, or failed `retryAfter` ago.
    func wanted(_ id: String) -> Bool {
        guard let entry = entries[id] else { return true }
        let now = now()
        if let failedAt = entry.failedAt, now.timeIntervalSince(failedAt) < Self.retryAfter { return false }
        guard entry.preview != nil else { return true }
        return now.timeIntervalSince(entry.at) >= Self.freshFor
    }

    func request(_ id: String, api: ApiClient?) {
        guard let api, !asking.contains(id), !queue.contains(id), wanted(id) else { return }
        self.api = api
        queue.append(id)
        guard flushing == nil else { return }
        flushing = Task { [weak self] in
            try? await Task.sleep(for: Self.gather)
            await self?.flush()
        }
    }

    /// Sends what is queued, `batch` ids per request, one request after the other.
    func flush() async {
        flushing = nil
        guard let api else { return }
        let ids = queue
        queue = []
        for start in stride(from: 0, to: ids.count, by: Self.batch) {
            let chunk = Array(ids[start..<min(start + Self.batch, ids.count)])
            asking.formUnion(chunk)
            do {
                let items = try await api.messagePreviews(ids: chunk)
                let at = now()
                var next = entries
                for item in items { next[item.id] = Entry(preview: item, at: at) }
                entries = next
            } catch {
                // Rate limited or offline: no card for now (the link in the text still opens the message); a card shown
                // before stays.
                let at = now()
                var next = entries
                for id in chunk { next[id, default: Entry(preview: nil, at: at)].failedAt = at }
                entries = next
            }
            asking.subtract(chunk)
        }
    }
}

/// What a message card shows now.
enum MessageCardSlot: Equatable {
    /// Not answered yet: the card's frame.
    case loading
    case card(MessagePreviewOut)
    case deleted
    case unavailable
    /// The request failed (and nothing was known before): no card.
    case none

    static func of(_ entry: MessagePreviews.Entry?) -> MessageCardSlot {
        guard let entry else { return .loading }
        guard let preview = entry.preview else { return entry.failedAt != nil ? .none : .loading }
        switch preview.state {
        case "ok": return .card(preview)
        case "deleted": return .deleted
        default: return .unavailable
        }
    }
}

/// A card the message's long press can remove (its link, and what the choice says when there are several).
struct ShownLinkCard: Equatable {
    let url: String
    let label: String
}

extension AppController {
    func requestMessagePreview(_ id: String) { store.messagePreviews.request(id, api: api) }

    func messageCardSlot(_ id: String) -> MessageCardSlot { .of(store.messagePreviews.entries[id]) }

    func canRemovePreviews(_ message: MessageState, readOnly: Bool) -> Bool {
        MessageLinkCards.canRemove(message, meId: store.me?.id, isAdmin: isAdmin, readOnly: readOnly)
    }

    /// The cards the message shows now, in their order (message cards, then the Open Graph card): what 「プレビューを
    /// 削除」 offers. A card that failed to load, or a link without a preview, shows nothing and is not offered.
    func shownCards(_ message: MessageState) -> [ShownLinkCard] {
        let selection = MessageLinkCards.of(message, base: api?.baseUrl)
        var cards: [ShownLinkCard] = []
        for card in selection.messages {
            switch messageCardSlot(card.id) {
            case .none: continue
            case .loading: cards.append(ShownLinkCard(url: card.url, label: tr("メッセージを読み込み中…")))
            case .deleted: cards.append(ShownLinkCard(url: card.url, label: tr("削除されたメッセージ")))
            case .unavailable: cards.append(ShownLinkCard(url: card.url, label: tr("表示できないメッセージ")))
            case .card(let preview):
                let senderId = preview.senderId ?? ""
                let label = store.blockedUsers.contains(senderId)
                    ? tr("ブロック中のユーザーのメッセージ")
                    : (store.users[senderId]?.displayName ?? "?") + " · "
                        + MessageLinkCards.conversation(preview, channel: preview.channelId.flatMap { store.channel($0) }, store: store)
                cards.append(ShownLinkCard(url: card.url, label: label))
            }
        }
        if let link = selection.external, autoLoadsLinkPreview(message) || revealedPreviews.contains(message.id) {
            switch linkPreviewSlot(link) {
            case .card(let preview):
                cards.append(ShownLinkCard(url: link, label: preview.title ?? preview.siteName ?? LinkPreviewCard.host(link)))
            case .placeholder: cards.append(ShownLinkCard(url: link, label: LinkPreviewCard.host(link)))
            case .none: break
            }
        }
        return cards
    }

    /// §4: removes a link's card from my message for everyone (or brings it back). The answer (a new updated_seq)
    /// replaces the row here; message.updated brings it to my other devices and everyone else. Removing says so, with
    /// 「元に戻す」; no confirmation first.
    @discardableResult
    func setPreviewHidden(_ message: MessageState, url: String, hidden: Bool) async -> Bool {
        guard let api else { return false }
        do {
            _ = store.upsertMessage(try await api.setPreviewHidden(messageId: message.id, url: url, hidden: hidden))
            if hidden {
                let text = tr("プレビューを削除しました")
                noticeAction = NoticeAction(notice: text, label: MessageLinkCards.undoLabel) { [weak self] in
                    Task { await self?.setPreviewHidden(message, url: url, hidden: false) }
                }
                notice = text
            }
            return true
        } catch {
            self.error = describe(error)
            return false
        }
    }
}

// MARK: the cards (§5)

/// A message link's card: as tall as a header line and two lines of text whatever its state, so a card whose answer
/// comes later fills the frame it had (the M11g card's lesson: rows that grew made the conversation jump).
struct MessageLinkCard: View {
    static let thumbnailSide: CGFloat = 56
    static let maxWidth: CGFloat = 560

    @Bindable var controller: AppController
    let messageId: String
    /// The removal, for VoiceOver's actions (nil: I may not remove it). Sighted, it is the message's long press.
    var onRemove: (() -> Void)? = nil
    /// Where the row is shown: a link to a message on the same screen scrolls there (PermalinkJump).
    @Environment(\.messageLinkContext) private var linkContext

    var body: some View {
        let slot = controller.messageCardSlot(messageId)
        if slot != .none {
            face(slot)
                .accessibilityActions {
                    if let onRemove { Button("プレビューを削除", action: onRemove) }
                }
        }
    }

    @ViewBuilder
    private func face(_ slot: MessageCardSlot) -> some View {
        switch slot {
        case .card(let preview):
            Button { Task { await controller.openPermalink(preview.id, from: linkContext) } } label: {
                ReadableMessageCard(controller: controller, preview: preview)
            }
            .buttonStyle(.plain)
            .accessibilityHint("メッセージを開く")
        case .deleted:
            CardShell(alignment: .leading) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "trash").foregroundStyle(.secondary)
                    Text("削除されたメッセージ").foregroundStyle(.secondary)
                }
                .font(.subheadline)
            }
            .accessibilityElement(children: .combine)
        case .unavailable:
            // Not a button: nothing to open, and nothing of the message is shown.
            CardShell(alignment: .leading) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Image(systemName: "lock").foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("表示できないメッセージ").font(.subheadline.weight(.medium))
                        Text("このメッセージを見る権限が無いか、見つかりません。").font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .font(.subheadline)
            }
            .accessibilityElement(children: .combine)
        case .loading, .none:
            CardShell(alignment: .leading) {
                HStack(spacing: 6) {
                    Circle().fill(Color.secondary.opacity(0.18)).frame(width: 18, height: 18)
                    Text("メッセージを読み込み中…").font(.caption).foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }
}

/// A readable card: the author's picture and name, the conversation and the time, then the first lines (and a photo).
/// Someone I blocked (MODERATION.md §4): no picture, name, text or photo, 「ブロック中のユーザーのメッセージ」.
private struct ReadableMessageCard: View {
    let controller: AppController
    let preview: MessagePreviewOut

    var body: some View {
        let store = controller.store
        let senderId = preview.senderId ?? ""
        let blocked = store.blockedUsers.contains(senderId)
        let name = store.users[senderId]?.displayName ?? "?"
        // The message as this device holds it (its conversation loaded): an edit shows at once.
        let live = preview.channelId.flatMap { store.message($0, id: preview.id) }
        let place = MessageLinkCards.conversation(preview, channel: preview.channelId.flatMap { store.channel($0) }, store: store)
        let thumbnail = blocked ? nil : live.map { MessageLinkCards.thumbnail($0.attachments) } ?? preview.thumbnailAttachmentId
        CardShell(trailing: thumbnail.map { id in AnyView(CardThumbnail(controller: controller, attachmentId: id)) }) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    if !blocked {
                        AvatarView(id: senderId, name: name, size: 18)
                        Text(name).font(.caption.weight(.semibold)).foregroundStyle(Color.primary).lineLimit(1)
                    }
                    Text(place).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    if let time = MessageLinkCards.timeLabel(preview.createdAt ?? live?.createdAt) {
                        Text(time).font(.caption).monospacedDigit().foregroundStyle(.secondary).lineLimit(1).fixedSize()
                    }
                }
                .frame(minHeight: 18)
                if blocked {
                    Text("ブロック中のユーザーのメッセージ").font(.footnote).italic().foregroundStyle(.secondary)
                } else {
                    CustomEmoji.excerpt(MessageLinkCards.cardText(preview, live: live, users: store.users, groups: store.groups),
                                        controller: controller, height: CustomEmoji.scaled(12, .footnote))
                        .font(.footnote)
                        .foregroundStyle(Color.primary)
                        .lineLimit(MessageLinkCards.lines)
                        .multilineTextAlignment(.leading)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The card's outline (a thin line, no accent bar: tester, 2026-09-30) around its content, at least a header line and
/// two lines of text high, with the photo at the right.
private struct CardShell<Content: View>: View {
    var trailing: AnyView? = nil
    /// A one-line state (deleted, unreadable, loading) sits in the middle of the frame.
    var alignment: Alignment = .topLeading
    @ViewBuilder let content: Content

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ZStack(alignment: alignment) {
                // The least height, in the text's own sizes (Dynamic Type).
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: "A").font(.caption).frame(minHeight: 18)
                    Text(verbatim: "A\nA").font(.footnote)
                }
                .hidden()
                .accessibilityHidden(true)
                content
            }
            .frame(maxWidth: .infinity, alignment: .topLeading)
            if let trailing { trailing }
        }
        .padding(10)
        .frame(maxWidth: MessageLinkCard.maxWidth, alignment: .leading)
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color(.separator), lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}

/// The linked message's photo (its thumbnail, kept with the albums' while there is room).
private struct CardThumbnail: View {
    let controller: AppController
    let attachmentId: String
    @State private var image: UIImage?

    var body: some View {
        ZStack {
            Color.secondary.opacity(0.12)
            if let image { Image(uiImage: image).resizable().scaledToFill() }
        }
        .frame(width: MessageLinkCard.thumbnailSide, height: MessageLinkCard.thumbnailSide)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .accessibilityHidden(true)
        .task(id: attachmentId) {
            image = AlbumThumbnails.shared.image(attachmentId)
            if image == nil { image = await AlbumThumbnails.shared.load(attachmentId, pixels: 512, controller: controller) }
        }
    }
}
