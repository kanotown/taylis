import SwiftUI
import UIKit

/// What a message's action sheet asks for once the sheet is gone: another sheet or a dialog can only come after it.
enum MessageFollowUp {
    case thread, edit, moreReactions, reactors, share, delete
}

/// A sheet a message row asks for. The conversation presents it (`messageSheets`), not the row: LazyVStack takes rows
/// down and builds them again while the list resizes (the keyboard coming up for the edit sheet or the emoji search,
/// or going away as a long press starts), and a sheet presented from a row closed and opened again with it (testers,
/// 2026-09-29: the editor kept closing and reopening, the actions came twice on iOS 18).
struct MessageSheet: Identifiable, Equatable {
    enum Kind: String { case actions, reactions, reactors, share, revisions, profile, edit, file }
    let kind: Kind
    let message: MessageState
    /// `.file`: the downloaded attachment, shown with Quick Look (a video plays there; its share button saves it).
    var url: URL? = nil
    var id: String { "\(kind.rawValue) \(message.id) \(url?.lastPathComponent ?? "")" }
}

extension View {
    /// Presents what the rows ask for (`sheet`), what the action sheet's choice leads to once it is gone, and the
    /// delete confirmation. `openThread` and `markUnread` are the conversation's (nil where it has none); `onClosed`
    /// runs when a message's sheet has gone.
    func messageSheets(_ controller: AppController, sheet: Binding<MessageSheet?>, openThread: ((MessageState) -> Void)? = nil,
                       markUnread: ((MessageState) -> (() -> Void)?)? = nil, onClosed: @escaping () -> Void = {}) -> some View {
        modifier(MessageSheets(controller: controller, sheet: sheet, openThread: openThread, markUnread: markUnread, onClosed: onClosed))
    }
}

private struct MessageSheets: ViewModifier {
    @Bindable var controller: AppController
    @Binding var sheet: MessageSheet?
    let openThread: ((MessageState) -> Void)?
    let markUnread: ((MessageState) -> (() -> Void)?)?
    let onClosed: () -> Void
    /// The action sheet's choice and its message, run once the sheet is gone.
    @State private var next: (MessageFollowUp, MessageState)?
    @State private var deleting: MessageState?

    private var store: Store { controller.store }

    /// The message as it is now: a reaction or an edit may have come while its sheet was open.
    private func current(_ message: MessageState) -> MessageState { store.message(message.channelId, id: message.id) ?? message }

    private func dismissed() {
        let choice = next
        next = nil
        switch choice {
        case (.thread, let message)?: openThread?(message)
        case (.edit, let message)?: sheet = MessageSheet(kind: .edit, message: message)
        case (.moreReactions, let message)?: sheet = MessageSheet(kind: .reactions, message: message)
        case (.reactors, let message)?: sheet = MessageSheet(kind: .reactors, message: message)
        case (.share, let message)?: sheet = MessageSheet(kind: .share, message: message)
        case (.delete, let message)?: deleting = message
        case nil: break
        }
        onClosed()
    }

    func body(content: Content) -> some View {
        content
            .sheet(item: $sheet, onDismiss: dismissed) { shown in
                let message = current(shown.message)
                switch shown.kind {
                case .actions:
                    let unread = markUnread?(message)
                    MessageActionsSheet(message: message, controller: controller, canThread: openThread != nil, canMarkUnread: unread != nil,
                                        onMarkUnread: { unread?() }, followUp: { next = ($0, message) })
                case .reactions:
                    EmojiPickerView(custom: Array(store.customEmoji.values), images: store.emojiImages, animations: store.emojiAnimations,
                                    onNeedImage: { controller.loadEmojiImage($0) }) { glyph in
                        Task { await controller.toggleReaction(current(message), emoji: glyph) }
                    }
                case .reactors:
                    ReactorsSheet(message: message, controller: controller)
                case .share:
                    ShareMessageSheet(controller: controller, message: message)
                case .revisions:
                    RevisionsView(controller: controller, message: message)
                case .profile:
                    ProfileSheet(controller: controller, userId: message.senderId) { id in
                        NotificationCenter.default.post(name: .chikuwaOpenChannel, object: nil, userInfo: ["id": id])
                    }
                case .file:
                    if let url = shown.url {
                        if AttachmentPreview.canPreview(url) { FilePreviewSheet(url: url, onDismiss: { sheet = nil }) } else { ShareSheet(items: [url]) }
                    }
                case .edit:
                    EditMessageView(initial: Mentions.decode(message.body, users: store.users, groups: store.groups)) { body in
                        await controller.editMessage(message.id, body: Mentions.encode(body, users: store.users.values, groups: Array(store.groups.values)))
                    }
                }
            }
            .confirmationDialog("メッセージを削除しますか？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                                titleVisibility: .visible, presenting: deleting) { message in
                Button("削除", role: .destructive) { Task { await controller.deleteMessage(message.id) } }
            }
    }
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
    /// The height every action takes, measured before the sheet shows; the sheet opens at it.
    @State private var fitted: CGFloat?
    @State private var detent = PresentationDetent.medium

    private var store: Store { controller.store }
    private var isMine: Bool { store.me?.id == message.senderId }
    /// The quick reactions: the ones used lately first (the picker's recents, standard emoji only), then the palette,
    /// six in all — as on the web and Android (parity audit 2026-09-29).
    @AppStorage("emoji.recent") private var recentRaw = ""
    private var quickReactions: [String] {
        let recent = recentRaw.split(separator: " ").map(String.init).filter { !$0.isEmpty && CustomEmoji.name(of: $0) == nil }
        var seen: Set<String> = []
        return (recent + reactionPalette).filter { seen.insert($0).inserted }.prefix(6).map { $0 }
    }
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
        ScrollView {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    ForEach(quickReactions, id: \.self) { emoji in
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
                // M27: who reacted (a long press on a reaction in Slack; here the message's own long press), first as
                // on the other clients.
                if !message.reactions.isEmpty { row("リアクションした人", "person.2") { then(.reactors) } }
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
                    VStack(spacing: 0) {
                        rowLabel("リマインド", "alarm").foregroundStyle(Color.primary)
                        Divider().padding(.leading, 56)
                    }
                }
                if canMarkUnread { row("ここから未読にする", "envelope.badge") { onMarkUnread(); dismiss() } }
                row("リンクをコピー", "link") { controller.copyPermalink(message.id); dismiss() }
                row("別のチャンネルに共有…", "arrowshape.turn.up.right") { then(.share) }
                row(message.pinnedAt != nil ? "ピン留めを外す" : "チャンネルにピン留め", message.pinnedAt != nil ? "pin.slash" : "pin") {
                    run { await controller.togglePin(message) }
                }
                if isMine || controller.isAdmin {
                    row("削除", "trash", role: .destructive) { then(.delete) }
                }
            }
            .padding(.bottom, 8)
            .onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { height in
                // Once, before the sheet shows (a later change would move it under the reader's finger).
                if fitted == nil {
                    fitted = height
                    detent = .height(height)
                }
            }
        }
        .scrollBounceBehavior(.basedOnSize)
        // Tall enough for every action (testers, 2026-09-29: at .medium 「ピン留め」 and 「削除」 were under the edge).
        // Taller than the screen (the largest text sizes, a small iPhone), the system keeps it to the screen and the
        // actions scroll.
        .presentationDetents(fitted.map { [.height($0), .large] } ?? [.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
    }

    private func rowLabel(_ title: String, _ icon: String) -> some View {
        Label(title, systemImage: icon)
            .frame(maxWidth: .infinity, minHeight: 50, alignment: .leading) // a plain list's row
            .padding(.horizontal, 20)
            .contentShape(Rectangle())
    }

    private func row(_ title: String, _ icon: String, role: ButtonRole? = nil, action: @escaping () -> Void) -> some View {
        Button(role: role, action: action) {
            rowLabel(title, icon).foregroundStyle(role == .destructive ? Color.red : Color.primary)
        }
        .buttonStyle(ActionRowStyle())
    }
}

/// A row of the action sheet as a plain list shows one: the whole width, grey while pressed, a line under it.
private struct ActionRowStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(spacing: 0) {
            configuration.label
                .background(configuration.isPressed ? Color(.systemGray5) : Color.clear)
            Divider().padding(.leading, 56)
        }
    }
}
