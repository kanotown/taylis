import SwiftUI
import XCTest
@testable import ChikuwaChat

/// M49: the DM list's preview (MOBILE_UI.md §6.3 / §7.1, SYNC_PROTOCOL.md §7.8): the rule against the cases every client
/// shares (apps/shared/dm-preview.json), how the store keeps `last_message` current, the engine with the fake server, and
/// the rows drawn (light and dark).
@MainActor
final class DMPreviewTests: XCTestCase {
    // MARK: the shared cases

    private struct Vectors: Decodable {
        struct Excerpt: Decodable { let name: String; let body: String; let attachments: [String]; let excerpt: String }
        struct Last: Decodable { let senderId: String; let type: String; let excerpt: String }
        struct Line: Decodable { let name: String; let type: String; let dmUserIds: [String]?; let lastMessage: Last?; let line: String }
        let me: String
        let users: [String: String]
        let groups: [String: String]
        let excerpt: [Excerpt]
        let line: [Line]
    }

    private func vectors() throws -> Vectors {
        // The repository's own file (the simulator reads the Mac's disk).
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/dm-preview.json")
        return try JSON.snakeDecoder.decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func user(_ id: String, _ name: String) -> UserPublic {
        UserPublic(id: id, username: id, displayName: name, role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")
    }

    func testSharedExcerptCases() throws {
        let v = try vectors()
        let users = Dictionary(uniqueKeysWithValues: v.users.map { ($0.key, user($0.key, $0.value)) })
        let groups = Dictionary(uniqueKeysWithValues: v.groups.map { ($0.key, GroupOut(id: $0.key, name: $0.value, createdBy: "", createdAt: "", updatedAt: "")) })
        XCTAssertGreaterThan(v.excerpt.count, 10)
        for c in v.excerpt {
            let attachments = c.attachments.enumerated().map {
                AttachmentOut(id: "\($0.offset)", filename: "f", contentType: $0.element, sizeBytes: 1, width: nil, height: nil, hasThumbnail: false,
                              status: "attached", createdAt: "")
            }
            XCTAssertEqual(Timeline.excerpt(c.body, attachments: attachments, users: users, groups: groups, limit: DMList.previewLength), c.excerpt, c.name)
        }
    }

    func testSharedLineCases() throws {
        let v = try vectors()
        let users = Dictionary(uniqueKeysWithValues: v.users.map { ($0.key, user($0.key, $0.value)) })
        XCTAssertGreaterThan(v.line.count, 5)
        for c in v.line {
            let last = c.lastMessage.map {
                LastMessageOut(id: "m", senderId: $0.senderId, type: $0.type, seq: 1, excerpt: $0.excerpt, hasAttachments: false, createdAt: "")
            }
            XCTAssertEqual(DMList.previewLine(last, type: c.type, dmUserIds: c.dmUserIds, meId: v.me, users: users), c.line, c.name)
        }
    }

    /// Without a preview, the second line says what it said before (as the web's).
    func testFallbackLine() {
        XCTAssertEqual(DMList.fallbackLine(memberCount: 3, status: ("🏖", "休暇中"), presence: nil), "3 人")
        XCTAssertEqual(DMList.fallbackLine(memberCount: 2, status: ("🏖", "休暇中"), presence: "online"), "休暇中")
        XCTAssertEqual(DMList.fallbackLine(memberCount: 2, status: ("🏖", ""), presence: "online"), "オンライン")
        XCTAssertEqual(DMList.fallbackLine(memberCount: 1, status: nil, presence: "offline"), "オフライン")
        XCTAssertEqual(DMList.fallbackLine(memberCount: 2, status: nil, presence: nil), "")
    }

    // MARK: the store (§7.8)

    private func dm(_ held: LastMessageOut? = nil, id: String = "d", type: String = "dm") -> ChannelOut {
        ChannelOut(id: id, type: type, name: nil, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0, lastMessageAt: nil,
                   createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: ["me", "you"], lastMessage: held)
    }

    private func message(_ seq: Int, _ body: String, channel: String = "d", parentId: String? = nil, alsoInChannel: Bool = false,
                         deleted: Bool = false, edited: Bool = false, reactions: [ReactionOut] = [], attachments: [AttachmentOut] = [],
                         updatedSeq: Int? = nil) -> MessageOut {
        MessageOut(id: "m\(seq)", channelId: channel, senderId: "you", seq: seq, updatedSeq: updatedSeq ?? seq, clientMsgId: nil, body: body,
                   createdAt: "2026-09-30T10:00:\(String(format: "%02d", seq))Z", editedAt: edited ? "x" : nil, deleted: deleted, reactions: reactions,
                   parentId: parentId, alsoInChannel: alsoInChannel, attachments: attachments)
    }

    private func storeWith(_ held: LastMessageOut?) -> Store {
        let store = Store()
        store.upsertChannel(dm(held), isMember: true, replacesLastMessage: true)
        return store
    }

    private func last(_ store: Store, _ id: String = "d") -> LastMessageOut? { store.channel(id)?.channel.lastMessage }

    func testNullKeepsTheOneHeldAndBootstrapReplacesIt() {
        let held = Store().lastMessage(of: MessageState(message(3, "held")))
        let store = storeWith(held)
        var renamed = dm()
        renamed.archived = true
        store.upsertChannel(renamed) // a PATCH answer, channel.updated …: null = not said
        XCTAssertEqual(last(store), held)
        store.upsertChannel(dm(LastMessageOut(id: "m3", senderId: "you", type: "user", seq: 3, excerpt: "fresh", hasAttachments: false, createdAt: "")))
        XCTAssertEqual(last(store)?.excerpt, "fresh") // GET /channels/{id}, POST /dms
        store.upsertChannel(dm(), isMember: true, replacesLastMessage: true) // bootstrap: nothing left
        XCTAssertNil(last(store))
        // Older servers (and rows stored before M49) have no field at all.
        let decoded = try? JSON.snakeDecoder.decode(ChannelOut.self, from: Data("""
            {"id":"x","type":"dm","name":null,"topic":null,"purpose":null,"archived":false,"created_by":null,"last_seq":0,
             "last_message_at":null,"created_at":"","updated_at":"","membership":null,"dm_user_ids":["me"]}
            """.utf8))
        XCTAssertNotNil(decoded)
        XCTAssertNil(decoded?.lastMessage)
    }

    func testANewerTimelineMessageTakesItsPlace() {
        let store = storeWith(nil)
        store.upsertMessage(message(2, "two"))
        XCTAssertEqual(last(store)?.excerpt, "two")
        store.upsertMessage(message(1, "older (a history page)"))
        store.upsertMessage(message(3, "only in the thread", parentId: "m2"))
        store.applyLastMessage(MessageState(placeholderFor: "c", channelId: "d", senderId: "me", body: "pending", createdAt: "")) // a send in flight
        XCTAssertEqual(last(store)?.id, "m2")
        store.upsertMessage(message(4, "also in the channel", parentId: "m2", alsoInChannel: true))
        XCTAssertEqual(last(store), LastMessageOut(id: "m4", senderId: "you", type: "user", seq: 4, excerpt: "also in the channel", hasAttachments: false,
                                                   createdAt: "2026-09-30T10:00:04Z"))
        let image = AttachmentOut(id: "a", filename: "p.png", contentType: "image/png", sizeBytes: 1, width: 1, height: 1, hasThumbnail: true,
                                  status: "attached", createdAt: "")
        store.upsertMessage(message(5, "", attachments: [image]))
        XCTAssertEqual(last(store)?.excerpt, "画像を送信しました")
        XCTAssertEqual(last(store)?.hasAttachments, true)

        // Not a member (a public channel's preview, M27): nothing moves.
        store.upsertChannel(dm(id: "p", type: "public"), isMember: false)
        store.upsertMessage(message(7, "a preview's row", channel: "p"))
        XCTAssertNil(last(store, "p"))
    }

    func testAnEditOfTheOneShownBringsItsTextAndAReactionChangesNothing() {
        let store = storeWith(nil)
        let you = "00000000-0000-7000-8000-0000000000a1"
        store.upsertUser(user(you, "相手"))
        store.upsertMessage(message(2, "before"))
        store.upsertMessage(message(2, "after <@\(you)>", edited: true, updatedSeq: 10))
        XCTAssertEqual(last(store)?.excerpt, "after @相手")
        let before = store.channel("d")
        store.upsertMessage(message(2, "after <@\(you)>", edited: true, reactions: [ReactionOut(emoji: "👍", count: 1, userIds: ["me"])], updatedSeq: 11))
        XCTAssertEqual(store.channel("d"), before)
    }

    func testDeletingTheOneShownFallsBackToTheRowHeldBelow() {
        let store = storeWith(nil)
        var stale: [String] = []
        store.onStalePreview = { stale.append($0) }
        for seq in [1, 2, 3] { store.upsertMessage(message(seq, "m\(seq)")) }
        store.upsertMessage(message(2, "", deleted: true, updatedSeq: 20)) // not the one shown: nothing moves
        XCTAssertEqual(last(store)?.id, "m3")
        store.updateChannel("d") { $0.syncedSeq = 21; $0.oldestLoadedSeq = 0; $0.hasOlder = false }
        store.upsertMessage(message(3, "", deleted: true, updatedSeq: 22))
        XCTAssertEqual(last(store)?.id, "m1") // m2 is gone too
        store.upsertMessage(message(1, "", deleted: true, updatedSeq: 23))
        XCTAssertNil(last(store)) // the start of the conversation: nothing left, nothing to ask
        XCTAssertEqual(stale, [])
    }

    func testWhenTheRowsHeldCannotSayItEmptiesAndAsks() {
        let store = storeWith(Store().lastMessage(of: MessageState(message(8, "shown"))))
        var stale: [String] = []
        store.onStalePreview = { stale.append($0) }
        store.applyLastMessage(MessageState(message(8, "", deleted: true))) // no timeline here (syncedSeq nil)
        XCTAssertNil(last(store))
        XCTAssertEqual(stale, ["d"])

        store.applyLastMessage(MessageState(message(9, "arrived meanwhile")))
        store.setFetchedLastMessage("d", Store().lastMessage(of: MessageState(message(7, "the server's (older)"))))
        XCTAssertEqual(last(store)?.id, "m9")
        store.setFetchedLastMessage("d", nil)
        XCTAssertEqual(last(store)?.id, "m9")
        let emptied = storeWith(nil)
        emptied.setFetchedLastMessage("d", Store().lastMessage(of: MessageState(message(7, "the server's"))))
        XCTAssertEqual(last(emptied)?.excerpt, "the server's")

        // A timeline that does not reach the start (older pages not read) asks as well.
        let partial = storeWith(nil)
        partial.onStalePreview = { stale.append("partial:" + $0) }
        partial.upsertMessage(message(40, "shown"))
        partial.updateChannel("d") { $0.syncedSeq = 40; $0.oldestLoadedSeq = 40; $0.hasOlder = true }
        partial.upsertMessage(message(40, "", deleted: true, updatedSeq: 41))
        XCTAssertNil(last(partial))
        XCTAssertEqual(stale.last, "partial:d")
    }

    // MARK: the engine and the fake server

    private func settle(_ engine: SyncEngine) async {
        for _ in 0..<50 {
            await engine.idle()
            await Task.yield()
        }
    }

    func testTheEngineKeepsItFromEventsAndAsksAfterADeletionItCannotReplace() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let dmId = server.createChannel("", ownerId: alice.id, type: "dm").id
        server.join(dmId, bob.id)
        let (first, _) = try server.post(channelId: dmId, senderId: alice.id, body: "はじめまして")
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        options.reconnectMin = 0
        let api = server.api(for: bob.id)
        let engine = SyncEngine(api: api, connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "token" }, options: options)
        engine.isActive = { false }
        await engine.start()
        await settle(engine)
        XCTAssertEqual(last(store, dmId)?.id, first.id) // from bootstrap
        XCTAssertEqual(last(store, dmId)?.excerpt, "はじめまして")
        XCTAssertNil(store.channel(dmId)?.syncedSeq)

        let (mine, _) = try server.post(channelId: dmId, senderId: bob.id, body: "よろしく") // another device of mine
        await settle(engine)
        XCTAssertEqual(last(store, dmId)?.id, mine.id)
        XCTAssertEqual(last(store, dmId)?.senderId, bob.id)
        try server.delete(channelId: dmId, userId: bob.id, messageId: mine.id)
        await settle(engine)
        XCTAssertEqual(last(store, dmId)?.id, first.id) // GET /channels/{id}
        XCTAssertEqual(api.calls.filter { $0 == "channel" }.count, 1)

        // With the conversation open (its timeline held), a deletion falls back without asking.
        await engine.openChannel(dmId)
        await settle(engine)
        let (again, _) = try server.post(channelId: dmId, senderId: bob.id, body: "もう一度")
        await settle(engine)
        XCTAssertEqual(last(store, dmId)?.excerpt, "もう一度")
        try server.delete(channelId: dmId, userId: bob.id, messageId: again.id)
        await settle(engine)
        XCTAssertEqual(last(store, dmId)?.id, first.id)
        XCTAssertEqual(api.calls.filter { $0 == "channel" }.count, 1)
        engine.stop()
    }
}

/// M49: the DM tab's rows with the preview under the name (MOBILE_UI.md §6.3), light and dark. Run with
/// TEST_RUNNER_SNAPSHOT_DIR=<dir> to look at them.
@MainActor
final class DMPreviewSnapshotTests: XCTestCase {
    private func render<V: View>(_ view: V, size: CGSize, style: UIUserInterfaceStyle, name: String) throws -> UIImage {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        window.overrideUserInterfaceStyle = style
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

    private func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }

    private func add(_ store: Store, _ id: String, type: String = "dm", members: [String], at: Date, unread: Int = 0,
                     last: (sender: String, excerpt: String)?) {
        let out = ChannelOut(id: id, type: type, name: nil, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 10,
                             lastMessageAt: iso(at), createdAt: "2026-01-01T00:00:00Z", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""),
                             dmUserIds: members, readState: ReadStateOut(lastReadSeq: 10 - unread, unreadCount: unread, mentionCount: 0),
                             lastMessage: last.map { LastMessageOut(id: "m-\(id)", senderId: $0.sender, type: "user", seq: 10, excerpt: $0.excerpt,
                                                                    hasAttachments: false, createdAt: iso(at)) })
        store.upsertChannel(out, isMember: true, replacesLastMessage: true)
    }

    func testDMRowsRender() throws {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "加納", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                           email: nil, mustChangePassword: false))
        for (id, name) in [("me", "加納"), ("tanaka", "田中先生"), ("sato", "佐藤"), ("suzuki", "鈴木")] {
            var user = UserPublic(id: id, username: id, displayName: name, role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")
            if id == "tanaka" { user.statusEmoji = "🏖"; user.statusText = "休暇中" }
            store.upsertUser(user)
        }
        store.replacePresence([PresenceEntry(userId: "sato", status: "online")])
        let now = Date()
        add(store, "notes", members: ["me"], at: now.addingTimeInterval(-7200), last: ("me", "買い物メモ: 牛乳、卵"))
        add(store, "tanaka", members: ["me", "tanaka"], at: now.addingTimeInterval(-60), unread: 2,
            last: ("tanaka", "明日の件、資料を確認お願いします。スライドは共有フォルダに置いておきました"))
        add(store, "sato", members: ["me", "sato"], at: now.addingTimeInterval(-86_400), last: ("me", "了解しました、明日の輪講で話します"))
        add(store, "group", type: "group_dm", members: ["me", "sato", "suzuki"], at: now.addingTimeInterval(-3 * 86_400), unread: 3,
            last: ("sato", "スライド共有します"))
        add(store, "suzuki", members: ["me", "suzuki"], at: now.addingTimeInterval(-20 * 86_400), last: nil)
        let list = { NavigationStack { DMListView(controller: controller, onOpen: { _ in }, onNew: {}) } }
        _ = try render(list(), size: CGSize(width: 393, height: 620), style: .light, name: "dm-preview-light.png")
        let image = try render(list(), size: CGSize(width: 393, height: 620), style: .dark, name: "dm-preview-dark.png")
        XCTAssertGreaterThan(image.size.width, 0)
    }
}
