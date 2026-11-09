import SwiftUI

/// Where a message link was tapped: a thread (ThreadView) or a conversation's timeline (ChannelView). Elsewhere (a
/// canvas, the search, a preview) there is none, and a link opens its conversation as before.
enum MessageLinkContext: Equatable {
    case timeline(channelId: String)
    case thread(channelId: String, parentId: String)
}

/// What a tapped message link does (user report 2026-10-21). A message shown on the same screen is scrolled to and
/// highlighted there, loading what is missing: a reply of the open thread, or its parent, in the thread (the parent sits
/// at its top); a top-level message of the open timeline in that timeline. Anything else opens its conversation (and its
/// thread, for a reply), as before. Landing the same conversation again changed nothing on screen: the open thread had
/// placed itself once and stayed where it was.
enum PermalinkJump: Equatable {
    /// Scroll the open thread `parentId` to the message.
    case thread(parentId: String)
    /// Scroll the open timeline to the message (its surroundings, as a search hit).
    case timeline
    /// Open the message's conversation (and thread).
    case open

    static func of(channelId: String, messageId: String, parentId: String?, from context: MessageLinkContext?) -> PermalinkJump {
        switch context {
        case .thread(let openChannel, let openParent)? where openChannel == channelId && (parentId == openParent || messageId == openParent):
            return .thread(parentId: openParent)
        case .timeline(let openChannel)? where openChannel == channelId && parentId == nil:
            return .timeline
        default:
            return .open
        }
    }

    /// A message of the conversation to show (any focus but a thread-only one): a thread the conversation pushed itself
    /// (`open`, its 「N 件の返信」) goes, unless the message is in that thread, so the timeline (or the reply's thread,
    /// landed over it) comes in front (2026-11-05: a link in that thread to a message of its timeline did nothing visible).
    static func closesOwnThread(open: String?, focusParentId: String?) -> Bool {
        guard let open else { return false }
        return open != focusParentId
    }

    /// The same from the thread's side (ThreadView.onRevealElsewhere): a reveal in the thread's conversation of a message
    /// that is neither in the thread nor its parent. A thread-only focus (a link between this thread's messages) never is.
    static func revealsElsewhere(_ focus: AppController.MessageFocus, channelId: String, threadParentId: String) -> Bool {
        focus.channelId == channelId && !focus.threadOnly && focus.parentId != threadParentId && focus.messageId != threadParentId
    }
}

/// What a conversation (ChannelView) shows in front as one of its messages is revealed: its tab, and the thread it pushed
/// over itself (`thread`; always nil in the split, whose thread is MainView's pane).
struct ConversationFront: Equatable {
    var tab: ChannelTab
    var thread: String?

    /// M29: a pin or a file revealed from the conversation's own 「ピン留め」 / 「ファイル」 tab: the timeline in front and
    /// a reply's thread opened over it by the conversation itself, as a list row's reveal elsewhere pushes it (MainNavigation
    /// .show). Handed on through `pendingThreadId` it opened nothing under MainView, whose binding only ever takes nil back:
    /// a file posted in a thread, opened from the conversation's 「ファイル」, showed only the conversation (2026-11-09).
    mutating func revealedFromTab(parentId: String?) {
        tab = .messages
        if let parentId { thread = parentId }
    }

    /// The conversation's message focus changed (a reveal into it from anywhere): the timeline comes in front of the tab
    /// that covered it, and a thread of its own goes unless the message is in that thread (PermalinkJump.closesOwnThread),
    /// so a reply revealed from a tab keeps the thread `revealedFromTab` opened, whichever of the two comes first.
    mutating func focused(parentId: String?) {
        tab = .messages
        if PermalinkJump.closesOwnThread(open: thread, focusParentId: parentId) { thread = nil }
    }
}

private struct MessageLinkContextKey: EnvironmentKey {
    static let defaultValue: MessageLinkContext? = nil
}

extension EnvironmentValues {
    /// Where the message rows under it are shown, for their links (PermalinkJump).
    var messageLinkContext: MessageLinkContext? {
        get { self[MessageLinkContextKey.self] }
        set { self[MessageLinkContextKey.self] = newValue }
    }
}

/// Links to the server's own things (`/m/` messages, `/c/` canvases, `/p/` pages, `/e/` events, `/d/` drive items, `/eq/`
/// equipment), apps/shared/message-links.json, as the desktop's permalink.ts parseLink: only the server signed in to, by
/// its host (any case) and port (the default one written out or not) and its path, http and https alike (2026-11-05: a link
/// written with the other scheme opened in the browser), then the UUID (any case), ending there or with `/` `?` `#`.
enum ServerLink {
    private static let uuid = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: [.caseInsensitive])
    private static let split = try! NSRegularExpression(pattern: "^(https?)://([^/?#]*)(.*)$", options: [.caseInsensitive, .dotMatchesLineSeparators])

    /// The id when `url` is `<base><path><uuid>`; `path` is the kind's, e.g. "/m/".
    static func id(base: URL?, url: String, path: String) -> String? {
        guard let base, let server = parts(base.absoluteString), let link = parts(url), link.authority == server.authority else { return nil }
        var root = server.path
        while root.hasSuffix("/") { root.removeLast() }
        let head = root + path
        guard link.path.count >= head.count, link.path.prefix(head.count).lowercased() == head.lowercased() else { return nil }
        let tail = link.path.dropFirst(head.count)
        let id = String(tail.prefix(36))
        let after = tail.dropFirst(36)
        guard uuid.firstMatch(in: id, range: NSRange(location: 0, length: (id as NSString).length)) != nil,
              after.first.map({ "/?#".contains($0) }) ?? true else { return nil }
        return id.lowercased()
    }

    /// An http(s) URL's host and port (lower case, without the scheme's default port) and the rest; nil for anything else.
    private static func parts(_ url: String) -> (authority: String, path: String)? {
        let ns = url as NSString
        guard let match = split.firstMatch(in: url, range: NSRange(location: 0, length: ns.length)) else { return nil }
        var authority = ns.substring(with: match.range(at: 2)).lowercased()
        guard !authority.isEmpty, !authority.contains("@") else { return nil } // user info: someone else's host after it
        let port = ns.substring(with: match.range(at: 1)).lowercased() == "https" ? ":443" : ":80"
        if authority.hasSuffix(port) { authority.removeLast(port.count) }
        return (authority, ns.substring(with: match.range(at: 3)))
    }
}

/// Message permalinks (M12b): `<server>/m/<message_id>`, recognised only for the server we are logged into.
enum Permalink {
    static let scheme = "chikuwa-message"

    static func url(base: URL, messageId: String) -> String {
        var text = base.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text + "/m/" + messageId
    }

    /// The message id when `url` is a permalink on `base` (case-insensitive prefix, query / fragment ignored).
    static func messageId(base: URL?, url: String) -> String? {
        ServerLink.id(base: base, url: url, path: "/m/")
    }

    /// The in-app link put into a body's attributed text; the row's `openURL` handler turns it into a reveal.
    static func internalLink(messageId: String) -> URL? { URL(string: "\(scheme)://\(messageId)") }
}

/// A person a mention names (`<@id>`), as an in-app link in a body's attributed text: the row's `openURL` handler shows
/// their profile (user request, 2026-10-06).
enum UserLink {
    static let scheme = "chikuwa-user"

    static func internalLink(userId: String) -> URL? { URL(string: "\(scheme)://\(userId)") }
}

/// M45 (CANVAS.md §4.13): canvas links, `<server>/c/<canvas_id>`, recognised only for the server we are logged into.
enum CanvasLink {
    static let scheme = "chikuwa-canvas"

    /// The canvas id when `url` is a canvas link on `base` (case-insensitive prefix, query / fragment ignored).
    static func canvasId(base: URL?, url: String) -> String? {
        ServerLink.id(base: base, url: url, path: "/c/")
    }

    static func url(base: URL, canvasId: String) -> String {
        var text = base.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text + "/c/" + canvasId
    }

    /// The in-app link put into a body's attributed text; the row's `openURL` handler opens the canvas.
    static func internalLink(canvasId: String) -> URL? { URL(string: "\(scheme)://\(canvasId)") }
}

/// Event links, `<server>/e/<event_id>` (the 「予定」 bot's announcement of a channel event), recognised only for the
/// server we are logged into.
enum EventLink {
    static let scheme = "chikuwa-event"

    /// The event id when `url` is an event link on `base` (case-insensitive prefix, query / fragment ignored).
    static func eventId(base: URL?, url: String) -> String? {
        ServerLink.id(base: base, url: url, path: "/e/")
    }

    /// The in-app link put into a body's attributed text; the row's `openURL` handler opens the event.
    static func internalLink(eventId: String) -> URL? { URL(string: "\(scheme)://\(eventId)") }
}

/// M173 (docs/LENDING.md §13.5, §17.8): an equipment item's link, `<server>/eq/<item_id>` (the QR code on its label;
/// `/e/` is an event's), recognised only for the server we are logged into. It opens in 「備品」 while lending is on for
/// me; otherwise it stays a plain link (the browser's Web opens the item).
enum EquipmentLink {
    static let scheme = "chikuwa-equipment"

    /// The item id when `url` is an equipment link on `base` (case-insensitive prefix, query / fragment ignored).
    static func itemId(base: URL?, url: String) -> String? {
        ServerLink.id(base: base, url: url, path: "/eq/")
    }

    static func url(base: URL, itemId: String) -> String {
        var text = base.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text + "/eq/" + itemId
    }

    /// The in-app link put into a body's attributed text; the row's `openURL` handler opens the item.
    static func internalLink(itemId: String) -> URL? { URL(string: "\(scheme)://\(itemId)") }
}
