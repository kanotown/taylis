import SwiftUI

/// Emoji picker sheet (M11f): search by shortcode / keyword (en + ja) or browse by category.
struct EmojiPickerView: View {
    /// M12f: custom emoji shown under 「カスタム」 and found by name; a pick hands back `:name:`.
    var custom: [CustomEmojiOut] = []
    var images: [String: UIImage] = [:]
    /// The animated ones' frames (GIF), shown moving.
    var animations: [String: EmojiAnimation] = [:]
    var onNeedImage: ((CustomEmojiOut) -> Void)? = nil
    /// M100: a tab per pack (its tab icon by "id:version", else its first emoji) after 「カスタム」.
    var packs: [EmojiPackOut] = []
    var packTabs: [String: UIImage] = [:]
    var onNeedPackTab: ((EmojiPackOut) -> Void)? = nil
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
        if (category == "custom" || pack != nil) && query.trimmingCharacters(in: .whitespaces).isEmpty { return [] }
        let hits = Emoji.search(query)
        return query.trimmingCharacters(in: .whitespaces).isEmpty ? hits.filter { $0.category == category } : hits
    }
    /// The pack whose tab is open (M100).
    private var pack: EmojiPackOut? {
        guard category.hasPrefix("pack:") else { return nil }
        return packs.first { "pack:\($0.id)" == category }
    }
    private func inOrder(_ rows: [CustomEmojiOut]) -> [CustomEmojiOut] {
        rows.sorted { (($0.position ?? 0), $0.name) < (($1.position ?? 0), $1.name) }
    }
    /// Searching: every custom emoji by name, label and keywords (M100); 「カスタム」: the ungrouped ones; a pack's tab: its own.
    private var customShown: [CustomEmojiOut] {
        let q = query.trimmingCharacters(in: .whitespaces)
        if !q.isEmpty { return Emoji.customCandidates(q, custom: custom, limit: 40) }
        if category == "custom" {
            let packIds = Set(packs.map(\.id))
            return inOrder(custom.filter { $0.packId.map { !packIds.contains($0) } ?? true })
        }
        if let pack { return inOrder(custom.filter { $0.packId == pack.id }) }
        return []
    }
    private var categories: [(key: String, label: String)] {
        let base = EmojiData.categories.map { (key: $0.key, label: $0.label) }
        return custom.isEmpty ? base : base + [(key: "custom", label: "カスタム")]
    }
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 8)
    /// A pack's emoji are illustrations: four to a row, twice the cell (M100).
    private let bigColumns = Array(repeating: GridItem(.flexible(), spacing: 6), count: 4)
    private var big: Bool { pack != nil && browsing }

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
        EmojiUsage.shown(EmojiUsage.decode(usageRaw, recent: recentRaw).frequent, customNames: Set(custom.map(\.name)))
    }

    @ViewBuilder
    private func customCell(_ emoji: CustomEmojiOut, side: CGFloat = 30) -> some View {
        Button { pick(":\(emoji.name):") } label: {
            Group {
                if let image = images[emoji.id] {
                    EmojiImage(still: image, animation: animations[emoji.id])
                } else {
                    ProgressView().controlSize(.mini)
                }
            }
            .frame(width: side, height: side)
            .frame(maxWidth: .infinity, minHeight: side + 6)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(emoji.label.map { "\($0) :\(emoji.name):" } ?? ":\(emoji.name):")
        .onAppear { onNeedImage?(emoji) }
    }

    /// M100: a text emoji as its pill, as wide as its label.
    @ViewBuilder
    private func textCell(_ emoji: CustomEmojiOut) -> some View {
        let size = CustomEmoji.size(of: emoji, height: 24)
        Button { pick(":\(emoji.name):") } label: {
            Group {
                if let image = images[emoji.id] { Image(uiImage: image).resizable().scaledToFit() } else { Color.clear }
            }
            .frame(width: size.width, height: size.height)
            .padding(4)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(emoji.label ?? ":\(emoji.name):")
        .onAppear { onNeedImage?(emoji) }
    }

    /// A pack's tab (M100): its icon, else its first emoji, else its name.
    @ViewBuilder
    private func packTab(_ pack: EmojiPackOut) -> some View {
        let selected = category == "pack:\(pack.id)"
        Button { category = "pack:\(pack.id)" } label: {
            Group {
                if let version = pack.tabVersion, let image = packTabs["\(pack.id):\(version)"] {
                    Image(uiImage: image).resizable().scaledToFit().frame(height: 22)
                } else if let first = inOrder(custom.filter { $0.packId == pack.id }).first, let image = images[first.id] {
                    Image(uiImage: image).resizable().scaledToFit().frame(height: 22)
                } else {
                    Text(pack.name).font(.caption)
                }
            }
            .frame(minWidth: 28)
        }
        .buttonStyle(.bordered).controlSize(.small)
        .tint(selected ? Color.accentColor : Color.secondary)
        .accessibilityLabel(pack.name)
        .onAppear {
            onNeedPackTab?(pack)
            if pack.tabVersion == nil, let first = inOrder(custom.filter { $0.packId == pack.id }).first { onNeedImage?(first) }
        }
    }

    @ViewBuilder
    private func recentCell(_ glyph: String) -> some View {
        if let name = CustomEmoji.name(of: glyph) {
            // frequentShown keeps only known ones; one gone meanwhile shows nothing rather than its text.
            if let emoji = custom.first(where: { $0.name == name }) { customCell(emoji) }
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
                            ForEach(packs) { packTab($0) }
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
                    let texts = customShown.filter(\.isText)
                    if !texts.isEmpty {
                        // M100: text emoji as pills in a wrapping row of their own.
                        ChipsLayout(spacing: 4) { ForEach(texts) { textCell($0) } }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16)
                    }
                    if big {
                        LazyVGrid(columns: bigColumns, spacing: 6) {
                            ForEach(customShown.filter { !$0.isText }) { customCell($0, side: 64) }
                        }
                        .padding(.horizontal, 16)
                    }
                    LazyVGrid(columns: columns, spacing: 4) {
                        if !big { ForEach(customShown.filter { !$0.isText }) { customCell($0) } }
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
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "検索 (例: tada、乾杯、ありがとう)")
            .navigationTitle("絵文字")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        // MOBILE_POLISH.md C4: solid, not iOS 26's glass (the conversation showed through the emoji).
        .presentationBackground(Color(.systemBackground))
    }
}
