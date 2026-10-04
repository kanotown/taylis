import SwiftUI

/// Who did something to a message (M27): voted for an option, reacted, confirmed.
enum PeopleList {
    /// Up to `limit` names, then 「ほか N 人」 (the same on every platform).
    static func compact(_ names: [String], limit: Int = 3) -> String {
        guard names.count > limit else { return names.joined(separator: "、") }
        return names.prefix(limit).joined(separator: "、") + " ほか \(names.count - limit) 人"
    }

    @MainActor static func names(_ userIds: [String], store: Store) -> [String] {
        userIds.map { store.users[$0]?.displayName ?? "?" }
    }
}

/// Everyone who reacted to a message, by reaction (Slack's long press on a reaction), from its action sheet.
struct ReactorsSheet: View {
    let message: MessageState
    @Bindable var controller: AppController
    @Environment(\.dismiss) private var dismiss

    private var store: Store { controller.store }

    var body: some View {
        NavigationStack {
            List {
                ForEach(message.reactions, id: \.emoji) { reaction in
                    Section {
                        ForEach(reaction.userIds, id: \.self) { id in
                            let name = store.users[id]?.displayName ?? "?"
                            HStack(spacing: 10) {
                                AvatarView(id: id, name: name, size: 28)
                                Text(name)
                            }
                        }
                    } header: {
                        HStack(spacing: 6) {
                            emoji(reaction.emoji)
                            Text("\(reaction.count)")
                        }
                    }
                }
            }
            .navigationTitle("リアクションした人")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    /// A custom emoji is its picture in its own box (held blank until it loads), as on the chips.
    private func emoji(_ glyph: String) -> some View {
        ReactionGlyph(controller: controller, emoji: glyph, height: 20)
    }
}
