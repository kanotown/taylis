import SwiftUI

/// M114 (DATA_MODEL.md sidebar_sections): a section's letter badge, `letter:<text>:<colour>`: one or two ASCII letters /
/// digits or one Japanese character (kana, kanji, 々) in a text emoji colour. The server checks the same rule;
/// apps/shared/section-icons.json holds the cases every client passes.
struct SectionLetterIcon: Equatable {
    let text: String
    let color: String

    static let prefix = "letter:"
    /// The palette keys in the server's order (apps/shared/text-emoji.json), with the names the picker says.
    static var colors: [(key: String, name: String)] { [
        ("gray", tr("グレー")), ("red", tr("赤")), ("orange", tr("オレンジ")), ("yellow", tr("黄")),
        ("green", tr("緑")), ("blue", tr("青")), ("purple", tr("紫")), ("pink", tr("ピンク")),
    ] }

    var icon: String { Self.prefix + text + ":" + color }

    static func isLetterText(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        if (1...2).contains(scalars.count), scalars.allSatisfy({ $0.isASCII && (("0"..."9").contains($0) || ("A"..."Z").contains($0) || ("a"..."z").contains($0)) }) {
            return true
        }
        guard scalars.count == 1, let value = scalars.first?.value else { return false }
        return value == 0x3005 || (0x3041...0x309F).contains(value) || (0x30A0...0x30FF).contains(value)
            || (0x3400...0x4DBF).contains(value) || (0x4E00...0x9FFF).contains(value)
    }

    /// The badge an icon is, or nil (an emoji or a custom emoji `:name:`, drawn as before).
    static func parse(_ icon: String?) -> SectionLetterIcon? {
        guard let icon, icon.hasPrefix(prefix) else { return nil }
        let parts = icon.dropFirst(prefix.count).split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 2, isLetterText(parts[0]), colors.contains(where: { $0.key == parts[1] }) else { return nil }
        return SectionLetterIcon(text: parts[0], color: parts[1])
    }

    /// What the picker's field holds, made ready: full-width letters and half-width kana become their usual form.
    static func normalize(_ input: String) -> String {
        input.precomposedStringWithCompatibilityMapping.filter { !$0.isWhitespace }
    }
}

/// M114: the letters on a rounded square in their text emoji colour (light or dark), `size` points square.
struct LetterBadge: View {
    let text: String
    let color: String
    var size: CGFloat = 16
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = CustomEmoji.textPalette[color] ?? CustomEmoji.textPalette["gray"]!
        let pair = colorScheme == .dark ? palette.dark : palette.light
        Text(text)
            .font(.system(size: size * (text.unicodeScalars.count > 1 ? 0.52 : 0.64), weight: .bold))
            .lineLimit(1)
            .minimumScaleFactor(0.5)
            .foregroundStyle(rgbColor(pair.fg))
            .frame(width: size, height: size)
            .background(rgbColor(pair.bg), in: RoundedRectangle(cornerRadius: size * 0.26, style: .continuous))
    }

    private func rgbColor(_ rgb: UInt32) -> Color {
        Color(red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255)
    }
}

/// A section's icon (M26): an emoji, or a custom emoji drawn from its image (its `:name:` until the image is here; a
/// text emoji's pill as wide as its label); M114: a letter badge.
struct SectionIcon: View {
    let controller: AppController
    let emoji: String?
    var size: CGFloat = 16

    var body: some View {
        if let emoji {
            Group {
                if let letter = SectionLetterIcon.parse(emoji) {
                    LetterBadge(text: letter.text, color: letter.color, size: size)
                } else if let name = CustomEmoji.name(of: emoji), let custom = controller.store.customEmoji[name] {
                    if let image = controller.store.emojiImages[custom.id] {
                        EmojiImage(still: image, animation: controller.store.emojiAnimations[custom.id])
                            .frame(width: CustomEmoji.size(of: custom, height: size).width, height: size)
                    } else {
                        Text(emoji).font(.system(size: size * 0.6)).lineLimit(1).onAppear { controller.loadEmojiImage(custom) }
                    }
                } else {
                    Text(emoji).font(.system(size: size))
                }
            }
            .accessibilityHidden(true) // the section's name says what it is
        }
    }
}

/// Making or editing one of my sections (M26, Slack): its name and icon; when making one, also the conversations that
/// go in it (they leave the section they were in). `preselected` ticks the conversation a long-press started from.
struct SectionFormView: View {
    let controller: AppController
    let section: SidebarSectionOut?
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var emoji: String?
    @State private var chosen: Set<String>
    @State private var query = ""
    @State private var picking = false
    @State private var busy = false
    @State private var error: String?

    init(controller: AppController, section: SidebarSectionOut?, preselected: [String] = []) {
        self.controller = controller
        self.section = section
        _name = State(initialValue: section?.name ?? "")
        _emoji = State(initialValue: section?.emoji)
        _chosen = State(initialValue: Set(preselected))
    }

    private var creating: Bool { section == nil }
    private var store: Store { controller.store }
    private var trimmed: String { name.trimmingCharacters(in: .whitespaces) }

    /// The conversations I am in, by title, narrowed by the filter.
    private var conversations: [(channel: ChannelState, title: String)] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return store.channels.values.filter { $0.isMember && !$0.channel.archived }
            .map { (channel: $0, title: channelTitle($0, store: store)) }
            .filter { q.isEmpty || $0.title.lowercased().contains(q) }
            .sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("名前とアイコン") {
                    HStack(spacing: 12) {
                        Button { picking = true } label: {
                            Group {
                                if emoji != nil {
                                    SectionIcon(controller: controller, emoji: emoji, size: 26)
                                } else {
                                    Image(systemName: "face.smiling").font(.title3).foregroundStyle(.secondary)
                                }
                            }
                            .frame(width: 44, height: 44)
                            .background(RoundedRectangle(cornerRadius: 10).strokeBorder(Color(.separator)))
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(emoji == nil ? "アイコンを選ぶ" : "アイコンを変更")
                        TextField("セクション名（例：研究、授業）", text: $name)
                            .onChange(of: name) { _, value in if value.count > 40 { name = String(value.prefix(40)) } }
                    }
                    if emoji != nil { Button("アイコンを外す", role: .destructive) { emoji = nil } }
                }
                if creating {
                    Section("入れる会話（\(chosen.count)）") {
                        HStack {
                            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                            TextField("チャンネルや DM を絞り込む", text: $query).textInputAutocapitalization(.never).autocorrectionDisabled()
                        }
                        ForEach(conversations, id: \.channel.id) { row in
                            conversationRow(row.channel, title: row.title)
                        }
                        if conversations.isEmpty { Text("該当する会話がありません").foregroundStyle(.secondary) }
                    }
                }
                if let error { Text(error).foregroundStyle(.red).font(.footnote) }
            }
            .navigationTitle(creating ? "新しいセクション" : "セクションを編集")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() }.disabled(busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(creating ? "作成" : "保存") { submit() }.disabled(busy || trimmed.isEmpty)
                }
            }
            .sheet(isPresented: $picking) {
                SectionIconPicker(controller: controller, current: emoji) { emoji = $0 }
            }
        }
        .interactiveDismissDisabled(busy)
    }

    private func conversationRow(_ channel: ChannelState, title: String) -> some View {
        let ticked = chosen.contains(channel.id)
        // One place per conversation: a starred one leaves お気に入り (DATA_MODEL.md sidebar_sections).
        let current = store.isFavorite(channel.id) ? tr("お気に入り") : store.sidebarSections.first { $0.channelIds.contains(channel.id) }?.name
        return Button {
            if ticked { chosen.remove(channel.id) } else { chosen.insert(channel.id) }
        } label: {
            HStack {
                Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(ticked ? Color.accentColor : Color.secondary)
                // Concrete colors: inside a Form button `.primary` would follow the tint.
                Text(title).foregroundStyle(Color.primary).lineLimit(1)
                Spacer()
                if let current { Text("\(current) から移動").font(.caption).foregroundStyle(Color.secondary).lineLimit(1) }
            }
        }
        .accessibilityAddTraits(ticked ? .isSelected : [])
    }

    private func submit() {
        guard !trimmed.isEmpty, !busy else { return }
        busy = true
        error = nil
        Task {
            let done = if let section {
                await controller.editSection(section.id, name: trimmed, emoji: emoji)
            } else {
                await controller.createSection(trimmed, emoji: emoji, channelIds: Array(chosen))
            }
            busy = false
            if done {
                dismiss()
            } else {
                // Said here: the toast is under this sheet.
                error = controller.error ?? ErrorMessages.unknown
                controller.error = nil
            }
        }
    }
}

/// The icon sheet (M114): 「絵文字」 (the emoji picker) or 「文字」 (a letter badge), chosen by the segment on top. It
/// opens on 「文字」 when the section has a letter badge.
struct SectionIconPicker: View {
    let controller: AppController
    let current: String?
    let onPick: (String) -> Void
    @State private var letters: Bool

    init(controller: AppController, current: String?, onPick: @escaping (String) -> Void) {
        self.controller = controller
        self.current = current
        self.onPick = onPick
        _letters = State(initialValue: SectionLetterIcon.parse(current) != nil)
    }

    var body: some View {
        let store = controller.store
        Group {
            if letters {
                LetterIconPickerView(current: SectionLetterIcon.parse(current), onPick: onPick)
            } else {
                EmojiPickerView(custom: Array(store.customEmoji.values), images: store.emojiImages, animations: store.emojiAnimations,
                                onNeedImage: { controller.loadEmojiImage($0) }, packs: store.sortedEmojiPacks,
                                packTabs: store.packTabImages, onNeedPackTab: { controller.loadPackTab($0) }, onPick: onPick)
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            Picker("アイコンの種類", selection: $letters) {
                Text("絵文字").tag(false)
                Text("文字").tag(true)
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 4)
            .background(Color(.systemBackground))
        }
        .presentationDetents([.medium, .large])
        .presentationBackground(Color(.systemBackground))
    }
}

/// M114: one or two letters (or one Japanese character) and a colour, previewed as they are typed.
struct LetterIconPickerView: View {
    let onPick: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    /// As typed: an IME composes 「しゅう」 before 「修」, so nothing is cut while typing; `text` is what is saved.
    @State private var raw: String
    @State private var color: String
    @FocusState private var focused: Bool

    init(current: SectionLetterIcon?, onPick: @escaping (String) -> Void) {
        self.onPick = onPick
        _raw = State(initialValue: current?.text ?? "")
        _color = State(initialValue: current?.color ?? "blue")
    }

    private var text: String { SectionLetterIcon.normalize(raw) }
    private var valid: Bool { SectionLetterIcon.isLetterText(text) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 16) {
                        LetterBadge(text: valid ? text : (text.isEmpty ? "A" : "?"), color: color, size: 52)
                            .opacity(valid ? 1 : 0.5)
                        TextField("例：M、B、修", text: $raw)
                            .font(.title3)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .focused($focused)
                            .submitLabel(.done)
                            .onSubmit(apply)
                            .accessibilityLabel("アイコンの文字")
                    }
                    .padding(.vertical, 4)
                } footer: {
                    Text("英数字 2 文字まで、または日本語 1 文字（例：修論指導は「M」や「修」）")
                        .foregroundStyle(!text.isEmpty && !valid ? Color.red : Color.secondary)
                }
                Section("色") {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 10) {
                        ForEach(SectionLetterIcon.colors, id: \.key) { option in
                            Button { color = option.key } label: {
                                LetterBadge(text: valid ? text : "A", color: option.key, size: 36)
                                    .padding(4)
                                    .overlay(RoundedRectangle(cornerRadius: 13, style: .continuous)
                                        .strokeBorder(color == option.key ? Color.accentColor : Color.clear, lineWidth: 2))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(option.name)
                            .accessibilityAddTraits(color == option.key ? .isSelected : [])
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            .navigationTitle("文字のアイコン")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("決定", action: apply).disabled(!valid) }
            }
            .onAppear { focused = true }
        }
    }

    private func apply() {
        guard valid else { return }
        onPick(SectionLetterIcon(text: text, color: color).icon)
        dismiss()
    }
}
