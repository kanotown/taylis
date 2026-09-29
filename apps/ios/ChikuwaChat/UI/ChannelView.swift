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
    /// The list's UIScrollView, for keeping its bottom edge on iOS 18 (KeepsBottom), and whether it is doing that.
    @State private var scroller = ScrollViewProbe()
    @State private var resizing = false
    /// A message's sheet, presented here rather than by its row (MessageSheet).
    @State private var messageSheet: MessageSheet?
    /// The list's side margin, inside each row: a message's highlight reaches the screen's edges.
    private static let margin: CGFloat = 12

    enum ChannelSheet: Identifiable {
        case info, addMember, pins
        case link(ChannelLinkOut?)  // M15f: add (nil) or edit
        var id: Int { switch self { case .info: 0; case .addMember: 1; case .pins: 2; case .link: 3 } }
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
        Timeline.build(messages, firstUnreadAfterSeq: dividerMark, meId: controller.store.me?.id)
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
        // Under any sheet (the thread, channel info, a message's menu sheets, MainView's search or settings) the list
        // still follows the bottom; rows arriving there are not seen.
        let looking = thread == nil && sheet == nil && scenePhase == .active && !cover.covered
        let visible = looking ? rows.filter { fullyShown(visibleFrames[$0.id]) } : []
        let onScreen = looking ? Set(visibleFrames.compactMap { partlyShown($0.value) ? $0.key : nil }) : []
        var next = anchor
        let seq = next.observe(unreadCount: channel.unreadCount, ready: ReadGate.readRangeReady(channel),
                               firstUnread: ReadGate.firstUnreadRow(rows, afterSeq: channel.lastReadSeq, meId: controller.store.me?.id),
                               visible: visible, onScreenIds: onScreen)
        if next != anchor { anchor = next }
        if send, let seq { controller.engine?.markRead(channelId, seq: seq) }
    }

    /// Back from one of this view's sheets: the rows that arrived under it are judged from the screen once UIKit has
    /// finished taking the sheet away (onDismiss comes while it still counts as covering the list, §10.1 2.-4).
    private func sheetClosed() {
        Task {
            for _ in 0..<20 where cover.covered { try? await Task.sleep(nanoseconds: 100_000_000) }
            markRead()
        }
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
        case .center(let key): proxy.scrollTo(key, anchor: .center)
        case .top(let key):
            // Placed by the landing task; the banner stays hidden meanwhile, so it does not flash.
            if let row = messages.first(where: { $0.rowKey == key }) { anchor.land(on: row) }
            seenSeq = mark // §10.1 7.: 「新着 N 件」 counts every unread row below the divider
        case .bottom:
            proxy.scrollTo("bottom", anchor: .bottom)
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
            proxy.scrollTo(dividerAbove ? TimelineItem.unread.id : landing.rowKey, anchor: .top)
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

    /// M25: while a page of older rows settles, a layout that reports the kept row elsewhere scrolls it back. LazyVStack
    /// places it from the page's estimated heights first; iOS 26 corrects that by itself a pass later, iOS 18 did not
    /// (the rows stayed about a quarter screen off on the simulator). A few times at most, never during a landing.
    private func keepOlderPlace(_ proxy: ScrollViewProxy) {
        guard let kept = frames.kept, frames.keptTries < 4, anchor.landing == nil else { return }
        if let frame = frames.byId[kept.rowId], abs(frame.minY - kept.minY) <= 1 { return }
        frames.keptTries += 1
        proxy.scrollTo(kept.rowKey, anchor: UnitPoint(x: 0, y: kept.anchorY))
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

    /// The rows go in above with the row at the top kept where it is (the onChange of oldestLoadedSeq).
    private func loadOlder() {
        guard !loadingOlder, let engine = controller.engine else { return }
        let window = { (channel?.oldestLoadedSeq, channel?.hasOlder) }
        let before = window()
        loadingOlder = true
        olderStalled = false
        Task {
            await engine.loadOlder(channelId)
            // The page settles (keepOlderPlace), and the next look at the top row waits for the frames of the layout
            // with the page in: the ones from before would still show it on screen and load a page nobody scrolled to.
            try? await Task.sleep(nanoseconds: 300_000_000)
            frames.kept = nil
            loadingOlder = false
            if window() == before { olderStalled = true } else { loadOlderIfShown() }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            if let channel { ChannelLinksRow(controller: controller, channel: channel, onAdd: { sheet = .link(nil) }, onEdit: { sheet = .link($0) }) }  // M15f
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
            ScrollViewReader { proxy in
                GeometryReader { viewport in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            if let channel {
                                if focus == nil, channel.hasOlder, channel.syncedSeq != nil {
                                    // M25: on screen, it loads the page before (loadOlderIfShown). The button stays for
                                    // when that cannot happen by itself: offline, or after a load that brought nothing.
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
                                } else if messages.isEmpty {
                                    ContentUnavailableView("まだメッセージはありません", systemImage: "bubble.left",
                                                           description: Text("最初のメッセージを送ってみましょう。"))
                                        .padding(.top, 40)
                                } else if focus == nil {
                                    ChannelIntroView(controller: controller, channel: channel).padding(.horizontal, Self.margin)
                                }
                            }
                            ForEach(items) { item in
                                switch item {
                                case .date(let label, _):
                                    DaySeparator(label: label).padding(.horizontal, Self.margin)
                                case .unread:
                                    UnreadSeparator().padding(.horizontal, Self.margin).id(item.id)
                                case .message(let message, let compact):
                                    MessageRow(message: message, controller: controller, compact: compact, margin: Self.margin,
                                               highlighted: messageSheet?.kind == .actions && messageSheet?.message.id == message.id,
                                               onOpenThread: { thread = ThreadTarget(id: message.parentId ?? message.id) },
                                               present: { messageSheet = $0 })
                                        .equatable() // unchanged messages skip their body (M20)
                                        .id(message.rowKey)
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
                        .padding(.vertical, 8) // the side margin is each row's (margin)
                        // Exactly as wide as the list: a row wider than the screen made the whole stack wider, and the
                        // scroll view showed it centred, the messages shifted to the left (testers, 2026-09-29).
                        .containerRelativeFrame(.horizontal)
                        .background(ScrollViewProbe.Marker(probe: scroller))
                        .background(StatusBarTapStays())
                    }
                    .coordinateSpace(name: "conversation")
                    .onUserScroll {
                        if !positioned && !messages.isEmpty { userScrolled = true }
                        if anchor.landing != nil { landingInterrupted = true } // never pull the list from under a finger
                        olderStalled = false // M25: the reader scrolled: the top row may try again
                        frames.kept = nil // and the list is theirs
                    }
                    .onScrollMotion { moving in
                        frames.moving = moving
                        if !moving { loadOlderIfShown() } // M25: came to rest, perhaps at the top
                    }
                    .background(CoverProbe.Marker(probe: cover))
                    .modifier(TimelineScrollAnchor(landing: anchor.landing != nil, resizing: resizing))
                    .scrollDismissesKeyboard(.interactively)
                    .dismissesKeyboardOnTap()
                    // The keyboard, the input growing, the typing line: the bottom edge stays (KeyboardBehavior.swift).
                    // Not while the list is being placed or lands on the first unread row (§10.1 4.).
                    .keepsBottomOnResize(enabled: positioned && anchor.landing == nil && focus == nil, atEnd: atBottom, scroller: scroller,
                                         resizing: { resizing = $0 }) { height, atEnd in
                        if atEnd {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        } else if let id = KeyboardBehavior.rowAtBottomEdge(visibleFrames, height: height),
                                  let row = messages.first(where: { $0.id == id }) {
                            proxy.scrollTo(row.rowKey, anchor: .bottom)
                        }
                    }
                    .onPreferenceChange(VisibleMessageFrames.self) { frames in
                        self.frames.byId = frames
                        self.frames.viewportHeight = viewport.size.height
                        keepOlderPlace(proxy)
                        markRead()
                    }
                    .onPreferenceChange(OlderRowFrame.self) { frame in
                        frames.topRow = frame
                        loadOlderIfShown()
                    }
                    .onChange(of: channel?.oldestLoadedSeq) { old, _ in
                        // M25: a page of older rows went in above, in this very update. The list does not keep its place
                        // by itself (LazyVStack's rows moved down by about the page's height), so the row at the top is
                        // scrolled back to where it was, from the frames of the layout before the page, in the same update
                        // (a scroll after it showed the page-sized jump), and again while it settles (keepOlderPlace).
                        // Not during a landing (§10.1 4./6.).
                        guard loadingOlder, anchor.landing == nil else { return }
                        let formerFirst = old.flatMap { seq in messages.first { ($0.seq ?? -1) >= seq } }
                        guard let kept = OlderPaging.keptRow(visibleFrames, rows: messages, viewportHeight: viewportHeight,
                                                             regrouped: formerFirst?.id) else { return }
                        frames.kept = kept
                        frames.keptTries = 0
                        proxy.scrollTo(kept.rowKey, anchor: UnitPoint(x: 0, y: kept.anchorY))
                    }
                    .onChange(of: positioned && anchor.landing == nil && !jumping) { _, ready in
                        if ready { loadOlderIfShown() } // M25: placed, or a landing over, with the top row already on screen
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
                    .onChange(of: controller.engine?.postedHere) { _, id in
                        // A post of mine made through its own endpoint (a poll): shown like one from the outbox, whichever
                        // came first, its response or its event (§10.1 11.).
                        guard let id, positioned, focus == nil, messages.contains(where: { $0.id == id }) else { return }
                        if anchor.landing != nil { anchor.landed() }
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
                        markSeen()
                    }
                    .onChange(of: messages.last?.rowKey) { _, _ in
                        // Arrivals while at the bottom, and my own top-level send from this device, show the newest
                        // message. A landing on the first unread row is not overridden by someone else's arrival.
                        let mine = ReadGate.ownPendingPost(messages.last, meId: controller.store.me?.id)
                        if positioned && focus == nil && (mine || atBottom && anchor.landing == nil) {
                            if mine && anchor.landing != nil { anchor.landed() } // my post wins; it reads the conversation anyway
                            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
                            markSeen()
                        }
                    }
                    .task(id: "\(messages.count):\(channel.map(ReadGate.reachesNewest) ?? false)") { await Task.yield(); position(proxy) }
                    .task(id: focus == nil) {
                        // Opened, or back from the search context: the placement waits for a catch-up at most this long.
                        guard (try? await Task.sleep(nanoseconds: 3_000_000_000)) != nil else { return }
                        syncWaitOver = true
                        position(proxy)
                    }
                    .task(id: anchor.landing) {
                        if let landing = anchor.landing { await land(landing, proxy) }
                    }
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
                } else if !channel.canPostTopLevel(isAdmin: controller.store.me?.role == "admin") {
                    Label("このチャンネルに投稿できるのはオーナーと管理者だけです。スレッドでは返信できます。", systemImage: "megaphone")
                        .font(.footnote).foregroundStyle(.secondary).padding()
                } else {
                    TypingLine(controller: controller, channelId: channelId)
                    ComposerView(channelId: channelId, users: Array(controller.store.users.values), placeholder: "\(channelTitle(channel, store: controller.store)) へメッセージ", controller: controller) { body, attachmentIds, options in
                        Task { await controller.engine?.send(channelId, body: body, attachmentIds: attachmentIds, options: options) }
                    }
                }
            }
        }
        .keepsKeyboardRoomWhileSwipingBack()
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                if let channel {
                    Button { sheet = .info } label: {
                        VStack(spacing: 0) {
                            HStack(spacing: 4) {
                                if isMuted(channel) { Image(systemName: "bell.slash").font(.caption).foregroundStyle(.secondary) }
                                Text(channelTitle(channel, store: controller.store)).font(.headline).lineLimit(1)
                            }
                            if let subtitle = headerSubtitle(channel) {
                                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("チャンネル情報")
                }
            }
            // One ⋯ for the rest (testers, 2026-09-28): four buttons left the channel's name almost no room.
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    if let channel, channel.isMember {
                        let starred = controller.store.isFavorite(channelId)
                        Button(starred ? "お気に入りから外す" : "お気に入りに追加", systemImage: starred ? "star.fill" : "star") {
                            Task { await controller.toggleFavorite(channelId) }
                        }
                        Button("ピン留め", systemImage: "pin") { sheet = .pins }
                        NotificationMenu(controller: controller, channel: channel)
                    }
                    Button("チャンネル情報", systemImage: "info.circle") { sheet = .info }
                } label: {
                    Image(systemName: "ellipsis")
                }
                .accessibilityLabel("チャンネルのメニュー")
            }
        }
        .sheet(item: $sheet, onDismiss: sheetClosed) { which in
            switch which {
            case .info: ChannelInfoView(controller: controller, channelId: channelId)
            case .pins: PinsView(controller: controller, channelId: channelId) { message in
                Task {
                    if await controller.revealMessage(message) {
                        pendingThreadId = message.parentId
                        sheet = nil
                    }
                }
            }
            case .addMember: AddMemberView(controller: controller, channelId: channelId)
            case .link(let link): ChannelLinkEditor(controller: controller, channelId: channelId, link: link)
            }
        }
        .sheet(item: $thread, onDismiss: sheetClosed) { target in ThreadView(controller: controller, channelId: channelId, parentId: target.id) }
        .messageSheets(controller, sheet: $messageSheet, openThread: { thread = ThreadTarget(id: $0.parentId ?? $0.id) },
                       markUnread: markUnreadAction, onClosed: sheetClosed)
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
        return channel.isMember && !channel.channel.archived ? "トピックを設定" : nil
    }
}

/// The channel's notification level plus a timed mute (PUSH_NOTIFICATIONS.md §4), a submenu of the header's ⋯.
struct NotificationMenu: View {
    @Bindable var controller: AppController
    let channel: ChannelState

    private var level: String { channel.channel.notification?.level ?? (channel.channel.isDm ? "all" : "mentions") }
    private var muteLabel: String? { Timeline.muteLabel(channel.channel.notification?.mutedUntil) }
    private var levelName: String {
        switch level {
        case "all": "すべて"
        case "none": "通知しない"
        default: "メンションのみ"
        }
    }

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
            Label(muteLabel.map { "通知 (\($0)までミュート)" } ?? "通知: \(levelName)", systemImage: isMuted(channel) ? "bell.slash" : "bell")
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

/// A conversation list starts at the bottom, a short one sits at the bottom, and size changes keep the bottom where it
/// is, except while a landing scroll is on its way (§10.1 4./6.): LazyVStack settling the heights of the rows below the
/// divider then pulled the list back towards the bottom, and it never landed (2026-09-28, iOS 18–27). Nor while the
/// list's height follows the keyboard frame by frame (iOS 18, KeepsBottom): LazyVStack's re-estimates then passed for
/// the end, and the list went there from the middle of the conversation.
struct TimelineScrollAnchor: ViewModifier {
    let landing: Bool
    var resizing = false

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(.bottom, for: .alignment)
                .defaultScrollAnchor(landing || resizing ? nil : .bottom, for: .sizeChanges)
        } else {
            content.defaultScrollAnchor(landing ? nil : .bottom)
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
        guard !message.pending, let onOpenThread, !KeyboardBehavior.isUp else { return }
        onOpenThread()
    }

    private var senderName: String { store.users[message.senderId]?.displayName ?? (message.pending ? store.me?.displayName ?? "" : "?") }
    /// Why the server refused an unsent message (its outbox row keeps the code), in the shared Japanese words.
    private var failureText: String {
        let code = store.outbox.first { $0.clientMsgId == message.clientMsgId }?.failed
        return code.flatMap { ErrorMessages.byCode[$0] }.map { "送信に失敗しました: \($0)" } ?? "送信に失敗しました"
    }

    /// M15c: in the channel a shared reply names its thread (tap opens it); in the thread it says it was shared.
    @ViewBuilder
    private var replyLine: some View {
        if let onOpenThread {
            let parent = message.parentId.flatMap { store.message(message.channelId, id: $0) }
            let excerpt = parent.map { Timeline.excerpt($0.body, hasAttachments: !$0.attachments.isEmpty, users: store.users, groups: store.groups) }
            Button { onOpenThread() } label: {
                Label("スレッドに返信: \(excerpt ?? "元のメッセージ")", systemImage: "bubble.left").lineLimit(1)
            }
            .buttonStyle(.plain).font(.caption2).foregroundStyle(.secondary)
        } else if message.alsoInChannel {
            Text("チャンネルにも送信済み").font(.caption2).foregroundStyle(.secondary)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if compact {
                // Grouped under the previous message: its time, small, where the avatar would be, so where one message
                // ends and the next begins shows (testers, 2026-09-28; the same on Android and the web).
                Text(Timeline.timeLabel(message.createdAt))
                    .font(.system(size: 10)).monospacedDigit().foregroundStyle(.tertiary)
                    .frame(width: 36, alignment: .center)
                    .padding(.top, 3)
            } else {
                AvatarView(id: message.senderId, name: senderName)
                    .onTapGesture { if !message.pending { show(.profile) } }
            }
            VStack(alignment: .leading, spacing: 2) {
                if message.isReply { replyLine }  // M15c
                if let priority = message.priority { PriorityLabelView(priority: priority) }  // M15e
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
                        if store.users[message.senderId]?.role == "bot" {
                            Text("BOT").font(.caption2).bold().foregroundStyle(.secondary)
                                .padding(.horizontal, 4).padding(.vertical, 1).background(Color.secondary.opacity(0.15)).clipShape(RoundedRectangle(cornerRadius: 3))
                        }
                        StatusEmojiView(user: store.users[message.senderId])
                        Text(Timeline.timeLabel(message.createdAt)).font(.caption).foregroundStyle(.secondary)
                        if message.editedAt != nil {
                            if isMine {
                                Button { show(.revisions) } label: { Text("(編集済み)").font(.caption).underline() }
                                    .buttonStyle(.plain).foregroundStyle(.secondary)
                            } else {
                                Text("(編集済み)").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } else if message.editedAt != nil {
                    Text(Timeline.fullLabel(message.createdAt) + (message.editedAt != nil ? " (編集済み)" : ""))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if !message.body.isEmpty && !PollCardView.hidesBody(message.body, poll: message.poll) {
                    MessageBodyView(text: message.body, users: store.users, groups: store.groups, internalBase: controller.api?.baseUrl,
                                    customEmoji: store.customEmoji, emojiImages: store.emojiImages, emojiAnimations: store.emojiAnimations,
                                    onNeedEmojiImage: { controller.loadEmojiImage($0) })
                        .environment(\.openURL, OpenURLAction { url in
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
                if !message.pending, let link = Links.first(in: message.body), Permalink.messageId(base: controller.api?.baseUrl, url: link) == nil {
                    LinkPreviewCard(controller: controller, url: link)
                }
                if let poll = message.poll { PollCardView(poll: poll, message: message, controller: controller, readOnly: readOnly) }  // M14b
                if message.ackRequested && !message.pending { AckBarView(message: message, controller: controller, readOnly: readOnly) }  // M15e
                if !message.reactions.isEmpty {
                    ChipsLayout(spacing: 6) {
                        ForEach(message.reactions, id: \.emoji) { reaction in
                            let mine = store.me.map { reaction.userIds.contains($0.id) } ?? false
                            Button { Task { await controller.toggleReaction(message, emoji: reaction.emoji) } } label: {
                                if let name = CustomEmoji.name(of: reaction.emoji), let custom = store.customEmoji[name] {
                                    HStack(spacing: 3) {
                                        if let image = store.emojiImages[custom.id] {
                                            EmojiImage(still: image, animation: store.emojiAnimations[custom.id]).frame(height: 16)
                                        } else {
                                            Text(reaction.emoji).font(.caption2).onAppear { controller.loadEmojiImage(custom) }
                                        }
                                        Text("\(reaction.count)").font(.caption)
                                    }
                                } else {
                                    Text("\(reaction.emoji) \(reaction.count)").font(.caption)
                                }
                            }
                            .buttonStyle(.bordered)
                            .tint(mine ? Color.accentColor : Color.secondary)
                            .controlSize(.mini)
                        }
                        // M25: one more reaction right there (Slack; the web's 「＋」): the picker the action sheet's
                        // smiley opens.
                        if !readOnly {
                            Button { show(.reactions) } label: {
                                HStack(spacing: 1) {
                                    Image(systemName: "plus").font(.system(size: 8, weight: .bold))
                                    Image(systemName: "face.smiling").font(.caption)
                                }
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
                    Button { onOpenThread() } label: {
                        Label("\(message.replyCount) 件の返信", systemImage: "bubble.left.and.bubble.right").font(.caption)
                    }
                    .padding(.top, 2)
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
        // Slack: a tap opens the thread (in the channel); the links, buttons, name and pictures in the row keep their
        // own taps.
        .onTapGesture(perform: tapped)
        // M25: VoiceOver has no long press on a row: the same sheet is an action (the actions rotor) of every element
        // of the message, which keeps its own links and buttons. So is the thread a tap opens.
        .accessibilityActions {
            if !message.pending && present != nil {
                Button("メッセージの操作") { openActions(haptic: false) }
            }
            if !message.pending, let onOpenThread {
                Button("スレッドを開く") { onOpenThread() }
            }
        }
    }
}

/// Chips in lines as wide as the row, as many lines as they need. The reactions were an HStack: with many of them it
/// was wider than the screen, the chips squeezed empty and the 「＋」 past the edge, and the list laid every row out as
/// wide as that one, so text near it was cut off at the right (testers, 2026-09-29).
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
            let error = await onSave(trimmed)
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
                    .disabled(saving)
                    .padding()
            }
            .navigationTitle("メッセージを編集")
            .navigationBarTitleDisplayMode(.inline)
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
    var placeholder = "メッセージを入力"
    var controller: AppController? = nil
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
    @State private var showSchedule = false
    @State private var showCustomSchedule = false
    @State private var customSendAt = Date().addingTimeInterval(3600)
    /// M15e: priority and "ask for acknowledgement" for a top-level post; cleared after each send.
    @State private var priority: String?
    @State private var ackRequested = false
    @FocusState private var focused: Bool
    /// The cursor and selection (iOS 18: `TextSelection`), where the formatting and the emoji go.
    @State private var selection = ComposerSelection()

    /// `/st` at the very start offers the slash commands (M13b).
    private var commandHits: [SlashCommands.Command] {
        guard candidates.isEmpty, emojiCandidates.isEmpty else { return [] }
        return SlashCommands.candidates(text)
    }
    private var candidates: [Mentions.Candidate] {
        guard let query = Mentions.query(text) else { return [] }
        return Mentions.candidates(query, users: users, groups: controller.map { Array($0.store.groups.values) } ?? [])
    }
    /// `:tada` completes to an emoji (M11f) when no mention is being typed.
    private var emojiCandidates: [EmojiEntry] {
        guard candidates.isEmpty, let query = Emoji.query(text) else { return [] }
        let names = (controller?.store.customEmoji.keys.sorted() ?? []).filter { $0.hasPrefix(query) || $0.contains(query) }
        let custom = names.prefix(4).map { EmojiEntry(shortcode: $0, glyph: ":\($0):", category: "custom", keywords: $0) }
        return Array((custom + Emoji.candidates(query)).prefix(8))
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSend: Bool { uploading == 0 && (!trimmed.isEmpty || !pending.isEmpty) }
    private var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    private func upload(data: Data, filename: String, contentType: String) async {
        guard let controller else { return }
        let store = controller.store
        guard pending.count < 10 else { controller.error = "添付は10件までです"; return }
        if let tooLarge = controller.attachmentTooLarge(data.count) { controller.error = tooLarge; return }
        if let uploaded = await controller.uploadAttachment(data: data, filename: filename, contentType: contentType) {
            store.setDraft(channelId, parentId: parentId) { $0.attachments.append(uploaded) }
        }
    }

    /// A picked file: checked against the server's size limit first, then streamed from disk (never read whole).
    private func upload(file url: URL) async {
        guard let controller else { return }
        guard pending.count < 10 else { controller.error = "添付は10件までです"; return }
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
        guard at.timeIntervalSinceNow >= 60 else { controller.error = "1 分以上先の時刻を選んでください"; return }
        let body = Mentions.encode(trimmed, users: users, groups: Array(controller.store.groups.values))
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
            if !command.known { controller.error = "/\(command.name) というコマンドはありません (/help で一覧)"; return }
            if command.name == "poll" && command.args.isEmpty {  // the form instead of the syntax
                controller.store.setDraft(channelId, parentId: parentId) { $0.text = "" }
                showPollForm = true
                return
            }
            controller.store.setDraft(channelId, parentId: parentId) { $0.text = "" }
            Task { _ = await controller.runCommand(command, channelId: channelId, parentId: parentId) }
            return
        }
        let body = Mentions.encode(trimmed, users: users, groups: controller.map { Array($0.store.groups.values) } ?? [])
        guard canSend else { return }
        guard body.count <= 20_000, pending.count <= 10 else { controller?.error = "添付は10件、本文は20,000文字までです"; return }
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
        if #available(iOS 18.0, *) {
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
            toolButton("at", label: "メンション") { insert("@") }
            toolButton("face.smiling", label: "絵文字") { showEmojiPicker = true }
            Menu {
                ForEach(ComposerFormat.allCases) { format in
                    Button(format.label, systemImage: format.icon) { apply(format) }
                }
            } label: {
                Image(systemName: "textformat").font(.system(size: 20)).frame(width: 36, height: 36)
            }
            .accessibilityLabel("書式")
            toolButton("clock", label: "後で送信") { showSchedule = true }.disabled(!canSend)
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

    private func toolButton(_ icon: String, label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { Image(systemName: icon).font(.system(size: 20)).frame(width: 36, height: 36) }
            .accessibilityLabel(label)
    }

    private func sendButton(size: CGFloat) -> some View {
        Button(action: send) {
            Image(systemName: "arrow.up.circle.fill").font(.system(size: size)).foregroundStyle(Color.accentColor)
        }
        .accessibilityLabel("送信")
    }

    /// The cursor or selection as character offsets (iOS 18 reports it; before, the end of the text).
    private func selectedRange() -> Range<Int> {
        let end = text.count
        if #available(iOS 18.0, *), let current = selection.raw(for: text) as? TextSelection, case .selection(let range) = current.indices {
            func offset(_ index: String.Index) -> Int {
                let utf16 = min(max(0, index.utf16Offset(in: text)), text.utf16.count)
                return text[..<String.Index(utf16Offset: utf16, in: text)].count
            }
            let lower = offset(range.lowerBound), upper = offset(range.upperBound)
            return min(lower, upper)..<max(lower, upper)
        }
        return end..<end
    }

    private func setText(_ value: String, selecting range: Range<Int>) {
        textBinding.wrappedValue = value
        if #available(iOS 18.0, *) {
            let lower = value.index(value.startIndex, offsetBy: min(range.lowerBound, value.count))
            let upper = value.index(value.startIndex, offsetBy: min(range.upperBound, value.count))
            selection.raw = lower == upper ? TextSelection(insertionPoint: lower) : TextSelection(range: lower..<upper)
            selection.text = value
        }
        focused = true
    }

    /// Text at the cursor, in place of the selection (the end of the text before iOS 18).
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
            PendingAttachmentsView(items: pending, uploading: uploading, controller: controller) { item in
                controller?.store.setDraft(channelId, parentId: parentId) { $0.attachments.removeAll { $0.id == item.id } }
            }
            .confirmationDialog("後で送信", isPresented: $showSchedule, titleVisibility: .visible) {
                ForEach(Schedule.presets()) { preset in
                    Button("\(preset.label) (\(Schedule.label(preset.at)))") { schedule(preset.at) }
                }
                Button("日時を指定…") { customSendAt = Date().addingTimeInterval(3600); showCustomSchedule = true }
            }
            .sheet(isPresented: $showCustomSchedule) {
                NavigationStack {
                    Form {
                        DatePicker("送信日時", selection: $customSendAt, in: Date().addingTimeInterval(60)..., displayedComponents: [.date, .hourAndMinute])
                        Text(Schedule.label(customSendAt) + " に送信します").font(.footnote).foregroundStyle(.secondary)
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
            if !emojiCandidates.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(emojiCandidates, id: \.shortcode) { entry in
                            Button { textBinding.wrappedValue = Emoji.complete(text, glyph: entry.glyph) } label: {
                                Text(entry.glyph) + Text("  :\(entry.shortcode):").foregroundStyle(.secondary)
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
            if !commandHits.isEmpty {
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
        // The picker is presented from the composer itself; a PhotosPicker inside a Menu never opens.
        .sheet(isPresented: $showEmojiPicker) {
            EmojiPickerView(custom: controller.map { Array($0.store.customEmoji.values) } ?? [], images: controller?.store.emojiImages ?? [:],
                            animations: controller?.store.emojiAnimations ?? [:],
                            onNeedImage: { emoji in controller?.loadEmojiImage(emoji) }) { glyph in insert(glyph) }
        }
        .sheet(isPresented: $showPollForm) {
            if let controller { PollFormView(controller: controller, channelId: channelId, parentId: parentId) }
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
                            controller?.error = "動画を読み込めませんでした"
                            continue
                        }
                        await upload(video: movie.url)
                        continue
                    }
                    // Library photos are mostly HEIC: re-encoded as JPEG like the camera's, or the server keeps no thumbnail.
                    guard let data = try? await item.loadTransferable(type: Data.self), let photo = ImageUpload.prepare(data) else { continue }
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
}


/// Row frames and the viewport's height, kept out of view state (ChannelView.frames).
final class RowFrames {
    var byId: [String: CGRect] = [:]
    var viewportHeight: CGFloat = 0
    /// M25: the progress row at the top of the loaded range, whether the list is moving, and the row kept in place while
    /// a page of older rows settles (OlderPaging).
    var topRow: CGRect?
    var moving = false
    var kept: OlderPaging.Kept?
    var keptTries = 0
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

/// The composer's cursor and selection: a `TextSelection?` from iOS 18, kept untyped so the view builds for iOS 17.
final class ComposerSelection {
    var raw: Any?
    /// The text the selection belongs to. Its indices are only good for that text: after a send cleared the input,
    /// an emoji chosen from the picker went in at an index past the end and the app crashed (testers, 2026-09-29).
    var text: String?

    /// The selection when it still belongs to `current`, else nil.
    func raw(for current: String) -> Any? { text == current ? raw : nil }
}

/// The input with its selection reported (iOS 18), for the formatting menu and inserting at the cursor.
@available(iOS 18.0, *)
private struct SelectingTextField: View {
    let placeholder: String
    let text: Binding<String>
    let box: ComposerSelection

    var body: some View {
        TextField(placeholder, text: text, selection: Binding(get: { box.raw(for: text.wrappedValue) as? TextSelection },
                                                              set: { box.raw = $0; box.text = text.wrappedValue }), axis: .vertical)
    }
}
