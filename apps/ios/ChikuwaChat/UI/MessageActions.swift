import SwiftUI
import UIKit

/// What a message's action sheet asks its row to do once the sheet is gone: another sheet or a dialog can only come
/// after it.
enum MessageFollowUp {
    case thread, edit, moreReactions, share, delete
}

/// A message's actions, Slack-like (testers, 2026-09-28): a long press highlights the message where it is and opens this
/// sheet from the bottom. It replaced the system context menu, whose lifted copy of the message overlapped its
/// neighbours and made reactions flicker. Reactions first, then the actions; delete last.
struct MessageActionsSheet: View {
    let message: MessageState
    @Bindable var controller: AppController
    let canThread: Bool
    let canMarkUnread: Bool
    let onMarkUnread: () -> Void
    let followUp: (MessageFollowUp) -> Void
    @Environment(\.dismiss) private var dismiss

    private var store: Store { controller.store }
    private var isMine: Bool { store.me?.id == message.senderId }
    private var mine: Set<String> {
        guard let me = store.me?.id else { return [] }
        return Set(message.reactions.filter { $0.userIds.contains(me) }.map(\.emoji))
    }

    private func run(_ action: @escaping () async -> Void) {
        dismiss()
        Task { await action() }
    }

    private func then(_ next: MessageFollowUp) {
        followUp(next)
        dismiss()
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                ForEach(reactionPalette, id: \.self) { emoji in
                    Button { run { await controller.toggleReaction(message, emoji: emoji) } } label: {
                        Text(emoji).font(.system(size: 26))
                            .frame(width: 44, height: 44)
                            .background(mine.contains(emoji) ? Color.accentColor.opacity(0.2) : Color(.secondarySystemBackground), in: Circle())
                    }
                    .buttonStyle(.plain)
                }
                Button { then(.moreReactions) } label: {
                    Image(systemName: "face.smiling").font(.system(size: 22))
                        .frame(width: 44, height: 44)
                        .background(Color(.secondarySystemBackground), in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("その他のリアクション")
            }
            .padding(.top, 22)
            .padding(.bottom, 8)
            List {
                if canThread { row("スレッドで返信", "bubble.left.and.bubble.right") { then(.thread) } }
                if isMine { row("編集", "pencil") { then(.edit) } }
                if !message.body.isEmpty {
                    row("テキストをコピー", "doc.on.doc") {
                        UIPasteboard.general.string = Mentions.decode(message.body, users: store.users, groups: store.groups)
                        dismiss()
                    }
                }
                let saved = store.isBookmarked(message.id)
                row(saved ? "保存を解除" : "あとで見る (保存)", saved ? "bookmark.slash" : "bookmark") {
                    run { await controller.toggleBookmark(message.id) }
                }
                Menu {
                    ForEach(Schedule.reminderPresets()) { preset in
                        Button("\(preset.label) (\(Schedule.label(preset.at)))") {
                            run { _ = await controller.setReminder(messageId: message.id, at: preset.at) }
                        }
                    }
                } label: {
                    Label("リマインド", systemImage: "alarm")
                }
                .tint(.primary)
                if canMarkUnread { row("ここから未読にする", "envelope.badge") { onMarkUnread(); dismiss() } }
                row("リンクをコピー", "link") { controller.copyPermalink(message.id); dismiss() }
                row("別のチャンネルに共有…", "arrowshape.turn.up.right") { then(.share) }
                row(message.pinnedAt != nil ? "ピン留めを外す" : "チャンネルにピン留め", message.pinnedAt != nil ? "pin.slash" : "pin") {
                    run { await controller.togglePin(message) }
                }
                if isMine || controller.isAdmin {
                    Button(role: .destructive) { then(.delete) } label: { Label("削除", systemImage: "trash") }
                }
            }
            .listStyle(.plain)
        }
        .presentationDetents([.medium, .large])
        .presentationDragIndicator(.visible)
    }

    private func row(_ title: String, _ icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Label(title, systemImage: icon).foregroundStyle(.primary) }
    }
}
