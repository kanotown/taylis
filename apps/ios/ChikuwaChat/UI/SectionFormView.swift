import SwiftUI

/// A section's icon (M26): an emoji, or a custom emoji drawn from its image (its `:name:` until the image is here).
struct SectionIcon: View {
    let controller: AppController
    let emoji: String?
    var size: CGFloat = 16

    var body: some View {
        if let emoji {
            Group {
                if let name = CustomEmoji.name(of: emoji), let custom = controller.store.customEmoji[name] {
                    if let image = controller.store.emojiImages[custom.id] {
                        EmojiImage(still: image, animation: controller.store.emojiAnimations[custom.id]).frame(width: size, height: size)
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
                        TextField("セクション名 (例: 研究、授業)", text: $name)
                            .onChange(of: name) { _, value in if value.count > 40 { name = String(value.prefix(40)) } }
                    }
                    if emoji != nil { Button("アイコンを外す", role: .destructive) { emoji = nil } }
                }
                if creating {
                    Section("入れる会話 (\(chosen.count))") {
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
                EmojiPickerView(custom: Array(store.customEmoji.values), images: store.emojiImages, animations: store.emojiAnimations,
                                onNeedImage: { controller.loadEmojiImage($0) }, packs: store.sortedEmojiPacks,
                                packTabs: store.packTabImages, onNeedPackTab: { controller.loadPackTab($0) }) { glyph in emoji = glyph }
            }
        }
        .interactiveDismissDisabled(busy)
    }

    private func conversationRow(_ channel: ChannelState, title: String) -> some View {
        let ticked = chosen.contains(channel.id)
        let current = store.sidebarSections.first { $0.channelIds.contains(channel.id) }
        return Button {
            if ticked { chosen.remove(channel.id) } else { chosen.insert(channel.id) }
        } label: {
            HStack {
                Image(systemName: ticked ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(ticked ? Color.accentColor : Color.secondary)
                // Concrete colors: inside a Form button `.primary` would follow the tint.
                Text(title).foregroundStyle(Color.primary).lineLimit(1)
                Spacer()
                if let current { Text("\(current.name) から移動").font(.caption).foregroundStyle(Color.secondary).lineLimit(1) }
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
