import SwiftUI

/// The `:` emoji and `@` mention candidates of an input: the composer's (M11f, MOBILE_UI.md §23) and, since M187, the
/// message editor's (MOBILE_UI.md §30). Both read what is being typed at the end of the text, as the composer always has.
enum ComposerCompletions {
    /// The people (then groups, `@channel`, `@here`) for the `@` being typed at the end of `text`; none when no `@` is.
    /// MOBILE_UI.md §23: the people of this conversation first (the thread's, then the channel's), me last.
    @MainActor
    static func mentions(_ text: String, users: [UserPublic], controller: AppController?, channelId: String,
                         parentId: String?) -> [Mentions.Candidate] {
        guard let query = Mentions.query(text) else { return [] }
        return Mentions.candidates(query, users: users, groups: controller.map { Array($0.store.groups.values) } ?? [],
                                   aiBotIds: controller?.aiHub?.knownBotUserIds,
                                   context: controller.map { Mentions.context(store: $0.store, channelId: channelId, parentId: parentId) } ?? .init())
    }

    /// `:tada` completes to an emoji (M11f): the workspace's own first, 8 at most. M100: also by label and keywords
    /// (":ありがとう" finds :hpd-bow:). The caller asks only when no mention is being typed.
    @MainActor
    static func emoji(_ text: String, controller: AppController?) -> [EmojiEntry] {
        emoji(text, custom: controller.map { Array($0.store.customEmoji.values) } ?? [])
    }

    static func emoji(_ text: String, custom: [CustomEmojiOut]) -> [EmojiEntry] {
        guard let query = Emoji.query(text) else { return [] }
        let found = Emoji.customCandidates(query, custom: custom)
        let own = found.map { EmojiEntry(shortcode: $0.name, glyph: ":\($0.name):", category: "custom", keywords: $0.label ?? "") }
        return Array((own + Emoji.candidates(query)).prefix(8))
    }

    /// M187: what the candidates read in an input whose cursor (or selection) is `range`: the text before the cursor, so a
    /// word in the middle of the text completes in place; nothing while a range is selected. Android's
    /// `Completions.typed`; the desktop reads up to the caret too. (The composer reads the whole text.)
    static func typed(_ text: String, range: Range<Int>) -> String {
        guard range.isEmpty else { return "" }
        return String(text.prefix(max(0, min(range.lowerBound, text.count))))
    }

    /// `completed` (`Mentions.complete` / `Emoji.complete`, which end with a space) on the text before `cursor`; the text
    /// after it stays. A space right after the cursor is the one the completion ends with (the desktop's `takenAfter`):
    /// one space there, and the cursor after it, past the completed word (before it, the word would be read again and
    /// offered). The new text and the cursor.
    static func complete(_ text: String, cursor: Int, _ completed: (String) -> String) -> (text: String, selection: Range<Int>) {
        let at = max(0, min(cursor, text.count))
        let head = completed(String(text.prefix(at)))
        var rest = Substring(text.dropFirst(at))
        if head.hasSuffix(" "), rest.first == " " { rest = rest.dropFirst() }
        return (head + rest, head.count..<head.count)
    }

    /// While an `@` is being typed: the key under which the conversation's members are read for the ranking (read again
    /// when they change). nil when no `@` is being typed.
    @MainActor
    static func membersKey(_ text: String, controller: AppController?, channelId: String) -> String? {
        guard Mentions.query(text) != nil, let controller else { return nil }
        return "\(channelId):\(controller.store.memberListVersion[channelId, default: 0])"
    }
}

/// The candidates by an input: the emoji, then the mentions, each a row of chips that scrolls sideways (only one of the
/// two shows at a time: the emoji are asked for only while no mention is being typed).
struct CompletionChips: View {
    let emoji: [EmojiEntry]
    let mentions: [Mentions.Candidate]
    let controller: AppController?
    let onEmoji: (EmojiEntry) -> Void
    let onMention: (Mentions.Candidate) -> Void

    var body: some View {
        if !emoji.isEmpty {
            chipRow {
                ForEach(emoji, id: \.shortcode) { entry in
                    Button { onEmoji(entry) } label: {
                        if entry.category == "custom", let controller {
                            // The image (or text pill) and its label, not `:name:` twice.
                            CustomEmoji.text(entry.glyph, custom: controller.store.customEmoji, images: controller.store.emojiImages,
                                             onNeed: { controller.loadEmojiImage($0) })
                                + Text("  \(entry.keywords.isEmpty ? ":\(entry.shortcode):" : entry.keywords)").foregroundStyle(.secondary)
                        } else {
                            Text(entry.glyph) + Text("  :\(entry.shortcode):").foregroundStyle(.secondary)
                        }
                    }
                    .font(.footnote)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
        if !mentions.isEmpty {
            chipRow {
                ForEach(mentions) { candidate in
                    Button { onMention(candidate) } label: {
                        Text("@\(candidate.username)").fontWeight(.semibold) + Text("  \(candidate.label)").foregroundStyle(.secondary)
                            + (candidate.kind == "ai" ? Text("  AI").font(.caption2).bold().foregroundStyle(Color.accentColor) : Text(""))
                    }
                    .font(.footnote)
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
    }

    private func chipRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) { content() }
                .padding(.horizontal, 12)
        }
        .padding(.top, 6)
    }
}
