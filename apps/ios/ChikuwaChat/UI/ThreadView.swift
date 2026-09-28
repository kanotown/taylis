import SwiftUI

/// One thread: the parent, its replies (oldest first) and a composer that posts with parent_id.
/// The toolbar follows / unfollows the thread; replies that were shown advance the thread read position.
struct ThreadView: View {
    @Bindable var controller: AppController
    let channelId: String
    let parentId: String
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase

    /// Placed once the whole thread and my read position are known (§10.2); `provisional` until then.
    @State private var positioned = false
    @State private var provisional = false
    /// The reader scrolled away from the provisional bottom before the thread was ready: it is not moved again.
    @State private var userScrolled = false
    /// §10.2: the first unread reply has been on screen with the thread complete; only then do visible replies mark read.
    @State private var anchor = ReadAnchor()
    /// The replies were fetched on this connection. They are fetched again on the next one, and when the thread stops
    /// being complete while online (a §7.3 reload of its channel drops its rows).
    @State private var fetchedOnline = false
    /// M15c: "also send to the channel", unticked again after each send (Slack).
    @State private var alsoInChannel = false
    @State private var atBottom = true
    @State private var visibleFrames: [String: CGRect] = [:]
    @State private var viewportHeight: CGFloat = 0
    @State private var cover = CoverProbe()
    @State private var landingInterrupted = false
    /// The list's UIScrollView, for keeping its bottom edge on iOS 18 (KeepsBottom), and whether it is doing that.
    @State private var scroller = ScrollViewProbe()
    @State private var resizing = false
    /// A message's sheet, presented here rather than by its row (MessageSheet).
    @State private var messageSheet: MessageSheet?
    private var entry: ThreadEntry? { controller.store.threads[parentId] }
    /// Every reply fetched and my read position loaded: only then is 「最初の未読返信」 known.
    private var threadReady: Bool { (controller.engine?.threadComplete(parentId) ?? false) && entry != nil }
    private var focusReplyId: String? { controller.messageFocus.flatMap { $0.parentId == parentId ? $0.messageId : nil } }
    private var parent: MessageState? {
        controller.store.message(channelId, id: parentId)
            ?? entry.map { MessageState($0.parent) }
            ?? controller.messageFocus?.context.first { $0.id == parentId }
    }
    private var replies: [MessageState] { controller.store.replies(channelId, parentId: parentId) }
    /// 「新しい返信」 sits before the first reply from someone else past my read position.
    private var firstUnreadId: String? {
        guard let state = entry?.state, let me = controller.store.me?.id else { return nil }
        return replies.first { ($0.seq ?? 0) > state.lastReadSeq && $0.senderId != me }?.id
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    GeometryReader { viewport in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 12) {
                                if let parent {
                                    MessageRow(message: parent, controller: controller, highlighted: highlighted(parent), present: { messageSheet = $0 })
                                    Text(replies.isEmpty ? "返信はまだありません" : "\(replies.count) 件の返信")
                                        .font(.caption).foregroundStyle(.secondary)
                                    Divider()
                                    ForEach(replies, id: \.rowKey) { reply in
                                        // One cell with its divider, so a reply scrolled to the top shows 「新しい返信」 too.
                                        VStack(alignment: .leading, spacing: 12) {
                                            if reply.id == firstUnreadId { NewRepliesDivider() }
                                            MessageRow(message: reply, controller: controller, highlighted: highlighted(reply), present: { messageSheet = $0 })
                                                .background(GeometryReader { geometry in
                                                    Color.clear.preference(key: VisibleReplyFrames.self,
                                                                           value: [reply.id: geometry.frame(in: .named("threadViewport"))])
                                                })
                                        }
                                        .id(reply.rowKey)
                                    }
                                } else {
                                    Text("メッセージが見つかりません").foregroundStyle(.secondary)
                                }
                                Color.clear.frame(height: 1).id("bottom")
                                    .onAppear { atBottom = true }
                                    .onDisappear { atBottom = false }
                            }
                            .padding()
                            .background(ScrollViewProbe.Marker(probe: scroller))
                        }
                        .coordinateSpace(name: "threadViewport")
                        .dismissesKeyboardOnTap()
                        // KeyboardBehavior.swift: the newest reply (or the reply read last) stays above the input.
                        .keepsBottomOnResize(enabled: (positioned || provisional) && anchor.landing == nil, atEnd: atBottom, scroller: scroller,
                                             resizing: { resizing = $0 }) { height, atEnd in
                            if atEnd {
                                proxy.scrollTo("bottom", anchor: .bottom)
                            } else if let id = KeyboardBehavior.rowAtBottomEdge(visibleFrames, height: height),
                                      let reply = replies.first(where: { $0.id == id }) {
                                proxy.scrollTo(reply.rowKey, anchor: .bottom)
                            }
                        }
                        .onUserScroll {
                            if provisional && !positioned { userScrolled = true }
                            if anchor.landing != nil { landingInterrupted = true }
                        }
                        .background(CoverProbe.Marker(probe: cover))
                        .onPreferenceChange(VisibleReplyFrames.self) { frames in
                            visibleFrames = frames
                            viewportHeight = viewport.size.height
                            markRead()
                        }
                    }
                    .modifier(TimelineScrollAnchor(landing: anchor.landing != nil, resizing: resizing))
                    .scrollDismissesKeyboard(.interactively)
                    .onChange(of: replies.last?.rowKey) { _, _ in
                        let mine = replies.last.map { $0.senderId == controller.store.me?.id && $0.pending } ?? false
                        if (positioned || provisional) && (mine || atBottom && anchor.landing == nil) && controller.messageFocus?.parentId != parentId {
                            if mine && anchor.landing != nil { anchor.landed() } // my post wins; it reads the conversation anyway
                            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
                        }
                    }
                    .onChange(of: scenePhase) { _, _ in markRead() }
                    .onChange(of: controller.engine?.status) { _, _ in markRead() }
                    .onChange(of: threadReady) { _, _ in markRead() }
                    .task(id: "\(replies.count):\(threadReady)") {
                        await Task.yield()
                        position(proxy)
                    }
                    .task(id: anchor.landing) {
                        if let landing = anchor.landing { await land(landing, proxy) }
                    }
                }
                if let channel = controller.store.channel(channelId), channel.isMember, !channel.channel.archived, parent != nil {
                    TypingLine(controller: controller, channelId: channelId, parentId: parentId)
                    let canShare = channel.canPostTopLevel(isAdmin: controller.store.me?.role == "admin")
                    if canShare {
                        Toggle(channel.channel.isDm ? "会話にも送信" : "#\(channel.channel.name ?? "") にも送信", isOn: $alsoInChannel)
                            .font(.footnote).padding(.horizontal, 16)
                    }
                    ComposerView(channelId: channelId, parentId: parentId, users: Array(controller.store.users.values), placeholder: "スレッドに返信", controller: controller) { body, attachmentIds, _ in
                        let shared = canShare && alsoInChannel
                        alsoInChannel = false
                        Task { await controller.engine?.send(channelId, body: body, parentId: parentId, attachmentIds: attachmentIds,
                                                             options: SendOptions(alsoInChannel: shared)) }
                    }
                }
            }
            .navigationTitle("スレッド")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                if let state = entry?.state, controller.store.channel(channelId)?.isMember == true {
                    ToolbarItem(placement: .primaryAction) {
                        Button {
                            Task { await controller.engine?.setThreadFollow(parentId, following: !state.following) }
                        } label: {
                            followLabel(state.following)
                        }
                        .modifier(ToolbarPill())
                        .tint(state.following ? Color.accentColor : .secondary)
                        .accessibilityLabel(state.following ? "スレッドのフォローを外す" : "スレッドをフォロー")
                    }
                }
            }
            .task(id: "\(controller.engine?.status.rawValue ?? ""):\(controller.engine?.threadComplete(parentId) ?? false)") {
                guard let engine = controller.engine else { return }
                guard engine.status == .online else { fetchedOnline = false; return }
                if engine.threadComplete(parentId) && fetchedOnline { return }
                fetchedOnline = await engine.loadReplies(channelId, parentId: parentId)
            }
            // THREADS.md §5: my relation to the thread (follow flag, read position) is fetched once per thread.
            .task(id: "\(parentId):\(controller.engine?.status.rawValue ?? "")") {
                guard entry == nil, let parent, let out = MessageOut(parent) else { return }
                await controller.engine?.loadThreadState(parentId, parent: out)
            }
            .messageSheets(controller, sheet: $messageSheet)
        }
        // §7.7: the channel's rows (these replies among them) are not trimmed while the thread is open, also when the
        // channel is not the open conversation (a thread opened from 「スレッド」).
        .keepsChannelRows(controller.engine, channelId)
    }

    /// 「フォロー中」 / 「フォロー」 with the bell where the toolbar shows titles (iOS 18). From iOS 26 it shows the bell
    /// alone, and the title is what VoiceOver reads there (iOS 26.2 read it rather than the button's label).
    @ViewBuilder
    private func followLabel(_ following: Bool) -> some View {
        if #available(iOS 26.0, *) {
            Label(following ? "スレッドのフォローを外す" : "スレッドをフォロー", systemImage: following ? "bell.fill" : "bell")
        } else {
            Label(following ? "フォロー中" : "フォロー", systemImage: following ? "bell.fill" : "bell").labelStyle(.titleAndIcon)
        }
    }

    private func highlighted(_ message: MessageState) -> Bool { messageSheet?.kind == .actions && messageSheet?.message.id == message.id }

    /// §10.2: until the thread is ready the local rows (live replies only, perhaps) sit at the bottom, or the focus reply
    /// in the middle when held; once ready it is placed once, like a channel: the focus, else the first unread reply at the
    /// top, else the bottom. A reader who scrolled meanwhile is left where they are.
    private func position(_ proxy: ScrollViewProxy) {
        guard !positioned else { return }
        let rows = replies
        guard threadReady, let state = entry?.state else {
            guard !provisional, !rows.isEmpty else { return }
            if let focusReplyId, let focus = rows.first(where: { $0.id == focusReplyId }) {
                proxy.scrollTo(focus.rowKey, anchor: .center)
                positioned = true // already where the ready thread would put it
            } else {
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            provisional = true
            return
        }
        positioned = true
        if userScrolled { return }
        switch ReadGate.threadTarget(rows, focusId: focusReplyId, lastReadSeq: state.lastReadSeq, meId: controller.store.me?.id) {
        case .center(let key): proxy.scrollTo(key, anchor: .center)
        case .top(let key):
            // Anchored only once the reply is really on screen: a long thread lands by estimated heights first.
            if let row = rows.first(where: { $0.rowKey == key }) { anchor.land(on: row) }
        case .bottom: proxy.scrollTo("bottom", anchor: .bottom)
        }
    }

    /// Scrolls the first unread reply (and its divider) to the top, again while LazyVStack's estimates leave it off
    /// screen, then lets the anchor judge from the frames where it ended.
    private func land(_ landing: ReadAnchor.Landing, _ proxy: ScrollViewProxy) async {
        landingInterrupted = false
        for _ in 0..<3 {
            if landingInterrupted { break } // the reader took the list: it is not pulled from under a finger
            proxy.scrollTo(landing.rowKey, anchor: .top)
            try? await Task.sleep(nanoseconds: 200_000_000)
            if Task.isCancelled { return }
            if fullyShown(visibleFrames[landing.rowId]) { break }
        }
        guard anchor.landing == landing else { return }
        anchor.landed()
        markRead()
    }

    private func fullyShown(_ frame: CGRect?) -> Bool {
        guard let frame, frame.maxY > 0, frame.minY < viewportHeight else { return false }
        return frame.minY >= 0 && frame.maxY <= viewportHeight || frame.height > viewportHeight
    }

    /// Read position = the newest reply fully shown (never just "opened"), like the timeline, and only once anchored:
    /// the thread complete and its first unread reply seen (or none), so no unread reply above the screen is skipped.
    /// A thread's unread count says nothing about the rows held before it is complete, so it is not used here.
    private func markRead() {
        let rows = replies
        let looking = scenePhase == .active && viewportHeight > 0 && !cover.covered // not under a message's menu sheets
        let visible = looking ? rows.filter { fullyShown(visibleFrames[$0.id]) } : []
        let onScreen = looking ? Set(visibleFrames.compactMap { $0.value.maxY > 0 && $0.value.minY < viewportHeight ? $0.key : nil }) : []
        let state = threadReady ? entry?.state : nil
        var next = anchor
        let seq = next.observe(unreadCount: nil, ready: state != nil,
                               firstUnread: state.flatMap { ReadGate.firstUnreadRow(rows, afterSeq: $0.lastReadSeq, meId: controller.store.me?.id) },
                               visible: visible, onScreenIds: onScreen)
        if next != anchor { anchor = next }
        if let seq { controller.engine?.markThreadRead(parentId, seq: seq) }
    }
}

/// A toolbar button that shows its state as a shape of its own: bordered where the toolbar draws none (iOS 18); from
/// iOS 26 the toolbar puts every item in a glass capsule already, and a bordered button in it showed two shapes
/// (testers, 2026-09-29). The icon and the tint carry the state there.
private struct ToolbarPill: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content
        } else {
            content.buttonStyle(.bordered).controlSize(.small)
        }
    }
}

private struct NewRepliesDivider: View {
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(Color.red.opacity(0.6)).frame(height: 1)
            Text("新しい返信").font(.caption2).bold().foregroundStyle(.red)
        }
    }
}

private struct VisibleReplyFrames: PreferenceKey {
    static let defaultValue: [String: CGRect] = [:]
    static func reduce(value: inout [String: CGRect], nextValue: () -> [String: CGRect]) {
        value.merge(nextValue(), uniquingKeysWith: { _, latest in latest })
    }
}

struct ThreadTarget: Identifiable, Hashable {
    let id: String
}
