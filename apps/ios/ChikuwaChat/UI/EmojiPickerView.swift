import SwiftUI

/// Emoji picker sheet (M11f): search by shortcode / keyword (en + ja) or browse by category.
struct EmojiPickerView: View {
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var category = EmojiData.categories.first?.key ?? "smileys"
    @AppStorage("emoji.recent") private var recentRaw = ""

    private var recent: [String] { recentRaw.split(separator: " ").map(String.init).filter { !$0.isEmpty } }
    private var shown: [EmojiEntry] {
        let hits = Emoji.search(query)
        return query.trimmingCharacters(in: .whitespaces).isEmpty ? hits.filter { $0.category == category } : hits
    }
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 8)

    private func pick(_ glyph: String) {
        recentRaw = ([glyph] + recent.filter { $0 != glyph }).prefix(16).joined(separator: " ")
        onPick(glyph)
        dismiss()
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 8) {
                if query.trimmingCharacters(in: .whitespaces).isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(EmojiData.categories, id: \.key) { item in
                                Button(item.label) { category = item.key }
                                    .buttonStyle(.bordered).controlSize(.small)
                                    .tint(category == item.key ? Color.accentColor : Color.secondary)
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                    if !recent.isEmpty {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("最近").font(.caption2).foregroundStyle(.secondary)
                            LazyVGrid(columns: columns, spacing: 4) {
                                ForEach(recent, id: \.self) { glyph in
                                    Button(glyph) { pick(glyph) }.font(.title2)
                                }
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                }
                ScrollView {
                    LazyVGrid(columns: columns, spacing: 4) {
                        ForEach(shown, id: \.shortcode) { entry in
                            Button(entry.glyph) { pick(entry.glyph) }
                                .font(.title2)
                                .accessibilityLabel(":\(entry.shortcode):")
                        }
                    }
                    .padding(.horizontal, 16)
                    if shown.isEmpty { Text("見つかりません").font(.footnote).foregroundStyle(.secondary).padding() }
                }
            }
            .padding(.top, 8)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "検索 (例: tada、乾杯)")
            .navigationTitle("絵文字")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}
