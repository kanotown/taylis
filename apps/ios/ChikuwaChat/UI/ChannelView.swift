import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ChannelView: View {
    @Bindable var controller: AppController
    let channelId: String
    @Binding var pendingThreadId: String?
    @State private var sheet: ChannelSheet?
    @State private var thread: ThreadTarget?
    @Environment(\.scenePhase) private var scenePhase
    @State private var atBottom = false
    @State private var positioned = false
    @State private var visibleFrames: [String: CGRect] = [:]
    @State private var viewportHeight: CGFloat = 0
    @State private var loadingOlder = false
    /// Read position when the channel was opened; the 「新着メッセージ」 divider stays there.
    @State private var unreadMark: Int?
    /// Newest seq the reader has had on screen at the bottom; later messages from others are "new".
    @State private var seenSeq: Int?

    enum ChannelSheet: Identifiable {
        case info, addMember
        var id: Int { switch self { case .info: 0; case .addMember: 1 } }
    }

    private var channel: ChannelState? { controller.store.channel(channelId) }
    private var focus: AppController.MessageFocus? { controller.messageFocus.flatMap { $0.channelId == channelId ? $0 : nil } }
    private var messages: [MessageState] {
        if let focus {
            return focus.context.map { message in
                let cached = controller.store.message(channelId, id: message.id)
                return cached.map { $0.updatedSeq >= message.updatedSeq ? $0 : message } ?? message
            }.filter { !$0.deleted }
        }
        return controller.store.messages(channelId)
    }
    private var items: [TimelineItem] {
        Timeline.build(messages, firstUnreadAfterSeq: controller.engine?.unreadHold[channelId] ?? unreadMark, meId: controller.store.me?.id)
    }
    private var unseenBelow: Int {
        guard focus == nil, let seenSeq else { return 0 }
        let me = controller.store.me?.id
        return messages.filter { ($0.seq ?? 0) > seenSeq && $0.senderId != me }.count
    }
    private func markSeen() {
        let newest = messages.compactMap(\.seq).max() ?? 0
        if newest > (seenSeq ?? 0) { seenSeq = newest }
    }

    private func markRead() {
        guard positioned, focus == nil, thread == nil, scenePhase == .active else { return }
        let seq = messages.compactMap { message -> Int? in
            guard let frame = visibleFrames[message.id], frame.maxY > 0,
                  frame.minY < viewportHeight,
                  (frame.minY >= 0 && frame.maxY <= viewportHeight || frame.height > viewportHeight) else { return nil }
            return message.seq
        }.max()
        if let seq { controller.engine?.markRead(channelId, seq: seq) }
    }

    private func position(_ proxy: ScrollViewProxy) {
        guard !positioned, !messages.isEmpty else { return }
        let target = focus.map { $0.parentId ?? $0.messageId }
            ?? messages.first(where: { message in unreadMark.map { (message.seq ?? 0) > $0 } ?? false })?.id
        if let target { proxy.scrollTo(target, anchor: focus == nil ? .top : .center) }
        else { proxy.scrollTo("bottom", anchor: .bottom) }
        positioned = true
    }

    private func loadOlder() {
        guard !loadingOlder else { return }
        loadingOlder = true
        Task {
            await controller.engine?.loadOlder(channelId)
            loadingOlder = false
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if focus != nil {
                HStack {
                    Text("検索位置の前後の会話").font(.caption)
                    Spacer()
                    Button("最新の会話へ") { controller.messageFocus = nil; unreadMark = nil }
                }.padding(10)
            }
            ScrollViewReader { proxy in
                GeometryReader { viewport in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            if let channel {
                                if focus == nil, channel.hasOlder, channel.syncedSeq != nil {
                                    Button(action: loadOlder) {
                                        if loadingOlder { ProgressView().controlSize(.small) } else { Text("以前のメッセージを読み込む") }
                                    }
                                    .frame(maxWidth: .infinity)
                                    .font(.footnote)
                                    .padding(.vertical, 8)
                                } else if messages.isEmpty {
                                    ContentUnavailableView("まだメッセージはありません", systemImage: "bubble.left",
                                                           description: Text("最初のメッセージを送ってみましょう。"))
                                        .padding(.top, 40)
                                } else if focus == nil {
                                    Text("ここが会話の始まりです").font(.caption).foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity).padding(.vertical, 8)
                                }
                            }
                            ForEach(items) { item in
                                switch item {
                                case .date(let label, _):
                                    DaySeparator(label: label)
                                case .unread:
                                    UnreadSeparator()
                                case .message(let message, let compact):
                                    MessageRow(message: message, controller: controller, compact: compact,
                                               onOpenThread: { thread = ThreadTarget(id: message.id) },
                                               onMarkUnread: message.seq.map { seq in {
                                                   controller.engine?.markUnread(channelId, seq: seq)
                                                   unreadMark = seq - 1
                                               } })
                                        .id(message.id)
                                        .background(GeometryReader { geometry in
                                            Color.clear.preference(key: VisibleMessageFrames.self,
                                                value: [message.id: geometry.frame(in: .named("conversation"))])
                                        })
                                }
                            }
                            Color.clear.frame(height: 1).id("bottom")
                                .onAppear { atBottom = true }
                                .onDisappear { atBottom = false }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                    }
                    .coordinateSpace(name: "conversation")
                    .defaultScrollAnchor(.bottom)
                    .scrollDismissesKeyboard(.interactively)
                    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                        // The keyboard shrinks the viewport: keep the newest message in view when we were at the bottom.
                        guard atBottom, focus == nil else { return }
                        DispatchQueue.main.async { withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) } }
                    }
                    .onPreferenceChange(VisibleMessageFrames.self) { frames in
                        visibleFrames = frames
                        viewportHeight = viewport.size.height
                        markRead()
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if !atBottom && focus == nil {
                            Button { withAnimation { proxy.scrollTo("bottom", anchor: .bottom) } } label: {
                                if unseenBelow > 0 {
                                    Label("新着 \(unseenBelow) 件", systemImage: "arrow.down")
                                        .font(.footnote.bold())
                                        .padding(.horizontal, 12).padding(.vertical, 8)
                                        .background(Color.accentColor, in: Capsule())
                                        .foregroundStyle(.white)
                                } else {
                                    Image(systemName: "arrow.down").padding(10).background(.thinMaterial, in: Circle())
                                }
                            }
                            .accessibilityLabel(unseenBelow > 0 ? "新着 \(unseenBelow) 件へ" : "最新のメッセージへ")
                            .padding(12)
                        }
                    }
                    .onChange(of: atBottom) { _, bottom in if bottom { markSeen() } }
                    .onChange(of: messages.last?.id) { _, _ in
                        // Arrivals while at the bottom, and my own sends from anywhere, show the newest message.
                        let last = messages.last
                        let mine = last.map { $0.senderId == controller.store.me?.id && ($0.pending || $0.seq == channel?.lastSeq) } ?? false
                        if positioned && focus == nil && (atBottom || mine) {
                            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
                            markSeen()
                        }
                    }
                    .task(id: messages.count) { await Task.yield(); position(proxy) }
                    .onChange(of: focus?.messageId) { _, _ in
                        positioned = false
                        position(proxy)
                    }
                    .onChange(of: controller.engine?.status) { _, _ in markRead() }
                    .onChange(of: scenePhase) { _, _ in markRead() }
                    .onAppear {
                        if unreadMark == nil, let channel, channel.unreadCount > 0 { unreadMark = channel.lastReadSeq }
                        if seenSeq == nil { seenSeq = channel?.lastReadSeq ?? 0 }
                    }
                }
            }
            if let channel {
                if !channel.isMember {
                    Button("参加する") {
                        Task {
                            guard let api = controller.api else { return }
                            do {
                                let joined = try await api.joinChannel(id: channelId)
                                controller.store.upsertChannel(joined, isMember: true)
                                await controller.engine?.openChannel(channelId)
                            } catch { controller.error = controller.describe(error) }
                        }
                    }
                    .buttonStyle(.borderedProminent).padding()
                } else if channel.channel.archived {
                    Text("アーカイブ済みのチャンネルです").font(.footnote).foregroundStyle(.secondary).padding()
                } else {
                    ComposerView(channelId: channelId, users: Array(controller.store.users.values), placeholder: "\(channelTitle(channel, store: controller.store)) へメッセージ", controller: controller) { body, attachmentIds in
                        Task { await controller.engine?.send(channelId, body: body, attachmentIds: attachmentIds) }
                    }
                }
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                if let channel {
                    Button { sheet = .info } label: {
                        VStack(spacing: 0) {
                            Text(channelTitle(channel, store: controller.store)).font(.headline).lineLimit(1)
                            if let subtitle = headerSubtitle(channel) {
                                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("チャンネル情報")
                }
            }
            if let channel, channel.isMember {
                ToolbarItem(placement: .topBarTrailing) { NotificationMenu(controller: controller, channel: channel) }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("チャンネル情報", systemImage: "info.circle") { sheet = .info }
            }
        }
        .sheet(item: $sheet) { which in
            switch which {
            case .info: ChannelInfoView(controller: controller, channelId: channelId)
            case .addMember: AddMemberView(controller: controller, channelId: channelId)
            }
        }
        .sheet(item: $thread) { target in ThreadView(controller: controller, channelId: channelId, parentId: target.id) }
        .onChange(of: pendingThreadId, initial: true) { _, id in
            if let id {
                thread = ThreadTarget(id: id)
                pendingThreadId = nil
            }
        }
    }

    private func headerSubtitle(_ channel: ChannelState) -> String? {
        if let topic = channel.channel.topic, !topic.isEmpty { return topic }
        return !channel.channel.isDm && channel.isMember && !channel.channel.archived ? "トピックを設定" : nil
    }
}

/// Bell in the channel toolbar: notification level plus a timed mute (PUSH_NOTIFICATIONS.md §4).
struct NotificationMenu: View {
    @Bindable var controller: AppController
    let channel: ChannelState

    private var level: String { channel.channel.notification?.level ?? (channel.channel.isDm ? "all" : "mentions") }
    private var muteLabel: String? { Timeline.muteLabel(channel.channel.notification?.mutedUntil) }

    var body: some View {
        Menu {
            Picker("通知", selection: Binding(get: { level }, set: { value in
                Task { await controller.setNotification(channel.id, level: value, mutedUntil: channel.channel.notification?.mutedUntil) }
            })) {
                Text("すべてのメッセージ").tag("all")
                Text("メンションのみ").tag("mentions")
                Text("通知しない").tag("none")
            }
            Divider()
            if let muteLabel {
                Button("ミュート解除 (\(muteLabel))", systemImage: "bell") {
                    Task { await controller.setNotification(channel.id, level: level, mutedUntil: nil) }
                }
            } else {
                Button("8 時間ミュート", systemImage: "moon.zzz") {
                    let until = ISO8601DateFormatter().string(from: Date().addingTimeInterval(8 * 3600))
                    Task { await controller.setNotification(channel.id, level: level, mutedUntil: until) }
                }
            }
        } label: {
            Image(systemName: isMuted(channel) ? "bell.slash" : "bell")
        }
        .accessibilityLabel("通知設定")
    }
}

struct DaySeparator: View {
    let label: String

    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(Color(.separator)).frame(height: 1)
            Text(label).font(.caption).foregroundStyle(.secondary).fixedSize()
            Rectangle().fill(Color(.separator)).frame(height: 1)
        }
        .padding(.vertical, 10)
    }
}

struct UnreadSeparator: View {
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(.red).frame(height: 1)
            Text("新着メッセージ").font(.caption.bold()).foregroundStyle(.red).fixedSize()
            Rectangle().fill(.red).frame(height: 1)
        }
        .padding(.vertical, 6)
    }
}

let reactionPalette = ["👍", "❤️", "😂", "🎉", "👀", "✅"]

struct MessageRow: View {
    let message: MessageState
    @Bindable var controller: AppController
    var compact = false
    var onOpenThread: (() -> Void)? = nil
    /// 「ここから未読にする」; nil for thread replies and pending rows.
    var onMarkUnread: (() -> Void)? = nil
    @State private var editing = false
    @State private var confirmingDelete = false
    @State private var showTime = false

    private var store: Store { controller.store }
    private var engine: SyncEngine? { controller.engine }
    private var isMine: Bool { store.me?.id == message.senderId }
    private var senderName: String { store.users[message.senderId]?.displayName ?? (message.pending ? store.me?.displayName ?? "" : "?") }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if compact {
                Color.clear.frame(width: 36, height: 1)
            } else {
                AvatarView(id: message.senderId, name: senderName)
            }
            VStack(alignment: .leading, spacing: 2) {
                if !compact {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(senderName).bold()
                        Text(Timeline.timeLabel(message.createdAt)).font(.caption).foregroundStyle(.secondary)
                        if message.editedAt != nil { Text("(編集済み)").font(.caption).foregroundStyle(.secondary) }
                    }
                } else if showTime || message.editedAt != nil {
                    Text(Timeline.fullLabel(message.createdAt) + (message.editedAt != nil ? " (編集済み)" : ""))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if !message.body.isEmpty { MessageBodyView(text: message.body, users: store.users) }
                if !message.attachments.isEmpty { AttachmentsView(attachments: message.attachments, controller: controller) }
                if !message.reactions.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(message.reactions, id: \.emoji) { reaction in
                            let mine = store.me.map { reaction.userIds.contains($0.id) } ?? false
                            Button { Task { await controller.toggleReaction(message, emoji: reaction.emoji) } } label: {
                                Text("\(reaction.emoji) \(reaction.count)").font(.caption)
                            }
                            .buttonStyle(.bordered)
                            .tint(mine ? Color.accentColor : Color.secondary)
                            .controlSize(.mini)
                        }
                    }
                    .padding(.top, 2)
                }
                if message.replyCount > 0, let onOpenThread {
                    Button { onOpenThread() } label: {
                        Label("\(message.replyCount) 件の返信", systemImage: "bubble.left.and.bubble.right").font(.caption)
                    }
                    .padding(.top, 2)
                }
                if message.failed {
                    HStack {
                        Text("送信に失敗しました").font(.caption).foregroundStyle(.red)
                        Button("再送") { Task { await engine?.retryFailed() } }.font(.caption)
                        Button("破棄", role: .destructive) { if let key = message.clientMsgId { engine?.discardFailed(key) } }.font(.caption)
                    }
                }
            }
        }
        .padding(.vertical, compact ? 1 : 5)
        .opacity(message.pending && !message.failed ? 0.6 : 1)
        .background(controller.messageFocus?.messageId == message.id ? Color.yellow.opacity(0.18) : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture { if compact { showTime.toggle() } }
        .contextMenu {
            if !message.pending {
                ForEach(reactionPalette, id: \.self) { emoji in
                    Button(emoji) { Task { await controller.toggleReaction(message, emoji: emoji) } }
                }
                if let onOpenThread { Button("スレッドで返信", systemImage: "bubble.left.and.bubble.right") { onOpenThread() } }
                if let onMarkUnread { Button("ここから未読にする", systemImage: "envelope.badge") { onMarkUnread() } }
                if isMine { Button("編集", systemImage: "pencil") { editing = true } }
                if isMine || controller.isAdmin { Button("削除", systemImage: "trash", role: .destructive) { confirmingDelete = true } }
            }
        }
        .sheet(isPresented: $editing) {
            EditMessageView(initial: Mentions.decode(message.body, users: store.users)) { body in
                Task { await controller.editMessage(message.id, body: Mentions.encode(body, users: store.users.values)) }
            }
        }
        .confirmationDialog("メッセージを削除しますか？", isPresented: $confirmingDelete, titleVisibility: .visible) {
            Button("削除", role: .destructive) { Task { await controller.deleteMessage(message.id) } }
        }
    }
}

struct EditMessageView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    let onSave: (String) -> Void

    init(initial: String, onSave: @escaping (String) -> Void) {
        _text = State(initialValue: initial)
        self.onSave = onSave
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            TextEditor(text: $text)
                .padding()
                .navigationTitle("メッセージを編集")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button("保存") { onSave(trimmed); dismiss() }.disabled(trimmed.isEmpty)
                    }
                }
        }
    }
}

/// The server sends ISO 8601 with microseconds; ISO8601DateFormatter only understands milliseconds.
func parseIsoDate(_ iso: String) -> Date? {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: iso) { return date }
    let truncated = iso.replacingOccurrences(of: #"(\.\d{3})\d+"#, with: "$1", options: .regularExpression)
    if let date = formatter.date(from: truncated) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: iso)
}

struct ComposerView: View {
    let channelId: String
    var parentId: String? = nil
    let users: [UserPublic]
    var placeholder = "メッセージを入力"
    var controller: AppController? = nil
    let onSend: (String, [String]) -> Void
    private var text: String { controller?.store.draft(channelId, parentId: parentId).text ?? "" }
    private var pending: [AttachmentOut] { controller?.store.draft(channelId, parentId: parentId).attachments ?? [] }
    private var uploading: Int { controller?.store.uploading(channelId, parentId: parentId) ?? 0 }
    private var textBinding: Binding<String> { Binding(get: { text }, set: { value in
        controller?.store.setDraft(channelId, parentId: parentId) { $0.text = value }
    }) }
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @State private var showCamera = false
    @FocusState private var focused: Bool

    private var candidates: [Mentions.Candidate] {
        guard let query = Mentions.query(text) else { return [] }
        return Mentions.candidates(query, users: users)
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { uploading == 0 && (!trimmed.isEmpty || !pending.isEmpty) }
    private var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    private func upload(data: Data, filename: String, contentType: String) async {
        guard let controller else { return }
        let store = controller.store
        guard pending.count < 10 else { controller.error = "添付は10件までです"; return }
        if let uploaded = await controller.uploadAttachment(data: data, filename: filename, contentType: contentType) {
            store.setDraft(channelId, parentId: parentId) { $0.attachments.append(uploaded) }
        }
    }

    private func send() {
        let body = Mentions.encode(trimmed, users: users)
        guard canSend else { return }
        guard body.count <= 20_000, pending.count <= 10 else { controller?.error = "添付は10件、本文は20,000文字までです"; return }
        let ids = pending.map(\.id)
        controller?.store.setDraft(channelId, parentId: parentId) { $0 = Draft() }
        onSend(body, ids)
    }

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            PendingAttachmentsView(items: pending) { item in
                controller?.store.setDraft(channelId, parentId: parentId) { $0.attachments.removeAll { $0.id == item.id } }
            }
            if !candidates.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(candidates) { candidate in
                            Button { textBinding.wrappedValue = Mentions.complete(text, username: candidate.username) } label: {
                                Text("@\(candidate.username)").fontWeight(.semibold) + Text("  \(candidate.label)").foregroundStyle(.secondary)
                            }
                            .font(.footnote)
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                    }
                    .padding(.horizontal, 12)
                }
                .padding(.top, 6)
            }
            HStack(alignment: .bottom, spacing: 8) {
                if controller != nil {
                    // "+" like Slack / Mattermost: photos, camera and files from one place.
                    Menu {
                        Button("写真ライブラリ", systemImage: "photo.on.rectangle") { showPhotoPicker = true }
                        if cameraAvailable { Button("カメラ", systemImage: "camera") { showCamera = true } }
                        Button("ファイル", systemImage: "folder") { showFileImporter = true }
                    } label: {
                        Image(systemName: "plus.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(uploading > 0 ? Color.secondary : Color.accentColor)
                            .frame(width: 36, height: 36)
                    }
                    .disabled(uploading > 0)
                    .accessibilityLabel("添付")
                }
                HStack(alignment: .bottom, spacing: 4) {
                    TextField(placeholder, text: textBinding, axis: .vertical)
                        .lineLimit(1...6)
                        .focused($focused)
                        .padding(.leading, 14)
                        .padding(.vertical, 9)
                        .padding(.trailing, canSend || uploading > 0 ? 0 : 12)
                    if uploading > 0 {
                        ProgressView().controlSize(.small).padding(.trailing, 10).padding(.bottom, 10)
                    } else if canSend {
                        Button(action: send) {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 28))
                                .foregroundStyle(Color.accentColor)
                        }
                        .accessibilityLabel("送信")
                        .padding(.trailing, 5)
                        .padding(.bottom, 4)
                        .transition(.scale.combined(with: .opacity))
                    }
                }
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 21, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 21, style: .continuous).strokeBorder(Color(.separator).opacity(0.6), lineWidth: 0.5))
                .animation(.easeOut(duration: 0.15), value: canSend)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
        }
        .background(Color(.systemBackground))
        // The picker is presented from the composer itself; a PhotosPicker inside a Menu never opens.
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItems, maxSelectionCount: 5, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            controller?.store.trackUpload(channelId, parentId: parentId, delta: 1)
            Task {
                defer { controller?.store.trackUpload(channelId, parentId: parentId, delta: -1) }
                for item in items {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                    let type = item.supportedContentTypes.first
                    await upload(data: data, filename: "photo." + (type?.preferredFilenameExtension ?? "jpg"), contentType: type?.preferredMIMEType ?? "image/jpeg")
                }
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                guard let data = image.normalizedUp().jpegData(compressionQuality: 0.85) else { return }
                controller?.store.trackUpload(channelId, parentId: parentId, delta: 1)
                Task {
                    defer { controller?.store.trackUpload(channelId, parentId: parentId, delta: -1) }
                    await upload(data: data, filename: "photo-\(Int(Date().timeIntervalSince1970)).jpg", contentType: "image/jpeg")
                }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $showFileImporter, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            controller?.store.trackUpload(channelId, parentId: parentId, delta: 1)
            Task {
                defer { controller?.store.trackUpload(channelId, parentId: parentId, delta: -1) }
                for url in urls {
                    let accessed = url.startAccessingSecurityScopedResource()
                    defer { if accessed { url.stopAccessingSecurityScopedResource() } }
                    guard let data = try? Data(contentsOf: url) else { continue }
                    let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
                    await upload(data: data, filename: url.lastPathComponent, contentType: type)
                }
            }
        }
    }
}

private struct VisibleMessageFrames: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}
