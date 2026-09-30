import SwiftUI

/// Emoji picker sheet (M11f): search by shortcode / keyword (en + ja) or browse by category.
struct EmojiPickerView: View {
    /// M12f: custom emoji shown under 「カスタム」 and found by name; a pick hands back `:name:`.
    var custom: [CustomEmojiOut] = []
    var images: [String: UIImage] = [:]
    /// The animated ones' frames (GIF), shown moving.
    var animations: [String: EmojiAnimation] = [:]
    var onNeedImage: ((CustomEmojiOut) -> Void)? = nil
    /// false where a pick is a choice rather than a use (M50's quick reaction slots): 「よく使う」 and the recents stay.
    var countsUse = true
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var category = EmojiData.categories.first?.key ?? "smileys"
    @AppStorage(EmojiUsage.recentKey) private var recentRaw = ""
    /// C10: how often each emoji was used here (EmojiUsage), for 「よく使う」.
    @AppStorage(EmojiUsage.key) private var usageRaw = ""

    private var recent: [String] { recentRaw.split(separator: " ").map(String.init).filter { !$0.isEmpty } }
    private var shown: [EmojiEntry] {
        if category == "custom" && query.trimmingCharacters(in: .whitespaces).isEmpty { return [] }
        let hits = Emoji.search(query)
        return query.trimmingCharacters(in: .whitespaces).isEmpty ? hits.filter { $0.category == category } : hits
    }
    private var customShown: [CustomEmojiOut] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if q.isEmpty { return category == "custom" ? custom : [] }
        return custom.filter { $0.name.contains(q) }
    }
    private var categories: [(key: String, label: String)] {
        let base = EmojiData.categories.map { (key: $0.key, label: $0.label) }
        return custom.isEmpty ? base : base + [(key: "custom", label: "カスタム")]
    }
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 8)

    private func pick(_ glyph: String) {
        if countsUse {
            var usage = EmojiUsage.decode(usageRaw, recent: recentRaw)
            usage.record(glyph)
            usageRaw = usage.encoded
            recentRaw = ([glyph] + recent.filter { $0 != glyph }).prefix(16).joined(separator: " ")
        }
        onPick(glyph)
        dismiss()
    }

    /// 「よく使う」 that can be shown: a custom emoji only while it exists (testers, 2026-09-29: a removed or unknown
    /// `:name:` was shown as its text, wider than its cell).
    private var frequentShown: [String] {
        EmojiUsage.decode(usageRaw, recent: recentRaw).frequent.filter { glyph in
            guard let name = CustomEmoji.name(of: glyph) else { return true }
            return custom.contains { $0.name == name }
        }
    }

    @ViewBuilder
    private func customCell(_ emoji: CustomEmojiOut) -> some View {
        Button { pick(":\(emoji.name):") } label: {
            Group {
                if let image = images[emoji.id] {
                    EmojiImage(still: image, animation: animations[emoji.id])
                } else {
                    ProgressView().controlSize(.mini)
                }
            }
            .frame(width: 30, height: 30)
            .frame(maxWidth: .infinity, minHeight: 36)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(":\(emoji.name):")
        .onAppear { onNeedImage?(emoji) }
    }

    @ViewBuilder
    private func recentCell(_ glyph: String) -> some View {
        if let name = CustomEmoji.name(of: glyph), let emoji = custom.first(where: { $0.name == name }) {
            customCell(emoji)
        } else {
            Button(glyph) { pick(glyph) }.font(.title2).frame(maxWidth: .infinity, minHeight: 36)
        }
    }

    /// Browsing by category (no search words).
    private var browsing: Bool { query.trimmingCharacters(in: .whitespaces).isEmpty }

    private func sectionTitle(_ title: String) -> some View {
        Text(title).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .accessibilityAddTraits(.isHeader)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 8) {
                if browsing {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(categories, id: \.key) { item in
                                Button(item.label) { category = item.key }
                                    .buttonStyle(.bordered).controlSize(.small)
                                    .tint(category == item.key ? Color.accentColor : Color.secondary)
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                }
                ScrollView {
                    // C10: 「よく使う」 first (Slack), scrolling with the category under it.
                    if browsing && !frequentShown.isEmpty {
                        sectionTitle("よく使う")
                        LazyVGrid(columns: columns, spacing: 4) {
                            ForEach(frequentShown, id: \.self) { recentCell($0) }
                        }
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                        sectionTitle(categories.first { $0.key == category }?.label ?? "")
                    }
                    LazyVGrid(columns: columns, spacing: 4) {
                        ForEach(customShown) { customCell($0) }
                        ForEach(shown, id: \.shortcode) { entry in
                            Button(entry.glyph) { pick(entry.glyph) }
                                .font(.title2)
                                .frame(maxWidth: .infinity, minHeight: 36)
                                .accessibilityLabel(":\(entry.shortcode):")
                        }
                    }
                    .padding(.horizontal, 16)
                    if shown.isEmpty && customShown.isEmpty { Text("見つかりません").font(.footnote).foregroundStyle(.secondary).padding() }
                }
            }
            .padding(.top, 8)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "検索 (例: tada、乾杯)")
            .navigationTitle("絵文字")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        // MOBILE_POLISH.md C4: solid, not iOS 26's glass (the conversation showed through the emoji).
        .presentationBackground(Color(.systemBackground))
    }
}
