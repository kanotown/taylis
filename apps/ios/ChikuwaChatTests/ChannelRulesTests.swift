import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

final class ChannelRulesTests: XCTestCase {
    private func channel(_ id: String, type: String = "public", unread: Int = 0, mentions: Int = 0,
                         level: String? = nil, mutedUntil: String? = nil) -> ChannelState {
        let out = ChannelOut(id: id, type: type, name: id, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: nil, dmUserIds: nil, readState: nil,
                             notification: level.map { NotificationPreferenceOut(channelId: id, level: $0, mutedUntil: mutedUntil) })
        return ChannelState(channel: out, isMember: true, syncedSeq: nil, lastSeq: 0, lastReadSeq: 0, unreadCount: unread, mentionCount: mentions, hasOlder: true)
    }

    /// The preview of a channel I have not joined (M27): an archived one (an `is:times` hit) offers no 「参加する」.
    func testPreviewOffersJoiningOnlyWhenNotArchived() {
        var out = channel("times-alice").channel
        XCTAssertTrue(PreviewJoin.canJoin(out))
        out.archived = true
        XCTAssertFalse(PreviewJoin.canJoin(out))
        XCTAssertEqual(PreviewJoin.archivedNote, "アーカイブされたチャンネルです (読むだけ)")
    }

    func testMutedChannelsCountOnlyMentions() {
        let muted = channel("a", unread: 5, level: "none")
        XCTAssertTrue(muted.isMuted)
        XCTAssertFalse(muted.hasUnread(meId: nil))
        XCTAssertEqual(muted.badgeContribution, 0)
        let future = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
        let mentioned = channel("b", unread: 5, mentions: 2, level: "mentions", mutedUntil: future)
        XCTAssertTrue(mentioned.isMuted)
        XCTAssertTrue(mentioned.hasUnread(meId: nil))
        XCTAssertEqual(mentioned.badgeContribution, 2)
        let expired = channel("c", unread: 1, level: "mentions", mutedUntil: "2020-01-01T00:00:00Z")
        XCTAssertFalse(expired.isMuted)
        XCTAssertTrue(expired.hasUnread(meId: nil))
        XCTAssertEqual(channel("d", type: "dm", unread: 3).badgeContribution, 3)
    }

    // MARK: M35 the overall setting and 「ミュート」

    /// PUSH_NOTIFICATIONS.md §4's table, and a level of its own beating it.
    func testPushLevelFollowsTheResolutionTable() {
        let table: [(overall: String, dm: String, othersTimes: String, other: String)] = [
            ("all", "all", "mentions", "all"),
            ("mentions", "all", "mentions", "mentions"),
            ("none", "none", "none", "none"),
        ]
        for row in table {
            XCTAssertEqual(NotificationRules.pushLevel(own: nil, isDm: true, othersTimes: false, overall: row.overall), row.dm, row.overall)
            XCTAssertEqual(NotificationRules.pushLevel(own: nil, isDm: false, othersTimes: true, overall: row.overall), row.othersTimes, row.overall)
            XCTAssertEqual(NotificationRules.pushLevel(own: nil, isDm: false, othersTimes: false, overall: row.overall), row.other, row.overall)
            for own in ["all", "mentions", "none"] {
                XCTAssertEqual(NotificationRules.pushLevel(own: own, isDm: true, othersTimes: false, overall: row.overall), own)
                XCTAssertEqual(NotificationRules.pushLevel(own: own, isDm: false, othersTimes: true, overall: row.overall), own)
            }
        }
        // Through a channel: a group DM is a DM, my own times is an ordinary channel, a missing preference follows.
        XCTAssertEqual(channel("g", type: "group_dm").pushLevel(overall: "mentions", meId: "me"), "all")
        var times = channel("t")
        times.channel.timesOwnerId = "me"
        XCTAssertEqual(times.pushLevel(overall: "all", meId: "me"), "all")
        times.channel.timesOwnerId = "someone"
        XCTAssertEqual(times.pushLevel(overall: "all", meId: "me"), "mentions")
        times.channel.notification = NotificationPreferenceOut(channelId: "t", level: "all", mutedUntil: nil, followsDefault: false)
        XCTAssertEqual(times.pushLevel(overall: "none", meId: "me"), "all")
        // Following the default: the level the server resolved then is not used, the overall setting held now is.
        times.channel.notification = NotificationPreferenceOut(channelId: "t", level: "mentions", mutedUntil: nil, followsDefault: true)
        XCTAssertEqual(times.pushLevel(overall: "none", meId: "me"), "none")
    }

    func testOwnLevelAndMuteComeFromThePreference() {
        var row = channel("a", unread: 4, mentions: 1)
        XCTAssertNil(row.ownNotificationLevel)  // no preference yet
        row.channel.notification = NotificationPreferenceOut(channelId: "a", level: "none", mutedUntil: nil, followsDefault: true)
        XCTAssertNil(row.ownNotificationLevel)
        XCTAssertFalse(row.isMuted, "overall none resolves to none, but the overall setting never mutes")
        XCTAssertEqual(row.badgeContribution, 1)
        row.channel.notification = NotificationPreferenceOut(channelId: "a", level: "none", mutedUntil: nil, followsDefault: false)
        XCTAssertEqual(row.ownNotificationLevel, "none")
        XCTAssertTrue(row.isMuted)
        row.channel.notification = NotificationPreferenceOut(channelId: "a", level: "all", mutedUntil: nil, followsDefault: false, muted: true)
        XCTAssertTrue(row.isMuted)
        XCTAssertTrue(row.hasUnread(meId: "me"))  // the mention
        row.mentionCount = 0
        XCTAssertFalse(row.hasUnread(meId: "me"))
        // Muted someone else's times is muted, not quiet.
        row.channel.timesOwnerId = "someone"
        XCTAssertFalse(row.isQuiet(meId: "me"))
        // Old servers and rows stored before M35: the reported level is the channel's own.
        row.channel.notification = NotificationPreferenceOut(channelId: "a", level: "mentions", mutedUntil: nil)
        XCTAssertEqual(row.ownNotificationLevel, "mentions")
        XCTAssertFalse(row.channel.notification!.followsDefault)
    }

    func testPreferencesDecodeWithAndWithoutTheM35Fields() throws {
        let old = try JSON.snakeDecoder.decode(NotificationPreferenceOut.self, from: Data(#"{"channel_id":"c","level":"none","muted_until":null}"#.utf8))
        XCTAssertEqual(old.level, "none")
        XCTAssertNil(old.reportedFollowsDefault)
        XCTAssertFalse(old.muted)
        XCTAssertEqual(old.ownLevel, "none")
        let noUntil = try JSON.snakeDecoder.decode(NotificationPreferenceOut.self, from: Data(#"{"channel_id":"c","level":"all"}"#.utf8))
        XCTAssertNil(noUntil.mutedUntil)
        let new = try JSON.snakeDecoder.decode(NotificationPreferenceOut.self, from: Data(
            #"{"channel_id":"c","level":"mentions","muted_until":"2026-10-01T00:00:00Z","follows_default":true,"muted":true}"#.utf8))
        XCTAssertEqual(new.reportedFollowsDefault, true)
        XCTAssertNil(new.ownLevel)
        XCTAssertTrue(new.muted)
        XCTAssertEqual(new.mutedUntil, "2026-10-01T00:00:00Z")
        // Stored with the plain coders (the local database): both shapes survive the round trip.
        for pref in [old, new] {
            XCTAssertEqual(try JSON.plainDecoder.decode(NotificationPreferenceOut.self, from: JSON.plainEncoder.encode(pref)), pref)
        }
        // UserMe: the overall setting, "mentions" when a server before M35 leaves it out.
        let me = #"{"id":"u","username":"bob","display_name":"Bob","role":"member","deactivated_at":null,"created_at":"","updated_at":"","email":null,"must_change_password":false"#
        XCTAssertEqual(try JSON.snakeDecoder.decode(UserMe.self, from: Data((me + "}").utf8)).overallNotification, "mentions")
        XCTAssertEqual(try JSON.snakeDecoder.decode(UserMe.self, from: Data((me + #","notification_default":"none"}"#).utf8)).overallNotification, "none")
    }

    /// MOBILE_POLISH.md D1: the channel details' one 「通知」 row.
    func testTheNotificationRowValue() {
        XCTAssertEqual(NotificationRules.rowValue(level: "all", muted: false, timedMute: nil), "すべて")
        XCTAssertEqual(NotificationRules.rowValue(level: "mentions", muted: false, timedMute: nil), "メンション")
        XCTAssertEqual(NotificationRules.rowValue(level: "none", muted: false, timedMute: nil), "なし")
        XCTAssertEqual(NotificationRules.rowValue(level: "mentions", muted: true, timedMute: "15:30 までミュート"), "メンション · ミュート")
        XCTAssertEqual(NotificationRules.rowValue(level: "all", muted: false, timedMute: "15:30 までミュート"), "すべて · 15:30 までミュート")
    }

    func testTheNotificationMenuLabel() {
        XCTAssertEqual(NotificationRules.menuLabel(level: "all", muted: false, timedMute: nil), "通知: すべて")
        XCTAssertEqual(NotificationRules.menuLabel(level: "mentions", muted: false, timedMute: "15:30 までミュート"), "通知 (15:30 までミュート)")
        XCTAssertEqual(NotificationRules.menuLabel(level: "none", muted: true, timedMute: "15:30 までミュート"), "通知: ミュート中")
        XCTAssertEqual(NotificationRules.overallLabel("mentions"), "メンションと DM のみ")
    }

    func testAnnouncementChannelsLetOwnersAndAdminsPost() {  // M15a
        var announce = channel("a")
        XCTAssertTrue(announce.canPostTopLevel(isAdmin: false))
        announce.channel.postingPolicy = "owners"
        announce.channel.membership = MembershipOut(role: "member", joinedAt: "")
        XCTAssertFalse(announce.canPostTopLevel(isAdmin: false))
        XCTAssertTrue(announce.canPostTopLevel(isAdmin: true))
        announce.channel.membership = MembershipOut(role: "owner", joinedAt: "")
        XCTAssertTrue(announce.canPostTopLevel(isAdmin: false))
    }

    // MARK: times and quiet unread (M24, SYNC_PROTOCOL.md §10.5)

    /// One case of apps/shared/unread-rules.json.
    private struct UnreadCase: Decodable {
        struct Expect: Decodable { let hasUnread: Bool; let badge: Int; let quiet: Bool }
        let name: String
        let type: String
        let times: String?
        let level: String?
        let muted: Bool
        let unread: Int
        let mentions: Int
        let expect: Expect
    }

    func testUnreadRulesFollowTheSharedVectors() throws {
        // The repository's own file (the simulator reads the Mac's disk), which the server and desktop tests read too.
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/unread-rules.json")
        struct Vectors: Decodable { let cases: [UnreadCase] }
        let cases = try JSON.snakeDecoder.decode(Vectors.self, from: Data(contentsOf: url)).cases
        XCTAssertGreaterThanOrEqual(cases.count, 11)
        let now = try XCTUnwrap(parseIsoDate("2026-09-26T12:00:00Z"))
        for c in cases {
            var row = channel("c", type: c.type, unread: c.unread, mentions: c.mentions)
            row.channel.timesOwnerId = c.times == "mine" ? "me" : c.times == "others" ? "someone" : nil
            // M35: without a level of its own the server reports the one resolved from the overall setting (any of them:
            // the rules must not look at it) with follows_default; muted is either mute (until unmuted, or timed).
            for overall in ["all", "mentions", "none"] {
                let resolved = row.pushLevel(overall: overall, meId: "me")
                for timed in [false, true] {
                    row.channel.notification = NotificationPreferenceOut(
                        channelId: "c", level: c.level ?? resolved, mutedUntil: c.muted && timed ? "2026-09-27T00:00:00Z" : nil,
                        followsDefault: c.level == nil, muted: c.muted && !timed)
                    let label = "\(c.name) (overall \(overall), \(timed ? "timed" : "until unmuted"))"
                    XCTAssertEqual(row.hasUnread(meId: "me", now: now), c.expect.hasUnread, label)
                    XCTAssertEqual(row.badgeContribution(now: now), c.expect.badge, label)
                    XCTAssertEqual(row.isQuiet(meId: "me", now: now), c.expect.quiet, label)
                }
            }
            // A server before M35 (no follows_default): the level it reported, the type's default when none was set,
            // counted as the channel's own gives the same answers.
            row.channel.notification = NotificationPreferenceOut(channelId: "c", level: c.level ?? (row.channel.isDm ? "all" : "mentions"),
                                                                mutedUntil: c.muted ? "2026-09-27T00:00:00Z" : nil)
            XCTAssertEqual(row.hasUnread(meId: "me", now: now), c.expect.hasUnread, c.name)
            XCTAssertEqual(row.badgeContribution(now: now), c.expect.badge, c.name)
            XCTAssertEqual(row.isQuiet(meId: "me", now: now), c.expect.quiet, c.name)
            // A channel joined since bootstrap has no preference yet: the same answers.
            guard c.level == nil, !c.muted else { continue }
            row.channel.notification = nil
            XCTAssertEqual(row.hasUnread(meId: "me", now: now), c.expect.hasUnread, c.name)
            XCTAssertEqual(row.badgeContribution(now: now), c.expect.badge, c.name)
            XCTAssertEqual(row.isQuiet(meId: "me", now: now), c.expect.quiet, c.name)
        }
    }

    func testTimesGetTheirOwnSectionMineFirst() {
        var all = [channel("general"), channel("times-zed"), channel("times-me"), channel("times-amy", unread: 3), channel("times-bob", unread: 2, mentions: 1)]
        for (index, owner) in [(1, "zed"), (2, "me"), (3, "amy"), (4, "bob")] { all[index].channel.timesOwnerId = owner }
        let sections = ChannelListView.channelSections(all, meId: "me") { _ in true }
        XCTAssertEqual(sections.channels.map(\.id), ["general"])
        XCTAssertEqual(sections.times.map(\.id), ["times-me", "times-amy", "times-bob", "times-zed"])
        // The unread filter: amy's quiet unread stays out, bob's mention does not.
        let unread = ChannelListView.channelSections(all, meId: "me") { $0.hasUnread(meId: "me") }
        XCTAssertEqual(unread.times.map(\.id), ["times-bob"])
        // Someone else's times at level all is an ordinary channel again.
        all[3].channel.notification = NotificationPreferenceOut(channelId: "times-amy", level: "all", mutedUntil: nil)
        XCTAssertEqual(ChannelListView.channelSections(all, meId: "me") { $0.hasUnread(meId: "me") }.times.map(\.id), ["times-amy", "times-bob"])
    }

    func testAFoldedSectionKeepsUnreadAndTheOpenConversation() {  // M26 (Slack)
        var muted = channel("muted", unread: 3)
        muted.channel.notification = NotificationPreferenceOut(channelId: "muted", level: "none", mutedUntil: nil)
        let rows = [channel("read"), channel("unread", unread: 2), channel("open"), channel("dm", type: "dm", unread: 1), muted]
        XCTAssertEqual(ChannelListView.shown(rows, collapsed: false, meId: "me", selection: nil).map(\.id), rows.map(\.id))
        // A muted conversation with posts but no mention is not unread, so it folds away too.
        XCTAssertEqual(ChannelListView.shown(rows, collapsed: true, meId: "me", selection: "open").map(\.id), ["unread", "open", "dm"])
    }

    func testDefaultSectionsFoldOnThisDevice() {  // M26
        var raw = ""
        XCTAssertEqual(ChannelListView.foldedKeys(raw), [])
        raw = ChannelListView.toggledFold(raw, key: "dms")
        raw = ChannelListView.toggledFold(raw, key: "channels")
        XCTAssertEqual(raw, "channels dms")
        XCTAssertEqual(ChannelListView.foldedKeys(raw), ["channels", "dms"])
        raw = ChannelListView.toggledFold(raw, key: "dms")
        XCTAssertEqual(ChannelListView.foldedKeys(raw), ["channels"])
        XCTAssertEqual(ChannelListView.toggledFold(raw, key: "channels"), "")
    }

    /// `times_owner_id` from the wire; older servers omit it, and channels persisted before M24 lack it.
    func testTimesOwnerDecodesWithAndWithoutTheField() throws {
        let wire = { (extra: String) in
            Data(#"""
            {"id": "c1", "type": "public", "name": "times-kano", "topic": null, "purpose": null, "archived": false, "created_by": "u1",
             "last_seq": 3, "last_message_at": null, "created_at": "", "updated_at": "", "membership": {"role": "owner", "joined_at": ""},
             "dm_user_ids": null\#(extra)}
            """#.utf8)
        }
        let times = try JSON.snakeDecoder.decode(ChannelOut.self, from: wire(#", "times_owner_id": "u1""#))
        XCTAssertEqual(times.timesOwnerId, "u1")
        XCTAssertTrue(times.isTimes)
        let older = try JSON.snakeDecoder.decode(ChannelOut.self, from: wire(""))
        XCTAssertNil(older.timesOwnerId)
        XCTAssertFalse(older.isTimes)
        XCTAssertNil(try JSON.snakeDecoder.decode(ChannelOut.self, from: wire(#", "times_owner_id": null"#)).timesOwnerId)

        let state = ChannelState(channel: times, isMember: true, syncedSeq: 3, lastSeq: 3, hasOlder: false)
        let persisted = try JSON.plainEncoder.encode(state)
        XCTAssertEqual(try JSON.plainDecoder.decode(ChannelState.self, from: persisted).channel.timesOwnerId, "u1")
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: persisted) as? [String: Any])
        var legacyChannel = try XCTUnwrap(legacy["channel"] as? [String: Any])
        XCTAssertNotNil(legacyChannel.removeValue(forKey: "timesOwnerId"))
        legacy["channel"] = legacyChannel
        let restored = try JSON.plainDecoder.decode(ChannelState.self, from: JSONSerialization.data(withJSONObject: legacy))
        XCTAssertNil(restored.channel.timesOwnerId)
        XCTAssertEqual(restored.channel.name, "times-kano")
    }
}

/// Renders the channel list with a Times section: mine first, a quiet row, a mentioned row and one at level all;
/// then without a times of mine (the row to make one). Writes PNGs when SNAPSHOT_DIR is set
/// (`TEST_RUNNER_SNAPSHOT_DIR=/path xcodebuild test …`).
@MainActor
final class TimesSnapshotTests: XCTestCase {
    private func render<V: View>(_ view: V, size: CGSize, name: String, scrollBy offset: CGFloat = 0, settle: TimeInterval = 0.6) throws -> UIImage {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: view)
        host.view.backgroundColor = .systemBackground
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(settle))
        if offset != 0 {
            // The list's own scroll view (the tallest vertical one; the tiles scroll sideways).
            func scrollViews(_ view: UIView) -> [UIScrollView] {
                let own: [UIScrollView] = (view as? UIScrollView).map { [$0] } ?? []
                return own + view.subviews.flatMap(scrollViews)
            }
            let list = try XCTUnwrap(scrollViews(window).filter { $0.contentSize.height > $0.bounds.height }.max { $0.contentSize.height < $1.contentSize.height })
            list.setContentOffset(CGPoint(x: 0, y: -list.adjustedContentInset.top + offset), animated: false)
            RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        }
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
            if !window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) { window.layer.render(in: context.cgContext) }
        }
        window.isHidden = true
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], let data = image.pngData() {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
            print("snapshot written: \(url.path)")
        }
        return image
    }

    private func add(_ store: Store, _ name: String, owner: String?, unread: Int = 0, mentions: Int = 0, level: String? = nil) {
        var out = ChannelOut(id: name, type: "public", name: name, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: unread,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil,
                             readState: ReadStateOut(lastReadSeq: 0, unreadCount: unread, mentionCount: mentions),
                             notification: NotificationPreferenceOut(channelId: name, level: level ?? "mentions", mutedUntil: nil))
        out.timesOwnerId = owner
        store.upsertChannel(out, isMember: true)
    }

    func testTimesSectionRenders() throws {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                           email: nil, mustChangePassword: false))
        add(store, "general", owner: nil, unread: 2)
        add(store, "random", owner: nil)
        add(store, "times-zed", owner: "zed", unread: 3, mentions: 1)
        add(store, "times-amy", owner: "amy", unread: 7)
        add(store, "times-bob", owner: "bob", unread: 2, level: "all")
        add(store, "times-cat", owner: "cat")
        let list = { NavigationStack { ChannelListView(controller: controller, selection: .constant(nil)) } }
        _ = try render(list(), size: CGSize(width: 393, height: 1100), name: "times-others.png")
        add(store, "times-kano", owner: "me", unread: 1)
        let image = try render(list(), size: CGSize(width: 393, height: 1100), name: "times-mine.png")
        XCTAssertGreaterThan(image.size.width, 0)
    }

    /// MOBILE_POLISH.md H1: scrolled down, the section titles go up with their rows (Slack) instead of sticking under
    /// the translucent navigation bar over the rows above. Writes home-top.png and home-scrolled.png (light and dark).
    func testHomeSectionTitlesScrollWithTheRows() throws {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                           email: nil, mustChangePassword: false))
        for index in 0..<24 { add(store, String(format: "ch-%02d", index), owner: nil, unread: index == 3 ? 2 : 0) }
        store.favorites = ["ch-00", "ch-01"]
        for scheme in [ColorScheme.light, .dark] {
            let home = NavigationStack {
                ChannelListView(controller: controller, selection: .constant(nil))
                    .navigationTitle("ChikuwaChat")
                    .navigationBarTitleDisplayMode(.inline)
            }
            .environment(\.colorScheme, scheme)
            let suffix = scheme == .dark ? "-dark" : ""
            _ = try render(home, size: CGSize(width: 393, height: 852), name: "home-top\(suffix).png")
            // Far enough that 「チャンネル」 would have stuck at the top with rows scrolling behind it.
            let image = try render(home, size: CGSize(width: 393, height: 852), name: "home-scrolled\(suffix).png", scrollBy: 420)
            XCTAssertGreaterThan(image.size.width, 0)
        }
    }

    /// MOBILE_POLISH.md C4: the long-press sheet and the emoji picker are solid; the text behind does not show through.
    /// Writes sheet-actions.png and sheet-emoji.png.
    func testMessageSheetsAreOpaque() throws {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                           email: nil, mustChangePassword: false))
        let message = MessageState(MessageOut(id: "m1", channelId: "c1", senderId: "me", seq: 1, updatedSeq: 1, clientMsgId: nil, body: "本文",
                                              createdAt: "2026-09-30T00:00:00Z", editedAt: nil, deleted: false))
        let behind = VStack(alignment: .leading, spacing: 4) {
            ForEach(0..<40, id: \.self) { index in
                Text("後ろの会話 \(index) — 透けて見えてはいけない文字").font(.title3.bold()).foregroundStyle(index % 2 == 0 ? .red : .blue)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        let actions = behind.sheet(isPresented: .constant(true)) {
            MessageActionsSheet(message: message, controller: controller, canThread: true, canMarkUnread: true, onMarkUnread: {}, followUp: { _ in })
        }
        _ = try render(actions, size: CGSize(width: 393, height: 852), name: "sheet-actions.png", settle: 1.2)
        let emoji = behind.sheet(isPresented: .constant(true)) { EmojiPickerView { _ in } }
        let image = try render(emoji, size: CGSize(width: 393, height: 852), name: "sheet-emoji.png", settle: 1.2)
        XCTAssertGreaterThan(image.size.width, 0)
        // M50: my chosen quick reactions, exactly (three here), with the thinner rows. Writes sheet-actions-chosen.png.
        var chosen = try XCTUnwrap(store.me)
        chosen.quickReactions = .chosen(["🍤", "🙏", "💯"])
        store.setMe(chosen)
        let mine = behind.sheet(isPresented: .constant(true)) {
            MessageActionsSheet(message: message, controller: controller, canThread: true, canMarkUnread: true, onMarkUnread: {}, followUp: { _ in })
        }
        _ = try render(mine, size: CGSize(width: 393, height: 852), name: "sheet-actions-chosen.png", settle: 1.2)
    }

    /// M50: 自分 → 表示's 「リアクションの候補」 — chosen (three slots and three empty), not chosen (the recent-first six,
    /// 元に戻す disabled), and hidden for a server that does not know the field. Writes appearance-quick-*.png.
    func testQuickReactionSettingsRender() throws {
        let controller = AppController()
        let store = controller.store
        var me = UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                        email: nil, mustChangePassword: false)
        let view = { NavigationStack { AppearanceView(controller: controller) } }
        for (setting, name) in [(QuickReactionsSetting.chosen(["🍤", "🙏", "💯"]), "chosen"), (.unset, "unset"), (.unsupported, "older-server")] {
            me.quickReactions = setting
            store.setMe(me)
            _ = try render(view(), size: CGSize(width: 393, height: 1000), name: "appearance-quick-\(name).png")
        }
        me.quickReactions = .chosen(["🍤", "🙏", "💯"])
        store.setMe(me)
        let dark = try render(view().environment(\.colorScheme, .dark), size: CGSize(width: 393, height: 1000), name: "appearance-quick-chosen-dark.png")
        XCTAssertGreaterThan(dark.size.width, 0)
    }

    /// 「新しいメッセージ」 (the ✏️ button): rows tighter than the home's (tester, 2026-09-30).
    func testNewMessageListRenders() throws {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                           email: nil, mustChangePassword: false))
        for name in ["general", "random", "m2-進捗", "輪講", "times-kano", "design-review"] { add(store, name, owner: nil) }
        let image = try render(NewMessageView(controller: controller) { _, _ in }, size: CGSize(width: 393, height: 700), name: "new-message.png")
        XCTAssertGreaterThan(image.size.width, 0)
    }
}
