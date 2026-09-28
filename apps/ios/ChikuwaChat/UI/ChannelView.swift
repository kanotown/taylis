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
    /// §10.1: the first unread row has been on screen with every unread row held; only then do visible rows mark read.
    @State private var anchor = ReadAnchor()
    /// 「最初の未読へ」 is loading the rows above the window.
    @State private var jumping = false
    /// The reader dragged the list before it was placed: it is left where it is.
    @State private var userScrolled = false
    /// The catch-up the placement waits for did not come (a failed request while online): place with the rows held.
    @State private var syncWaitOver = false
    @State private var cover = CoverProbe()

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
        for _ in 0..<3 {
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

    /// 「ここから未読にする」 for a row, when it is offered (§10.1 10.).
    private func markUnreadAction(_ message: MessageState) -> (() -> Void)? {
        guard let seq = message.seq, let channel, ReadGate.markUnreadOffered(channel, seq: seq) else { return nil }
        return {
            if let held = controller.engine?.markUnread(channelId, seq: seq) { unreadMark = held }
        }
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
                                    ChannelIntroView(controller: controller, channel: channel)
                                }
                            }
                            ForEach(items) { item in
                                switch item {
                                case .date(let label, _):
                                    DaySeparator(label: label)
                                case .unread:
                                    UnreadSeparator().id(item.id)
                                case .message(let message, let compact):
                                    MessageRow(message: message, controller: controller, compact: compact,
                                               onOpenThread: { thread = ThreadTarget(id: message.parentId ?? message.id) },
                                               onMarkUnread: markUnreadAction(message))
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
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                    }
                    .coordinateSpace(name: "conversation")
                    .onUserScroll { if !positioned && !messages.isEmpty { userScrolled = true } }
                    .background(CoverProbe.Marker(probe: cover))
                    .modifier(TimelineScrollAnchor(landing: anchor.landing != nil))
                    .scrollDismissesKeyboard(.interactively)
                    .dismissesKeyboardOnTap()
                    // The keyboard, the input growing, the typing line: the bottom edge stays (KeyboardBehavior.swift).
                    // Not while the list is being placed or lands on the first unread row (§10.1 4.).
                    .keepsBottomOnResize(enabled: positioned && anchor.landing == nil && focus == nil, atEnd: atBottom) { height, atEnd in
                        if atEnd {
                            proxy.scrollTo("bottom", anchor: .bottom)
                        } else if let id = KeyboardBehavior.rowAtBottomEdge(visibleFrames, height: height),
                                  let row = messages.first(where: { $0.id == id }) {
                            proxy.scrollTo(row.rowKey, anchor: .bottom)
                        }
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
                    .onChange(of: controller.engine?.status) { _, _ in markRead() }
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
        .onChange(of: pendingThreadId, initial: true) { _, id in
            if let id {
                thread = ThreadTarget(id: id)
                pendingThreadId = nil
            }
        }
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
/// divider then pulled the list back towards the bottom, and it never landed (2026-09-28, iOS 18–27).
struct TimelineScrollAnchor: ViewModifier {
    let landing: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                .defaultScrollAnchor(.bottom, for: .alignment)
                .defaultScrollAnchor(landing ? nil : .bottom, for: .sizeChanges)
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

let reactionPalette = ["👍", "❤️", "😂", "🎉", "👀"]

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
    @State private var showingProfile = false
    @State private var pickingReaction = false
    @State private var sharing = false
    @State private var showingRevisions = false

    private var store: Store { controller.store }
    private var engine: SyncEngine? { controller.engine }
    private var isMine: Bool { store.me?.id == message.senderId }
    /// A menu action that changes this row (a reaction, a pin, the saved mark) lands once the long-press menu has
    /// closed: the menu flies its picture of the row back into place, and a row that had grown meanwhile was drawn
    /// over its neighbour for a moment (testers, 2026-09-28).
    private func afterMenu(_ work: @escaping @MainActor () async -> Void) {
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 450_000_000)
            await work()
        }
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
                    .onTapGesture { if !message.pending { showingProfile = true } }
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
                        Text(senderName).bold().onTapGesture { if !message.pending { showingProfile = true } }
                        if store.users[message.senderId]?.role == "bot" {
                            Text("BOT").font(.caption2).bold().foregroundStyle(.secondary)
                                .padding(.horizontal, 4).padding(.vertical, 1).background(Color.secondary.opacity(0.15)).clipShape(RoundedRectangle(cornerRadius: 3))
                        }
                        StatusEmojiView(user: store.users[message.senderId])
                        Text(Timeline.timeLabel(message.createdAt)).font(.caption).foregroundStyle(.secondary)
                        if message.editedAt != nil {
                            if isMine {
                                Button { showingRevisions = true } label: { Text("(編集済み)").font(.caption).underline() }
                                    .buttonStyle(.plain).foregroundStyle(.secondary)
                            } else {
                                Text("(編集済み)").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                } else if showTime || message.editedAt != nil {
                    Text(Timeline.fullLabel(message.createdAt) + (message.editedAt != nil ? " (編集済み)" : ""))
                        .font(.caption2).foregroundStyle(.secondary)
                }
                if !message.body.isEmpty {
                    MessageBodyView(text: message.body, users: store.users, groups: store.groups, internalBase: controller.api?.baseUrl,
                                    customEmoji: store.customEmoji, emojiImages: store.emojiImages, onNeedEmojiImage: { controller.loadEmojiImage($0) })
                        .environment(\.openURL, OpenURLAction { url in
                            guard url.scheme == Permalink.scheme, let id = url.host else { return .systemAction }
                            Task { await controller.openPermalink(id) }
                            return .handled
                        })
                }
                if !message.attachments.isEmpty { AttachmentsView(attachments: message.attachments, controller: controller) }
                if !message.pending, let link = Links.first(in: message.body), Permalink.messageId(base: controller.api?.baseUrl, url: link) == nil {
                    LinkPreviewCard(controller: controller, url: link)
                }
                if let poll = message.poll { PollCardView(poll: poll, message: message, controller: controller) }  // M14b
                if message.ackRequested && !message.pending { AckBarView(message: message, controller: controller) }  // M15e
                if !message.reactions.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(message.reactions, id: \.emoji) { reaction in
                            let mine = store.me.map { reaction.userIds.contains($0.id) } ?? false
                            Button { Task { await controller.toggleReaction(message, emoji: reaction.emoji) } } label: {
                                if let name = CustomEmoji.name(of: reaction.emoji), let custom = store.customEmoji[name] {
                                    HStack(spacing: 3) {
                                        if let image = store.emojiImages[custom.id] {
                                            Image(uiImage: image).resizable().scaledToFit().frame(height: 16)
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
                        Text(failureText).font(.caption).foregroundStyle(.red)
                        Button("再送") { Task { await engine?.retryFailed() } }.font(.caption)
                        Button("破棄", role: .destructive) { if let key = message.clientMsgId { engine?.discardFailed(key) } }.font(.caption)
                    }
                }
            }
        }
        .padding(.vertical, compact ? 4 : 5)
        .opacity(message.pending && !message.failed ? 0.6 : 1)
        .background(controller.messageFocus?.messageId == message.id ? Color.yellow.opacity(0.18) : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture { if compact { showTime.toggle() } }
        .contextMenu {
            if !message.pending {
                ControlGroup {
                    ForEach(reactionPalette, id: \.self) { emoji in
                        Button(emoji) { afterMenu { await controller.toggleReaction(message, emoji: emoji) } }
                    }
                    Button("その他のリアクション", systemImage: "face.smiling") { pickingReaction = true }
                }
                .controlGroupStyle(.palette)
                .menuActionDismissBehavior(.enabled) // a palette keeps the menu open otherwise
                if let onOpenThread { Button("スレッドで返信", systemImage: "bubble.left.and.bubble.right") { onOpenThread() } }
                if isMine { Button("編集", systemImage: "pencil") { editing = true } }
                if !message.body.isEmpty {
                    Button("テキストをコピー", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = Mentions.decode(message.body, users: store.users, groups: store.groups)
                    }
                }
                Button(store.isBookmarked(message.id) ? "保存を解除" : "あとで見る (保存)", systemImage: store.isBookmarked(message.id) ? "bookmark.slash" : "bookmark") {
                    afterMenu { await controller.toggleBookmark(message.id) }
                }
                Button(message.pinnedAt != nil ? "ピン留めを外す" : "チャンネルにピン留め", systemImage: message.pinnedAt != nil ? "pin.slash" : "pin") {
                    afterMenu { await controller.togglePin(message) }
                }
                Button("リンクをコピー", systemImage: "link") { controller.copyPermalink(message.id) }
                Button("別のチャンネルに共有…", systemImage: "arrowshape.turn.up.right") { sharing = true }
                Menu("リマインド", systemImage: "alarm") {
                    ForEach(Schedule.reminderPresets()) { preset in
                        Button("\(preset.label) (\(Schedule.label(preset.at)))") { Task { _ = await controller.setReminder(messageId: message.id, at: preset.at) } }
                    }
                }
                if let onMarkUnread { Button("ここから未読にする", systemImage: "envelope.badge") { onMarkUnread() } }
                if isMine || controller.isAdmin { Button("削除", systemImage: "trash", role: .destructive) { confirmingDelete = true } }
            }
        }
        .sheet(isPresented: $pickingReaction) {
            EmojiPickerView(custom: Array(store.customEmoji.values), images: store.emojiImages, onNeedImage: { controller.loadEmojiImage($0) }) { glyph in Task { await controller.toggleReaction(message, emoji: glyph) } }
        }
        .sheet(isPresented: $sharing) { ShareMessageSheet(controller: controller, message: message) }
        .sheet(isPresented: $showingRevisions) { RevisionsView(controller: controller, message: message) }
        .sheet(isPresented: $showingProfile) {
            ProfileSheet(controller: controller, userId: message.senderId) { id in
                NotificationCenter.default.post(name: .chikuwaOpenChannel, object: nil, userInfo: ["id": id])
            }
        }
        .sheet(isPresented: $editing) {
            EditMessageView(initial: Mentions.decode(message.body, users: store.users, groups: store.groups)) { body in
                Task { await controller.editMessage(message.id, body: Mentions.encode(body, users: store.users.values, groups: Array(store.groups.values))) }
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
    @State private var showSchedule = false
    @State private var showCustomSchedule = false
    @State private var customSendAt = Date().addingTimeInterval(3600)
    /// M15e: priority and "ask for acknowledgement" for a top-level post; cleared after each send.
    @State private var priority: String?
    @State private var ackRequested = false
    @FocusState private var focused: Bool

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

    var body: some View {
        VStack(spacing: 0) {
            Divider()
            PendingAttachmentsView(items: pending) { item in
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
            HStack(alignment: .bottom, spacing: 8) {
                if controller != nil {
                    // "+" like Slack / Mattermost: photos, camera and files from one place.
                    Menu {
                        Button("写真ライブラリ", systemImage: "photo.on.rectangle") { showPhotoPicker = true }
                        if cameraAvailable { Button("カメラ", systemImage: "camera") { showCamera = true } }
                        Button("ファイル", systemImage: "folder") { showFileImporter = true }
                        Button("絵文字", systemImage: "face.smiling") { showEmojiPicker = true }
                        Divider()
                        Button("後で送信…", systemImage: "clock") { showSchedule = true }.disabled(!canSend)
                        if parentId == nil {
                            Divider()
                            Picker("重要度", selection: $priority) {
                                Text("通常").tag(String?.none)
                                Label("重要", systemImage: "info.circle").tag(String?.some("important"))
                                Label("緊急", systemImage: "exclamationmark.triangle").tag(String?.some("urgent"))
                            }
                            Toggle("確認を求める", systemImage: "checkmark.circle", isOn: $ackRequested)
                        }
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
        .sheet(isPresented: $showEmojiPicker) {
            EmojiPickerView(custom: controller.map { Array($0.store.customEmoji.values) } ?? [], images: controller?.store.emojiImages ?? [:],
                            onNeedImage: { emoji in controller?.loadEmojiImage(emoji) }) { glyph in textBinding.wrappedValue = text + glyph }
        }
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItems, maxSelectionCount: 5, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            controller?.store.trackUpload(channelId, parentId: parentId, delta: 1)
            Task {
                defer { controller?.store.trackUpload(channelId, parentId: parentId, delta: -1) }
                for item in items {
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


extension Notification.Name {
    /// A profile card asked to open a conversation (userInfo["id"] = channel id).
    static let chikuwaOpenChannel = Notification.Name("chikuwa.openChannel")
}
