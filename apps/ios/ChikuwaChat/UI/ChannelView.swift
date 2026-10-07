import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ChannelView: View {
    @Bindable var controller: AppController
    let channelId: String
    @Binding var pendingThreadId: String?
    /// The thread opened or closed here: MainView carries it across a change of layout, and in the split shows it in its
    /// pane (MOBILE_UI.md §13).
    var onThreadChange: ((String?) -> Void)? = nil
    @State private var sheet: ChannelSheet?
    /// M29: the thread and the channel's details are pages pushed over the conversation (Slack), not sheets. On an
    /// iPad's split (MOBILE_UI.md §13) the thread is MainView's pane beside the conversation instead (`onThreadChange`).
    @State private var thread: ThreadTarget?
    @Environment(\.threadInPane) private var threadInPane
    @State private var showInfo = false
    /// M66: the summary sheet's request (the ⋯ 「要約」).
    @State private var aiSummary: AiSummaryRequest?
    /// M86: the deadline the header's chip opened.
    @State private var deadlineForm: TaskFormTarget?
    /// M29: 「メッセージ」, or the pins or files covering the conversation (which stays as it was underneath).
    @State private var tab: ChannelTab = .messages
    @Environment(\.scenePhase) private var scenePhase
    /// M47: read here, so switching it in 自分 → 表示 redraws an open conversation.
    @AppStorage(Timeline.groupingKey) private var grouping = false
    @State private var atBottom = false
    @State private var positioned = false
    /// Where the rows are on screen, for the read rules and the keyboard (not view state: written on every scroll frame,
    /// it redrew the whole conversation each time, M20).
    @State private var frames = RowFrames()
    private var visibleFrames: [String: CGRect] { frames.byId }
    private var viewportHeight: CGFloat { frames.viewportHeight }
    @State private var loadingOlder = false
    /// M25: the last load of older rows brought nothing (it failed, or could not start): no automatic one again until
    /// the reader scrolls, the connection changes or the button that then replaces the progress row is pressed, so a
    /// failing request is not repeated in a loop.
    @State private var olderStalled = false
    /// Read position when the channel was opened; the 「新着メッセージ」 divider stays there.
    @State private var unreadMark: Int?
    /// Newest seq the reader has had on screen at the bottom; later messages from others are "new".
    @State private var seenSeq: Int?
    /// §10.1: the first unread row has been on screen with every unread row held; only then do visible rows mark read.
    @State private var anchor = ReadAnchor()
    /// 「最初の未読へ」 is loading the rows above the window.
    @State private var jumping = false
    /// The reader dragged the list before it was placed: it is left where it is.
    @State private var userScrolled = false
    /// The catch-up the placement waits for did not come (a failed request while online): place with the rows held.
    @State private var syncWaitOver = false
    /// The reader touched the list while it was landing on the first unread row: the landing stops scrolling.
    @State private var landingInterrupted = false
    @State private var cover = CoverProbe()
    /// A message's sheet, presented here rather than by its row (MessageSheet).
    @State private var messageSheet: MessageSheet?
    @State private var syncWait: Task<Void, Never>?
    /// The landing on the first unread row (land). Not a `.task` either: opened from a notification, the navigation let
    /// the view go and come back as it opened, the task stayed cancelled, and the landing never ended — no keyboard
    /// follow and no read marks until the conversation was opened again (testers, 2026-09-29).
    @State private var landingTask: Task<Void, Never>?
    /// The row the list is kept at (SwiftUI's scroll position): up in the conversation, a row arriving below does not move
    /// what is on screen; at the newest edge it is the edge's marker, so arrivals show (UpsideDownList.swift).
    @State private var keptRowId: String?
    /// The list's side margin, inside each row: a message's highlight reaches the screen's edges.
    private static let margin: CGFloat = 12

    enum ChannelSheet: Identifiable {
        case addMember
        case link(ChannelLinkOut?)  // M15f: add (nil) or edit
        var id: Int { switch self { case .addMember: 1; case .link: 3 } }
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
    /// The 「新着メッセージ」 divider's position, when every row after it is held (§10.1 3.); none in the search context.
    private var dividerMark: Int? {
        guard focus == nil else { return nil }
        return ReadGate.dividerMark(held: controller.engine?.unreadHold[channelId], captured: unreadMark, oldestLoadedSeq: channel?.oldestLoadedSeq)
    }
    private var items: [TimelineItem] {
        Timeline.build(messages, firstUnreadAfterSeq: dividerMark, meId: controller.store.me?.id, grouping: grouping)
    }
    private var unreadBanner: ReadGate.Banner? {
        guard let channel else { return nil }
        let status = controller.engine?.status
        // Rows are looked at only while a catch-up is on its way (the only case the banner needs them for).
        let firstUnreadHeld = !ReadGate.catchingUp(channel, status: status)
            || ReadGate.firstUnreadRow(messages, afterSeq: channel.lastReadSeq, meId: controller.store.me?.id) != nil
        return ReadGate.banner(channel, focused: focus != nil, positioned: positioned, anchored: anchor.hidesBanner,
                               held: controller.engine?.unreadHold[channelId] != nil, jumping: jumping, status: status, firstUnreadHeld: firstUnreadHeld)
    }
    /// What re-evaluates the anchor: another device's read, a mark-as-unread and its hold, the window's reach (§10.1 2.).
    private struct ReadWatch: Equatable {
        var lastRead = 0, unread = 0, oldest: Int?, synced: Int?, last = 0
        var held: Int?
    }
    private var readWatch: ReadWatch {
        ReadWatch(lastRead: channel?.lastReadSeq ?? 0, unread: channel?.unreadCount ?? 0, oldest: channel?.oldestLoadedSeq, synced: channel?.syncedSeq,
                  last: channel?.lastSeq ?? 0, held: controller.engine?.unreadHold[channelId])
    }
    private var unseenBelow: Int {
        guard focus == nil else { return 0 }
        return ReadGate.newBelow(messages, seenSeq: seenSeq, meId: controller.store.me?.id)
    }
    /// At the bottom: the newest row counts as seen, once the view is placed and not landing (§10.1 7.).
    private func markSeen() {
        seenSeq = ReadGate.seenAtBottom(seenSeq, rows: messages, placed: positioned && anchor.landing == nil)
    }

    /// Visible rows mark the channel read once anchored (§10.1 2.); the anchor itself is re-evaluated on every call,
    /// even while a sheet covers the timeline (nothing on screen then), so it drops as soon as the range stops being
    /// held. `send` is false right after the position went down: a mark-as-unread must not be undone by rows that were
    /// already on screen before it.
    private func markRead(send: Bool = true) {
        guard positioned, focus == nil, let channel else { return }
        let rows = messages
        // Under any page or sheet (the thread, channel info, a message's menu sheets, MainView's search or settings) or
        // the pins / files tab (M29) the list still follows the bottom; rows arriving there are not seen.
        let looking = (thread == nil || threadInPane) && !showInfo && tab == .messages && sheet == nil && scenePhase == .active && !cover.covered && !veiled
        let visible = looking ? rows.filter { fullyShown(visibleFrames[$0.id]) } : []
        let onScreen = looking ? Set(visibleFrames.compactMap { partlyShown($0.value) ? $0.key : nil }) : []
        var next = anchor
        let seq = next.observe(unreadCount: channel.unreadCount, ready: ReadGate.readRangeReady(channel),
                               firstUnread: ReadGate.firstUnreadRow(rows, afterSeq: channel.lastReadSeq, meId: controller.store.me?.id),
                               visible: visible, onScreenIds: onScreen)
        if next != anchor { anchor = next }
        if send, let seq { controller.engine?.markRead(channelId, seq: seq) }
    }

    /// Back from one of this view's sheets or pages, or to the 「メッセージ」 tab: the rows that arrived under it are judged from the screen once UIKit has
    /// finished taking the sheet away (onDismiss comes while it still counts as covering the list, §10.1 2.-4).
    private func sheetClosed() {
        Task {
            for _ in 0..<20 where cover.covered { try? await Task.sleep(nanoseconds: 100_000_000) }
            markRead()
        }
    }

    /// M29: a pin or file was revealed (the list now shows its message): back to 「メッセージ」, into its thread if a reply.
    private func showMessage(parentId: String?) {
        tab = .messages
        pendingThreadId = parentId
    }

    /// Shown in full, or taller than the viewport and filling it.
    private func fullyShown(_ frame: CGRect?) -> Bool {
        guard let frame, partlyShown(frame) else { return false }
        return frame.minY >= 0 && frame.maxY <= viewportHeight || frame.height > viewportHeight
    }

    private func partlyShown(_ frame: CGRect) -> Bool { frame.maxY > 0 && frame.minY < viewportHeight }

    /// §10.1 4.: a search / permalink hit in the middle, the divider's row at the top, or the bottom. A channel whose
    /// window has not caught up to last_seq waits for its catch-up (the divider's row may be in it), unless none can
    /// come or the reader has already scrolled.
    private func position(_ proxy: ScrollViewProxy) {
        guard !positioned, !messages.isEmpty else { return }
        if focus == nil, let channel,
           ReadGate.placementWaits(channel, status: controller.engine?.status, userScrolled: userScrolled, waitOver: syncWaitOver) { return }
        positioned = true
        if focus == nil && userScrolled {
            seenSeq = ReadGate.seenLeftInPlace(messages, dividerMark: dividerMark)
            return
        }
        let mark = dividerMark
        switch ReadGate.openTarget(messages, focusId: focus.map { $0.parentId ?? $0.messageId }, mark: mark, meId: controller.store.me?.id) {
        case .center(let key):
            proxy.scrollTo(key, anchor: .center)
            // LazyVStack places by estimated heights, so one scroll can stop short of a row far up (a pin or search
            // result revealed in a long context): again while it is not on screen, as the landing does.
            let id = messages.first { $0.rowKey == key }?.id
            Task {
                for _ in 0..<3 {
                    try? await Task.sleep(nanoseconds: 200_000_000)
                    guard focus != nil, let id, visibleFrames[id].map(partlyShown) != true else { return }
                    proxy.scrollTo(key, anchor: .center)
                }
            }
        case .top(let key):
            // Placed by the landing task; the banner stays hidden meanwhile, so it does not flash.
            if let row = messages.first(where: { $0.rowKey == key }) { anchor.land(on: row) }
            seenSeq = mark // §10.1 7.: 「新着 N 件」 counts every unread row below the divider
        case .bottom:
            proxy.scrollTo(UpsideDown.newest, anchor: UpsideDown.anchor(.bottom))
            markSeen() // §10.1 7.: the rows on screen now are not 「新着」
        }
    }

    /// Scrolls the landing row to the top (with the divider above it when it has one), again while LazyVStack's
    /// estimated heights leave it off screen, then lets the anchor judge from the frames where it ended (§10.1 4./6.).
    private func land(_ landing: ReadAnchor.Landing, _ proxy: ScrollViewProxy) async {
        let items = items
        let index = items.firstIndex { if case .message(let message, _) = $0 { message.id == landing.rowId } else { false } }
        let dividerAbove = index.map { $0 > 0 && items[$0 - 1].id == TimelineItem.unread.id } ?? false
        landingInterrupted = false
        for _ in 0..<3 {
            if landingInterrupted { break }
            proxy.scrollTo(dividerAbove ? TimelineItem.unread.id : landing.rowKey, anchor: UpsideDown.anchor(.top))
            try? await Task.sleep(nanoseconds: 200_000_000)
            if Task.isCancelled { return }
            if fullyShown(visibleFrames[landing.rowId]) { break }
        }
        guard anchor.landing == landing else { return }
        anchor.landed()
        // A short unread region lands clamped at the bottom, where atBottom never changes: its rows are seen (§10.1 7.).
        if atBottom { markSeen() }
        markRead()
    }

    /// 「新着 N 件」 / ↓ at the bottom right while the list is not at the end.
    @ViewBuilder
    private func jumpButton(_ proxy: ScrollViewProxy) -> some View {
        if !atBottom && focus == nil && !veiled {
            JumpToNewestButton(unseen: unseenBelow, latestLabel: "最新のメッセージへ") { UpsideDown.jumpToNewest($keptRowId, proxy) }
        }
    }

    /// The rows have been shown since this view opened: they are not hidden again (a later landing, a reconnect).
    @State private var revealed = false
    /// The rows are hidden while the conversation opens (ReadGate.hidesOpeningRows): they come into view once, final.
    private var veiled: Bool {
        guard !revealed, let channel else { return false }
        let status = controller.engine?.status
        let landsOnOpen: Bool = {
            guard !positioned else { return false }
            if case .top = ReadGate.openTarget(messages, focusId: nil, mark: dividerMark, meId: controller.store.me?.id) { return true }
            return false
        }()
        return ReadGate.hidesOpeningRows(hasRows: !messages.isEmpty, focused: focus != nil, placed: positioned, connecting: status == .connecting,
                                         waits: ReadGate.placementWaits(channel, status: status, userScrolled: userScrolled, waitOver: syncWaitOver),
                                         landsOnOpen: landsOnOpen, landing: anchor.landing != nil)
    }

    /// What makes the placement look again: rows coming in, the window reaching the newest row.
    private var placementKey: String { "\(messages.count):\(channel.map(ReadGate.reachesNewest) ?? false)" }

    /// A new newest row (mine sent from here, or anyone's arriving). At the newest row the list shows it, the rows moving
    /// up for it animated (UpsideDownList.swift); my own post from further up jumps to it; someone else's leaves the reader
    /// where they are (UpsideDown.arrival).
    private func newestRowChanged(_ proxy: ScrollViewProxy) {
        guard positioned, focus == nil else { return }
        let mine = ReadGate.ownPendingPost(messages.last, meId: controller.store.me?.id)
        if mine && anchor.landing != nil { anchor.landed() } // my post wins; it reads the conversation anyway
        showNewest(UpsideDown.arrival(atNewest: atBottom, mine: mine), proxy)
        if atBottom || mine { markSeen() }
    }

    private func showNewest(_ arrival: UpsideDown.Arrival, _ proxy: ScrollViewProxy) {
        switch arrival {
        case .follow: keptRowId = UpsideDown.newest
        case .jump: UpsideDown.jumpToNewest($keptRowId, proxy)
        case .stay: break
        }
    }

    /// Lands on `landing` in a task of its own, replacing the one under way (a new landing, or the same one again after the
    /// view came back).
    private func startLanding(_ landing: ReadAnchor.Landing?, _ proxy: ScrollViewProxy) {
        landingTask?.cancel()
        landingTask = nil
        guard let landing else { return }
        landingTask = Task { await land(landing, proxy) }
    }

    /// The placement's wait for a catch-up (§10.1 4.), at most 3 s, then placed with what is there.
    private func startSyncWait(_ proxy: ScrollViewProxy) {
        syncWait?.cancel()
        syncWait = Task {
            guard (try? await Task.sleep(nanoseconds: 3_000_000_000)) != nil else { return }
            syncWaitOver = true
            position(proxy)
            revealed = true // the rows are not kept from the reader any longer (a connection that does not come)
        }
    }

    /// 「最初の未読へ」 (§10.1 6.): load back to the read position, then show its first unread row at the top like an open.
    private func jumpToFirstUnread() {
        guard !jumping, let engine = controller.engine else { return }
        jumping = true
        Task {
            do {
                let covered = try await engine.loadFirstUnread(channelId)
                jumping = false
                guard covered, focus == nil, engine.currentChannelId == channelId, let channel else { return } // not yet: the banner stays
                unreadMark = channel.lastReadSeq
                seenSeq = channel.lastReadSeq // 「新着 N 件」 counts every unread row below again: they are all held now
                if let row = ReadGate.firstUnreadRow(messages, afterSeq: channel.lastReadSeq, meId: controller.store.me?.id) {
                    anchor.land(on: row) // anchored only once the row is really on screen
                } else {
                    markRead()
                }
            } catch {
                jumping = false
                controller.error = controller.describe(error)
            }
        }
    }

    /// 「ここから未読にする」 for a row, when it is offered (§10.1 10.).
    private func markUnreadAction(_ message: MessageState) -> (() -> Void)? {
        guard let seq = message.seq, let channel, ReadGate.markUnreadOffered(channel, seq: seq) else { return nil }
        return {
            if let held = controller.engine?.markUnread(channelId, seq: seq) { unreadMark = held }
        }
    }

    /// M25: the progress row at the top of the loaded range is on screen with the list at rest: the page before it
    /// loads by itself (the rules are OlderPaging.shouldLoad). Called whenever one of them may have changed.
    private func loadOlderIfShown() {
        guard OlderPaging.shouldLoad(channel, topRow: frames.topRow, viewportHeight: viewportHeight, status: controller.engine?.status,
                                     focused: focus != nil, placed: positioned, landing: anchor.landing != nil,
                                     busy: loadingOlder || jumping || olderStalled, moving: frames.moving) else { return }
        loadOlder()
    }

    /// The rows go in at the far end of the flipped list: what is on screen stays where it is.
    private func loadOlder() {
        guard !loadingOlder, let engine = controller.engine else { return }
        let window = { (channel?.oldestLoadedSeq, channel?.hasOlder) }
        let before = window()
        loadingOlder = true
        olderStalled = false
        Task {
            await engine.loadOlder(channelId)
            // The next look at the top row waits for the frames of the layout with the page in: the ones from before
            // would still show it on screen and load a page nobody scrolled to.
            try? await Task.sleep(nanoseconds: 300_000_000)
            loadingOlder = false
            if window() == before { olderStalled = true } else { loadOlderIfShown() }
        }
    }

    /// The top of the conversation: the page before the loaded ones (M25), or what the conversation is.
    @ViewBuilder
    private func conversationTop(_ channel: ChannelState) -> some View {
        if focus == nil, channel.hasOlder, channel.syncedSeq != nil {
            // M25: on screen, it loads the page before (loadOlderIfShown). The button stays for when that cannot happen by
            // itself: offline, or after a load that brought nothing.
            Group {
                if loadingOlder || controller.engine?.status == .online && !olderStalled {
                    ProgressView().controlSize(.small).accessibilityLabel("以前のメッセージを読み込み中")
                } else {
                    Button("以前のメッセージを読み込む", action: loadOlder)
                }
            }
            .frame(maxWidth: .infinity)
            .font(.footnote)
            .padding(.vertical, 8)
            .background(GeometryReader { geometry in
                Color.clear.preference(key: OlderRowFrame.self, value: geometry.frame(in: .named("conversation")))
            })
            .onDisappear { frames.topRow = nil } // LazyVStack let go of it: off screen
        } else if messages.isEmpty, channel.channel.isDm, DMList.isNotesToSelf(channel, meId: controller.store.me?.id) {
            // My DM with myself: what it is for (Slack, Mattermost), under my name.
            ContentUnavailableView(channelTitle(channel, store: controller.store), systemImage: "note.text",
                                   description: Text(DMList.notesIntro))
                .padding(.top, 40)
        } else if messages.isEmpty {
            ContentUnavailableView("まだメッセージはありません", systemImage: "bubble.left",
                                   description: Text("最初のメッセージを送ってみましょう。"))
                .padding(.top, 40)
        } else if focus == nil {
            ChannelIntroView(controller: controller, channel: channel).padding(.horizontal, Self.margin)
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if let channel {
                if channel.isMember {
                    if TaskRules.hasBoard(channel) {
                        // M86 (DEADLINES.md §8 2.): the next deadline, a row of its own (the navigation bar stays as it was).
                        DeadlineChipRow(controller: controller, channel: channel) { deadlineForm = .task($0) }
                    }
                    // M29: the tabs, then the links (the link bar of M15f moved into this row).
                    ChannelTabsRow(controller: controller, channel: channel, tab: $tab,
                                   upcoming: controller.calendarHub?.upcomingOf(channel.id)?.count ?? 0,
                                   onAddLink: { sheet = .link(nil) }, onEditLink: { sheet = .link($0) })
                } else {
                    ChannelLinksRow(controller: controller, channel: channel, onAdd: { sheet = .link(nil) }, onEdit: { sheet = .link($0) })  // M15f
                }
            }
            VStack(spacing: 0) {
                if focus != nil {
                    HStack {
                        Text("検索位置の前後の会話").font(.caption)
                        Spacer()
                        Button("最新の会話へ") { controller.messageFocus = nil }
                    }.padding(10)
                }
                if let banner = unreadBanner, let channel {
                    HStack(spacing: 12) {
                        Text(banner.text).font(.caption).lineLimit(2)
                        Spacer(minLength: 0)
                        if banner.loading {
                            Text("読み込み中…").font(.footnote).foregroundStyle(.secondary)
                        } else {
                            if banner.jump { Button("最初の未読へ", action: jumpToFirstUnread).fixedSize() }
                            Button("既読にする") { controller.engine?.markRead(channelId, seq: channel.lastSeq, force: true) }.fixedSize()
                        }
                    }
                    .font(.footnote.weight(.semibold))
                    .disabled(!banner.enabled)
                    .padding(10)
                }
                // Never under the navigation bar (ThreadView): a preview's links row can be empty.
                Color.clear.frame(height: 1)
                ScrollViewReader { proxy in
                    GeometryReader { viewport in
                        ScrollView {
                            // Upside down (UpsideDownList.swift): the newest edge first, then the rows newest first, then
                            // what is at the top of the conversation; each flipped back the right way up.
                            LazyVStack(alignment: .leading, spacing: 0) {
                                NewestEdgeMarker { atBottom = $0 }
                                ForEach(Timeline.rows(items).reversed()) { row in
                                    // A day's separator is part of the row under it: they come and move together.
                                    VStack(alignment: .leading, spacing: 0) {
                                        if let day = row.day { DaySeparator(label: day).padding(.horizontal, Self.margin) }
                                        switch row.item {
                                        case .date: EmptyView() // drawn over the row after it (Timeline.rows)
                                        case .unread:
                                            UnreadSeparator().padding(.horizontal, Self.margin)
                                        case .message(let message, let compact):
                                            MessageRow(message: message, controller: controller, compact: compact, margin: Self.margin,
                                                       highlighted: messageSheet?.kind == .actions && messageSheet?.message.id == message.id,
                                                       onOpenThread: { thread = ThreadTarget(id: message.parentId ?? message.id) },
                                                       present: { messageSheet = $0 })
                                                .equatable() // unchanged messages skip their body (M20)
                                                .background(GeometryReader { geometry in
                                                    Color.clear.preference(key: VisibleMessageFrames.self,
                                                        value: [message.id: geometry.frame(in: .named("conversation"))])
                                                })
                                        }
                                    }
                                    .upsideDown()
                                    // A new newest row comes up from under the input with the others (in the flipped list the
                                    // top edge is the screen's bottom); faded in in place, it overlapped the row above.
                                    .transition(.asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .opacity))
                                    .id(row.id) // the row key (scrollTo), "unread" for the divider
                                }
                                if let channel {
                                    conversationTop(channel).upsideDown()
                                }
                            }
                            .scrollTargetLayout()
                            .padding(.vertical, 8) // the side margin is each row's (margin)
                            // Exactly as wide as the list: a row wider than the screen made the whole stack wider, and the
                            // scroll view showed it centred, the messages shifted to the left (testers, 2026-09-29).
                            // The viewport's width, not `containerRelativeFrame`: in an iPad's split detail column that
                            // laid the conversation out again and again without end (a frozen app, MOBILE_UI.md §13).
                            .frame(width: viewport.size.width)
                            // A new newest row: the others move up for it, animated (the list keeps its origin by itself).
                            .animation(positioned ? .easeOut(duration: 0.25) : nil, value: items.last?.id)
                            .background(StatusBarTapStays())
                        }
                        .scrollPosition(id: $keptRowId, anchor: .top)
                        .upsideDown()
                        .clipped()
                        // Laid out but not shown while the conversation opens (`veiled`): the catch-up, the placement and
                        // the landing happen out of sight, and the rows come into view once, as they stay.
                        .animation(.easeOut(duration: 0.15)) { $0.opacity(veiled ? 0 : 1) }
                        .overlay { if veiled { OpeningProgress() } }
                        .onChange(of: veiled, initial: true) { _, hidden in
                            guard !hidden, !messages.isEmpty else { return }
                            revealed = true
                            markRead() // the rows on screen were not looked at while hidden
                        }
                        .onNewestEdge { atBottom = $0 }
                        .onUserScroll {
                            if !positioned && !messages.isEmpty { userScrolled = true }
                            if anchor.landing != nil { landingInterrupted = true } // never pull the list from under a finger
                            olderStalled = false // M25: the reader scrolled: the top row may try again
                        }
                        .onScrollMotion { moving in
                            frames.moving = moving
                            if !moving { loadOlderIfShown() } // M25: came to rest, perhaps at the top
                        }
                        .background(CoverProbe.Marker(probe: cover))
                        .scrollDismissesKeyboard(.interactively)
                        .dismissesKeyboardOnTap()
                        .onPreferenceChange(VisibleMessageFrames.self) { frames in
                            self.frames.byId = frames
                            self.frames.viewportHeight = viewport.size.height
                            markRead()
                        }
                        .onPreferenceChange(OlderRowFrame.self) { frame in
                            frames.topRow = frame
                            loadOlderIfShown()
                        }
                        .onChange(of: positioned && anchor.landing == nil && !jumping) { _, ready in
                            if ready { loadOlderIfShown() } // M25: placed, or a landing over, with the top row already on screen
                        }
                        .overlay(alignment: .bottomTrailing) { jumpButton(proxy) }
                        .onChange(of: atBottom) { _, bottom in if bottom { markSeen() } }
                        .onChange(of: controller.engine?.postedHere) { _, id in
                            // A post of mine made through its own endpoint (a poll): shown like one from the outbox, whichever
                            // came first, its response or its event (§10.1 11.).
                            guard let id, positioned, focus == nil, messages.contains(where: { $0.id == id }) else { return }
                            if anchor.landing != nil { anchor.landed() }
                            showNewest(UpsideDown.arrival(atNewest: atBottom, mine: true), proxy)
                            markSeen()
                        }
                        .onChange(of: messages.last?.rowKey) { _, _ in newestRowChanged(proxy) }
                        .task(id: placementKey) { await Task.yield(); position(proxy) }
                        // Opened, or back from the search context: the placement waits for a catch-up at most this long.
                        // Not a `.task`: the navigation lets the view go and come back once as it opens, which cancelled
                        // the task for good, and a channel whose catch-up failed stayed unplaced (no banner, no reads).
                        .onAppear { startSyncWait(proxy) }
                        .onChange(of: focus == nil) { _, _ in startSyncWait(proxy) }
                        .onChange(of: anchor.landing, initial: true) { _, landing in startLanding(landing, proxy) }
                        .onAppear { if anchor.landing != nil { startLanding(anchor.landing, proxy) } } // back after a disappear
                        .onChange(of: focus?.messageId) { _, id in
                            if id == nil, let channel {
                                // Back from the search context: like a fresh open, from the read position as it is now (§10.1 4.).
                                unreadMark = ReadGate.openMark(channel)
                                seenSeq = channel.lastReadSeq
                                syncWaitOver = false
                            }
                            positioned = false
                            userScrolled = false
                            anchor.reset()
                            position(proxy)
                        }
                        .onChange(of: readWatch) { old, new in
                            // Lower than before (a mark-as-unread here or elsewhere), or a hold gone without a read: the new
                            // first unread row has to be seen first, and rows already on screen do not undo it.
                            let lowered = new.lastRead < old.lastRead || old.held != nil && new.held == nil
                            if lowered { anchor.positionLowered() }
                            markRead(send: !lowered)
                        }
                        .onChange(of: controller.engine?.status) { _, _ in
                            position(proxy) // offline now: nothing more to wait for (ReadGate.placementWaits)
                            markRead()
                            olderStalled = false // M25: back online (or a new connection): the top row may try again
                            loadOlderIfShown()
                        }
                        .onChange(of: scenePhase) { _, _ in markRead() }
                        .onAppear {
                            if unreadMark == nil, let channel { unreadMark = ReadGate.openMark(channel) }
                            if seenSeq == nil { seenSeq = channel?.lastReadSeq ?? 0 }
                        }
                    }
                    // Outside the flip: the rows' frames come out as they are on screen (0 at the list's top).
                    .coordinateSpace(name: "conversation")
                }
                if let channel {
                    if !channel.isMember && PreviewJoin.canJoin(channel.channel) {
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
                    } else if !channel.canPostTopLevel(isAdmin: controller.store.me?.role == "admin") {
                        Label("このチャンネルに投稿できるのはオーナーと管理者だけです。スレッドでは返信できます。", systemImage: "megaphone")
                            .font(.footnote).foregroundStyle(.secondary).padding()
                    } else {
                        TypingLine(controller: controller, channelId: channelId)
                        ComposerView(channelId: channelId, users: Array(controller.store.users.values), placeholder: tr("\(channelTitle(channel, store: controller.store)) へのメッセージ"), controller: controller) { body, attachmentIds, options in
                            Task { await controller.engine?.send(channelId, body: body, attachmentIds: attachmentIds, options: options) }
                        }
                        // Under the pins / files (M29): SwiftUI's text field stays an accessibility element through a
                        // hidden container, so it is disabled there as well.
                        .accessibilityHidden(tab != .messages)
                        .disabled(tab != .messages)
                    }
                }
            }
            .accessibilityHidden(tab != .messages)
            .overlay {
                // M29: 「ピン留め」「ファイル」 cover the conversation and its input; the list stays as it was underneath
                // (its place, the read anchor, the draft), not seen while covered (§10.1 2.).
                if tab != .messages {
                    Group {
                        if tab == .canvas, let channel {
                            CanvasPane(controller: controller, channel: channel) { thread = ThreadTarget(id: $0) }  // M45; M58 コメント
                        } else if tab == .events, let channel {
                            ChannelEventsPane(controller: controller, channel: channel)  // M52
                        } else if tab == .tasks, let channel {
                            ChannelTasksPane(controller: controller, channel: channel)  // M56
                        } else if tab == .pins {
                            PinsView(controller: controller, channelId: channelId) { message in
                                Task { if await controller.revealMessage(message) { showMessage(parentId: message.parentId) } }
                            }
                        } else {
                            FilesView(controller: controller, channelId: channelId, onOpen: { messageId, channelId, parentId in
                                Task {
                                    if await controller.revealMessage(id: messageId, channelId: channelId, parentId: parentId) {
                                        showMessage(parentId: parentId)
                                    }
                                }
                            }, embedded: true)
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(.systemBackground))
                }
            }
        }
        .keepsKeyboardRoomWhileSwipingBack()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                if let channel {
                    Button { showInfo = true } label: {
                        VStack(spacing: 0) {
                            HStack(spacing: 4) {
                                if isMuted(channel) { Image(systemName: "bell.slash").font(.caption).foregroundStyle(.secondary) }
                                Text(channelTitle(channel, store: controller.store)).font(.headline).lineLimit(1)
                            }
                            if let subtitle = headerSubtitle(channel) {
                                // The other person's status emoji may be a custom one: its image, not its `:name:`.
                                StatusGlyph.text(subtitle, controller: controller, height: 14).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("チャンネル情報")
                }
            }
            // M117 (docs/CALLS.md §7): 📞 where I may start a call here.
            if let channel, CallRules.canStart(channel, settings: controller.store.workspaceSettings, isAdmin: controller.store.me?.role == "admin",
                                               meId: controller.store.me?.id) {
                ToolbarItem(placement: .topBarTrailing) { CallButton(controller: controller, channelId: channelId) }
            }
            // One ⋯ for the rest (testers, 2026-09-28): four buttons left the channel's name almost no room.
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if let channel, channel.isMember {
                        let starred = controller.store.isFavorite(channelId)
                        Button(starred ? "お気に入りから外す" : "お気に入りに追加", systemImage: starred ? "star.fill" : "star") {
                            Task { await controller.toggleFavorite(channelId) }
                        }
                        NotificationMenu(controller: controller, channel: channel)
                        DmCloseButton(controller: controller, channel: channel)  // M141
                    }
                    if controller.canSummarize(channelId) {  // M66
                        AiSummaryMenu(channelId: channelId, target: controller.aiHub?.target(channelId)) { request in aiSummary = request; controller.summarize(request) }
                    }
                    Button("チャンネル情報", systemImage: "info.circle") { showInfo = true }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("チャンネルのメニュー")
            }
        }
        .sheet(item: $sheet, onDismiss: sheetClosed) { which in
            switch which {
            case .addMember: AddMemberView(controller: controller, channelId: channelId)
            case .link(let link): ChannelLinkEditor(controller: controller, channelId: channelId, link: link)
            }
        }
        .fullScreenCover(item: $deadlineForm, onDismiss: sheetClosed) { target in
            TaskForm(controller: controller, hub: controller.taskHub, target: target)
        }
        .aiSummarySheet(controller, request: $aiSummary)
        .loadsSummaryTarget(controller, channelId: channelId)
        .navigationDestination(item: Binding(get: { threadInPane ? nil : thread }, set: { thread = $0 })) { target in
            ThreadView(controller: controller, channelId: channelId, parentId: target.id)
        }
        .onChange(of: thread?.id) { _, id in
            // The split (MOBILE_UI.md §13): MainView shows the thread in its pane beside the detail column (an inspector
            // here, inside the conversation, laid it out without end); nothing is pushed or kept here.
            if threadInPane {
                guard let id else { return }
                onThreadChange?(id)
                thread = nil
            } else {
                onThreadChange?(id)
            }
        }
        .navigationDestination(isPresented: $showInfo) { ChannelInfoView(controller: controller, channelId: channelId) }
        .onChange(of: (thread == nil || threadInPane) && !showInfo) { _, back in if back { sheetClosed() } }
        .onChange(of: tab) { _, tab in
            if tab == .messages { sheetClosed() } else { KeyboardBehavior.dismiss() } // the input is under the pins / files
        }
        .messageSheets(controller, sheet: $messageSheet, openThread: { thread = ThreadTarget(id: $0.parentId ?? $0.id) },
                       markUnread: markUnreadAction, onClosed: sheetClosed)
        .onChange(of: controller.calendarOpen, initial: true) { _, open in
            // M52: a notification of this channel's event: its 「予定」 tab, which shows the event.
            if let open, open.channelId == channelId, channel.map(AppController.hasCalendar) == true { tab = .events }
        }
        .onChange(of: controller.taskOpen, initial: true) { _, open in
            // M56: a task's notification, or 「自分の担当」's channel name: its 「タスク」 tab (which shows the task).
            guard let open, open.channelId == channelId, channel.map(TaskRules.hasBoard) == true else { return }
            tab = .tasks
            if open.taskId == nil { controller.taskOpen = nil }
        }
        .onChange(of: controller.canvasOpen, initial: true) { _, open in
            // M73: a canvas mention's notification, a task's 元のキャンバス: the 「キャンバス」 tab (which selects the canvas).
            if let open, open.channelId == channelId { tab = .canvas }
        }
        .onChange(of: controller.messageFocus?.messageId) { _, _ in
            // M56: a message of this conversation to show (a task's 「メッセージを開く」): back to the messages.
            if focus != nil, tab == .tasks { tab = .messages }
        }
        .onChange(of: pendingThreadId, initial: true) { _, id in
            if let id {
                thread = ThreadTarget(id: id)
                pendingThreadId = nil
            }
        }
        // Also while another conversation is the open one: a search result's, opened in the sheet over this one (§7.7).
        .keepsChannelRows(controller.engine, channelId)
    }

    private func headerSubtitle(_ channel: ChannelState) -> String? {
        if let topic = channel.channel.topic, !topic.isEmpty { return topic }
        if channel.channel.isDm {
            // 1:1 DM: the other person's presence (SYNC_PROTOCOL.md §5.2) and custom status (M11d).
            let others = (channel.channel.dmUserIds ?? []).filter { $0 != controller.store.me?.id }
            guard others.count == 1 else { return nil }
            let presence = presenceLabel(controller.store.presenceOf(others[0]))
            if let status = activeStatus(controller.store.users[others[0]]) { return "\(presence) · \(status.emoji) \(status.text)".trimmingCharacters(in: .whitespaces) }
            return presence
        }
        return channel.isMember && !channel.channel.archived ? tr("トピックを設定") : nil
    }
}

/// The channel's notification level, 「ミュート」 (until unmuted, M35) and a timed mute (PUSH_NOTIFICATIONS.md §4), a
/// submenu of the header's ⋯. The label shows what the conversation notifies me of, or that it is muted.
struct NotificationMenu: View {
    @Bindable var controller: AppController
    let channel: ChannelState

    private var level: String { channel.pushLevel(overall: controller.store.me?.overallNotification ?? "mentions", meId: controller.store.me?.id) }

    var body: some View {
        Menu {
            NotificationLevelPicker(controller: controller, channel: channel)
            Divider()
            NotificationMuteControls(controller: controller, channel: channel, withIcons: true)
        } label: {
            let pref = channel.channel.notification
            Label(NotificationRules.menuLabel(level: level, muted: pref?.muted ?? false, timedMute: Timeline.muteLabel(pref?.mutedUntil)),
                  systemImage: isMuted(channel) ? "bell.slash" : "bell")
        }
        .accessibilityLabel("通知設定")
    }
}

/// M35: a conversation's level: 既定 (it follows my overall setting; sends level null) or a level of its own. The
/// mutes stay as they are.
struct NotificationLevelPicker: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    static let followDefaultTag = "default"

    var body: some View {
        let overall = controller.store.me?.overallNotification ?? "mentions"
        Picker("通知", selection: Binding(get: { channel.ownNotificationLevel ?? Self.followDefaultTag }, set: { value in
            Task { _ = await controller.setNotificationLevel(channel, own: value == Self.followDefaultTag ? nil : value) }
        })) {
            Text("既定（\(NotificationRules.overallLabel(overall))）").tag(Self.followDefaultTag)
            Text("すべてのメッセージ").tag("all")
            Text("メンションのみ").tag("mentions")
            Text("通知しない").tag("none")
        }
    }
}

/// M35: 「ミュート」 (until unmuted) and the timed 「8 時間ミュート」 / its 解除. Neither pins the level.
struct NotificationMuteControls: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    var withIcons = false

    var body: some View {
        Toggle(isOn: Binding(get: { channel.channel.notification?.muted ?? false }, set: { on in
            Task { _ = await controller.setMuted(channel, on) }
        })) {
            if withIcons { Label("ミュート", systemImage: "bell.slash") } else { Text("ミュート") }
        }
        if let timed = Timeline.muteLabel(channel.channel.notification?.mutedUntil) {
            Button {
                Task { _ = await controller.setTimedMute(channel, until: nil) }
            } label: {
                if withIcons { Label("ミュート解除（\(timed)）", systemImage: "bell") } else { Text("ミュート解除（\(timed)）") }
            }
        } else {
            Button {
                Task { _ = await controller.setTimedMute(channel, until: Date().addingTimeInterval(8 * 3600)) }
            } label: {
                if withIcons { Label("8 時間ミュート", systemImage: "moon.zzz") } else { Text("8 時間ミュート") }
            }
        }
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

extension View {
    /// Runs `action` when the reader drags the list, not when it moves by itself (rows inserted above, the keyboard,
    /// scrollTo).
    func onUserScroll(_ action: @escaping () -> Void) -> some View { modifier(UserScrollDetector(action: action)) }

    /// M25: runs `action(moving)` when the list starts or stops moving: under the reader's finger, gliding, or scrolled
    /// by code. iOS 17 has no scroll phase, so there the list always counts as at rest.
    func onScrollMotion(_ action: @escaping (_ moving: Bool) -> Void) -> some View { modifier(ScrollMotionDetector(action: action)) }

    /// §7.7 (M22): the channel's rows are not trimmed to the cap while this view (a conversation, a thread) is on screen.
    func keepsChannelRows(_ engine: SyncEngine?, _ channelId: String) -> some View {
        modifier(ChannelRowsHold(engine: engine, channelId: channelId))
    }
}

/// Registered with the engine from appearing to disappearing; the engine counts every view of a channel.
private struct ChannelRowsHold: ViewModifier {
    let engine: SyncEngine?
    let channelId: String
    @State private var release: (@MainActor () -> Void)?

    func body(content: Content) -> some View {
        content
            .onAppear { if release == nil { release = engine?.viewing(channelId) } }
            .onDisappear {
                release?()
                release = nil
            }
    }
}

private struct ScrollMotionDetector: ViewModifier {
    let action: (Bool) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollPhaseChange { old, phase in if (old == .idle) != (phase == .idle) { action(phase != .idle) } }
        } else {
            content
        }
    }
}

private struct UserScrollDetector: ViewModifier {
    let action: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollPhaseChange { _, phase in if phase == .interacting { action() } }
        } else {
            content.simultaneousGesture(DragGesture(minimumDistance: 8).onChanged { _ in action() })
        }
    }
}

/// Whether a view is under a presentation (a sheet, a full-screen cover, an alert), wherever it was presented from:
/// its rows are not being looked at, so they do not mark anything read (§10 「表示できた」). A view that is itself in
/// a sheet counts as uncovered while that sheet is the top one.
@MainActor
final class CoverProbe {
    weak var view: UIView?

    var covered: Bool {
        guard let view, let window = view.window, var top = window.rootViewController else { return true }
        // Bounded, and never loads a view: this runs on every frame change, also in the middle of a presentation.
        var seen: Set<ObjectIdentifier> = [ObjectIdentifier(top)]
        while let presented = top.presentedViewController, seen.insert(ObjectIdentifier(presented)).inserted { top = presented }
        guard let topView = top.viewIfLoaded else { return true }
        return !view.isDescendant(of: topView)
    }

    /// Placed behind the view it reports on.
    struct Marker: UIViewRepresentable {
        let probe: CoverProbe
        func makeUIView(context: Context) -> UIView {
            let view = UIView()
            view.isUserInteractionEnabled = false
            probe.view = view
            return view
        }
        func updateUIView(_ view: UIView, context: Context) { probe.view = view }
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

/// MOBILE_POLISH.md C3: under a thread's parent, up to three small overlapping avatars of who replied (the latest
/// first), 「N 件の返信」 and 「最終返信 今日 14:05」 — Slack's line, and the web's `ThreadSummaryLine`. A server without
/// `reply_user_ids` gives no avatars: the bubble shows instead.
struct ThreadSummaryLine: View {
    let message: MessageState
    let store: Store
    let open: () -> Void
    static let avatarSize: CGFloat = 20

    private var repliers: [String] { Array(message.replyUserIds.prefix(3)) }
    private var last: String? { message.lastReplyAt.flatMap { Timeline.lastReplyLabel($0) } }

    var body: some View {
        Button(action: open) {
            HStack(spacing: 6) {
                if repliers.isEmpty {
                    Image(systemName: "bubble.left.and.bubble.right").font(.caption).foregroundStyle(Color.accentColor)
                } else {
                    HStack(spacing: -4) {
                        ForEach(repliers, id: \.self) { id in
                            AvatarView(id: id, name: store.users[id]?.displayName ?? "?", size: Self.avatarSize)
                                // A ring of the page's colour parts the overlapping faces.
                                .padding(1.5)
                                .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: (Self.avatarSize + 3) / 4, style: .continuous))
                        }
                    }
                }
                Text("\(message.replyCount) 件の返信")
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
                    .lineLimit(1)
                    .layoutPriority(1)
                if let last {
                    Text(last).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([tr("\(message.replyCount) 件の返信"), last].compactMap { $0 }.joined(separator: tr("、")))
        .accessibilityAddTraits(.isButton)
    }
}

struct MessageRow: View {
    let message: MessageState
    @Bindable var controller: AppController
    var compact = false
    /// The list's side margin, inside the row: its highlight and its press reach the screen's edges (testers,
    /// 2026-09-29), with the text where it was.
    var margin: CGFloat = 0
    /// The message whose actions are open: it stays highlighted where it is (Slack).
    var highlighted = false
    /// In the channel: its thread (the parent's for a reply shared there), from 「N 件の返信」 and a tap on the message.
    var onOpenThread: (() -> Void)? = nil
    /// Asks the conversation for one of the message's sheets (`messageSheets`); the row presents nothing itself.
    var present: ((MessageSheet) -> Void)? = nil
    /// A channel read before joining (M27): its reactions, poll and confirmation show but take nothing.
    var readOnly = false
    /// L8: a tap on the message does this instead of opening its thread (the Times feed: the message in its channel);
    /// 「N 件の返信」 still opens the thread.
    var onTap: (() -> Void)? = nil

    private var store: Store { controller.store }
    private var engine: SyncEngine? { controller.engine }
    private var isMine: Bool { store.me?.id == message.senderId }

    private func show(_ kind: MessageSheet.Kind) { present?(MessageSheet(kind: kind, message: message)) }

    /// The action sheet (a long press, or VoiceOver's action); the keyboard goes first, as in Slack.
    private func openActions(haptic: Bool) {
        guard !message.pending, present != nil else { return }
        if haptic { UIImpactFeedbackGenerator(style: .medium).impactOccurred() }
        KeyboardBehavior.dismiss()
        show(.actions)
    }

    /// A tap on the message opens its thread (Slack; testers, 2026-09-29), to read or to reply. With the keyboard up the
    /// tap only closes it, as a tap on the list always did (`dismissesKeyboardOnTap`).
    private func tapped() {
        guard !message.pending, !KeyboardBehavior.isUp else { return }
        if let onTap { return onTap() }
        onOpenThread?()
    }

    /// The link a preview card is shown for (M11g): the body's first, unless it opens a message or a canvas here.
    private var previewLink: String? {
        // M117: a call's link is its card, without a preview.
        guard !message.pending, message.call == nil, let link = Links.first(in: message.body), Permalink.messageId(base: controller.api?.baseUrl, url: link) == nil,
              CanvasLink.canvasId(base: controller.api?.baseUrl, url: link) == nil,
              PageLink.pageId(base: controller.api?.baseUrl, url: link) == nil else { return nil }
        return link
    }

    /// 「プレビューを表示」 was tapped on this message.
    private var revealed: Bool { controller.revealedPreviews.contains(message.id) }
    /// Whether the row asks for its link's preview and shows the card (review v0.1.18 #5: a bot's only when asked for).
    private var loadsPreview: Bool { revealed || controller.autoLoadsLinkPreview(message) }

    private var senderName: String { store.users[message.senderId]?.displayName ?? (message.pending ? store.me?.displayName ?? "" : "?") }
    /// Why the server refused an unsent message (its outbox row keeps the code), in the shared Japanese words.
    private var failureText: String {
        let code = store.outbox.first { $0.clientMsgId == message.clientMsgId }?.failed
        return code.flatMap { ErrorMessages.byCode[$0] }.map { tr("送信に失敗しました：\($0)") } ?? tr("送信に失敗しました")
    }

    /// M15c: in the channel a shared reply names its thread (tap opens it); in the thread it says it was shared.
    @ViewBuilder
    private var replyLine: some View {
        if let onOpenThread {
            let parent = message.parentId.flatMap { store.message(message.channelId, id: $0) }
            let excerpt = parent.map { Timeline.excerpt($0.body, attachments: $0.attachments, users: store.users, groups: store.groups) }
            Button { onOpenThread() } label: {
                Label {
                    CustomEmoji.excerpt(tr("スレッドに返信：\(excerpt ?? tr("元のメッセージ"))"), controller: controller, height: 11)
                } icon: {
                    Image(systemName: "bubble.left")
                }
                .lineLimit(1)
            }
            .buttonStyle(.plain).font(.caption2).foregroundStyle(.secondary)
        } else if message.alsoInChannel {
            Text("チャンネルにも送信済み").font(.caption2).foregroundStyle(.secondary)
        }
    }

    var body: some View {
        if message.isSystem {
            // M89 (MEMBERSHIP.md §5 3.): one muted line; no taps, long press or VoiceOver actions (nothing to open).
            SystemMessageRow(message: message, store: store, margin: margin, focused: controller.messageFocus?.messageId == message.id)
        } else if Moderation.folds(message, blocked: store.blockedUsers, revealed: controller.revealedBlocked) {
            // M104 (MODERATION.md §4): someone I blocked, folded until I ask to see it.
            BlockedMessageRow(margin: margin) { controller.revealedBlocked.insert(message.id) }
        } else {
            personRow
        }
    }

    private var personRow: some View {
        HStack(alignment: .top, spacing: 10) {
            if compact {
                // Grouped under the previous message: its time, small, where the avatar would be, so where one message
                // ends and the next begins shows (testers, 2026-09-28; the same on Android and the web).
                Text(Timeline.timeLabel(message.createdAt))
                    .font(.caption2).monospacedDigit().foregroundStyle(.tertiary) // scales with Dynamic Type (audit 2026-09-29)
                    .frame(width: 36, alignment: .center)
                    .padding(.top, 3)
            } else {
                AvatarView(id: message.senderId, name: senderName)
                    .onTapGesture { if !message.pending { show(.profile) } }
            }
            VStack(alignment: .leading, spacing: 2) {
                if message.isReply { replyLine }  // M15c
                if let priority = message.priority { PriorityLabelView(priority: priority) }  // M15e
                if let workflow = message.workflow, !message.deleted {  // M95: 「⚡ name」, opens its form
                    WorkflowLabel(name: workflow.name) { Task { await controller.openWorkflow(id: workflow.id) } }
                }
                let saved = store.isBookmarked(message.id)
                let pinnedBy = message.pinnedAt.map { _ in store.users[message.pinnedBy ?? ""]?.displayName ?? "?" }
                if pinnedBy != nil || saved {
                    HStack(spacing: 10) {
                        if let pinnedBy { Label("\(pinnedBy) がピン留め", systemImage: "pin.fill").foregroundStyle(.orange) }
                        if saved { Label("保存済み", systemImage: "bookmark.fill").foregroundStyle(Color.accentColor) }
                    }
                    .font(.caption2)
                }
                if !compact {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(senderName).bold().onTapGesture { if !message.pending { show(.profile) } }
                        if controller.isAiBot(message.senderId) {
                            AiBadge()  // M66
                        } else if store.users[message.senderId]?.role == "bot" {
                            Text("BOT").font(.caption2).bold().foregroundStyle(.secondary)
                                .padding(.horizontal, 4).padding(.vertical, 1).background(Color.secondary.opacity(0.15)).clipShape(RoundedRectangle(cornerRadius: 3))
                        }
                        StatusEmojiView(user: store.users[message.senderId], controller: controller)
                        Text(Timeline.timeLabel(message.createdAt)).font(.caption).foregroundStyle(.secondary)
                        if message.editedAt != nil {
                            if isMine {
                                Button { show(.revisions) } label: { Text("（編集済み）").font(.caption).underline() }
                                    .buttonStyle(.plain).foregroundStyle(.secondary)
                            } else {
                                Text("（編集済み）").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } else if message.editedAt != nil {
                    Text(tr("\(Timeline.fullLabel(message.createdAt))（編集済み）"))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if let call = message.call, !message.deleted {  // M117: the card instead of the link
                    CallCardView(call: call, starter: store.users[call.startedBy]?.displayName ?? senderName)
                }
                let body = message.call.map { CallRules.extraBody(message.body, call: $0) } ?? message.body
                if !body.isEmpty && !PollCardView.hidesBody(body, poll: message.poll) {
                    MessageBodyView(text: body, users: store.users, groups: store.groups, internalBase: controller.api?.baseUrl,
                                    customEmoji: store.customEmoji, emojiImages: store.emojiImages, emojiAnimations: store.emojiAnimations,
                                    onNeedEmojiImage: { controller.loadEmojiImage($0) }, keywords: store.me?.notifyKeywords ?? [], jumbo: true,
                                    userLinks: present != nil && !message.pending)
                        .environment(\.openURL, OpenURLAction { url in
                            if url.scheme == CanvasLink.scheme, let id = url.host {  // M45
                                controller.canvasLink = CanvasLinkTarget(id: id)
                                return .handled
                            }
                            if url.scheme == PageLink.scheme, let id = url.host {  // M122: a wiki page
                                controller.pageLink = PageLinkTarget(id: id)
                                return .handled
                            }
                            if url.scheme == UserLink.scheme, let id = url.host {  // a mention: that person's profile
                                KeyboardBehavior.dismiss()
                                present?(MessageSheet(kind: .profile, message: message, userId: id))
                                return .handled
                            }
                            guard url.scheme == Permalink.scheme, let id = url.host else { return .systemAction }
                            Task { await controller.openPermalink(id) }
                            return .handled
                        })
                        // The text takes its own taps: SwiftUI gives a touch to a control within some 12 pt of it, and a
                        // tap on the first line went to the name above (the profile), on the last to the reactions below.
                        // Its links keep theirs.
                        .contentShape(Rectangle())
                        .onTapGesture(perform: tapped)
                }
                if !message.attachments.isEmpty {
                    AttachmentsView(attachments: message.attachments, controller: controller,
                                    present: present.map { present in { url in present(MessageSheet(kind: .file, message: message, url: url)) } })
                }
                if let link = previewLink {
                    if loadsPreview {
                        // The card's frame from the start, so the row does not grow when the preview comes (LinkPreviewSlot).
                        switch controller.linkPreviewSlot(link) {
                        case .card(let preview): LinkPreviewCard(preview: preview, url: link)
                        case .placeholder: LinkPreviewCard(preview: nil, url: link)
                        // Asked for by hand and the page gives none: the plain link stays, without the button.
                        case .none: if revealed { LinkPreviewOffer(url: link, offer: false) {} }
                        }
                    } else {
                        // A bot's link (review v0.1.18 #5): fetched only when asked for.
                        LinkPreviewOffer(url: link) { controller.revealLinkPreview(message.id) }
                    }
                }
                if let poll = message.poll { PollCardView(poll: poll, message: message, controller: controller, readOnly: readOnly) }  // M14b
                if message.ackRequested && !message.pending { AckBarView(message: message, controller: controller, readOnly: readOnly, present: present) }  // M15e
                if let collection = message.collection, !message.deleted {  // L6: who of the targets has replied
                    CollectionChipView(collection: collection, meId: store.me?.id,
                                       onOpen: present.map { present in { present(MessageSheet(kind: .collection, message: message)) } })
                }
                if !message.tasks.isEmpty && !message.deleted {  // L9: its review requests and shared tasks
                    MessageTaskChips(tasks: message.tasks, controller: controller,
                                     onOpen: present.map { present in { id in present(MessageSheet(kind: .task, message: message, taskId: id)) } })
                }
                if !message.reactions.isEmpty {
                    ChipsLayout(spacing: 6) {
                        ForEach(message.reactions, id: \.emoji) { reaction in
                            let mine = store.me.map { reaction.userIds.contains($0.id) } ?? false
                            Button { Task { await controller.toggleReaction(message, emoji: reaction.emoji) } } label: {
                                // One 16 pt box for the emoji of either kind (2026-10-04: a standard emoji was 12 pt
                                // caption text beside a 16 pt image, and the chips differed in height).
                                ReactionChipLine(spacing: 3) {
                                    if let name = CustomEmoji.name(of: reaction.emoji), let custom = store.customEmoji[name] {
                                        // M100: a wide one (at most 3:1) or a text emoji's pill is wider, as high.
                                        let box = CustomEmoji.size(of: custom, height: 16)
                                        if let image = store.emojiImages[custom.id] {
                                            EmojiImage(still: image, animation: store.emojiAnimations[custom.id]).frame(width: box.width, height: 16)
                                        } else {
                                            // Its room until the image comes: `:name:` there made the chip wider and the
                                            // chips re-wrapped, changing the row's height (CustomEmoji.text).
                                            Color.clear.frame(width: box.width, height: 16)
                                                .onAppear { controller.loadEmojiImage(custom) }
                                        }
                                    } else if CustomEmoji.name(of: reaction.emoji) != nil {
                                        Text(reaction.emoji).font(.caption)  // a name this workspace does not have
                                    } else {
                                        Text(reaction.emoji).font(.system(size: 15)).fixedSize().frame(minWidth: 16).frame(height: 16)
                                    }
                                    Text("\(reaction.count)").font(.caption)
                                }
                            }
                            .buttonStyle(.bordered)
                            .tint(mine ? Color.accentColor : Color.secondary)
                            .controlSize(.mini)
                            .accessibilityLabel(ReactionChipLabel.text(reaction.emoji, count: reaction.count,
                                                                       custom: CustomEmoji.name(of: reaction.emoji).flatMap { store.customEmoji[$0] }))
                            .accessibilityAddTraits(mine ? .isSelected : [])
                        }
                        // M25: one more reaction right there (Slack; the web's 「＋」): the picker the action sheet's
                        // smiley opens.
                        if !readOnly {
                            Button { show(.reactions) } label: {
                                AddReactionChipLabel()
                            }
                            .buttonStyle(.bordered)
                            .tint(Color.secondary)
                            .controlSize(.mini)
                            .accessibilityLabel("リアクションを追加")
                        }
                    }
                    .allowsHitTesting(!readOnly) // a tap goes to the row (the thread)
                    .padding(.top, 2)
                }
                if message.replyCount > 0, let onOpenThread {
                    ThreadSummaryLine(message: message, store: store, open: onOpenThread).padding(.top, 2)
                }
                if message.failed {
                    HStack {
                        Text(failureText).font(.caption).foregroundStyle(.red)
                        Button("再送") { if let key = message.clientMsgId { Task { await engine?.retryFailed(key) } } }.font(.caption)
                        Button("破棄", role: .destructive) { if let key = message.clientMsgId { engine?.discardFailed(key) } }.font(.caption)
                    }
                }
            }
        }
        .padding(.vertical, compact ? 4 : 5)
        .padding(.horizontal, margin)
        // The row is as wide as the list: a press right of a short message is on it. It was only as wide as its text,
        // and a press beside that went to whichever row was nearest, often the one above (testers, 2026-09-29).
        .frame(maxWidth: .infinity, alignment: .leading)
        .opacity(message.pending && !message.failed ? 0.6 : 1)
        .background(controller.messageFocus?.messageId == message.id ? Color.yellow.opacity(0.18) : Color.clear)
        .background(highlighted ? Color(.systemGray5) : Color.clear) // the message whose actions are open (Slack)
        .contentShape(Rectangle())
        // A long press anywhere on the row opens the actions from the bottom (MessageActions.swift). Before the buttons
        // in it: a press on or near the name, a reaction or 「N 件の返信」 went to that control instead (the chip looked
        // pressed, then toggled as the finger lifted; the name opened the profile). Their taps still come once the
        // press is too short to be this one.
        .highPriorityGesture(LongPressGesture(minimumDuration: 0.35).onEnded { _ in openActions(haptic: true) })
        // The link's preview is asked for by the row, which is always there. The card asked for it itself, but it is
        // empty until the preview has come, and an empty view has nothing to run a task on: it never started, and no
        // card ever showed (audit 2026-09-30).
        // Only for a link whose preview the row may ask for (LinkPreviewRules; a bot's after 「プレビューを表示」).
        .task(id: loadsPreview ? previewLink : nil) { if loadsPreview, let previewLink { await controller.loadLinkPreview(previewLink) } }
        // Slack: a tap opens the thread (in the channel); the links, buttons, name and pictures in the row keep their
        // own taps.
        .onTapGesture(perform: tapped)
        // M25: VoiceOver has no long press on a row: the same sheet is an action (the actions rotor) of every element
        // of the message, which keeps its own links and buttons. So is the thread a tap opens.
        .accessibilityActions {
            if !message.pending && present != nil {
                Button("メッセージの操作") { openActions(haptic: false) }
            }
            if !message.pending, let onTap {
                Button("チャンネルで開く") { onTap() }
            }
            if !message.pending, let onOpenThread {
                Button("スレッドを開く") { onOpenThread() }
            }
            // The avatar and the name take taps VoiceOver cannot make (audit 2026-09-29).
            if !message.pending && present != nil {
                Button("プロフィール") { show(.profile) }
            }
        }
    }
}

/// Chips in lines as wide as the row, as many lines as they need. The reactions were an HStack: with many of them it
/// was wider than the screen, the chips squeezed empty and the 「＋」 past the edge, and the list laid every row out as
/// wide as that one, so text near it was cut off at the right (testers, 2026-09-29).
/// A reaction chip's content line: as high as the 16 pt emoji box and the count's `.caption` line, whatever it holds,
/// so the 「＋☺」 chip after the reactions is exactly as high as they are (2026-10-05: its symbols were ~13 pt high and
/// it sat shorter, at the top of the row).
struct ReactionChipLine<Content: View>: View {
    static var emojiHeight: CGFloat { 16 }
    var spacing: CGFloat = 3
    @ViewBuilder var content: Content

    var body: some View {
        ZStack(alignment: .leading) {
            // The count's line height even where there is no count (the add chip), at any text size.
            Text("0").font(.caption).fixedSize().hidden().frame(width: 0)
            HStack(spacing: spacing) { content }
        }
        .frame(minHeight: Self.emojiHeight)
    }
}

/// Review v0.1.37 (iOS test note): what VoiceOver reads for a reaction chip, in the UI language — 「👍、2 人がリアクション」,
/// "👍, 2 people reacted". SwiftUI used to join the chip's texts itself (「👍、2」, before the i18n 「👍 2」), and a custom
/// emoji's image said nothing: it is read by its label (a text emoji's text), else its name.
enum ReactionChipLabel {
    static func text(_ emoji: String, count: Int, custom: CustomEmojiOut?) -> String {
        let name = custom.map { $0.label?.isEmpty == false ? $0.label! : $0.name } ?? CustomEmoji.name(of: emoji) ?? emoji
        return name + tr("、") + tr("\(count) 人がリアクション")
    }
}

/// The 「＋☺」 at the end of a message's reactions (M25), as high as the chips (ReactionChipLine).
struct AddReactionChipLabel: View {
    var body: some View {
        ReactionChipLine(spacing: 1) {
            Image(systemName: "plus").font(.system(size: 8, weight: .bold))
            Image(systemName: "face.smiling").font(.caption)
        }
    }
}

struct ChipsLayout: Layout {
    var spacing: CGFloat = 6

    /// Where each chip goes, from the top leading corner: a chip that does not fit after the others starts a line.
    static func frames(_ sizes: [CGSize], width: CGFloat, spacing: CGFloat) -> [CGRect] {
        var frames: [CGRect] = []
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0
        for size in sizes {
            if x > 0 && x + size.width > width {
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            frames.append(CGRect(origin: CGPoint(x: x, y: y), size: size))
            x += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }
        return frames
    }

    private func frames(_ subviews: Subviews, width: CGFloat?) -> [CGRect] {
        Self.frames(subviews.map { $0.sizeThatFits(.unspecified) }, width: width ?? .infinity, spacing: spacing)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let frames = frames(subviews, width: proposal.width)
        return CGSize(width: frames.map(\.maxX).max() ?? 0, height: frames.map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for (subview, frame) in zip(subviews, frames(subviews, width: bounds.width)) {
            subview.place(at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY), proposal: ProposedViewSize(frame.size))
        }
    }
}

/// C4 (Codex audit): the editor stays open, with the text, until the server has the edit. It closed as 保存 was
/// pressed, and a failed save (offline) lost the text.
struct EditMessageView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var saving = false
    @State private var failure: String?
    /// Editing means typing: the keyboard is up as the editor opens (testers, 2026-09-30).
    @FocusState private var focused: Bool
    /// Saves the text: nil once the server took it, else why not (shown here, the editor stays).
    let onSave: (String) async -> String?

    init(initial: String, onSave: @escaping (String) async -> String?) {
        _text = State(initialValue: initial)
        self.onSave = onSave
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func save() {
        saving = true
        failure = nil
        Task {
            let error = await onSave(BodyTokenizer.straightenCode(trimmed))  // smart punctuation out of code
            saving = false
            if let error { failure = error } else { dismiss() }
        }
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 0) {
                if let failure {
                    Label(failure, systemImage: "exclamationmark.triangle.fill")
                        .font(.footnote).foregroundStyle(.red)
                        .padding([.horizontal, .top])
                }
                TextEditor(text: $text)
                    .focused($focused)
                    .disabled(saving)
                    .padding()
            }
            .navigationTitle("メッセージを編集")
            .navigationBarTitleDisplayMode(.inline)
            // After the sheet has come up: focused while it was still presenting, the keyboard did not show.
            .task {
                try? await Task.sleep(nanoseconds: 350_000_000)
                focused = true
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "保存中…" : "保存", action: save).disabled(trimmed.isEmpty || saving)
                }
            }
            .interactiveDismissDisabled(saving)
        }
    }
}

/// The server sends ISO 8601 with microseconds. Each string is parsed once (IsoDates): a timeline asks for every
/// row's time on every redraw, and a new ISO8601DateFormatter plus a regex per call made that grow with the rows (M20).
func parseIsoDate(_ iso: String) -> Date? { IsoDates.shared.date(iso) }

final class IsoDates: @unchecked Sendable {
    static let shared = IsoDates()
    private let lock = NSLock()
    private var cache: [String: Date] = [:]
    private let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private let whole = Date.ISO8601FormatStyle()

    func date(_ iso: String) -> Date? {
        lock.lock()
        let known = cache[iso]
        lock.unlock()
        if let known { return known }
        guard let date = (try? fractional.parse(iso)) ?? (try? whole.parse(iso)) ?? Self.legacy(iso) else { return nil }
        lock.lock()
        if cache.count >= 50_000 { cache.removeAll(keepingCapacity: true) }
        cache[iso] = date
        lock.unlock()
        return date
    }

    /// Anything the format styles refuse (ISO8601DateFormatter reads only milliseconds).
    private static func legacy(_ iso: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = formatter.date(from: iso) { return date }
        let truncated = iso.replacingOccurrences(of: #"(\.\d{3})\d+"#, with: "$1", options: .regularExpression)
        if let date = formatter.date(from: truncated) { return date }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: iso)
    }
}

struct ComposerView: View {
    let channelId: String
    var parentId: String? = nil
    let users: [UserPublic]
    var placeholder = tr("メッセージを入力")
    var controller: AppController? = nil
    /// A line of the composer's own above the input (the thread's 「#… にも送信」), inside its top edge.
    var accessory: AnyView? = nil
    let onSend: (String, [String], SendOptions) -> Void
    private var text: String { controller?.store.draft(channelId, parentId: parentId).text ?? "" }
    private var pending: [AttachmentOut] { controller?.store.draft(channelId, parentId: parentId).attachments ?? [] }
    private var uploading: Int { controller?.store.uploading(channelId, parentId: parentId) ?? 0 }
    private var textBinding: Binding<String> { Binding(get: { text }, set: { value in
        controller?.store.setDraft(channelId, parentId: parentId) { $0.text = value }
        if !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { controller?.engine?.sendTyping(channelId, parentId: parentId) } // §5.2, throttled
    }) }
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showFileImporter = false
    @State private var showCamera = false
    @State private var showEmojiPicker = false
    /// 「アンケートを作成」: from the ＋ menu, or `/poll` sent alone.
    @State private var showPollForm = false
    /// M54: 「日程調整を作成」, from the ＋ menu or `/日程` (the dates typed after it fill it in).
    @State private var scheduleForm: ScheduleFormInitial?
    @State private var showSchedule = false
    @State private var showCustomSchedule = false
    /// M95: 「＋」 → 「ワークフロー」, the workflow picked there (its form opens once the list has gone), and the channel's
    /// workflows for `/name` and `/wf name` (read when `/` is typed, kept a minute).
    @State private var showWorkflows = false
    @State private var pickedWorkflow: WorkflowOut?
    @State private var workflows: [WorkflowOut] = []
    @State private var customSendAt = Date().addingTimeInterval(3600)
    /// M15e: priority and "ask for acknowledgement" for a top-level post; cleared after each send.
    @State private var priority: String?
    @State private var ackRequested = false
    @FocusState private var focused: Bool
    /// The cursor and selection (iOS 26: `TextSelection`), where the formatting and the emoji go.
    @State private var selection = ComposerSelection()

    /// `/st` at the very start offers the slash commands (M13b).
    private var commandHits: [SlashCommands.Command] {
        guard candidates.isEmpty, emojiCandidates.isEmpty else { return [] }
        return SlashCommands.candidates(text)
    }
    /// M30: then the templates whose name starts so.
    private var templateHits: [TemplateOut] {
        guard candidates.isEmpty, emojiCandidates.isEmpty, let prefix = SlashCommands.typedPrefix(text), let controller else { return [] }
        return Templates.candidates(prefix: prefix, in: controller.store.templates, inTimes: inTimes)
    }
    private var inTimes: Bool { controller?.store.channel(channelId)?.channel.isTimes ?? false }
    /// M95: a channel's top-level composer offers workflows (not a thread's: they post top-level; not a DM).
    private var offersWorkflows: Bool {
        guard parentId == nil, let channel = controller?.store.channel(channelId)?.channel else { return false }
        return !channel.isDm
    }
    /// M95: then the workflows (`/name`, `/wf name`), as on the desktop: built-in, templates, workflows.
    private var workflowHits: [WorkflowOut] {
        guard offersWorkflows, candidates.isEmpty, emojiCandidates.isEmpty else { return [] }
        return Workflows.candidates(text, in: workflows)
    }
    private func openWorkflow(_ workflow: WorkflowOut) {
        controller?.store.setDraft(channelId, parentId: parentId) { $0.text = "" }
        controller?.runWorkflow(workflow, here: channelId)
    }
    private var templates: [TemplateOut] { Templates.ordered(controller?.store.templates ?? [], inTimes: inTimes) }

    /// M30: a template into the input, its date put in (DATA_MODEL.md message_templates); nothing is sent.
    private func insertTemplate(_ template: TemplateOut, replacing: Bool = false, after rest: String = "") {
        let body = Templates.expand(template.body, today: .today())
        var value = replacing ? body : Templates.inserted(body, into: text)
        if !rest.isEmpty { value += "\n" + rest }
        setText(value, selecting: value.count..<value.count)
    }
    private var candidates: [Mentions.Candidate] {
        guard let query = Mentions.query(text) else { return [] }
        return Mentions.candidates(query, users: users, groups: controller.map { Array($0.store.groups.values) } ?? [],
                                   aiBotIds: controller?.aiHub?.knownBotUserIds)
    }
    /// `:tada` completes to an emoji (M11f) when no mention is being typed.
    private var emojiCandidates: [EmojiEntry] {
        guard candidates.isEmpty, let query = Emoji.query(text) else { return [] }
        // M100: also by label and keywords (":ありがとう" finds :hpd-bow:).
        let found = Emoji.customCandidates(query, custom: controller.map { Array($0.store.customEmoji.values) } ?? [])
        let custom = found.map { EmojiEntry(shortcode: $0.name, glyph: ":\($0.name):", category: "custom", keywords: $0.label ?? "") }
        return Array((custom + Emoji.candidates(query)).prefix(8))
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { uploading == 0 && (!trimmed.isEmpty || !pending.isEmpty) }
    /// Asked once: the question took 8–20 ms on the main thread, and the input asked it on every keystroke and send
    /// (the list stalled as the sent row came in; time profile, 2026-09-29).
    private static let hasCamera = UIImagePickerController.isSourceTypeAvailable(.camera)
    private var cameraAvailable: Bool { Self.hasCamera }

    private func upload(data: Data, filename: String, contentType: String) async {
        guard let controller else { return }
        let store = controller.store
        guard pending.count < 10 else { controller.error = tr("添付は10件までです"); return }
        if let tooLarge = controller.attachmentTooLarge(data.count) { controller.error = tooLarge; return }
        if let uploaded = await controller.uploadAttachment(data: data, filename: filename, contentType: contentType) {
            store.setDraft(channelId, parentId: parentId) { $0.attachments.append(uploaded) }
        }
    }

    /// A picked file: checked against the server's size limit first, then streamed from disk (never read whole).
    private func upload(file url: URL) async {
        guard let controller else { return }
        guard pending.count < 10 else { controller.error = tr("添付は10件までです"); return }
        let accessed = url.startAccessingSecurityScopedResource()
        defer { if accessed { url.stopAccessingSecurityScopedResource() } }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if let tooLarge = controller.attachmentTooLarge(size) { controller.error = tooLarge; return }
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        if let uploaded = await controller.uploadAttachment(fileAt: url, filename: url.lastPathComponent, contentType: type) {
            controller.store.setDraft(channelId, parentId: parentId) { $0.attachments.append(uploaded) }
        }
    }

    /// A library video (testers, 2026-09-29): as it is when it fits the server's limit, else exported again at 720p; the
    /// copies go once uploaded.
    private func upload(video url: URL) async {
        guard let controller else { return }
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) } // PickedMovie's folder
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard controller.attachmentTooLarge(size) != nil, let smaller = await VideoUpload.shrink(url) else {
            await upload(file: url)
            return
        }
        defer { try? FileManager.default.removeItem(at: smaller) }
        await upload(file: smaller)
    }

    /// M12d 「後で送信」: the same draft, posted by the server at the chosen time.
    private func schedule(_ at: Date) {
        guard canSend, let controller else { return }
        guard at.timeIntervalSinceNow >= 60 else { controller.error = tr("1 分以上先の時刻を選んでください"); return }
        let body = Mentions.encode(BodyTokenizer.straightenCode(trimmed), users: users, groups: Array(controller.store.groups.values))
        let ids = pending.map(\.id)
        Task {
            if await controller.scheduleMessage(channelId: channelId, parentId: parentId, body: body, attachmentIds: ids, sendAt: at) {
                controller.store.setDraft(channelId, parentId: parentId) { $0 = Draft() }
            }
        }
    }

    /// M15e: what the next post will carry, with a way to clear it.
    private var priorityChips: some View {
        HStack(spacing: 8) {
            if let priority { PriorityLabelView(priority: priority) }
            if ackRequested { Label("確認を求める", systemImage: "checkmark.circle").font(.caption).foregroundStyle(.secondary) }
            Button { priority = nil; ackRequested = false } label: { Image(systemName: "xmark.circle.fill") }
                .buttonStyle(.plain).foregroundStyle(.secondary).accessibilityLabel("重要度を外す")
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
    }

    private func send() {
        if let command = SlashCommands.parse(trimmed) {  // M13b
            guard let controller else { return }
            if !command.known {
                // M30: `/日報` puts the template into the input instead (`/日報 文` keeps the words after it).
                if let template = Templates.named(command.name, in: controller.store.templates) {
                    insertTemplate(template, replacing: true, after: command.args)
                    return
                }
                // M95: `/name` of a workflow (or `/wf name`) opens its form; what was typed goes.
                if offersWorkflows {
                    let channelId = channelId
                    Task {
                        let list = await controller.channelWorkflows(channelId) ?? controller.cachedWorkflows(channelId)
                        if let workflow = Workflows.command(name: command.name, args: command.args, in: list) {
                            openWorkflow(workflow)
                        } else if command.name == "wf" {
                            controller.error = command.args.isEmpty ? tr("/wf の後にワークフローの名前を続けてください")
                                : tr("「\(command.args)」というワークフローはこのチャンネルにありません")
                        } else {
                            controller.error = tr("/\(command.name) というコマンドはありません（/help で一覧）")
                        }
                    }
                    return
                }
                controller.error = tr("/\(command.name) というコマンドはありません（/help で一覧）")
                return
            }
            if command.name == "poll" && command.args.isEmpty {  // the form instead of the syntax
                controller.store.setDraft(channelId, parentId: parentId) { $0.text = "" }
                showPollForm = true
                return
            }
            if command.name == "日程" {  // M54: the scheduling form, with the dates (and times) typed as its candidates (i18n-ignore)
                guard let initial = ScheduleFormInitial.reading(command.args, today: .today()) else {
                    controller.error = Templates.scheduleUsage  // nothing opens; what was typed stays to be corrected
                    return
                }
                controller.store.setDraft(channelId, parentId: parentId) { $0.text = "" }
                scheduleForm = initial
                return
            }
            controller.store.setDraft(channelId, parentId: parentId) { $0.text = "" }
            Task { _ = await controller.runCommand(command, channelId: channelId, parentId: parentId) }
            return
        }
        // The TextField's smart punctuation (‘ ’ “ ” — –) goes back to what was typed inside code.
        let body = Mentions.encode(BodyTokenizer.straightenCode(trimmed), users: users, groups: controller.map { Array($0.store.groups.values) } ?? [])
        guard canSend else { return }
        guard body.count <= 20_000, pending.count <= 10 else { controller?.error = tr("添付は10件、本文は20,000文字までです"); return }
        let ids = pending.map(\.id)
        controller?.store.setDraft(channelId, parentId: parentId) { $0 = Draft() }
        let options = SendOptions(priority: parentId == nil ? priority : nil, ackRequested: parentId == nil && ackRequested)
        priority = nil
        ackRequested = false
        onSend(body, ids, options)
    }

    /// The height of a one-line input: 「＋」 is as tall, so the two sit on one line (it was 4 pt lower).
    private static let fieldHeight: CGFloat = 40
    /// The tools row shows while the input has the keyboard (Slack / Mattermost).
    private var typing: Bool { focused }

    @ViewBuilder
    private var inputField: some View {
        // Not on iOS 18: typing crashed there at the first character (a tester, 2026-09-29), where the Japanese
        // keyboard's text being converted counts in the selection and not yet in the text. Its input is iOS 17's.
        if #available(iOS 26.0, *) {
            SelectingTextField(placeholder: placeholder, text: textBinding, box: selection)
        } else {
            TextField(placeholder, text: textBinding, axis: .vertical)
        }
    }

    /// 「＋」: photos, the camera and files, and how the next post goes out.
    private var attachMenu: some View {
        Menu {
            Button("写真ライブラリ", systemImage: "photo.on.rectangle") { showPhotoPicker = true }
            if cameraAvailable { Button("カメラ", systemImage: "camera") { showCamera = true } }
            Button("ファイル", systemImage: "folder") { showFileImporter = true }
            Button("アンケート", systemImage: "chart.bar.doc.horizontal") { showPollForm = true }
            Button("日程調整", systemImage: "calendar.badge.clock") { scheduleForm = ScheduleFormInitial() }
            if offersWorkflows { Button("ワークフロー", systemImage: "bolt") { showWorkflows = true } }  // M95
            if !typing && !templates.isEmpty { templateMenu }
            if !typing { Button("絵文字", systemImage: "face.smiling") { showEmojiPicker = true } }
            if parentId == nil {
                Divider()
                Picker("重要度", selection: $priority) {
                    Text("通常").tag(String?.none)
                    Label("重要", systemImage: "info.circle").tag(String?.some("important"))
                    Label("緊急", systemImage: "exclamationmark.triangle").tag(String?.some("urgent"))
                }
                Toggle("確認を求める", systemImage: "checkmark.circle", isOn: $ackRequested)
            }
            if !typing {
                Divider()
                Button("後で送信…", systemImage: "clock") { showSchedule = true }.disabled(!canSend)
            }
        } label: {
            if typing {
                Image(systemName: "plus.circle").font(.system(size: 22)).frame(width: 36, height: 36)
            } else {
                Image(systemName: "plus.circle.fill")
                    .font(.system(size: 30))
                    .foregroundStyle(uploading > 0 ? Color.secondary : Color.accentColor)
                    .frame(width: 36, height: Self.fieldHeight)
            }
        }
        .disabled(uploading > 0)
        .accessibilityLabel("添付")
    }

    /// Under the input while typing: attach, mention, emoji, formatting, send later; send on the right.
    private var toolRow: some View {
        HStack(spacing: 6) {
            attachMenu
            toolButton("at", label: tr("メンション")) { insert("@") }
            toolButton("face.smiling", label: tr("絵文字")) { showEmojiPicker = true }
            Menu {
                ForEach(ComposerFormat.allCases) { format in
                    Button(format.label, systemImage: format.icon) { apply(format) }
                }
            } label: {
                Image(systemName: "textformat").font(.system(size: 20)).frame(width: 36, height: 36)
            }
            .accessibilityLabel("書式")
            toolButton("clock", label: tr("後で送信")) { showSchedule = true }.disabled(!canSend)
            if !templates.isEmpty {
                Menu { templateItems } label: {
                    Image(systemName: "doc.text").font(.system(size: 20)).frame(width: 36, height: 36)
                }
                .accessibilityLabel("テンプレート")
            }
            Spacer()
            if uploading > 0 {
                ProgressView().controlSize(.small).frame(width: 36, height: 36)
            } else {
                sendButton(size: 30).disabled(!canSend).opacity(canSend ? 1 : 0.35)
            }
        }
        .foregroundStyle(Color.secondary)
        .padding(.horizontal, 12)
        .padding(.bottom, 6)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    /// M30: the templates, the workspace's then mine (those for times first in a times channel).
    @ViewBuilder
    private var templateItems: some View {
        ForEach(templates) { template in
            Button(template.scope == "user" ? tr("\(template.name)（個人）") : template.name) { insertTemplate(template) }
        }
    }

    private var templateMenu: some View {
        Menu { templateItems } label: { Label("テンプレート", systemImage: "doc.text") }
    }

    private func toolButton(_ icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: icon).font(.system(size: 20)).frame(width: 36, height: 36) }
            .accessibilityLabel(label)
    }

    private func sendButton(size: CGFloat) -> some View {
        Button(action: send) {
            Image(systemName: "arrow.up.circle.fill").font(.system(size: size)).foregroundStyle(Color.accentColor)
        }
        // A hardware keyboard (iPad): ⌘Return sends, Return makes a new line (the desktop's default; a plain Return also
        // confirms a Japanese conversion). Only the composer being typed in, with a thread's composer beside it.
        .keyboardShortcut(focused ? KeyboardShortcut(.return, modifiers: .command) : nil)
        .hoverEffect(.highlight)
        .accessibilityLabel("送信")
    }

    /// The cursor or selection as character offsets (iOS 26 reports it; before, the end of the text).
    private func selectedRange() -> Range<Int> {
        let end = text.count
        if #available(iOS 26.0, *), let current = selection.selection(for: text), case .selection(let range) = current.indices,
           let offsets = ComposerSelection.offsets(range, in: text) {
            return offsets
        }
        return end..<end
    }

    private func setText(_ value: String, selecting range: Range<Int>) {
        textBinding.wrappedValue = value
        if #available(iOS 26.0, *) {
            let lower = value.index(value.startIndex, offsetBy: min(range.lowerBound, value.count))
            let upper = value.index(value.startIndex, offsetBy: min(range.upperBound, value.count))
            selection.raw = lower == upper ? TextSelection(insertionPoint: lower) : TextSelection(range: lower..<upper)
            selection.text = value
        }
        focused = true
    }

    /// Text at the cursor, in place of the selection (the end of the text before iOS 26).
    private func insert(_ inserted: String) {
        var chars = Array(text)
        let range = selectedRange().clamped(to: 0..<(chars.count + 1))
        chars.replaceSubrange(range.lowerBound..<min(range.upperBound, chars.count), with: Array(inserted))
        let cursor = range.lowerBound + inserted.count
        setText(String(chars), selecting: cursor..<cursor)
    }

    private func apply(_ format: ComposerFormat) {
        let result = format.apply(to: text, selection: selectedRange())
        setText(result.text, selecting: result.selection)
    }

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            if let accessory { accessory }
            PendingAttachmentsView(items: pending, uploading: uploading, controller: controller) { item in
                controller?.store.setDraft(channelId, parentId: parentId) { $0.attachments.removeAll { $0.id == item.id } }
            }
            if !emojiCandidates.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(emojiCandidates, id: \.shortcode) { entry in
                            Button { textBinding.wrappedValue = Emoji.complete(text, glyph: entry.glyph) } label: {
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
                    .padding(.horizontal, 12)
                }
                .padding(.top, 6)
            }
            if !candidates.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(candidates) { candidate in
                            Button { textBinding.wrappedValue = Mentions.complete(text, username: candidate.username) } label: {
                                Text("@\(candidate.username)").fontWeight(.semibold) + Text("  \(candidate.label)").foregroundStyle(.secondary)
                                    + (candidate.kind == "ai" ? Text("  AI").font(.caption2).bold().foregroundStyle(Color.accentColor) : Text(""))
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
            if !commandHits.isEmpty || !templateHits.isEmpty || !workflowHits.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(commandHits) { command in
                            Button { textBinding.wrappedValue = "/" + command.name + " " } label: {
                                Text(command.usage).fontWeight(.semibold) + Text("  \(command.description)").foregroundStyle(.secondary)
                            }
                            .font(.footnote)
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                        // M30: a template goes into the input at once.
                        ForEach(templateHits) { template in
                            Button { insertTemplate(template, replacing: true) } label: {
                                Text("/" + template.name).fontWeight(.semibold)
                                    + Text("  \(template.scope == "user" ? tr("個人 · ") : "")\(Templates.summary(template.body))").foregroundStyle(.secondary)
                            }
                            .font(.footnote)
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                        }
                        // M95: a workflow opens its form at once.
                        ForEach(workflowHits) { workflow in
                            Button { openWorkflow(workflow) } label: {
                                Text("\(workflow.mark) \(Workflows.commandText(workflow))").fontWeight(.semibold)
                                    + Text("  \(workflow.canRun ? (workflow.description.isEmpty ? tr("ワークフロー") : workflow.description) : tr("使えません"))")
                                        .foregroundStyle(.secondary)
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
            if priority != nil || ackRequested { priorityChips }
            // Slack / Mattermost (testers, 2026-09-29): at rest, 「＋」 beside the input; while typing, the input takes the
            // whole width and a row of tools goes under it (attach, mention, emoji, formatting, send later, send).
            HStack(alignment: .bottom, spacing: 8) {
                if !typing && controller != nil { attachMenu }
                HStack(alignment: .bottom, spacing: 4) {
                    inputField
                        .lineLimit(1...6)
                        .focused($focused)
                        .padding(.leading, 14)
                        .padding(.vertical, 9)
                        .padding(.trailing, !typing && (canSend || uploading > 0) ? 0 : 12)
                    if !typing {
                        if uploading > 0 {
                            ProgressView().controlSize(.small).padding(.trailing, 10).padding(.bottom, 10)
                        } else if canSend {
                            sendButton(size: 28).padding(.trailing, 5).padding(.bottom, 4).transition(.scale.combined(with: .opacity))
                        }
                    }
                }
                .frame(minHeight: Self.fieldHeight)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 21, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 21, style: .continuous).strokeBorder(Color(.separator).opacity(0.6), lineWidth: 0.5))
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, typing ? 2 : 8)
            if typing && controller != nil { toolRow }
        }
        .animation(.easeOut(duration: 0.15), value: canSend)
        .animation(.easeOut(duration: 0.2), value: typing)
        .background(Color(.systemBackground))
        // On the composer itself: on the attachments strip (nothing drawn without attachments) the dialog never showed
        // and 「後で送信」 did nothing (tester, 2026-09-30).
        .confirmationDialog("後で送信", isPresented: $showSchedule, titleVisibility: .visible) {
            ForEach(Schedule.presets()) { preset in
                Button(Schedule.choice(preset)) { schedule(preset.at) }
            }
            Button("日時を指定…") { customSendAt = Date().addingTimeInterval(3600); showCustomSchedule = true }
        }
        .sheet(isPresented: $showCustomSchedule) {
            NavigationStack {
                Form {
                    DatePicker("送信日時", selection: $customSendAt, in: Date().addingTimeInterval(60)..., displayedComponents: [.date, .hourAndMinute])
                    Text(tr("\(Schedule.label(customSendAt)) に送信します")).font(.footnote).foregroundStyle(.secondary)
                }
                .navigationTitle("後で送信")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { showCustomSchedule = false } }
                    ToolbarItem(placement: .confirmationAction) { Button("予約") { showCustomSchedule = false; schedule(customSendAt) } }
                }
            }
            .presentationDetents([.medium])
        }
        // M37 (6): chosen from 「新しいメッセージ」: the input takes the keyboard once the push has settled.
        .task(id: parentId == nil && controller?.composerFocus == channelId) {
            guard parentId == nil, let controller, controller.composerFocus == channelId else { return }
            try? await Task.sleep(for: .milliseconds(450))
            guard !Task.isCancelled else { return }
            controller.composerFocus = nil
            focused = true
        }
        // The picker is presented from the composer itself; a PhotosPicker inside a Menu never opens.
        // A popover beside the composer on an iPad's regular width, the sheet on a phone.
        .adaptivePopover(isPresented: $showEmojiPicker) {
            EmojiPickerView(custom: controller.map { Array($0.store.customEmoji.values) } ?? [], images: controller?.store.emojiImages ?? [:],
                            animations: controller?.store.emojiAnimations ?? [:],
                            onNeedImage: { emoji in controller?.loadEmojiImage(emoji) },
                            packs: controller?.store.sortedEmojiPacks ?? [], packTabs: controller?.store.packTabImages ?? [:],
                            onNeedPackTab: { controller?.loadPackTab($0) }) { glyph in insert(glyph) }
        }
        // M95: the channel's workflows when `/` starts the input (kept a minute by the controller).
        .task(id: offersWorkflows && text.hasPrefix("/") ? channelId : nil) {
            guard offersWorkflows, text.hasPrefix("/"), let controller else { return }
            workflows = controller.cachedWorkflows(channelId)
            if let list = await controller.channelWorkflows(channelId) { workflows = list }
        }
        .sheet(isPresented: $showWorkflows, onDismiss: {
            if let picked = pickedWorkflow { pickedWorkflow = nil; openWorkflow(picked) }
        }) {
            if let controller { WorkflowListSheet(controller: controller, channelId: channelId, picked: $pickedWorkflow) }
        }
        .sheet(isPresented: $showPollForm) {
            if let controller { PollFormView(controller: controller, channelId: channelId, parentId: parentId) }
        }
        .fullScreenCover(item: $scheduleForm) { initial in
            if let controller { ScheduleFormView(controller: controller, channelId: channelId, parentId: parentId, initial: initial) }
        }
        // Videos too (testers, 2026-09-29: they were not in the list at all).
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItems, maxSelectionCount: 5, matching: .any(of: [.images, .videos]))
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            controller?.store.trackUpload(channelId, parentId: parentId, delta: 1)
            Task {
                defer { controller?.store.trackUpload(channelId, parentId: parentId, delta: -1) }
                for item in items {
                    if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
                        guard let movie = try? await item.loadTransferable(type: PickedMovie.self) else {
                            controller?.error = tr("動画を読み込めませんでした")
                            continue
                        }
                        await upload(video: movie.url)
                        continue
                    }
                    // Library photos are mostly HEIC: re-encoded as JPEG like the camera's, or the server keeps no thumbnail.
                    guard let data = try? await item.loadTransferable(type: Data.self), let photo = ImageUpload.prepare(data) else {
                        controller?.error = tr("写真を読み込めませんでした") // it was dropped without a word (audit 2026-09-29)
                        continue
                    }
                    await upload(data: photo.data, filename: "photo." + photo.ext, contentType: photo.mime)
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
                for url in urls { await upload(file: url) }
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

/// M25: where the progress row at the top of the loaded range is (nil while LazyVStack has not built it).
private struct OlderRowFrame: PreferenceKey {
    static let defaultValue: CGRect? = nil
    static func reduce(value: inout CGRect?, nextValue: () -> CGRect?) { value = nextValue() ?? value }
}


extension Notification.Name {
    /// A profile card asked to open a conversation (userInfo["id"] = channel id).
    static let chikuwaOpenChannel = Notification.Name("chikuwa.openChannel")
    /// M141: I closed a DM (userInfo["id"] = channel id); its screens leave the stacks (back to the list).
    static let chikuwaCloseConversation = Notification.Name("chikuwa.closeConversation")
}


/// Over an opening conversation's hidden rows (ChannelView.veiled): a spinner only when the wait is long enough to see,
/// so the usual round trip shows nothing at all.
private struct OpeningProgress: View {
    @State private var shown = false

    var body: some View {
        ProgressView()
            .opacity(shown ? 1 : 0)
            .task {
                guard (try? await Task.sleep(nanoseconds: 400_000_000)) != nil else { return }
                withAnimation(.easeIn(duration: 0.2)) { shown = true }
            }
            .accessibilityLabel("メッセージを読み込み中")
    }
}

/// Row frames and the viewport's height, kept out of view state (ChannelView.frames).
final class RowFrames {
    var byId: [String: CGRect] = [:]
    var viewportHeight: CGFloat = 0
    /// M25: the progress row at the top of the loaded range, and whether the list is moving (OlderPaging).
    var topRow: CGRect?
    var moving = false
}

/// A row redraws when its message, its grouping or its highlight changes; what it reads from the store (names, custom
/// emoji, the saved mark) redraws it through observation. Before (M20), every row ran its body on every change of the
/// conversation.
extension MessageRow: Equatable {
    static func == (lhs: MessageRow, rhs: MessageRow) -> Bool {
        lhs.message == rhs.message && lhs.compact == rhs.compact && lhs.margin == rhs.margin && lhs.highlighted == rhs.highlighted
            && lhs.readOnly == rhs.readOnly && lhs.controller === rhs.controller
            && (lhs.onOpenThread == nil) == (rhs.onOpenThread == nil) && (lhs.present == nil) == (rhs.present == nil)
    }
}

/// The composer's cursor and selection: a `TextSelection?` from iOS 26, kept untyped so the view builds for iOS 17.
final class ComposerSelection {
    var raw: Any?
    /// The text the selection belongs to. Its indices are only good for that text: after a send cleared the input,
    /// an emoji chosen from the picker went in at an index past the end and the app crashed (testers, 2026-09-29).
    var text: String?

    /// The selection when it still belongs to `current`, else nil. Scalar by scalar: `==` also matches canonically
    /// equivalent texts (が as one scalar or two), whose indices differ.
    func raw(for current: String) -> Any? {
        guard let text, text.unicodeScalars.elementsEqual(current.unicodeScalars) else { return nil }
        return raw
    }

    /// The selection for `current` when its indices are all positions in it, else nil. A matching text is not enough
    /// (the field reports the selection and the text separately, and they can pair up wrong): on iOS 27 an emoji picked
    /// with an index past the end crashed the app in `utf16Offset(in:)` (TestFlight build 93, 2026-10-05).
    @available(iOS 26.0, *)
    func selection(for current: String) -> TextSelection? {
        guard let selection = raw(for: current) as? TextSelection else { return nil }
        switch selection.indices {
        case .selection(let range):
            return Self.offsets(range, in: current) == nil ? nil : selection
        case .multiSelection(let set):
            return set.ranges.allSatisfy { Self.offsets($0, in: current) != nil } ? selection : nil
        @unknown default:
            return nil
        }
    }

    /// `range` as character offsets in `text`, or nil when an index is not a position in it (made in another text, past
    /// its end). Never traps (`characterOffset`).
    static func offsets(_ range: Range<String.Index>, in text: String) -> Range<Int>? {
        guard let lower = characterOffset(range.lowerBound, in: text),
              let upper = characterOffset(range.upperBound, in: text) else { return nil }
        return min(lower, upper)..<max(lower, upper)
    }

    /// `index` as a character offset in `text`, or nil when it is not a position in it. Never traps.
    ///
    /// `samePosition(in:)` alone was not enough: TestFlight build 98 (iOS 27, 2026-10-06) crashed inside it ("String
    /// index is out of bounds") as text, an emoji and a space were typed. The field's indices are made in its own copy of
    /// the text (a bridged NSString, offsets counted in UTF-16), and one past the end of a text stored as UTF-8 traps
    /// while it is converted, before anything can answer nil. An ASCII text needs no conversion, so only texts with
    /// Japanese or emoji crashed. `fits` checks the offset in the index's own unit first.
    static func characterOffset(_ index: String.Index, in text: String) -> Int? {
        guard fits(index, in: text), let position = index.samePosition(in: text.utf16) else { return nil }
        // The characters that end at or before it: inside one (a ZWJ sequence, a flag) counts as its start.
        let units = text.utf16.distance(from: text.utf16.startIndex, to: position)
        var count = 0, end = 0
        for character in text {
            end += character.utf16.count
            if end > units { break }
            count += 1
        }
        return count
    }

    /// Whether `index`'s offset is within `text` in the unit the index counts in, so converting it to `text`'s encoding
    /// cannot run past the end. `String.Index` is a frozen struct of one `UInt64` (the standard library's ABI): the
    /// offset in bits 63…16, bit 2 "counted in UTF-8", bit 3 "counted in UTF-16"; with neither or both (ASCII), the
    /// stricter bound of the two. ComposerFormatTests pins the layout down.
    static func fits(_ index: String.Index, in text: String) -> Bool {
        guard MemoryLayout<String.Index>.size == MemoryLayout<UInt64>.size else { return false }
        let bits = unsafeBitCast(index, to: UInt64.self)
        let offset = Int(truncatingIfNeeded: bits >> 16)
        switch (bits & 0x4 != 0, bits & 0x8 != 0) {
        case (true, false): return offset <= text.utf8.count
        case (false, true): return offset <= text.utf16.count
        default: return offset <= min(text.utf8.count, text.utf16.count)
        }
    }
}

/// The input with its selection reported (iOS 26), for the formatting menu and inserting at the cursor.
@available(iOS 26.0, *)
private struct SelectingTextField: View {
    let placeholder: String
    let text: Binding<String>
    let box: ComposerSelection

    var body: some View {
        TextField(placeholder, text: text, selection: Binding(get: { box.selection(for: text.wrappedValue) },
                                                              set: { box.raw = $0; box.text = text.wrappedValue }), axis: .vertical)
    }
}

