import SwiftUI

/// Full-text search: the server filters by membership; we highlight the keywords it matched.
struct SearchView: View {
    @Bindable var controller: AppController
    let onOpen: (MessageOut) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var hits: [SearchHit] = []
    @State private var keywords: [String] = []
    @State private var hasMore = false
    @State private var searched = false
    @State private var filters: SearchFilters?

    var body: some View {
        NavigationStack {
            List {
                // M15h: a hint adds its modifier; a complete one (has:file, is:thread …) searches right away.
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(SearchHints.all, id: \.insert) { hint in
                            Button(hint.label) {
                                query = SearchHints.append(query, hint.insert)
                                if hint.complete { Task { await run(offset: 0) } }
                            }
                            .font(.caption)
                            .buttonStyle(.bordered)
                            .controlSize(.mini)
                        }
                    }
                }
                .listRowSeparator(.hidden)
                if let filters, !filters.unresolved.isEmpty {
                    Text("見つからない条件があります: \(filters.unresolved.joined(separator: " "))").font(.footnote).foregroundStyle(.red)
                }
                if let filters, filters.fromUsername != nil || filters.inChannel != nil || filters.after != nil || filters.before != nil
                    || !(filters.has ?? []).isEmpty || filters.isThread == true {
                    HStack(spacing: 6) {
                        if let name = filters.fromUsername { Text("from: @\(name)") }
                        if let name = filters.inChannel { Text("in: #\(name)") }
                        if let after = filters.after, let date = parseIsoDate(after) { Text(date.formatted(date: .abbreviated, time: .omitted) + " 以降") }
                        if let before = filters.before, let date = parseIsoDate(before) { Text(date.formatted(date: .abbreviated, time: .omitted) + " より前") }
                        ForEach(filters.has ?? [], id: \.self) { flag in Text(SearchHints.flagLabels[flag] ?? "has:\(flag)") }
                        if filters.isThread == true { Text("スレッド内") }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }
                if searched && hits.isEmpty { Text("見つかりませんでした").foregroundStyle(.secondary) }
                ForEach(hits) { hit in
                    let message = hit.message
                    Button {
                        onOpen(message)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(spacing: 8) {
                                Text(controller.store.channel(message.channelId).map { channelTitle($0, store: controller.store) } ?? "?").bold()
                                Text(controller.store.users[message.senderId]?.displayName ?? "?").foregroundStyle(.secondary)
                                if message.parentId != nil { Text("スレッド").font(.caption).foregroundStyle(.secondary) }
                            }
                            .font(.caption)
                            Text(SearchHighlighter.attributed(message.body.isEmpty ? message.attachments.map(\.filename).joined(separator: ", ") : message.body, keywords: keywords))
                                .lineLimit(4)
                        }
                    }
                    .buttonStyle(.plain)
                }
                if hasMore { Button("さらに読み込む") { Task { await run(offset: hits.count) } } }
            }
            .listStyle(.plain)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "メッセージを検索")
            .onSubmit(of: .search) { Task { await run(offset: 0) } }
            .navigationTitle("検索")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
        }
    }

    private func run(offset: Int) async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty, let api = controller.api else { return }
        do {
            let result = try await api.searchMessages(q, offset: offset)
            hits = offset == 0 ? result.hits : hits + result.hits
            keywords = result.keywords
            hasMore = result.hasMore
            filters = result.filters
            searched = true
        } catch {
            controller.error = String(describing: error)
        }
    }
}

/// M15h: the modifiers offered above the results (same list as the desktop).
enum SearchHints {
    struct Hint { let label: String; let insert: String; let complete: Bool }

    static let all: [Hint] = [
        Hint(label: "from:@名前", insert: "from:@", complete: false),
        Hint(label: "in:#チャンネル", insert: "in:#", complete: false),
        Hint(label: "on:", insert: "on:", complete: false),
        Hint(label: "ファイルあり", insert: "has:file", complete: true),
        Hint(label: "リンクあり", insert: "has:link", complete: true),
        Hint(label: "ピン留め", insert: "has:pin", complete: true),
        Hint(label: "リアクションあり", insert: "has:reaction", complete: true),
        Hint(label: "投票", insert: "has:poll", complete: true),
        Hint(label: "スレッド", insert: "is:thread", complete: true),
    ]

    static let flagLabels = ["file": "ファイルあり", "link": "リンクあり", "pin": "ピン留め", "reaction": "リアクションあり", "poll": "投票"]

    /// Adds a modifier to the query (once); open ones such as "from:@" stay ready for typing.
    static func append(_ query: String, _ insert: String) -> String {
        if query.split(whereSeparator: \.isWhitespace).contains(Substring(insert)) { return query }
        let base = query.replacingOccurrences(of: #"\s+$"#, with: "", options: .regularExpression)
        let open = insert.hasSuffix(":") || insert.hasSuffix("@") || insert.hasSuffix("#")
        return (base.isEmpty ? "" : base + " ") + insert + (open ? "" : " ")
    }
}

/// Client-side keyword highlighting (the server only returns the keywords PGroonga matched).
enum SearchHighlighter {
    /// Sorted, non-overlapping ranges of every case-insensitive keyword occurrence, as UTF-16 offsets.
    static func ranges(in text: String, keywords: [String]) -> [Range<Int>] {
        let lower = text.lowercased() as NSString
        var found: [Range<Int>] = []
        for keyword in keywords.map({ $0.lowercased() }).filter({ !$0.isEmpty }).sorted(by: { $0.count > $1.count }) {
            var search = NSRange(location: 0, length: lower.length)
            while search.location < lower.length {
                let range = lower.range(of: keyword, options: [], range: search)
                if range.location == NSNotFound { break }
                found.append(range.location..<(range.location + range.length))
                search = NSRange(location: range.location + range.length, length: lower.length - range.location - range.length)
            }
        }
        found.sort { $0.lowerBound < $1.lowerBound }
        var merged: [Range<Int>] = []
        for range in found {
            if let last = merged.last, range.lowerBound <= last.upperBound {
                if range.upperBound > last.upperBound { merged[merged.count - 1] = last.lowerBound..<range.upperBound }
            } else {
                merged.append(range)
            }
        }
        return merged
    }

    static func attributed(_ text: String, keywords: [String]) -> AttributedString {
        var result = AttributedString(text)
        for range in ranges(in: text, keywords: keywords) {
            guard let swiftRange = Range(NSRange(location: range.lowerBound, length: range.count), in: text) else { continue }
            if let lower = AttributedString.Index(swiftRange.lowerBound, within: result), let upper = AttributedString.Index(swiftRange.upperBound, within: result) {
                result[lower..<upper].backgroundColor = .yellow.opacity(0.4)
                result[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
            }
        }
        return result
    }
}
