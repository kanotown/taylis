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

/// Message permalinks (M12b): `<server>/m/<message_id>`, recognised only for the server we are logged into.
enum Permalink {
    static let scheme = "chikuwa-message"
    private static let uuid = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: [.caseInsensitive])

    static func url(base: URL, messageId: String) -> String {
        var text = base.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text + "/m/" + messageId
    }

    /// The message id when `url` is a permalink on `base` (case-insensitive prefix, query / fragment ignored).
    static func messageId(base: URL?, url: String) -> String? {
        guard let base else { return nil }
        var prefix = base.absoluteString
        while prefix.hasSuffix("/") { prefix.removeLast() }
        prefix += "/m/"
        guard url.count >= prefix.count, url.prefix(prefix.count).lowercased() == prefix.lowercased() else { return nil }
        var id = String(url.dropFirst(prefix.count))
        for stop in ["/", "?", "#"] { if let range = id.range(of: stop) { id = String(id[..<range.lowerBound]) } }
        let range = NSRange(location: 0, length: (id as NSString).length)
        return uuid.firstMatch(in: id, range: range) != nil ? id.lowercased() : nil
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
    private static let uuid = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: [.caseInsensitive])

    /// The canvas id when `url` is a canvas link on `base` (case-insensitive prefix, query / fragment ignored).
    static func canvasId(base: URL?, url: String) -> String? {
        guard let base else { return nil }
        var prefix = base.absoluteString
        while prefix.hasSuffix("/") { prefix.removeLast() }
        prefix += "/c/"
        guard url.count >= prefix.count, url.prefix(prefix.count).lowercased() == prefix.lowercased() else { return nil }
        var id = String(url.dropFirst(prefix.count))
        for stop in ["/", "?", "#"] { if let range = id.range(of: stop) { id = String(id[..<range.lowerBound]) } }
        let range = NSRange(location: 0, length: (id as NSString).length)
        return uuid.firstMatch(in: id, range: range) != nil ? id.lowercased() : nil
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
    private static let uuid = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: [.caseInsensitive])

    /// The event id when `url` is an event link on `base` (case-insensitive prefix, query / fragment ignored).
    static func eventId(base: URL?, url: String) -> String? {
        guard let base else { return nil }
        var prefix = base.absoluteString
        while prefix.hasSuffix("/") { prefix.removeLast() }
        prefix += "/e/"
        guard url.count >= prefix.count, url.prefix(prefix.count).lowercased() == prefix.lowercased() else { return nil }
        var id = String(url.dropFirst(prefix.count))
        for stop in ["/", "?", "#"] { if let range = id.range(of: stop) { id = String(id[..<range.lowerBound]) } }
        let range = NSRange(location: 0, length: (id as NSString).length)
        return uuid.firstMatch(in: id, range: range) != nil ? id.lowercased() : nil
    }

    /// The in-app link put into a body's attributed text; the row's `openURL` handler opens the event.
    static func internalLink(eventId: String) -> URL? { URL(string: "\(scheme)://\(eventId)") }
}

/// M173 (docs/LENDING.md §13.5, §17.8): an equipment item's link, `<server>/eq/<item_id>` (the QR code on its label;
/// `/e/` is an event's), recognised only for the server we are logged into. It opens in 「備品」 while lending is on for
/// me; otherwise it stays a plain link (the browser's Web opens the item).
enum EquipmentLink {
    static let scheme = "chikuwa-equipment"
    private static let uuid = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: [.caseInsensitive])

    /// The item id when `url` is an equipment link on `base` (case-insensitive prefix, query / fragment ignored).
    static func itemId(base: URL?, url: String) -> String? {
        guard let base else { return nil }
        var prefix = base.absoluteString
        while prefix.hasSuffix("/") { prefix.removeLast() }
        prefix += "/eq/"
        guard url.count >= prefix.count, url.prefix(prefix.count).lowercased() == prefix.lowercased() else { return nil }
        var id = String(url.dropFirst(prefix.count))
        for stop in ["/", "?", "#"] { if let range = id.range(of: stop) { id = String(id[..<range.lowerBound]) } }
        let range = NSRange(location: 0, length: (id as NSString).length)
        return uuid.firstMatch(in: id, range: range) != nil ? id.lowercased() : nil
    }

    static func url(base: URL, itemId: String) -> String {
        var text = base.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text + "/eq/" + itemId
    }

    /// The in-app link put into a body's attributed text; the row's `openURL` handler opens the item.
    static func internalLink(itemId: String) -> URL? { URL(string: "\(scheme)://\(itemId)") }
}
