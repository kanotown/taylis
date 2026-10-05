import SwiftUI

/// The first http(s) link in a body, outside code (M11g); nil when there is none.
enum Links {
    private static let fence = try! NSRegularExpression(pattern: "```[\\s\\S]*?```")
    private static let code = try! NSRegularExpression(pattern: "`[^`\\n]*`")
    private static let url = try! NSRegularExpression(pattern: "https?://[^\\s<>)\\]]+")
    private static let trailing = CharacterSet(charactersIn: ".,!?;:。、」』）")  // i18n-ignore

    static func first(in body: String) -> String? {
        var text = body
        for regex in [fence, code] {
            text = regex.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: (text as NSString).length), withTemplate: " ")
        }
        let ns = text as NSString
        guard let match = url.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        var found = ns.substring(with: match.range)
        while let last = found.unicodeScalars.last, trailing.contains(last) { found.removeLast() }
        return found
    }
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

    var body: some View {
        Link(destination: URL(string: preview?.url ?? url) ?? URL(string: url)!) {
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
        .buttonStyle(.plain)
    }
}
