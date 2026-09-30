import SwiftUI

/// The first http(s) link in a body, outside code (M11g); nil when there is none.
enum Links {
    private static let fence = try! NSRegularExpression(pattern: "```[\\s\\S]*?```")
    private static let code = try! NSRegularExpression(pattern: "`[^`\\n]*`")
    private static let url = try! NSRegularExpression(pattern: "https?://[^\\s<>)\\]]+")
    private static let trailing = CharacterSet(charactersIn: ".,!?;:。、」』）")

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

/// Open Graph card under a message for its first link (M11g). The row shows it once the preview has come, and asks for
/// the preview itself (MessageRow): this view is only the card.
struct LinkPreviewCard: View {
    let preview: LinkPreviewOut
    let url: String

    /// The link's host without "www.", for a page that names no site.
    static func host(_ url: String) -> String {
        guard let host = URL(string: url)?.host() else { return url }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }

    var body: some View {
        Link(destination: URL(string: preview.url) ?? URL(string: url)!) {
            // A plain outlined card, the site first (tester, 2026-09-30: the accent bar at the left looked
            // "AI-like"); the same on the desktop and Android.
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(preview.siteName ?? Self.host(preview.url)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    if let title = preview.title { Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(2) }
                    if let description = preview.description { Text(description).font(.footnote).foregroundStyle(.secondary).lineLimit(2) }
                }
                Spacer(minLength: 0)
                if let image = preview.imageUrl, let imageUrl = URL(string: image) {
                    AsyncImage(url: imageUrl) { phase in
                        if let image = phase.image { image.resizable().scaledToFill() } else { Color.clear }
                    }
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
            }
            .padding(10)
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Color(.separator), lineWidth: 1))
            .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}
