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

/// Open Graph card under a message for its first link (M11g); nothing while loading or when the page had no data.
struct LinkPreviewCard: View {
    @Bindable var controller: AppController
    let url: String

    var body: some View {
        Group {
            if let entry = controller.linkPreviews[url], let preview = entry {
                Link(destination: URL(string: preview.url) ?? URL(string: url)!) {
                    HStack(alignment: .top, spacing: 10) {
                        VStack(alignment: .leading, spacing: 2) {
                            if let site = preview.siteName { Text(site.uppercased()).font(.caption2).foregroundStyle(.secondary) }
                            if let title = preview.title { Text(title).font(.subheadline).bold().foregroundStyle(.primary).lineLimit(2) }
                            if let description = preview.description { Text(description).font(.footnote).foregroundStyle(.secondary).lineLimit(3) }
                        }
                        Spacer(minLength: 0)
                        if let image = preview.imageUrl, let imageUrl = URL(string: image) {
                            AsyncImage(url: imageUrl) { phase in
                                if let image = phase.image { image.resizable().scaledToFill() } else { Color.clear }
                            }
                            .frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                    }
                    .padding(10)
                    .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .overlay(alignment: .leading) { RoundedRectangle(cornerRadius: 2).fill(Color.accentColor.opacity(0.6)).frame(width: 3).padding(.vertical, 6) }
                }
                .buttonStyle(.plain)
            }
        }
        .task(id: url) { await controller.loadLinkPreview(url) }
    }
}
