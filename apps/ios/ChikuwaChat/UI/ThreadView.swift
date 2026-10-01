import SwiftUI

/// One thread: the parent, its replies (oldest first) and a composer that posts with parent_id.
/// The toolbar follows / unfollows the thread; replies that were shown advance the thread read position.
struct ThreadView: View {
    @Bindable var controller: AppController
    let channelId: String
    let parentId: String
    @Environment(\.scenePhase) private var scenePhase
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
    @State private var visibleFrames: [String: CGRect] = [:]
    @State private var viewportHeight: CGFloat = 0
    @State private var cover = CoverProbe()
    @State private var landingInterrupted = false
    /// A message's sheet, presented here rather than by its row (MessageSheet).
    @State private var messageSheet: MessageSheet?
    /// The row the list is kept at (ChannelView.keptRowId): a reply arriving below does not move what is on screen.
    @State private var keptRowId: String?
    /// The landing on the first unread reply, in a task of its own (ChannelView.landingTask: a `.task` cancelled by the
    /// navigation's disappear and reappear left the landing unfinished).
    @State private var landingTask: Task<Void, Never>?
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

    var body: some View {
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
                        // The end marker outside the replies' stack, and the channel's 8 pt: under the newest reply the
                        // same gap as under a channel's newest message (2026-10-02: the default padding of 16 and the
                        // stack's 12 between the marker and that reply left 20 pt more).
                        VStack(alignment: .leading, spacing: 0) {
                            EndMarker(viewportHeight: viewport.size.height) { atBottom = $0 }.id(UpsideDown.newest)
                            rowStack()
                        }
                        .padding(.vertical, 8) // the side margin is each row's (margin)
                        // MOBILE_POLISH.md C7: a thread shorter than the screen starts at the top (the parent under the
                        // bar, the replies after it; Slack), not at the bottom under a gap. At least a screen tall, with
                        // the rows at its far end — the screen's top in the flipped list. Layout only: a longer thread
                        // is unchanged, and the newest reply stays at the origin (the keyboard, arrivals).
                        .frame(minHeight: viewport.size.height, alignment: .bottom)
                        .containerRelativeFrame(.horizontal) // never wider than the list (ChannelView)
                        .animation(positioned || provisional ? .easeOut(duration: 0.25) : nil, value: replies.last?.rowKey)
                        .background(StatusBarTapStays())
                    }
                    .scrollPosition(id: $keptRowId, anchor: .top)
                    .upsideDown()
                    .clipped()
                    .dismissesKeyboardOnTap()
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
                // Outside the flip: the replies' frames come out as they are on screen.
                .coordinateSpace(name: "threadViewport")
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: replies.last?.rowKey) { _, _ in
                    // At the newest reply the list shows a new one by itself; my own reply from further up brings it down.
                    let mine = replies.last.map { $0.senderId == controller.store.me?.id && $0.pending } ?? false
                    guard mine, positioned || provisional, controller.messageFocus?.parentId != parentId else { return }
                    if anchor.landing != nil { anchor.landed() } // my post wins; it reads the conversation anyway
                    if !atBottom {
                        withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(UpsideDown.newest, anchor: UpsideDown.anchor(.bottom)) }
                    }
                }
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
                ComposerView(channelId: channelId, parentId: parentId, users: Array(controller.store.users.values), placeholder: "スレッドに返信", controller: controller,
                             accessory: canShare ? AnyView(AlsoSendRow(title: channel.channel.isDm ? "会話にも送信" : "#\(channel.channel.name ?? "") にも送信",
                                                                       isOn: $alsoInChannel)) : nil) { body, attachmentIds, _ in
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
        }
        .task(id: "\(controller.engine?.status.rawValue ?? ""):\(controller.engine?.threadComplete(parentId) ?? false):\(loadAttempt)") {
            guard let engine = controller.engine else { return }
            guard engine.status == .online else { fetchedOnline = false; return }
            if engine.threadComplete(parentId) && fetchedOnline { return }
            fetchedOnline = await engine.loadReplies(channelId, parentId: parentId)
            // A failed fetch (a 5xx, a timeout) left the thread half shown for good, with no word and no read marks
            // (audit 2026-09-29): 「再読み込み」 tries again.
            if !fetchedOnline && engine.status == .online { loadFailed = true }
        }
        // THREADS.md §5: my relation to the thread (follow flag, read position) is fetched once per thread.
        .task(id: "\(parentId):\(controller.engine?.status.rawValue ?? ""):\(loadAttempt)") {
            guard entry == nil, let parent, let out = MessageOut(parent), let engine = controller.engine else { return }
            if !(await engine.loadThreadState(parentId, parent: out)) && engine.status == .online { loadFailed = true }
        }
        .messageSheets(controller, sheet: $messageSheet)
        .keepsKeyboardRoomWhileSwipingBack()
        // §7.7: the channel's rows (these replies among them) are not trimmed while the thread is open, also when the
        // channel is not the open conversation (a thread opened from 「スレッド」).
        .keepsChannelRows(controller.engine, channelId)
    }

    /// The thread's rows, laid out all at once up to `lazyFrom` replies. A LazyVStack went into an endless layout pass
    /// after landing on the first unread reply (a row at the edge of its range kept entering and leaving it as its estimated
    /// and measured heights differed): the main thread spun and the sheet stayed blank until a touch moved the list
    /// (testers, 2026-09-29; reproduced on iOS 26.2 with 60 replies of mixed heights over a slow network). A thread's rows
    /// are few, and with every height known the landing and the bottom are exact too. A very long thread stays lazy.
    private static let lazyFrom = 200
    /// The list's side margin, inside each row: a message's highlight reaches the sheet's edges (ChannelView).
    private static let margin: CGFloat = 16

    @ViewBuilder
    private func rowStack() -> some View {
        if replies.count > Self.lazyFrom {
            LazyVStack(alignment: .leading, spacing: 12) { rows() }.scrollTargetLayout()
        } else {
            VStack(alignment: .leading, spacing: 12) { rows() }.scrollTargetLayout()
        }
    }

    /// Upside down (the list is flipped): the replies newest first (the end marker is before them, in body), then the
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
                // A grouped reply sits right under the one before it, as a channel's rows do (they have no spacing).
                .padding(.top, compact ? -12 : 0)
                .upsideDown()
                .transition(.asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .opacity))
                .id(reply.rowKey)
            }
            Group {
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
                Divider().padding(.horizontal, Self.margin)
                Text(replies.isEmpty ? "返信はまだありません" : "\(replies.count) 件の返信")
                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, Self.margin)
                MessageRow(message: parent, controller: controller, margin: Self.margin, highlighted: highlighted(parent),
                           present: { messageSheet = $0 })
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
        if userScrolled { return }
        switch ReadGate.threadTarget(rows, focusId: focusReplyId, lastReadSeq: state.lastReadSeq, meId: controller.store.me?.id) {
        case .center(let key): proxy.scrollTo(key, anchor: .center)
        case .top(let key):
            // Anchored only once the reply is really on screen: a long thread lands by estimated heights first.
            if let row = rows.first(where: { $0.rowKey == key }) { anchor.land(on: row) }
        case .bottom: proxy.scrollTo(UpsideDown.newest, anchor: UpsideDown.anchor(.bottom))
        }
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

/// The end of the thread's list, and whether it is on screen: from where it is, since a plain VStack (before the rows,
/// in body) makes it once, on screen or not, and its onAppear said nothing.
private struct EndMarker: View {
    let viewportHeight: CGFloat
    let onScreen: (Bool) -> Void

    var body: some View {
        Color.clear.frame(height: 1)
            .onGeometryChange(for: Bool.self) { $0.frame(in: .named("threadViewport")).minY <= viewportHeight + 1 } action: { onScreen($0) }
            .onDisappear { onScreen(false) } // the thread closed
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
private struct AlsoSendRow: View {
    let title: String
    @Binding var isOn: Bool

    var body: some View {
        Button { isOn.toggle() } label: {
            HStack(spacing: 8) {
                Image(systemName: isOn ? "checkmark.square.fill" : "square")
                    .font(.system(size: 18))
                    .foregroundStyle(isOn ? Color.accentColor : Color.secondary)
                Text(title).font(.footnote).foregroundStyle(.primary).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 2)
            .frame(minHeight: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityAddTraits(isOn ? [.isButton, .isSelected] : .isButton)
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
