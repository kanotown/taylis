import SwiftUI
import UIKit

/// What the app hands to the system to open from a server's string (2026-11-16, a hostile-server review): http and https
/// with a host, and mailto where the UI means an address (a document's links). Anything else (tel:, sms:, facetime:,
/// shortcuts:, another app's scheme, file:) is refused: a tap on what a server sent must not start a call or run
/// another app's action. Channel bookmarks, link cards, calls, PDF links and Quick Look go through it.
enum ExternalLink {
    static func isAllowed(_ url: URL, mail: Bool = false) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        if scheme == "http" || scheme == "https" { return url.host?.isEmpty == false }
        return mail && scheme == "mailto"
    }

    /// The URL of `text` when it may be opened; nil otherwise (not a URL, or refused).
    static func url(_ text: String, mail: Bool = false) -> URL? {
        guard let url = URL(string: text), isAllowed(url, mail: mail) else { return nil }
        return url
    }

    /// Opens `url` with the system (Safari, Mail, a universal link's app) when it is allowed; false when refused.
    @MainActor @discardableResult
    static func open(_ url: URL, mail: Bool = false) -> Bool {
        guard isAllowed(url, mail: mail) else { return false }
        UIApplication.shared.open(url)
        return true
    }
}

/// The links a body shows (M11g, M166, M185).
enum Links {
    static func first(in body: String) -> String? { all(in: body).first }

    /// Every link in order: the links its tokenizer reads (2026-11-05, apps/shared/link-cards.json body_keys): a
    /// `[label](url)` link's URL and the bare URLs as far as they go (apps/shared/inline-format.json: not the closing mark
    /// or the Japanese after them, so 「…/m/<id>」を見て is a message card, not a card of a broken URL); none in code or in
    /// emphasis. A body's message, drive and Open Graph cards (MessageLinkCards, DriveLink.ids).
    static func all(in body: String) -> [String] {
        let key = body as NSString
        if let hit = cache.object(forKey: key) { return hit.urls }
        let urls = BodyTokenizer.tokenize(body).compactMap { token -> String? in
            if case .link(let url, _) = token { return url } else { return nil }
        }
        cache.setObject(Found(urls), forKey: key, cost: key.length)
        return urls
    }

    /// Once per body (2026-11-16): a row asks for its links on every evaluation (its cards, its drive links).
    private final class Found {
        let urls: [String]
        init(_ urls: [String]) { self.urls = urls }
    }

    private static let cache: NSCache<NSString, Found> = {
        let cache = NSCache<NSString, Found>()
        cache.countLimit = 600
        cache.totalCostLimit = 4_000_000
        return cache
    }()
}

/// What a row shows under its body for its link (M11g). A card that came in after the row was laid out made the rows
/// above it jump as a conversation opened (testers, 2026-10-01): until the preview is known the row holds a card of the
/// same height (the card's height does not depend on the page), and previews are kept with the account (Store).
enum LinkPreviewSlot: Equatable {
    case card(LinkPreviewOut)
    /// Not known yet: the card's frame, filled in when the preview comes.
    case placeholder
    case none

    /// `known`: the store's entry (nil = never asked; .some(nil) = the page gives none). `failed`: the request failed
    /// this session (offline, rate limited): no card rather than a frame that stays empty.
    static func of(_ known: LinkPreviewOut??, failed: Bool) -> LinkPreviewSlot {
        switch known {
        case .some(.some(let preview)): .card(preview)
        case .some(.none): .none
        case .none: failed ? .none : .placeholder
        }
    }

    /// The server keeps a preview 7 days and a page without one 1 day (SECURITY.md §14); kept longer here, it is shown
    /// as it is and asked for again.
    static let okFor: TimeInterval = 7 * 24 * 3600
    static let noneFor: TimeInterval = 24 * 3600
    /// The newest this many previews stay with the account.
    static let kept = 500

    static func stale(savedAt: Date?, ok: Bool, now: Date) -> Bool {
        guard let savedAt else { return true }
        return now.timeIntervalSince(savedAt) > (ok ? okFor : noneFor)
    }
}

/// A preview as the account's database keeps it (Store, meta "preview:<url>").
struct StoredLinkPreview: Codable, Equatable {
    var preview: LinkPreviewOut?
    var savedAt: TimeInterval
}

/// Review v0.1.18 #5: whether a row asks the server for its link's preview by itself. The server GETs the URL to
/// make the card, so a link an AI bot wrote (a prompt injection can make it put the conversation into the URL) would be
/// sent out without anyone tapping it. Such rows show the link plainly with 「プレビューを表示」 instead, and the
/// preview is asked for only on that tap.
///
/// Decided by the sender at render time, so stored and re-synced messages behave the same:
/// - an AI bot (`aiBotIds`, from GET /ai/status) → no;
/// - any `role = bot` sender → no, whether or not the AI status is known yet. That covers an AI bot before the status
///   has come (and a disabled agent, which leaves the status), and also incoming webhooks and scheduled posts (their
///   cards are one tap away). Deciding by role alone keeps the row's height fixed when the status arrives later;
/// - except (M98) a channel's feed bot (`botKind` "feed", not an AI agent): its links are the entries of feeds the
///   channel's members registered (SECURITY.md §14), so they load as a person's do;
/// - anyone else (an unknown sender too) → yes, as before.
enum LinkPreviewRules {
    static func autoLoads(senderId: String, senderRole: String?, senderBotKind: String? = nil, aiBotIds: Set<String>) -> Bool {
        !aiBotIds.contains(senderId) && (senderRole != "bot" || senderBotKind == "feed")
    }
}

/// The link of a row whose preview is not asked for by itself (LinkPreviewRules): the link as a plain line and, unless
/// `offer` is false, 「プレビューを表示」. One line whatever the link, so the row's height is final from the start.
struct LinkPreviewOffer: View {
    let url: String
    var offer = true
    let reveal: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "link").font(.caption).foregroundStyle(.secondary)
            if let destination = URL(string: url) {
                Link(destination: destination) {
                    Text(url).font(.footnote).lineLimit(1).truncationMode(.middle)
                }
            } else {
                Text(url).font(.footnote).lineLimit(1).truncationMode(.middle)
            }
            Spacer(minLength: 0)
            if offer {
                Button("プレビューを表示", action: reveal)
                    .font(.caption)
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .fixedSize()
            }
        }
        .padding(.top, 2)
    }
}

/// Open Graph card under a message for its first link (M11g). The row asks for the preview (MessageRow): this view is
/// only the card. It is always as tall as a site line, two title lines and two description lines, whatever the page
/// gives, so the frame shown while the preview is on its way (`preview` nil) has the card's height.
struct LinkPreviewCard: View {
    /// nil: not come yet.
    let preview: LinkPreviewOut?
    let url: String
    static let imageSide: CGFloat = 64

    /// The link's host without "www.", for a page that names no site.
    static func host(_ url: String) -> String {
        guard let host = URL(string: url)?.host() else { return url }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    /// What a tap opens: the message's own link, never the preview's `url` (the server's answer), and only http(s)
    /// (ExternalLink). nil for a link the system cannot read (`https://a:b:c`, `https://[x`: the tokenizer takes them as
    /// links): the card then has no tap. It was force-unwrapped, and any member could stop every iPhone that showed such
    /// a message (2026-11-16).
    static func destination(_ url: String) -> URL? { ExternalLink.url(url) }

    var body: some View {
        if let destination = Self.destination(url) {
            Link(destination: destination) { card }
                .buttonStyle(.plain)
        } else {
            card
        }
    }

    private var card: some View {
        // A plain outlined card, the site first (tester, 2026-09-30: the accent bar at the left looked
        // "AI-like"); the same on the desktop and Android.
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(preview?.siteName ?? Self.host(preview?.url ?? url)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if let preview {
                    Text(preview.title ?? " ").font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                        .lineLimit(2, reservesSpace: true)
                    Text(preview.description ?? " ").font(.footnote).foregroundStyle(.secondary).lineLimit(2, reservesSpace: true)
                } else {
                    Text("リンクのプレビュー").font(.subheadline.weight(.semibold)).lineLimit(2, reservesSpace: true)
                        .redacted(reason: .placeholder)
                    Text(" ").font(.footnote).lineLimit(2, reservesSpace: true)
                }
            }
            Spacer(minLength: 0)
            if let image = preview?.imageUrl, let imageUrl = URL(string: image) {
                AsyncImage(url: imageUrl) { phase in
                    if let image = phase.image { image.resizable().scaledToFill() } else { Color.clear }
                }
                .frame(width: Self.imageSide, height: Self.imageSide)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
        }
        .frame(minHeight: Self.imageSide, alignment: .top)
        .padding(10)
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color(.separator), lineWidth: 1))
        .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
    }
}
