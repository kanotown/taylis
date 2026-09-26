import XCTest
@testable import ChikuwaChat

@MainActor
final class SyncEngineTests: XCTestCase {
    struct World {
        let server: FakeServer
        let alice: UserPublic
        let bob: UserPublic
        let channel: ChannelOut
        let store: Store
        let engine: SyncEngine
        let api: FakeServer.Api
    }

    private var notifications: [String] = []

    private func makeWorld(hold: Bool = false) -> World {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("general", ownerId: alice.id)
        server.join(channel.id, bob.id)
        let store = Store()
        var options = EngineOptions()
        options.pageSize = 3
        options.gapLimit = 5
        options.reconnectMin = 0
        options.sleep = { _ in }
        options.random = { 0.5 }
        let api = server.api(for: bob.id)
        let engine = SyncEngine(api: api, connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "token" }, options: options)
        engine.isActive = { false }
        engine.onNotify = { [weak self] message, _ in self?.notifications.append(message.body) }
        server.holdEvents = hold
        return World(server: server, alice: alice, bob: bob, channel: channel, store: store, engine: engine, api: api)
    }

    private func settle(_ engine: SyncEngine) async {
        for _ in 0..<50 {
            await engine.idle()
            await Task.yield()
        }
    }

    func testConversationDraftsPersistSeparatelyIncludingAttachments() {
        let store = Store()
        let attachment = AttachmentOut(id: "a", filename: "note.txt", contentType: "text/plain", sizeBytes: 4,
            width: nil, height: nil, hasThumbnail: false, status: "pending", createdAt: "")
        store.setDraft("c1") { $0.text = "channel"; $0.attachments = [attachment] }
        store.setDraft("c1", parentId: "p1") { $0.text = "thread" }
        store.setDraft("c2") { $0.text = "other" }
        store.trackUpload("c1", delta: 1)
        let restored = Store.fromSnapshot(store.snapshot())
        XCTAssertEqual(restored.draft("c1").attachments, [attachment])
        XCTAssertEqual(restored.draft("c1", parentId: "p1").text, "thread")
        XCTAssertEqual(restored.draft("c2").text, "other")
        XCTAssertEqual(restored.uploading("c1"), 0)
        restored.setDraft("c1") { $0 = Draft() }
        XCTAssertEqual(Store.fromSnapshot(restored.snapshot()).draft("c1"), Draft())
        XCTAssertEqual(restored.draft("c1", parentId: "p1").text, "thread")
    }

    func testOpeningDoesNotReadAndBackgroundReadIsIgnored() async throws {
        let w = makeWorld()
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "unseen")
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        XCTAssertEqual(w.store.channel(w.channel.id)?.unreadCount, 1)
        w.engine.markRead(w.channel.id, seq: 1)
        XCTAssertEqual(w.store.channel(w.channel.id)?.lastReadSeq, 0)
        w.engine.stop()
        w.engine.isActive = { true }
        w.engine.markRead(w.channel.id, seq: 1)
        XCTAssertEqual(w.store.channel(w.channel.id)?.lastReadSeq, 0)
        await w.engine.send(w.channel.id, body: "offline send")
        XCTAssertEqual(w.store.outbox.count, 1)
        await w.engine.start()
        await settle(w.engine)
        XCTAssertEqual(w.store.outbox.count, 0)
        w.engine.stop()
    }

    func testSessionRestorationRetriesTemporaryFailure() async {
        let w = makeWorld()
        var attempts = 0
        w.store.setDraft("c1") { $0.text = "offline draft" }
        w.engine.prepareConnection = {
            attempts += 1
            if attempts == 1 { throw ApiError.network(URLError(.notConnectedToInternet)) }
        }
        await w.engine.start()
        await settle(w.engine)
        XCTAssertEqual(w.engine.status, .online)
        XCTAssertEqual(attempts, 2)
        XCTAssertEqual(w.store.draft("c1").text, "offline draft")
        w.engine.stop()
    }

    func testRevokedSessionDuringRestorationSignsOut() async {
        let w = makeWorld()
        w.engine.prepareConnection = { throw ApiError.api(status: 401, code: "session_revoked", message: "revoked") }
        await w.engine.start()
        XCTAssertEqual(w.engine.status, .signedOut)
        w.engine.stop()
    }

    func testAppliesLiveEditsDeletionsAndReactions() async throws {
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        let (m1, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m1")
        let (m2, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m2")
        await settle(w.engine)
        try w.server.edit(channelId: w.channel.id, userId: w.alice.id, messageId: m1.id, body: "m1 edited")
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m1 edited", "m2"])
        XCTAssertNotNil(w.store.messages(w.channel.id).first?.editedAt)
        try w.server.react(channelId: w.channel.id, userId: w.bob.id, messageId: m2.id, emoji: "👍", present: true)
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).last?.reactions.map(\.emoji), ["👍"])
        XCTAssertEqual(w.store.messages(w.channel.id).last?.reactedBy(w.bob.id, "👍"), true)
        try w.server.react(channelId: w.channel.id, userId: w.bob.id, messageId: m2.id, emoji: "👍", present: false)
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).last?.reactions.count, 0)
        try w.server.delete(channelId: w.channel.id, userId: w.alice.id, messageId: m2.id)
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m1 edited"])
        XCTAssertEqual(w.store.channel(w.channel.id)?.syncedSeq, 6)
        w.engine.stop()
    }

    func testChannelMentionsNotify() async throws {
        let w = makeWorld()
        await w.engine.start()
        await settle(w.engine)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "plain")
        await settle(w.engine)
        XCTAssertEqual(notifications, [])
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "hey <@\(w.bob.id)>")
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "<!channel> all")
        await settle(w.engine)
        XCTAssertEqual(notifications, ["hey <@\(w.bob.id)>", "<!channel> all"])
        w.engine.stop()
    }

    func testMarkUnreadMovesBackHoldsVisibleMarkingAndFollowsOtherDevices() async throws {
        let w = makeWorld()
        w.engine.isActive = { true }
        for body in ["m1", "m2", "m3"] { try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: body) }
        await w.engine.start()
        await settle(w.engine)
        await w.engine.openChannel(w.channel.id)
        w.engine.markRead(w.channel.id, seq: 3)
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id)?.unreadCount, 0)

        w.engine.markUnread(w.channel.id, seq: 2) // 「ここから未読にする」 on m2
        XCTAssertEqual(w.store.channel(w.channel.id).map { [$0.lastReadSeq, $0.unreadCount] }, [1, 2])
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertEqual(w.server.readState(userId: w.bob.id, channelId: w.channel.id).lastReadSeq, 1)
        w.engine.markRead(w.channel.id, seq: 3) // visible-range marking is on hold
        await w.engine.flushReads()
        XCTAssertEqual(w.store.channel(w.channel.id)?.lastReadSeq, 1)
        w.engine.markRead(w.channel.id, seq: 3, force: true) // an explicit read overrides the hold
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id)?.lastReadSeq, 3)

        try w.server.markRead(userId: w.bob.id, channelId: w.channel.id, seq: 0, mode: "set") // another device
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id).map { [$0.lastReadSeq, $0.unreadCount] }, [0, 3])
        // A plain advance event behind the local position (an older PUT of ours) must not lower it.
        w.engine.markRead(w.channel.id, seq: 3)
        try w.server.markRead(userId: w.bob.id, channelId: w.channel.id, seq: 2)
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id)?.lastReadSeq, 3)
        await w.engine.flushReads()
        w.engine.stop()
    }

    func testUnreadCountsFollowReadsAcrossDevices() async throws {
        let w = makeWorld()
        w.engine.isActive = { true }
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m1")
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m2")
        await w.engine.start()
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id)?.unreadCount, 2)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "hey <@\(w.bob.id)>")
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id).map { [$0.unreadCount, $0.mentionCount] }, [3, 1])
        w.engine.markRead(w.channel.id, seq: 2)
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id).map { [$0.lastReadSeq, $0.unreadCount, $0.mentionCount] }, [2, 1, 1])
        try w.server.markRead(userId: w.bob.id, channelId: w.channel.id, seq: 3) // another device of bob
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id).map { [$0.lastReadSeq, $0.unreadCount, $0.mentionCount] }, [3, 0, 0])
        w.engine.markRead(w.channel.id, seq: 1) // stale: ignored
        await w.engine.flushReads()
        XCTAssertEqual(w.store.channel(w.channel.id)?.lastReadSeq, 3)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m4")
        await settle(w.engine)
        await w.engine.openChannel(w.channel.id)
        await w.engine.send(w.channel.id, body: "mine")
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id).map { [$0.lastReadSeq, $0.unreadCount, $0.mentionCount] }, [5, 0, 0])
        w.engine.stop()
    }

    func testThreadsKeepRepliesOutOfTheTimelineAndUpdateTheParent() async throws {
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        let (parent, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "topic")
        await settle(w.engine)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "reply 1", parentId: parent.id)
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["topic"])
        XCTAssertEqual(w.store.replies(w.channel.id, parentId: parent.id).map(\.body), ["reply 1"])
        XCTAssertEqual(w.store.message(w.channel.id, id: parent.id)?.replyCount, 1)
        XCTAssertEqual(notifications, []) // bob is not part of the thread
        XCTAssertEqual(w.store.channel(w.channel.id)?.unreadCount, 1) // replies are not unread items

        await w.engine.send(w.channel.id, body: "reply 2", parentId: parent.id)
        await settle(w.engine)
        XCTAssertEqual(w.store.replies(w.channel.id, parentId: parent.id).map(\.body), ["reply 1", "reply 2"])
        XCTAssertEqual(w.store.message(w.channel.id, id: parent.id)?.replyCount, 2)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "reply 3", parentId: parent.id)
        await settle(w.engine)
        XCTAssertEqual(notifications, ["reply 3"]) // bob replied, so alice's reply notifies him

        // A fresh client loads the thread on demand.
        let restored = Store.fromSnapshot(Snapshot(meta: [:], users: Array(w.store.users.values), channels: Array(w.store.channels.values), messages: [], outbox: []))
        var options = EngineOptions()
        options.sleep = { _ in }
        let second = SyncEngine(api: w.server.api(for: w.bob.id), connect: w.server.connector(for: w.bob.id), wsUrl: URL(string: "ws://fake")!,
                                store: restored, getAccessToken: { "t" }, options: options)
        await second.start()
        await settle(second)
        XCTAssertEqual(restored.replies(w.channel.id, parentId: parent.id).count, 0)
        await second.loadReplies(w.channel.id, parentId: parent.id)
        XCTAssertEqual(restored.replies(w.channel.id, parentId: parent.id).map(\.body), ["reply 1", "reply 2", "reply 3"])
        second.stop()
        w.engine.stop()
    }

    func testFollowedThreadsListUnreadRepliesAndReadPosition() async throws {
        let w = makeWorld()
        w.engine.isActive = { true }
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        XCTAssertEqual(w.store.threadSummary, ThreadSummary(unreadCount: 0, mentionCount: 0))

        // bob's own topic: alice's reply makes it a followed, unread thread (badge via thread.updated).
        await w.engine.send(w.channel.id, body: "topic")
        await settle(w.engine)
        let parent = try w.server.messageByBody(w.channel.id, "topic")
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "<@\(w.bob.id)> reply 1", parentId: parent.id)
        await w.engine.flushThreads()
        await settle(w.engine)
        XCTAssertEqual(w.store.threadSummary, ThreadSummary(unreadCount: 1, mentionCount: 1))
        XCTAssertEqual(w.store.badgeCount, 1) // a thread mention counts on the app badge
        XCTAssertFalse(w.store.threadsLoaded) // only the badge until the view opens

        await w.engine.loadThreads(filter: "all")
        let rows = w.store.threadList()
        XCTAssertEqual(rows.map(\.parent.body), ["topic"])
        XCTAssertEqual(rows.first?.state.unreadCount, 1)
        XCTAssertEqual(rows.first?.state.mentionCount, 1)
        XCTAssertEqual(rows.first?.state.participantIds, [w.bob.id, w.alice.id])

        // Showing the reply marks the thread read (debounced PUT); the badge drops at once.
        let reply = try w.server.messageByBody(w.channel.id, "<@\(w.bob.id)> reply 1")
        await w.engine.loadReplies(w.channel.id, parentId: parent.id)
        w.engine.markThreadRead(parent.id, seq: reply.seq)
        XCTAssertEqual(w.store.threads[parent.id]?.state.unreadCount, 0)
        XCTAssertEqual(w.store.threadSummary, ThreadSummary(unreadCount: 0, mentionCount: 0))
        await w.engine.flushThreads()
        await settle(w.engine)
        XCTAssertEqual(try w.server.threadState(userId: w.bob.id, parentId: parent.id).lastReadSeq, reply.seq)
        XCTAssertEqual(w.store.threadList(filter: "unread").count, 0)

        // Unfollowing drops the thread from the list; the next reply does not bring it back.
        await w.engine.setThreadFollow(parent.id, following: false)
        XCTAssertEqual(w.store.threads[parent.id]?.state.following, false)
        XCTAssertEqual(w.store.threadList().count, 0)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "reply 2", parentId: parent.id)
        await w.engine.flushThreads()
        await settle(w.engine)
        XCTAssertEqual(w.store.threadList().count, 0)
        XCTAssertEqual(w.store.threadSummary.unreadCount, 0)
        XCTAssertEqual(try w.server.threadState(userId: w.alice.id, parentId: parent.id).participantIds, [w.alice.id]) // bob is no push target

        await w.engine.setThreadFollow(parent.id, following: true)
        await w.engine.flushThreads()
        await settle(w.engine)
        XCTAssertEqual(w.store.threadList().map(\.parent.id), [parent.id])
        XCTAssertEqual(w.store.threads[parent.id]?.state.unreadCount, 1)

        // A fresh client asks for the state when a thread pane opens from the channel.
        let fresh = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let second = SyncEngine(api: w.server.api(for: w.bob.id), connect: w.server.connector(for: w.bob.id), wsUrl: URL(string: "ws://fake")!,
                                store: fresh, getAccessToken: { "t" }, options: options)
        await second.start()
        await second.openChannel(w.channel.id)
        await settle(second)
        XCTAssertEqual(fresh.threadSummary.unreadCount, 1) // from bootstrap
        XCTAssertNil(fresh.threads[parent.id])
        await second.loadThreadState(parent.id)
        XCTAssertEqual(fresh.threads[parent.id]?.state.following, true)
        XCTAssertEqual(fresh.threads[parent.id]?.state.unreadCount, 1)
        second.stop()
        w.engine.stop()
    }

    func testPresenceAndTypingAreVolatile() async throws {
        let w = makeWorld()
        // alice is connected before bob bootstraps: listed in bootstrap.
        let aliceSocket = try await w.server.connector(for: w.alice.id)(URL(string: "ws://fake")!, "t")
        try await aliceSocket.send(ClientFrame.auth(token: "t"))
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        await settle(w.engine)
        XCTAssertEqual(w.store.presenceOf(w.alice.id), "online")
        XCTAssertEqual(w.store.presenceOf(w.bob.id), "online") // own connection announced too

        w.server.awayUsers.insert(w.alice.id)
        w.server.announcePresence(w.alice.id)
        await settle(w.engine)
        XCTAssertEqual(w.store.presenceOf(w.alice.id), "away")
        aliceSocket.close()
        await settle(w.engine)
        XCTAssertEqual(w.store.presenceOf(w.alice.id), "offline")
        XCTAssertNil(w.store.presence[w.alice.id])

        // Typing from alice shows up for bob, expires, and is cleared by her message.
        let aliceAgain = try await w.server.connector(for: w.alice.id)(URL(string: "ws://fake")!, "t")
        try await aliceAgain.send(ClientFrame.auth(token: "t"))
        try await aliceAgain.send(ClientFrame.typing(channelId: w.channel.id, parentId: nil))
        await settle(w.engine)
        XCTAssertEqual(w.store.typingUsers(w.channel.id, parentId: nil), [w.alice.id])
        XCTAssertEqual(w.store.typingUsers(w.channel.id, parentId: nil, now: Date().addingTimeInterval(6)), []) // 5 s TTL
        try await aliceAgain.send(ClientFrame.typing(channelId: w.channel.id, parentId: "p1"))
        await settle(w.engine)
        XCTAssertEqual(w.store.typingUsers(w.channel.id, parentId: "p1"), [w.alice.id])
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "here it is")
        await settle(w.engine)
        XCTAssertEqual(w.store.typingUsers(w.channel.id, parentId: nil), [])

        // Our own typing goes out at most once per interval and never comes back to us.
        w.engine.sendTyping(w.channel.id)
        w.engine.sendTyping(w.channel.id)
        await settle(w.engine)
        XCTAssertEqual(w.store.typingUsers(w.channel.id, parentId: nil), [])
        w.engine.stop()
    }

    func testPinsTravelAsMessageUpdatesAndBookmarksFollowTheUserEvent() async throws {
        let w = makeWorld()
        let (message, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "keep this")
        w.server.setBookmark(w.bob.id, messageId: message.id, on: true) // saved on another device before this one started
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        await settle(w.engine)
        XCTAssertTrue(w.store.isBookmarked(message.id))

        // A pin is an ordinary seq-consuming update: the row gets pinnedBy without a resync.
        try w.server.pin(channelId: w.channel.id, userId: w.alice.id, messageId: message.id, pinned: true)
        await settle(w.engine)
        XCTAssertEqual(w.store.message(w.channel.id, id: message.id)?.pinnedBy, w.alice.id)
        XCTAssertEqual(w.store.message(w.channel.id, id: message.id)?.updatedSeq, 2)
        XCTAssertEqual(w.store.channel(w.channel.id)?.syncedSeq, 2)
        try w.server.pin(channelId: w.channel.id, userId: w.bob.id, messageId: message.id, pinned: false)
        await settle(w.engine)
        XCTAssertNil(w.store.message(w.channel.id, id: message.id)?.pinnedAt)

        // Another device removes the bookmark: the flag follows the user event.
        w.server.setBookmark(w.bob.id, messageId: message.id, on: false)
        await settle(w.engine)
        XCTAssertFalse(w.store.isBookmarked(message.id))
        w.server.setBookmark(w.bob.id, messageId: message.id, on: true)
        await settle(w.engine)
        XCTAssertTrue(w.store.isBookmarked(message.id))
        w.engine.stop()
    }

    func testAttachmentIdsTravelWithTheOutbox() async throws {
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        await w.engine.send(w.channel.id, body: "", attachmentIds: ["a1", "a2"])
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).first?.attachments.map(\.id), ["a1", "a2"])
        XCTAssertEqual(w.server.channels[w.channel.id]?.messages.first?.attachments.map(\.id), ["a1", "a2"])
        w.engine.stop()
    }

    func testBootstrapLoadsLatestPageOfTheOpenedChannel() async throws {
        let w = makeWorld()
        for i in 1...5 { try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m\(i)") }
        await w.engine.openChannel(w.channel.id)
        await w.engine.start()
        await settle(w.engine)
        XCTAssertEqual(w.engine.status, .online)
        XCTAssertEqual(w.store.me?.username, "bob")
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m3", "m4", "m5"])
        XCTAssertEqual(w.store.channel(w.channel.id)?.syncedSeq, 5)
        await w.engine.loadOlder(w.channel.id)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m1", "m2", "m3", "m4", "m5"])
        XCTAssertEqual(w.store.channel(w.channel.id)?.hasOlder, false)
        w.engine.stop()
    }

    func testContiguousEventsAndGapDetection() async throws {
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m1")
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m1"])
        w.server.sockets(of: w.bob.id).first?.dropNext = 2
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m2")
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m3")
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m1"])
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m4") // gap → catch_up
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m1", "m2", "m3", "m4"])
        XCTAssertEqual(w.store.channel(w.channel.id)?.syncedSeq, 4)
        w.engine.stop()
    }

    func testEventsDuringBootstrapAreBuffered() async throws {
        let w = makeWorld(hold: true)
        await w.engine.openChannel(w.channel.id)
        let started = Task { await w.engine.start() }
        await Task.yield()
        w.server.holdEvents = false
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "during")
        await started.value
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["during"])
        w.engine.stop()
    }

    func testOptimisticSendRetriesWithoutDuplicates() async throws {
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        w.api.pendingFailure = ApiError.network(URLError(.notConnectedToInternet))
        await w.engine.send(w.channel.id, body: "hello")
        XCTAssertEqual(w.store.outbox.count, 1)
        XCTAssertEqual(w.store.messages(w.channel.id).map { ($0.body, $0.pending) }.map { "\($0.0):\($0.1)" }, ["hello:true"])
        await w.engine.flushOutbox()
        await settle(w.engine)
        XCTAssertEqual(w.store.outbox.count, 0)
        XCTAssertEqual(w.store.messages(w.channel.id).map { "\($0.body):\($0.seq ?? -1):\($0.pending)" }, ["hello:1:false"])
        XCTAssertEqual(w.server.channels[w.channel.id]?.messages.count, 1)
        w.engine.stop()
    }

    func testPermanentFailureCanBeDiscarded() async throws {
        let w = makeWorld()
        await w.engine.start()
        w.api.pendingFailure = ApiError.api(status: 409, code: "channel_archived", message: "archived")
        await w.engine.send(w.channel.id, body: "nope")
        XCTAssertEqual(w.store.outbox.first?.failed, "channel_archived")
        XCTAssertEqual(w.store.messages(w.channel.id).first?.failed, true)
        w.engine.discardFailed(w.store.outbox.first!.clientMsgId)
        XCTAssertEqual(w.store.outbox.count, 0)
        XCTAssertEqual(w.store.messages(w.channel.id).count, 0)
        w.engine.stop()
    }

    func testReconnectRecoversMissedEvents() async throws {
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m1")
        await settle(w.engine)
        w.server.disconnect(w.bob.id)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m2")
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m3")
        for _ in 0..<50 where w.engine.status != .online { await settle(w.engine) }
        await settle(w.engine)
        XCTAssertEqual(w.engine.status, .online)
        XCTAssertEqual(w.engine.reconnects, 1)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m1", "m2", "m3"])
        w.engine.stop()
    }

    func testSessionRevocationSignsOut() async throws {
        let w = makeWorld()
        var signedOut = false
        w.engine.onSignedOut = { signedOut = true }
        await w.engine.start()
        w.server.revokeSession(w.bob.id)
        await settle(w.engine)
        XCTAssertEqual(w.engine.status, .signedOut)
        XCTAssertTrue(signedOut)
    }

    func testDirectMessagesNotifyWhenInactive() async throws {
        let w = makeWorld()
        let dm = w.server.createChannel("", ownerId: w.alice.id, type: "dm")
        w.server.join(dm.id, w.bob.id)
        await w.engine.start()
        try w.server.post(channelId: dm.id, senderId: w.alice.id, body: "psst")
        await settle(w.engine)
        XCTAssertEqual(notifications, ["psst"])
        XCTAssertEqual(w.store.channel(dm.id)?.lastSeq, 1)
        w.engine.stop()
    }

    func testResumesFromPersistedSnapshot() async throws {
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m1")
        await settle(w.engine)
        w.engine.stop()
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m2")
        let restored = Store.fromSnapshot(w.store.snapshot())
        var options = EngineOptions()
        options.pageSize = 3
        options.sleep = { _ in }
        let second = SyncEngine(api: w.server.api(for: w.bob.id), connect: w.server.connector(for: w.bob.id), wsUrl: URL(string: "ws://fake")!,
                                store: restored, getAccessToken: { "t" }, options: options)
        await second.openChannel(w.channel.id)
        await second.start()
        await settle(second)
        XCTAssertEqual(restored.messages(w.channel.id).map(\.body), ["m1", "m2"])
        XCTAssertEqual(restored.channel(w.channel.id)?.syncedSeq, 2)
        second.stop()
    }

    func testBrowsablePublicChannelsAndJoining() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let general = server.createChannel("general", ownerId: alice.id)
        let secret = server.createChannel("secret", ownerId: alice.id, type: "private")
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        await engine.start()
        await settle(engine)
        XCTAssertEqual(store.channel(general.id)?.isMember, false)
        XCTAssertNil(store.channel(secret.id))
        server.join(general.id, bob.id)
        server.emitMembership(general.id, bob.id)
        await settle(engine)
        XCTAssertEqual(store.channel(general.id)?.isMember, true)
        engine.stop()
    }
}
