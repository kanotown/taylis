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
            // Bootstrap reports the default level (mentions for channels, all for DMs) when none is set.
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
    private func render<V: View>(_ view: V, size: CGSize, name: String) throws -> UIImage {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: view)
        host.view.backgroundColor = .systemBackground
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
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
}
