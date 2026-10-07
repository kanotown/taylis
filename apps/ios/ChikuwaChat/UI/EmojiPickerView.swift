import SwiftUI

/// The emoji picker's browsing layout (docs/EMOJI.md §9, Slack's): every emoji in one scrolling list, grouped by
/// category — 「よく使う」, 「カスタム」, a section per pack (M100), then the standard categories — under headers
/// that stay pinned at the top. Rows of a fixed number of cells, so the list lays out lazily, a row at a time.
enum EmojiPickerLayout {
    enum Item: Hashable {
        /// A standard emoji (its shortcode for VoiceOver; none for a glyph from 「よく使う」 not in the table).
        case glyph(String, shortcode: String?)
        case custom(CustomEmojiOut)
    }

    enum Style: Equatable {
        /// `columns` cells of one emoji.
        case cells
        /// A pack's illustrations: `bigColumns` cells, twice as large (M100).
        case big
        /// Text emoji as pills, wrapping (M100).
        case chips
    }

    struct Row: Identifiable, Equatable {
        let id: String
        let section: String
        let style: Style
        let items: [Item]
    }

    struct Section: Identifiable, Equatable {
        /// "frequent", "custom", "pack:<id>" or a standard category's key.
        let id: String
        let label: String
        var pack: EmojiPackOut? = nil
        let rows: [Row]
    }

    static let columns = 8
    static let bigColumns = 4
    static let frequentId = "frequent"
    static let customId = "custom"

    /// The standard categories as rows, built once (about 1,900 emoji).
    static let standard: [Section] = EmojiData.categories.map { category in
        let items = EmojiData.all.filter { $0.category == category.key }.map { Item.glyph($0.glyph, shortcode: $0.shortcode) }
        return Section(id: category.key, label: category.label, rows: rows(items, section: category.key, style: .cells))
    }

    static func rows(_ items: [Item], section: String, style: Style, from start: Int = 0) -> [Row] {
        if items.isEmpty { return [] }
        if style == .chips { return [Row(id: "\(section)#\(start)", section: section, style: .chips, items: items)] }
        let width = style == .big ? bigColumns : columns
        return stride(from: 0, to: items.count, by: width).enumerated().map { index, offset in
            Row(id: "\(section)#\(start + index)", section: section, style: style,
                items: Array(items[offset..<min(offset + width, items.count)]))
        }
    }

    private static func inOrder(_ rows: [CustomEmojiOut]) -> [CustomEmojiOut] {
        rows.sorted { (($0.position ?? 0), $0.name) < (($1.position ?? 0), $1.name) }
    }

    /// Custom emoji as rows: the text ones as one row of pills first, then the images.
    private static func customRows(_ emoji: [CustomEmojiOut], section: String, style: Style) -> [Row] {
        let texts = emoji.filter(\.isText).map(Item.custom)
        let images = emoji.filter { !$0.isText }.map(Item.custom)
        let head = rows(texts, section: section, style: .chips)
        return head + rows(images, section: section, style: style, from: head.count)
    }

    /// The browsing sections, in order; an empty one is left out (no 「よく使う」 yet, no custom emoji, an empty pack).
    /// `frequent`: glyphs and `:name:`s (EmojiUsage.shown has dropped unknown custom ones).
    static func sections(frequent: [String], custom: [CustomEmojiOut], packs: [EmojiPackOut]) -> [Section] {
        var out: [Section] = []
        let byName = Dictionary(custom.map { ($0.name, $0) }, uniquingKeysWith: { a, _ in a })
        let recent: [Item] = frequent.compactMap { glyph in
            if let name = CustomEmoji.name(of: glyph) { return byName[name].map(Item.custom) }
            return .glyph(glyph, shortcode: EmojiData.all.first { $0.glyph == glyph }?.shortcode)
        }
        if !recent.isEmpty {
            out.append(Section(id: frequentId, label: tr("よく使う"), rows: rows(recent, section: frequentId, style: .cells)))
        }
        let packIds = Set(packs.map(\.id))
        let loose = inOrder(custom.filter { $0.packId.map { !packIds.contains($0) } ?? true })
        if !loose.isEmpty {
            out.append(Section(id: customId, label: tr("カスタム"), rows: customRows(loose, section: customId, style: .cells)))
        }
        for pack in packs {
            let id = "pack:\(pack.id)"
            let rows = customRows(inOrder(custom.filter { $0.packId == pack.id }), section: id, style: .big)
            if !rows.isEmpty { out.append(Section(id: id, label: pack.name, pack: pack, rows: rows)) }
        }
        return out + standard
    }

    /// Where a row is, in the list's visible space (y = 0 at the list's top edge).
    struct RowFrame: Equatable {
        let section: String
        let minY: CGFloat
        let maxY: CGFloat
    }

    /// The section scrolled into view: that of the first row still showing below the pinned header (`top` high).
    /// nil when no row is known (the caller keeps what it has).
    static func activeSection(_ frames: [RowFrame], top: CGFloat) -> String? {
        frames.filter { $0.maxY > top + 1 }.min { $0.minY < $1.minY }?.section
    }
}

/// The highlighted category while scrolling (docs/EMOJI.md §9). A tap on a category jumps there and highlights it at
/// once; the sections passed on the way (or a section short of the top at the end of the list) are not shown — the
/// highlight follows the list again when it reaches the section, when the person scrolls, or once the list shows
/// another section than where the jump stopped.
struct EmojiPickerHighlight: Equatable {
    private(set) var active: String?
    /// The section a tap jumped to, until the list gets there.
    private(set) var target: String?
    /// Where a jump stopped short of its target: not highlighted until the list leaves it.
    private(set) var hold: String?
    private var seen: String?

    init(active: String?) { self.active = active }

    mutating func jump(to id: String) {
        active = id
        target = id
        hold = nil
    }

    /// The section the list shows now (EmojiPickerLayout.activeSection).
    mutating func observe(_ computed: String?) {
        guard let computed else { return }
        seen = computed
        if let target {
            if computed == target { self.target = nil }
            return
        }
        if let hold {
            if computed == hold { return }
            self.hold = nil
        }
        active = computed
    }

    /// The jump's scroll has ended (a moment after it): if it stopped short of its target, hold there.
    mutating func settle() {
        guard target != nil else { return }
        target = nil
        if let seen, seen != active { hold = seen }
    }

    /// The person scrolls: follow the list from now on.
    mutating func userScrolled() {
        target = nil
        hold = nil
        if let seen { active = seen }
    }
}

private struct EmojiRowFrames: PreferenceKey {
    static let defaultValue: [EmojiPickerLayout.RowFrame] = []
    static func reduce(value: inout [EmojiPickerLayout.RowFrame], nextValue: () -> [EmojiPickerLayout.RowFrame]) {
        value.append(contentsOf: nextValue())
    }
}

/// The picker's scrolling state outside its view's body (EmojiPickerView.scroll).
@Observable
final class EmojiPickerScrollModel {
    var highlight = EmojiPickerHighlight(active: nil)
    @ObservationIgnored var settleTask: Task<Void, Never>?
    /// The list's visible height, to put a jumped-to section just under the pinned header.
    @ObservationIgnored var listHeight: CGFloat = 600

    /// Applies a change only when it changes something (a write notifies the bar even when equal).
    func update(_ change: (inout EmojiPickerHighlight) -> Void) {
        var next = highlight
        change(&next)
        if next != highlight { highlight = next }
    }
}

/// The category bar: one tab per section, the scrolled-to one highlighted and kept in view.
private struct EmojiCategoryBar<TabLabel: View>: View {
    let sections: [EmojiPickerLayout.Section]
    let scroll: EmojiPickerScrollModel
    let onTap: (String) -> Void
    @ViewBuilder let label: (EmojiPickerLayout.Section) -> TabLabel

    var body: some View {
        let active = scroll.highlight.active ?? sections.first?.id
        ScrollViewReader { bar in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(sections) { section in
                        let selected = active == section.id
                        Button { onTap(section.id) } label: { label(section) }
                            .buttonStyle(.bordered).controlSize(.small)
                            .tint(selected ? Color.accentColor : Color.secondary)
                            .accessibilityLabel(section.label)
                            .accessibilityAddTraits(selected ? .isSelected : [])
                            .id("tab:\(section.id)")
                    }
                }
                .padding(.horizontal, 16)
            }
            .onChange(of: active) { _, active in
                guard let active else { return }
                withAnimation(.easeOut(duration: 0.2)) { bar.scrollTo("tab:\(active)", anchor: .center) }
            }
        }
    }
}

private struct PickerScrollDetector: ViewModifier {
    let action: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollPhaseChange { _, phase in if phase == .interacting { action() } }
        } else {
            content.simultaneousGesture(DragGesture(minimumDistance: 8).onChanged { _ in action() })
        }
    }
}

/// Emoji picker sheet (M11f): search by shortcode / keyword (en + ja) or browse every category in one list (§9).
struct EmojiPickerView: View {
    /// M12f: custom emoji shown under 「カスタム」 and found by name; a pick hands back `:name:`.
    var custom: [CustomEmojiOut] = []
    var images: [String: UIImage] = [:]
    /// The animated ones' frames (GIF), shown moving.
    var animations: [String: EmojiAnimation] = [:]
    var onNeedImage: ((CustomEmojiOut) -> Void)? = nil
    /// M100: a section per pack (its tab icon by "id:version", else its first emoji) after 「カスタム」.
    var packs: [EmojiPackOut] = []
    var packTabs: [String: UIImage] = [:]
    var onNeedPackTab: ((EmojiPackOut) -> Void)? = nil
    /// false where a pick is a choice rather than a use (M50's quick reaction slots): 「よく使う」 and the recents stay.
    var countsUse = true
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    /// The highlight, read only by the category bar: the picker's body (and its long list) is not rebuilt when the
    /// scrolled-to section changes (that cost 30–45 ms frames at each section boundary, measured 2026-10-07).
    @State private var scroll = EmojiPickerScrollModel()
    @AppStorage(EmojiUsage.recentKey) private var recentRaw = ""
    /// C10: how often each emoji was used here (EmojiUsage), for 「よく使う」.
    @AppStorage(EmojiUsage.key) private var usageRaw = ""

    private static let headerHeight: CGFloat = 28
    private static let rowHeight: CGFloat = 40
    private static let bigRowHeight: CGFloat = 76
    private static let space = "emoji-picker-list"

    private var recent: [String] { recentRaw.split(separator: " ").map(String.init).filter { !$0.isEmpty } }
    private var trimmed: String { query.trimmingCharacters(in: .whitespaces) }
    /// Browsing (no search words): the sectioned list; searching: one flat grid of the hits.
    private var browsing: Bool { trimmed.isEmpty }
    private var shown: [EmojiEntry] { Emoji.search(query) }
    /// Every custom emoji by name, label and keywords (M100).
    private var customShown: [CustomEmojiOut] { Emoji.customCandidates(trimmed, custom: custom, limit: 40) }
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: EmojiPickerLayout.columns)

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

    private var sections: [EmojiPickerLayout.Section] {
        EmojiPickerLayout.sections(frequent: frequentShown, custom: custom, packs: packs)
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

    private func glyphCell(_ glyph: String, shortcode: String?) -> some View {
        Button(glyph) { pick(glyph) }
            .font(.title2)
            .frame(maxWidth: .infinity, minHeight: 36)
            .accessibilityLabel(shortcode.map { ":\($0):" } ?? glyph)
    }

    @ViewBuilder
    private func cell(_ item: EmojiPickerLayout.Item, big: Bool) -> some View {
        switch item {
        case let .glyph(glyph, shortcode): glyphCell(glyph, shortcode: shortcode)
        case let .custom(emoji): customCell(emoji, side: big ? 64 : 30)
        }
    }

    @ViewBuilder
    private func row(_ row: EmojiPickerLayout.Row) -> some View {
        Group {
            switch row.style {
            case .chips:
                ChipsLayout(spacing: 4) {
                    ForEach(row.items, id: \.self) { item in
                        if case let .custom(emoji) = item { textCell(emoji) }
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 4)
            case .cells, .big:
                let big = row.style == .big
                let width = big ? EmojiPickerLayout.bigColumns : EmojiPickerLayout.columns
                HStack(spacing: big ? 6 : 4) {
                    ForEach(row.items, id: \.self) { cell($0, big: big) }
                    // A short last row keeps the cells' width.
                    ForEach(row.items.count..<width, id: \.self) { _ in Color.clear.frame(maxWidth: .infinity) }
                }
                .frame(height: big ? Self.bigRowHeight : Self.rowHeight)
            }
        }
        .padding(.horizontal, 16)
        .background {
            GeometryReader { geometry in
                let frame = geometry.frame(in: .named(Self.space))
                Color.clear.preference(key: EmojiRowFrames.self,
                                       value: [.init(section: row.section, minY: frame.minY, maxY: frame.maxY)])
            }
        }
    }

    private func header(_ section: EmojiPickerLayout.Section) -> some View {
        Text(section.label).font(.footnote.weight(.semibold)).foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: Self.headerHeight, alignment: .leading)
            .padding(.horizontal, 16)
            .background(Color(.systemBackground))
            .accessibilityAddTraits(.isHeader)
    }

    /// A category's tab: a pack's icon (else its first emoji, else its name), 「よく使う」 a clock (§9), the others' names.
    @ViewBuilder
    private func tabLabel(_ section: EmojiPickerLayout.Section) -> some View {
        if let pack = section.pack {
            let first: CustomEmojiOut? = section.rows.lazy.flatMap(\.items).compactMap { item -> CustomEmojiOut? in
                if case let .custom(emoji) = item { return emoji } else { return nil }
            }.first
            Group {
                if let version = pack.tabVersion, let image = packTabs["\(pack.id):\(version)"] {
                    Image(uiImage: image).resizable().scaledToFit().frame(height: 22)
                } else if let first, let image = images[first.id] {
                    Image(uiImage: image).resizable().scaledToFit().frame(height: 22)
                } else {
                    Text(pack.name).font(.caption)
                }
            }
            .frame(minWidth: 28)
            .onAppear {
                onNeedPackTab?(pack)
                if pack.tabVersion == nil, let first { onNeedImage?(first) }
            }
        } else if section.id == EmojiPickerLayout.frequentId {
            Image(systemName: "clock")
        } else {
            Text(section.label)
        }
    }

    private func jump(to id: String, list: ScrollViewProxy) {
        let scroll = scroll
        scroll.update { $0.jump(to: id) }
        // To the section's 1-pt marker, put the header's height below the top: a pinned header is not a target
        // scrollTo reaches (nor is a zero-high view), and the section's first row would sit under the header.
        list.scrollTo("top:\(id)", anchor: UnitPoint(x: 0.5, y: min(Self.headerHeight / max(scroll.listHeight - 1, 1), 1)))
        scroll.settleTask?.cancel()
        scroll.settleTask = Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            scroll.update { $0.settle() }
        }
    }

    private var browseList: some View {
        let sections = sections
        let scroll = scroll
        return ScrollViewReader { list in
            VStack(spacing: 8) {
                EmojiCategoryBar(sections: sections, scroll: scroll, onTap: { jump(to: $0, list: list) }) { tabLabel($0) }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        ForEach(sections) { section in
                            Section {
                                // The jump target (not the section's own id: that is the whole section, header
                                // included, which scrollTo does not move to).
                                Color.clear.frame(height: 1).id("top:\(section.id)")
                                ForEach(section.rows) { row($0) }
                                Color.clear.frame(height: 8)
                            } header: {
                                header(section)
                            }
                        }
                    }
                }
                .coordinateSpace(.named(Self.space))
                .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { scroll.listHeight = $0 }
                .onPreferenceChange(EmojiRowFrames.self) { frames in
                    let computed = EmojiPickerLayout.activeSection(frames, top: Self.headerHeight)
                    scroll.update { $0.observe(computed) }
                }
                .modifier(PickerScrollDetector {
                    scroll.settleTask?.cancel()
                    scroll.update { $0.userScrolled() }
                })
            }
        }
    }

    private var searchList: some View {
        ScrollView {
            let texts = customShown.filter(\.isText)
            if !texts.isEmpty {
                // M100: text emoji as pills in a wrapping row of their own.
                ChipsLayout(spacing: 4) { ForEach(texts) { textCell($0) } }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
            }
            LazyVGrid(columns: columns, spacing: 4) {
                ForEach(customShown.filter { !$0.isText }) { customCell($0) }
                ForEach(shown, id: \.shortcode) { glyphCell($0.glyph, shortcode: $0.shortcode) }
            }
            .padding(.horizontal, 16)
            if shown.isEmpty && customShown.isEmpty { Text("見つかりません").font(.footnote).foregroundStyle(.secondary).padding() }
        }
    }

    var body: some View {
        NavigationStack {
            Group {
                // Searching: one flat grid; clearing the words starts the list again at the top.
                if browsing { browseList } else { searchList }
            }
            .padding(.top, 8)
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "検索（例：tada、乾杯、ありがとう）")
            .navigationTitle("絵文字")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
        // MOBILE_POLISH.md C4: solid, not iOS 26's glass (the conversation showed through the emoji).
        .presentationBackground(Color(.systemBackground))
        .onChange(of: browsing) { _, browsing in if browsing { scroll.settleTask?.cancel(); scroll.highlight = EmojiPickerHighlight(active: nil) } }
    }
}
