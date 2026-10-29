import SwiftUI
import UIKit

/// What a message's action sheet asks for once the sheet is gone: another sheet or a dialog can only come after it.
enum MessageFollowUp {
    case thread, edit, moreReactions, reactors, share, delete, customReminder, task, review, report
    /// AL3 (docs/ALBUMS.md §9): 「この投稿の写真をアルバムに」.
    case addToAlbum
    /// CF3 (docs/CHANNEL_FILES.md §12.1): 「ドライブで表示」 for this drive item.
    case showInDrive(String)
}

/// A sheet a message row asks for. The conversation presents it (`messageSheets`), not the row: LazyVStack takes rows
/// down and builds them again while the list resizes (the keyboard coming up for the edit sheet or the emoji search,
/// or going away as a long press starts), and a sheet presented from a row closed and opened again with it (testers,
/// 2026-09-29: the editor kept closing and reopening, the actions came twice on iOS 18).
struct MessageSheet: Identifiable, Equatable {
    enum Kind: String { case actions, reactions, reactors, share, revisions, profile, edit, file, reminder, acks, collection, task, report }
    let kind: Kind
    let message: MessageState
    /// `.file`: the downloaded attachment, shown with Quick Look (a video plays there; its share button saves it).
    var url: URL? = nil
    /// `.task` (L9): the task a chip under the message opens.
    var taskId: String? = nil
    /// `.profile`: a person a mention in the body names (nil: the sender).
    var userId: String? = nil
    var id: String { "\(kind.rawValue) \(message.id) \(url?.lastPathComponent ?? "") \(taskId ?? "") \(userId ?? "")" }
}

extension View {
    /// Presents what the rows ask for (`sheet`), what the action sheet's choice leads to once it is gone, and the
    /// delete confirmation. `openThread` and `markUnread` are the conversation's (nil where it has none); `onClosed`
    /// runs when a message's sheet has gone. `threadRootId`: the root a thread screen shows at its top (deleting it there
    /// closes the thread without a notice, THREADS.md).
    func messageSheets(_ controller: AppController, sheet: Binding<MessageSheet?>, openThread: ((MessageState) -> Void)? = nil,
                       markUnread: ((MessageState) -> (() -> Void)?)? = nil, threadRootId: String? = nil,
                       onClosed: @escaping () -> Void = {}) -> some View {
        modifier(MessageSheets(controller: controller, sheet: sheet, openThread: openThread, markUnread: markUnread, threadRootId: threadRootId,
                               onClosed: onClosed))
    }
}

private struct MessageSheets: ViewModifier {
    @Bindable var controller: AppController
    @Binding var sheet: MessageSheet?
    let openThread: ((MessageState) -> Void)?
    let markUnread: ((MessageState) -> (() -> Void)?)?
    let threadRootId: String?
    let onClosed: () -> Void
    /// The action sheet's choice and its message, run once the sheet is gone.
    @State private var next: (MessageFollowUp, MessageState)?
    @State private var deleting: MessageState?
    /// CF3: a message with files in the channel's drive: its confirmation, a sheet with the drive's switch.
    @State private var deletingWithFiles: MessageState?
    /// M56: 「タスクにする」's form, once the action sheet is gone.
    @State private var taskForm: TaskFormTarget?
    /// AL3: the albums to put the message's photos in.
    @State private var addingToAlbum: MessageState?

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
        case (.customReminder, let message)?: sheet = MessageSheet(kind: .reminder, message: message)
        case (.share, let message)?: sheet = MessageSheet(kind: .share, message: message)
        case (.report, let message)?: sheet = MessageSheet(kind: .report, message: message)  // M104
        case (.delete, let message)?:
            // CF3 (docs/CHANNEL_FILES.md §7.3): with files in the channel's drive, the confirmation says what becomes of them.
            if ChannelFiles.asksOnDelete(message.attachments) { deletingWithFiles = message } else { deleting = message }
        case (.showInDrive(let itemId), _)?: controller.showInDrive(itemId)
        case (.addToAlbum, let message)?: addingToAlbum = message
        case (.task, let message)?:
            // M56 (TASKS.md §6): the message's line as the title, the message as the source, its channel's board (or
            // 「自分のタスク」 for a DM or a board I may not add to).
            taskForm = .new(TaskRules.messageTaskInit(message, channel: store.channel(message.channelId), users: store.users,
                                                      groups: store.groups, isAdmin: controller.isAdmin))
        case (.review, let message)?:
            // L9 (REVIEWS.md §2.3): the same form as a review request in the message's conversation (a DM too).
            taskForm = .new(TaskRules.messageReviewInit(message, channel: store.channel(message.channelId), users: store.users, groups: store.groups))
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
                                    onNeedImage: { controller.loadEmojiImage($0) }, packs: store.sortedEmojiPacks,
                                    packTabs: store.packTabImages, onNeedPackTab: { controller.loadPackTab($0) }) { glyph in
                        Task { await controller.toggleReaction(current(message), emoji: glyph) }
                    }
                case .reactors:
                    ReactorsSheet(message: message, controller: controller)
                case .acks:
                    AckStatusView(message: message, controller: controller)
                case .collection:
                    CollectionStatusView(message: message, controller: controller)  // L6
                case .task:
                    if let taskId = shown.taskId { TaskDetailLoader(controller: controller, taskId: taskId) }  // L9: a chip's task
                case .reminder:
                    ReminderFormView(controller: controller, message: message)
                case .share:
                    ShareMessageSheet(controller: controller, message: message)
                case .report:
                    ReportMessageSheet(controller: controller, message: message)  // M104 (MODERATION.md §3)
                case .revisions:
                    RevisionsView(controller: controller, message: message)
                case .profile:
                    ProfileSheet(controller: controller, userId: shown.userId ?? message.senderId) { id in
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
            .sheet(item: $addingToAlbum) { message in AlbumPickerSheet(controller: controller, message: message) }
            .fullScreenCover(item: $taskForm) { target in
                TaskForm(controller: controller, hub: controller.taskHub, target: target)
            }
            // An alert in the middle of the screen: a confirmation dialog pointed at the conversation from wherever
            // iOS 26 put it (testers, 2026-09-29).
            .alert("メッセージを削除しますか？", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                   presenting: deleting) { message in
                Button("キャンセル", role: .cancel) {}
                Button("削除", role: .destructive) {
                    if message.id == threadRootId { controller.markThreadRootDeletedHere(message.id) } // closes without a notice
                    withAnimation(.easeOut(duration: 0.25)) { controller.hideMessage(message) }
                    Task { await controller.deleteMessage(message) }
                }
            } message: { _ in Text("削除したメッセージは元に戻せません。") }
            .sheet(item: $deletingWithFiles) { message in
                DeleteMessageWithFilesSheet(controller: controller, message: message) { driveFiles in
                    if message.id == threadRootId { controller.markThreadRootDeletedHere(message.id) }
                    withAnimation(.easeOut(duration: 0.25)) { controller.hideMessage(message) }
                    Task { await controller.deleteMessage(message, driveFiles: driveFiles) }
                }
            }
    }
}

/// CF3 (docs/CHANNEL_FILES.md §7.3): deleting a message whose files are in the channel's drive. GET
/// /messages/{id}/drive-files says which the server's default (`auto`) puts in the drive's trash; the switch
/// 「ドライブの n 件のファイルもゴミ箱に移す」 starts on when there are any, and off keeps them all (`keep`). Files that
/// changed since they were posted stay whatever it says (a line says so).
struct DeleteMessageWithFilesSheet: View {
    @Bindable var controller: AppController
    let message: MessageState
    /// The `drive_files` to send (nil: the server's default).
    let onDelete: (String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var choice: ChannelFiles.DeleteChoice?
    @State private var failed = false
    @State private var trashing = true

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("削除したメッセージは元に戻せません。").foregroundStyle(.secondary)
                }
                Section {
                    if let choice {
                        if let title = choice.toggleTitle {
                            Toggle(title, isOn: $trashing)
                        }
                        if let note = choice.note {
                            Text(note).font(.footnote).foregroundStyle(.secondary)
                        }
                        if choice.trash > 0 && trashing {
                            Text("ゴミ箱のファイルは 30 日間は戻せます。").font(.footnote).foregroundStyle(.secondary)
                        }
                    } else if failed {
                        Text("ドライブのファイルを確認できませんでした。").font(.footnote).foregroundStyle(.secondary)
                        Button("再試行") { Task { await load() } }
                    } else {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
            }
            .navigationTitle("メッセージを削除しますか？")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .destructiveAction) {
                    Button("削除", role: .destructive) {
                        // Unknown (not read): the server's default, as a client before CF3 deletes.
                        let driveFiles = choice.map { $0.trash > 0 ? ChannelFiles.DeleteChoice.parameter(trashing: trashing) : "keep" }
                        dismiss()
                        onDelete(driveFiles)
                    }
                    .foregroundStyle(.red)
                    .disabled(choice == nil && !failed)
                }
            }
        }
        .presentationDetents([.medium])
        .task { await load() }
    }

    private func load() async {
        guard let api = controller.api else { failed = true; return }
        failed = false
        do {
            let found = ChannelFiles.DeleteChoice(try await api.messageDriveFiles(message.id).files)
            choice = found
            trashing = found.trash > 0
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }
}

/// The emoji at the top of a message's action sheet.
enum QuickReactions {
    static let count = 6

    /// The ones I chose (M50, the same on every device; since 2026-10-13 a custom emoji's `:name:` too), exactly and in
    /// their order. Without a choice: the ones used
    /// lately first (the picker's recents, standard emoji only), then the palette, six in all — as on the web and
    /// Android (parity audit 2026-09-29).
    static func row(chosen: [String]?, recent recentRaw: String) -> [String] {
        if let chosen, !chosen.isEmpty { return chosen }
        let recent = recentRaw.split(separator: " ").map(String.init).filter { !$0.isEmpty && CustomEmoji.name(of: $0) == nil }
        var seen: Set<String> = []
        return (recent + reactionPalette).filter { seen.insert($0).inserted }.prefix(count).map { $0 }
    }

    /// `row` as shown: a custom emoji this workspace does not have (deleted since it was chosen) is skipped
    /// (apps/shared/quick-reactions.json).
    static func shown(_ row: [String], known: (String) -> Bool) -> [String] {
        row.filter { CustomEmoji.name(of: $0).map(known) ?? true }
    }

    /// 「リアクションの候補」: `glyph` in slot `index` of `row` (an empty slot past the end adds it). One already in
    /// another slot trades places with the one it replaces, so each stays once (the server takes unique emoji).
    static func replacing(_ row: [String], slot index: Int, with glyph: String) -> [String] {
        var result = Array(row.prefix(count))
        guard index >= 0, index < count else { return result }
        if index >= result.count {
            if !result.contains(glyph) { result.append(glyph) }
            return result
        }
        if let other = result.firstIndex(of: glyph) { result[other] = result[index] }
        result[index] = glyph
        return result
    }
}

/// One quick reaction (the long-press sheet, 「リアクションの候補」): a standard emoji as text, a custom one as its image
/// (ReactionGlyph), a wide image made smaller to stay inside the 44 pt circle. A text emoji's pill keeps its height and
/// widens its button instead (`QuickReactionFace`): it was made smaller to fit the circle, and the 10 pt floor left a
/// long label (「ありがとうございます」) wider than the circle, over its neighbours (2026-10-14, as on the web).
struct QuickReactionGlyph: View {
    let controller: AppController
    let emoji: String

    static let height: CGFloat = 26
    /// The widest an image is drawn inside the 44 pt circle.
    static let circleWidth: CGFloat = 38
    /// The widest a text pill is drawn; a wider one (12 wide letters) is scaled down to it.
    static let pillMaxWidth: CGFloat = 200

    /// The height a custom emoji `natural` wide at `height` is drawn at: a text pill as high as an emoji up to
    /// `pillMaxWidth` wide, an image within the circle.
    static func drawnHeight(natural: CGFloat, isText: Bool) -> CGFloat {
        let limit = isText ? pillMaxWidth : circleWidth
        return natural > limit ? (height * limit / natural).rounded(.down) : height
    }

    var body: some View {
        if let name = CustomEmoji.name(of: emoji), let custom = controller.store.customEmoji[name] {
            let width = CustomEmoji.size(of: custom, height: Self.height).width
            ReactionGlyph(controller: controller, emoji: emoji, height: Self.drawnHeight(natural: width, isText: custom.isText))
        } else {
            Text(emoji).font(.system(size: Self.height))
        }
    }
}

/// A quick reaction's 44 pt button face: a circle, or for a text emoji (`wide`) a capsule as wide as its pill.
struct QuickReactionFace<Content: View>: View {
    let wide: Bool
    let fill: Color
    @ViewBuilder let content: Content

    var body: some View {
        content
            .padding(.horizontal, wide ? 9 : 0)
            .frame(minWidth: 44, minHeight: 44, maxHeight: 44)
            .fixedSize(horizontal: true, vertical: false)
            .background(fill, in: Capsule())
    }
}

extension QuickReactions {
    /// A text emoji, whose button grows with its pill.
    @MainActor static func isWide(_ emoji: String, store: Store) -> Bool {
        CustomEmoji.name(of: emoji).flatMap { store.customEmoji[$0] }?.isText ?? false
    }
}

/// The quick reactions in one centred line, or wrapped onto more when a text emoji makes them too wide.
struct QuickReactionsRow<Content: View>: View {
    var spacing: CGFloat = 10
    @ViewBuilder let content: Content

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: spacing) { content }
            ChipsLayout(spacing: spacing) { content }
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
    @AppStorage(EmojiUsage.recentKey) private var recentRaw = ""
    private var quickReactions: [String] {
        QuickReactions.shown(QuickReactions.row(chosen: store.me?.quickReactions.chosen, recent: recentRaw)) { store.customEmoji[$0] != nil }
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
                QuickReactionsRow {
                    ForEach(quickReactions, id: \.self) { emoji in
                        Button {
                            run { await controller.toggleReaction(message, emoji: emoji) }
                        } label: {
                            QuickReactionFace(wide: QuickReactions.isWide(emoji, store: store),
                                              fill: mine.contains(emoji) ? Color.accentColor.opacity(0.2) : Color(.secondarySystemBackground)) {
                                QuickReactionGlyph(controller: controller, emoji: emoji)
                            }
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
                if !message.reactions.isEmpty { row(tr("リアクションした人"), "person.2") { then(.reactors) } }
                if canThread { row(tr("スレッドで返信"), "bubble.left.and.bubble.right") { then(.thread) } }
                if isMine { row(tr("編集"), "pencil") { then(.edit) } }
                if !message.body.isEmpty {
                    row(tr("テキストをコピー"), "doc.on.doc") {
                        // 2026-10-08: the toast says so once the sheet is down (it said nothing before).
                        controller.copyToClipboard(Mentions.decode(message.body, users: store.users, groups: store.groups),
                                                   notice: tr("テキストをコピーしました"))
                        dismiss()
                    }
                }
                let saved = store.isBookmarked(message.id)
                row(saved ? tr("保存を解除") : tr("あとで見る（保存）"), saved ? "bookmark.slash" : "bookmark") {
                    run { await controller.toggleBookmark(message.id) }
                }
                Menu {
                    ForEach(Schedule.reminderPresets()) { preset in
                        Button(Schedule.choice(preset)) {
                            run { _ = await controller.setReminder(messageId: message.id, at: preset.at) }
                        }
                    }
                    Button("日時を指定…", systemImage: "calendar") { then(.customReminder) } // M28d: with a note, as on the web / Android
                } label: {
                    VStack(spacing: 0) {
                        rowLabel(tr("リマインド"), "alarm").foregroundStyle(Color.primary)
                        Divider().padding(.leading, 56)
                    }
                }
                // M56 (TASKS.md §6): after リマインド, as on the web; not on a server without tasks.
                if controller.serverHasTasks && controller.taskHub?.available == true && message.type == "user" {
                    row(tr("タスクにする"), "checklist") { then(.task) }
                    // L9 (REVIEWS.md §2.3): beside it, where the request can be shared (a board I may add to, a DM).
                    if TaskRules.canRequestReview(controller.store.channel(message.channelId), isAdmin: controller.isAdmin) {
                        row(tr("レビューを依頼"), "text.badge.checkmark") { then(.review) }
                    }
                }
                if canMarkUnread { row(tr("ここから未読にする"), "envelope.badge") { onMarkUnread(); dismiss() } }
                row(tr("リンクをコピー"), "link") { controller.copyPermalink(message.id); dismiss() }
                // CF3 (docs/CHANNEL_FILES.md §12.1): a posted file's place in the channel's drive (each file, when several).
                let driveItems = ChannelFiles.driveItems(message.attachments)
                if driveItems.count == 1, let only = driveItems.first {
                    row(tr("ドライブで表示"), "externaldrive") { then(.showInDrive(only.itemId)) }
                } else if driveItems.count > 1 {
                    Menu {
                        ForEach(driveItems, id: \.itemId) { item in
                            Button(item.name) { then(.showInDrive(item.itemId)) }
                        }
                    } label: {
                        VStack(spacing: 0) {
                            rowLabel(tr("ドライブで表示"), "externaldrive").foregroundStyle(Color.primary)
                            Divider().padding(.leading, 56)
                        }
                    }
                }
                // AL3 (docs/ALBUMS.md §9): the message's photos and videos into an album (where the server has albums).
                if controller.drive?.available == true, controller.drive?.albumsAvailable != false, !message.deleted,
                   !AlbumRules.messageMedia(message.attachments).isEmpty {
                    row(tr("この投稿の写真をアルバムに"), "photo.on.rectangle.angled") { then(.addToAlbum) }
                }
                row(tr("別のチャンネルに共有…"), "arrowshape.turn.up.right") { then(.share) }
                row(message.pinnedAt != nil ? tr("ピン留めを外す") : tr("チャンネルにピン留め"), message.pinnedAt != nil ? "pin.slash" : "pin") {
                    run { await controller.togglePin(message) }
                }
                // M104 (MODERATION.md §3): someone else's stored message.
                if Moderation.canReport(message, meId: store.me?.id) {
                    row(tr("報告する"), "flag") { then(.report) }
                }
                if isMine || controller.isAdmin {
                    row(tr("削除"), "trash", role: .destructive) { then(.delete) }
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
        // MOBILE_POLISH.md C4: iOS 26's sheet below full height is glass, and the photos and text behind showed through
        // the actions. A solid ground as Slack's (the elevated background in dark mode).
        .presentationBackground(Color(.systemBackground))
    }

    private func rowLabel(_ title: String, _ icon: String) -> some View {
        Label(title, systemImage: icon)
            // M50 (tester, 2026-10-01: the rows were tall): 44 pt, the smallest tap target, instead of a list's 50.
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
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
