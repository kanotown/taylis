import SwiftUI

/// One thread: the parent, its replies (oldest first) and a composer that posts with parent_id.
/// The toolbar follows / unfollows the thread; replies that were shown advance the thread read position.
struct ThreadView: View {
    @Bindable var controller: AppController
    let channelId: String
    let parentId: String
    /// Closes the thread where it is not a pushed screen (the split's pane); else the normal back (THREADS.md: a deleted root).
    var onClose: (() -> Void)? = nil
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss
    @Environment(\.isPresented) private var isPresented
    /// M47: replies group like the channel's rows when on (read here, so switching it redraws an open thread).
    @AppStorage(Timeline.groupingKey) private var grouping = false

    /// Placed once the whole thread and my read position are known (§10.2); `provisional` until then.
    @State private var positioned = false
    @State private var dividerMark: Int?
    @State private var dividerTaken = false
    @State private var provisional = false
    /// The reader scrolled away from the provisional bottom before the thread was ready: it is not moved again.
    @State private var userScrolled = false
    /// §10.2: the first unread reply has been on screen with the thread complete; only then do visible replies mark read.
    @State private var anchor = ReadAnchor()
    /// The replies were fetched on this connection. They are fetched again on the next one, and when the thread stops
    /// being complete while online (a §7.3 reload of its channel drops its rows).
    @State private var fetchedOnline = false
    /// A fetch of the replies or the thread's state failed while online; 「再読み込み」 bumps the attempt.
    @State private var loadFailed = false
    @State private var loadAttempt = 0
    /// M15c: "also send to the channel", unticked again after each send (Slack).
    @State private var alsoInChannel = false
    @State private var atBottom = true
    /// The newest reply the reader has had on screen at the newest edge (ChannelView.seenSeq): replies from others after
    /// it are 「新着 N 件」 on the jump button.
    @State private var seenSeq: Int?
    /// Where the replies are on screen, for the read rules and the landing: not view state (ChannelView's RowFrames).
    /// Written on every frame the list moves — and on iOS 18 on every frame of the keyboard's animation, which lays the
    /// conversation out frame by frame there — it ran this view's body each time (iOS 18 testers: the list stuttered as
    /// the keyboard came up, 2026-10-09).
    @State private var frames = RowFrames()
    private var visibleFrames: [String: CGRect] { frames.byId }
    private var viewportHeight: CGFloat { frames.viewportHeight }
    @State private var cover = CoverProbe()
    @State private var landingInterrupted = false
    /// A message's sheet, presented here rather than by its row (MessageSheet).
    @State private var messageSheet: MessageSheet?
    /// M66: the 「このスレッドを要約」 sheet's request.
    @State private var aiSummary: AiSummaryRequest?
    /// The row the list is kept at (ChannelView.keptRowId): a reply arriving below does not move what is on screen.
    @State private var keptRowId: String?
    /// The landing on the first unread reply, in a task of its own (ChannelView.landingTask: a `.task` cancelled by the
    /// navigation's disappear and reappear left the landing unfinished).
    @State private var landingTask: Task<Void, Never>?
    /// THREADS.md: the root deleted while the thread is shown closes it; opened already deleted, it says so.
    @State private var rootWatch = ThreadRootWatch()
    private var rootDeleted: Bool { controller.store.deletedThreadRoots.contains(parentId) }
    private var entry: ThreadEntry? { controller.store.threads[parentId] }
    /// Every reply fetched and my read position loaded: only then is 「最初の未読返信」 known.
    private var threadReady: Bool { (controller.engine?.threadComplete(parentId) ?? false) && entry != nil }
    private var focusReplyId: String? { controller.messageFocus.flatMap { $0.parentId == parentId ? $0.messageId : nil } }
    private var parent: MessageState? {
        controller.store.message(channelId, id: parentId)
            ?? entry.map { MessageState($0.parent) }
            ?? controller.messageFocus?.context.first { $0.id == parentId }
            ?? controller.timesFeed.parent(parentId).map { MessageState($0) } // opened from the Times feed (review #8)
    }
    private var replies: [MessageState] { controller.store.replies(channelId, parentId: parentId) }
    /// 「新しい返信」 sits before the first reply from someone else past my read position when the thread became ready
    /// (`dividerMark`), and stays there while it is open.
    private var firstUnreadId: String? {
        guard let mark = dividerMark, let me = controller.store.me?.id else { return nil }
        return replies.first { ($0.seq ?? 0) > mark && $0.senderId != me }?.id
    }

    /// Taken once, before the first read mark moves the position (ReadGate.threadDividerMark).
    private func takeDividerMark() {
        guard !dividerTaken, threadReady, let state = entry?.state else { return }
        dividerTaken = true
        dividerMark = ReadGate.threadDividerMark(replies, lastReadSeq: state.lastReadSeq, meId: controller.store.me?.id)
    }

    /// The thread itself: the replies under the parent, and the composer.
    private var conversation: some View {
        // M29: pushed onto the conversation's navigation (Slack), not a sheet: back and the swipe return to it.
        VStack(spacing: 0) {
            // The flipped list must not reach under the navigation bar: a scroll view there takes the bar's height as a
            // margin and draws the bar's edge effect, both at its top — which the flip puts at the bottom, and the replies
            // went under the bar blurred (M36). A hairline above keeps it below the bar, as the tabs row does in a channel.
            Color.clear.frame(height: 1)
            ScrollViewReader { proxy in
                GeometryReader { viewport in
                    // Upside down like a conversation (UpsideDownList.swift): the newest reply stays above the input as
                    // the keyboard comes and goes, and a new one pushes the others up by itself.
                    ScrollView {
                        // The channel's 8 pt: under the newest reply the same gap as under a channel's newest message.
                        rowStack(viewport.size.height)
                        .padding(.vertical, 8) // the side margin is each row's (margin)
                        // MOBILE_POLISH.md C7: a thread shorter than the screen starts at the top (the parent under the
                        // bar, the replies after it; Slack), not at the bottom under a gap. At least a screen tall, with
                        // the rows at its far end — the screen's top in the flipped list. Layout only: a longer thread
                        // is unchanged, and the newest reply stays at the origin (the keyboard, arrivals).
                        .frame(minHeight: viewport.size.height, alignment: .bottom)
                        .frame(width: viewport.size.width) // never wider than the list (ChannelView)
                        // At the newest edge a new reply moves in with the others, animated; not while older replies are
                        // read, where the row being read stays (UpsideDown.arrivalAnimation).
                        .animation(UpsideDown.arrivalAnimation(atNewest: atBottom, placed: positioned || provisional), value: replies.last?.rowKey)
                        .background(StatusBarTapStays())
                    }
                    .scrollPosition(id: $keptRowId, anchor: .top)
                    .upsideDown()
                    .clipped()
                    .onNewestEdge { atBottom = $0 }
                    .dismissesKeyboardOnTap()
                    .overlay(alignment: .bottomTrailing) {
                        if !atBottom && positioned {
                            JumpToNewestButton(unseen: unseenBelow, latestLabel: "最新の返信へ") { UpsideDown.jumpToNewest($keptRowId, proxy) }
                        }
                    }
                    .onUserScroll {
                        if provisional && !positioned { userScrolled = true }
                        if anchor.landing != nil { landingInterrupted = true }
                    }
                    .background(CoverProbe.Marker(probe: cover))
                    .onPreferenceChange(VisibleReplyFrames.self) { visible in
                        frames.byId = visible
                        frames.viewportHeight = viewport.size.height
                        markRead()
                    }
                }
                // Outside the flip: the replies' frames come out as they are on screen.
                .coordinateSpace(name: "threadViewport")
                .conversationDismissesKeyboard()
                .onChange(of: replies.last?.rowKey) { _, _ in
                    // As in a channel (UpsideDown.arrival): at the newest reply a new one shows, my own reply from further
                    // up jumps to it, someone else's leaves the reader where they are (the jump button counts it).
                    guard positioned || provisional else { return }
                    let mine = replies.last.map { $0.senderId == controller.store.me?.id && $0.pending } ?? false
                    let moves = mine && controller.messageFocus?.parentId != parentId
                    if moves && anchor.landing != nil { anchor.landed() } // my post wins; it reads the conversation anyway
                    switch UpsideDown.arrival(atNewest: atBottom, mine: moves) {
                    case .follow: keptRowId = UpsideDown.newest
                    case .jump: UpsideDown.jumpToNewest($keptRowId, proxy)
                    case .stay: break
                    }
                    if atBottom || moves { markSeen() }
                }
                .onChange(of: atBottom) { _, bottom in if bottom { markSeen() } }
                .onChange(of: scenePhase) { _, _ in markRead() }
                .onChange(of: controller.engine?.status) { _, _ in markRead() }
                .onChange(of: threadReady) { _, _ in
                    takeDividerMark()
                    markRead()
                }
                .task(id: "\(replies.count):\(threadReady)") {
                    await Task.yield()
                    position(proxy)
                }
                .onChange(of: anchor.landing, initial: true) { _, landing in startLanding(landing, proxy) }
                .onAppear { if anchor.landing != nil { startLanding(anchor.landing, proxy) } }
            }
            if let channel = controller.store.channel(channelId), channel.isMember, !channel.channel.archived, parent != nil {
                TypingLine(controller: controller, channelId: channelId, parentId: parentId)
                let canShare = channel.canPostTopLevel(isAdmin: controller.store.me?.role == "admin")
                ComposerView(channelId: channelId, parentId: parentId, users: Array(controller.store.users.values), placeholder: tr("スレッドに返信"), controller: controller,
                             accessory: canShare ? AnyView(AlsoSendRow(title: channel.channel.isDm ? tr("会話にも送信") : tr("#\(channel.channel.name ?? "") にも送信"),
                                                                       isOn: $alsoInChannel)) : nil) { body, attachmentIds, _ in
                    let shared = canShare && alsoInChannel
                    alsoInChannel = false
                    Task { await controller.engine?.send(channelId, body: body, parentId: parentId, attachmentIds: attachmentIds,
                                                         options: SendOptions(alsoInChannel: shared)) }
                }
            }
        }
    }

    var body: some View {
        Group {
            if rootDeleted {
                // THREADS.md: the root is gone: no parent row, no replies, no composer.
                Text("元のメッセージは削除されました")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, Self.margin)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                conversation
            }
        }
        .onChange(of: rootDeleted, initial: true) { _, deleted in
            guard rootWatch.next(rootDeleted: deleted) == .close else { return }
            controller.threadClosedForDeletedRoot(parentId)
            close()
        }
        .navigationTitle("スレッド")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // MOBILE_POLISH.md C7: which conversation, under the title (Slack; Android's two-line title).
            if let channel = controller.store.channel(channelId) {
                ToolbarItem(placement: .principal) {
                    ThreadTitle(conversation: channelTitle(channel, store: controller.store))
                }
            }
            if let state = entry?.state, controller.store.channel(channelId)?.isMember == true {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        Task { await controller.setThreadFollow(parentId, following: !state.following) }
                    } label: {
                        followLabel(state.following)
                    }
                    .modifier(ToolbarPill())
                    .tint(state.following ? Color.accentColor : .secondary)
                    .accessibilityLabel(state.following ? "スレッドのフォローを外す" : "スレッドをフォロー")
                }
            }
            if controller.canSummarize(channelId) && !rootDeleted {  // M66 (docs/AI.md §6)
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        let target = controller.aiHub?.target(channelId)
                        Button("このスレッドを要約", systemImage: "sparkles") {
                            let request = AiSummaryRequest(channelId: channelId, scope: .thread(parentId: parentId))
                            aiSummary = request
                            controller.summarize(request)
                        }
                        .disabled(AiRules.choicesDisabled(target))
                        AiSummaryTargetLine(target: target)
                    } label: {
                        Image(systemName: "ellipsis")
                    }
                    .accessibilityLabel("スレッドのメニュー")
                }
            }
        }
        .aiSummarySheet(controller, request: $aiSummary)
        .loadsSummaryTarget(controller, channelId: channelId)
        .task(id: "\(controller.engine?.status.rawValue ?? ""):\(controller.engine?.threadComplete(parentId) ?? false):\(loadAttempt)") {
            guard let engine = controller.engine else { return }
            guard engine.status == .online else { fetchedOnline = false; return }
            if engine.threadComplete(parentId) && fetchedOnline { return }
            fetchedOnline = await engine.loadReplies(channelId, parentId: parentId)
            if fetchedOnline { rootWatch.repliesLoaded(rootDeleted: rootDeleted) }
            // A failed fetch (a 5xx, a timeout) left the thread half shown for good, with no word and no read marks
            // (audit 2026-09-29): 「再読み込み」 tries again. Not for a root found deleted (a 404): that says so instead.
            if !fetchedOnline && engine.status == .online && !rootDeleted { loadFailed = true }
        }
        // THREADS.md §5: my relation to the thread (follow flag, read position) is fetched once per thread.
        .task(id: "\(parentId):\(controller.engine?.status.rawValue ?? ""):\(loadAttempt)") {
            guard entry == nil, !rootDeleted, let parent, let out = MessageOut(parent), let engine = controller.engine else { return }
            if !(await engine.loadThreadState(parentId, parent: out)) && engine.status == .online && !rootDeleted { loadFailed = true }
        }
        .messageSheets(controller, sheet: $messageSheet, threadRootId: parentId)
        .keepsKeyboardRoomWhileSwipingBack()
        // §7.7: the channel's rows (these replies among them) are not trimmed while the thread is open, also when the
        // channel is not the open conversation (a thread opened from 「スレッド」).
        .keepsChannelRows(controller.engine, channelId)
    }

    /// THREADS.md: back to where the thread was opened from (the pane closes); a thread with nothing under it goes to its
    /// conversation.
    private func close() {
        if let onClose {
            onClose()
        } else if isPresented {
            dismiss()
        } else {
            NotificationCenter.default.post(name: .chikuwaOpenChannel, object: nil, userInfo: ["id": channelId])
        }
    }

    /// The list's side margin, inside each row: a message's highlight reaches the sheet's edges (ChannelView).
    private static let margin: CGFloat = 16

    /// The thread's rows, laid out all at once up to `lazyFrom` replies (as from build 13; build 106 made them lazy). In a
    /// LazyVStack the rows' estimated heights (replies of 1 to 12 lines, the parent at the far end) were replaced by
    /// measured ones as rows came on screen, and `scrollPosition(id:)` re-anchored the list on each: the content height
    /// swung by 2,200 pt within a frame. The thread jumped as it opened (339 pt just after landing on the first unread
    /// reply), and the keyboard shown while reading older replies threw the rows 618 pt one way and 652 pt back, and hiding
    /// it left the list at the newest edge, the reading position lost (iOS 26, 2026-10-07). With every height known, the
    /// keyboard moves the rows by its own height only and the landing is exact; the row being read stays on an arrival as
    /// long as the insertion is not animated (body). A very long thread stays lazy.
    /// The newest edge's marker is one of the scroll targets, as in a channel, so at the newest edge it can be the kept row
    /// (UpsideDown.arrival); a VStack makes it once, so on iOS 17 it reports from where it is (NewestEdgeMarker.placed).
    /// The stack has no spacing (it would put 12 pt between the marker and the newest reply): each row brings the gap above it.
    private static let lazyFrom = 200

    @ViewBuilder
    private func rowStack(_ viewportHeight: CGFloat) -> some View {
        if replies.count > Self.lazyFrom {
            LazyVStack(alignment: .leading, spacing: 0) {
                NewestEdgeMarker { atBottom = $0 }
                rows()
            }
            .scrollTargetLayout()
        } else {
            VStack(alignment: .leading, spacing: 0) {
                NewestEdgeMarker(placed: ("threadViewport", viewportHeight)) { atBottom = $0 }
                rows()
            }
            .scrollTargetLayout()
        }
    }

    /// The gap above a reply (between it and the one before it, or the reply count); none above a grouped reply, which
    /// sits right under the one before it, as a channel's rows do.
    private static let rowGap: CGFloat = 12

    /// Upside down (the list is flipped): the replies newest first (the end marker is before them, in rowStack), then the
    /// reply count and the parent; each flipped back the right way up.
    @ViewBuilder
    private func rows() -> some View {
        if let parent {
            let compactIds = Timeline.threadCompactIds(replies, firstUnreadId: firstUnreadId, grouping: grouping)
            ForEach(replies.reversed(), id: \.rowKey) { reply in
                let compact = compactIds.contains(reply.id)
                // One cell with its divider, so a reply scrolled to the top shows 「新しい返信」 too.
                VStack(alignment: .leading, spacing: 12) {
                    if reply.id == firstUnreadId { NewRepliesDivider().padding(.horizontal, Self.margin) }
                    MessageRow(message: reply, controller: controller, compact: compact, margin: Self.margin, highlighted: highlighted(reply),
                               present: { messageSheet = $0 })
                        .background(GeometryReader { geometry in
                            Color.clear.preference(key: VisibleReplyFrames.self,
                                                   value: [reply.id: geometry.frame(in: .named("threadViewport"))])
                        })
                }
                .padding(.top, compact ? 0 : Self.rowGap)
                .upsideDown()
                .transition(.asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .opacity))
                .id(reply.rowKey)
            }
            // In screen order (top to bottom), flipped back as one.
            VStack(alignment: .leading, spacing: Self.rowGap) {
                MessageRow(message: parent, controller: controller, margin: Self.margin, highlighted: highlighted(parent),
                           present: { messageSheet = $0 })
                Text(replies.isEmpty ? "返信はまだありません" : "\(replies.count) 件の返信")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, Self.margin)
                Divider().padding(.horizontal, Self.margin)
                if loadFailed {
                    HStack(spacing: 10) {
                        Label("スレッドを読み込めませんでした", systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
                        Button("再読み込み") {
                            loadFailed = false
                            loadAttempt += 1
                        }
                    }
                    .font(.footnote).padding(.horizontal, Self.margin)
                }
            }
            .upsideDown()
        } else {
            Text("メッセージが見つかりません").foregroundStyle(.secondary).padding(.horizontal, Self.margin).upsideDown()
        }
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
        takeDividerMark()
        guard !positioned else { return }
        let rows = replies
        guard threadReady, let state = entry?.state else {
            guard !provisional, !rows.isEmpty else { return }
            if let focusReplyId, let focus = rows.first(where: { $0.id == focusReplyId }) {
                proxy.scrollTo(focus.rowKey, anchor: .center)
                positioned = true // already where the ready thread would put it
            } else {
                proxy.scrollTo(UpsideDown.newest, anchor: UpsideDown.anchor(.bottom))
            }
            provisional = true
            return
        }
        positioned = true
        if userScrolled {
            seenSeq = ReadGate.seenLeftInPlace(rows, dividerMark: nil)
            return
        }
        switch ReadGate.threadTarget(rows, focusId: focusReplyId, lastReadSeq: state.lastReadSeq, meId: controller.store.me?.id) {
        case .center(let key):
            seenSeq = ReadGate.seenLeftInPlace(rows, dividerMark: nil)
            center(key, rowId: rows.first { $0.rowKey == key }?.id, proxy)
        case .top(let key):
            // Anchored only once the reply is really on screen: a long thread lands by estimated heights first.
            if let row = rows.first(where: { $0.rowKey == key }) { anchor.land(on: row) }
            seenSeq = dividerMark ?? state.lastReadSeq // 「新着 N 件」 counts the unread replies below the landing
        case .bottom:
            proxy.scrollTo(UpsideDown.newest, anchor: UpsideDown.anchor(.bottom))
            markSeen()
        }
    }

    /// A focus reply in the middle; again while the lazy rows' estimated heights leave it off screen (ChannelView).
    private func center(_ key: String, rowId: String?, _ proxy: ScrollViewProxy) {
        proxy.scrollTo(key, anchor: .center)
        Task {
            for _ in 0..<3 {
                try? await Task.sleep(nanoseconds: 200_000_000)
                guard let rowId, visibleFrames[rowId].map({ $0.maxY > 0 && $0.minY < viewportHeight }) != true else { return }
                proxy.scrollTo(key, anchor: .center)
            }
        }
    }

    /// 「新着 N 件」: replies from others after the newest one seen at the newest edge.
    private var unseenBelow: Int { ReadGate.newBelow(replies, seenSeq: seenSeq, meId: controller.store.me?.id) }

    /// At the newest edge: the newest reply counts as seen, once placed and not landing (ChannelView.markSeen).
    private func markSeen() {
        seenSeq = ReadGate.seenAtBottom(seenSeq, rows: replies, placed: positioned && anchor.landing == nil)
    }

    /// Scrolls the first unread reply (and its divider) to the top, again while LazyVStack's estimates leave it off
    /// screen, then lets the anchor judge from the frames where it ended.
    private func startLanding(_ landing: ReadAnchor.Landing?, _ proxy: ScrollViewProxy) {
        landingTask?.cancel()
        landingTask = nil
        guard let landing else { return }
        landingTask = Task { await land(landing, proxy) }
    }

    private func land(_ landing: ReadAnchor.Landing, _ proxy: ScrollViewProxy) async {
        landingInterrupted = false
        for _ in 0..<3 {
            if landingInterrupted { break } // the reader took the list: it is not pulled from under a finger
            proxy.scrollTo(landing.rowKey, anchor: UpsideDown.anchor(.top))
            try? await Task.sleep(nanoseconds: 200_000_000)
            if Task.isCancelled { return }
            if fullyShown(visibleFrames[landing.rowId]) { break }
        }
        guard anchor.landing == landing else { return }
        anchor.landed()
        if atBottom { markSeen() } // a short unread region lands clamped at the newest edge (ChannelView.land)
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
        takeDividerMark() // before my position moves
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

/// 「スレッド」 over the conversation it is in (「#general」, a DM's names), as the channel's own title and subtitle.
struct ThreadTitle: View {
    let conversation: String

    var body: some View {
        VStack(spacing: 0) {
            Text("スレッド").font(.headline).lineLimit(1)
            if !conversation.isEmpty {
                Text(conversation).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
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

/// M15c / M38: 「#… にも送信」 as Slack has it, a checkbox inside the composer above the input. It was a switch between
/// the replies and the composer, on the composer's top line (testers, 2026-09-30).
/// Only the box and its label take the tap, with a strip under them that takes none: the whole row was the target,
/// right on the input's top edge, and taps meant for the input ticked it (2026-10-06).
private struct AlsoSendRow: View {
    let title: String
    @Binding var isOn: Bool

    var body: some View {
        HStack(spacing: 0) {
            Button { isOn.toggle() } label: {
                HStack(spacing: 8) {
                    Image(systemName: isOn ? "checkmark.square.fill" : "square")
                        .font(.system(size: 18))
                        .foregroundStyle(isOn ? Color.accentColor : Color.secondary)
                    Text(title).font(.footnote).foregroundStyle(.primary).lineLimit(1)
                }
                .padding(.horizontal, 6)
                .frame(minHeight: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(title)
            .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
            Spacer(minLength: 0)
        }
        .padding(.leading, 10)
        .padding(.trailing, 16)
        .padding(.top, 2)
        .padding(.bottom, 6) // with the input row's own top padding: 14 pt between the box and the input that toggle nothing
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

/// THREADS.md: what an open thread does about its root's deletion. Shown live on this screen (its replies loaded with the
/// root there), the deletion closes it, once; opened when the root is deleted already (a stale link, an activity row, a
/// notification), it stays and says the root is gone, rather than closing under the reader at once.
struct ThreadRootWatch: Equatable {
    enum Step: Equatable { case show, deletedState, close }
    private(set) var seenLive = false
    private(set) var closed = false

    /// The replies were fetched: the root was there, unless it is known deleted already.
    mutating func repliesLoaded(rootDeleted: Bool) {
        if !rootDeleted { seenLive = true }
    }

    mutating func next(rootDeleted: Bool) -> Step {
        guard rootDeleted else { return .show }
        guard seenLive, !closed else { return .deletedState }
        closed = true
        return .close
    }
}

struct ThreadTarget: Identifiable, Hashable {
    let id: String
}
