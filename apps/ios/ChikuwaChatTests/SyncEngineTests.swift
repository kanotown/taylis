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

    private func makeWorld(hold: Bool = false, heartbeat: TimeInterval? = nil, outboxRetry: TimeInterval = 2) -> World {
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
        options.heartbeatInterval = heartbeat
        options.outboxRetryMin = outboxRetry
        options.outboxRetryMax = outboxRetry * 8
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

    /// Waits until the engine is connected again (after a drop), then for what the connection started.
    private func waitOnline(_ engine: SyncEngine) async {
        for _ in 0..<50 where engine.status != .online { await settle(engine) }
        await engine.flushReads()
        await settle(engine)
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
        let reloaded = Store.fromSnapshot(restored.snapshot()).draft("c1")
        XCTAssertEqual(reloaded.text, "")
        XCTAssertEqual(reloaded.attachments, [])
        XCTAssertTrue(reloaded.isDirty) // M15d: the delete still has to reach the server
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
        w.engine.prepareConnection = { _ in
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
        w.engine.prepareConnection = { _ in throw ApiError.api(status: 401, code: "session_revoked", message: "revoked") }
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

    func testMyNotificationKeywordsCountAsMentionsHere() async throws {  // M16a: keyword hits stay on the server
        let w = makeWorld()
        w.server.notifyKeywords[w.bob.id] = ["Deploy", "リリース"]
        await w.engine.start()
        await settle(w.engine)
        await w.engine.openChannel(w.channel.id)
        await settle(w.engine)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "plain")
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "the deploy is done")
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "明日リリースします")
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id).map { [$0.unreadCount, $0.mentionCount] }, [3, 2])
        XCTAssertEqual(notifications, ["the deploy is done", "明日リリースします"])
        w.engine.markUnread(w.channel.id, seq: 1) // recounted here with the same rule
        XCTAssertEqual(w.store.channel(w.channel.id).map { [$0.unreadCount, $0.mentionCount] }, [3, 2])
        await w.engine.flushReads()
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

    func testPriorityAndAckRequestSurviveTheOutboxOnTopLevelPostsOnly() async throws {  // M15e
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        w.api.pendingFailure = ApiError.network(URLError(.notConnectedToInternet)) // the first attempt fails: the flags must survive the retry
        await w.engine.send(w.channel.id, body: "本番を止めます", options: SendOptions(priority: "urgent", ackRequested: true))
        XCTAssertEqual(w.store.outbox.first?.priority, "urgent")
        XCTAssertEqual(w.store.outbox.first?.ackRequested, true)
        await w.engine.flushOutbox()
        await settle(w.engine)
        let sent = try XCTUnwrap(w.store.messages(w.channel.id).last)
        XCTAssertEqual(sent.body, "本番を止めます")
        XCTAssertEqual(sent.priority, "urgent")
        XCTAssertTrue(sent.ackRequested)
        XCTAssertFalse(sent.pending)
        await w.engine.send(w.channel.id, body: "返信", parentId: sent.id, options: SendOptions(priority: "important", ackRequested: true))
        await settle(w.engine)
        let reply = try XCTUnwrap(w.store.replies(w.channel.id, parentId: sent.id).last)
        XCTAssertNil(reply.priority)
        XCTAssertFalse(reply.ackRequested)
        w.engine.stop()
    }

    func testReplyAlsoSentToTheChannelShowsInBothPlacesAndCountsUnread() async throws {  // M15c
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        let (parent, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "topic")
        await settle(w.engine)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "quiet", parentId: parent.id)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "loud", parentId: parent.id, options: SendOptions(alsoInChannel: true))
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["topic", "loud"])
        XCTAssertEqual(w.store.replies(w.channel.id, parentId: parent.id).map(\.body), ["quiet", "loud"])
        XCTAssertEqual(w.store.channel(w.channel.id)?.unreadCount, 2) // the topic and the shared reply

        await w.engine.send(w.channel.id, body: "mine too", parentId: parent.id, options: SendOptions(alsoInChannel: true))
        await settle(w.engine)
        let mine = try XCTUnwrap(w.store.messages(w.channel.id).last)
        XCTAssertEqual(mine.body, "mine too")
        XCTAssertTrue(mine.alsoInChannel)
        XCTAssertFalse(mine.pending)

        // Another device finds both shared replies in the channel history.
        let restored = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        options.pageSize = 3
        let second = SyncEngine(api: w.server.api(for: w.bob.id), connect: w.server.connector(for: w.bob.id), wsUrl: URL(string: "ws://fake")!,
                                store: restored, getAccessToken: { "t" }, options: options)
        await second.start()
        await second.openChannel(w.channel.id)
        await settle(second)
        XCTAssertEqual(restored.messages(w.channel.id).map(\.body), ["topic", "loud", "mine too"])
        second.stop()
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

    func testCustomEmojiLoadFromBootstrapAndFollowEvents() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        _ = server.createChannel("general", ownerId: alice.id)
        _ = server.addEmoji("party_parrot", userId: alice.id)
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: alice.id), connect: server.connector(for: alice.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        await engine.start()
        await settle(engine)
        XCTAssertEqual(Array(store.customEmoji.keys), ["party_parrot"])
        let ok = server.addEmoji("ok", userId: alice.id)
        server.emitEmoji(ok, deleted: false)
        await settle(engine)
        XCTAssertEqual(store.customEmoji.keys.sorted(), ["ok", "party_parrot"])
        server.emitEmoji(ok, deleted: true)
        await settle(engine)
        XCTAssertEqual(Array(store.customEmoji.keys), ["party_parrot"])
        engine.stop()
    }

    func testRemindersLoadListFiredFirstAndNudgeOnce() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let general = server.createChannel("general", ownerId: alice.id)
        let (message, _) = try server.post(channelId: general.id, senderId: alice.id, body: "remember me")
        let later = server.remind(alice.id, channelId: general.id, messageId: message.id, remindAt: "2026-10-03T00:00:00Z")
        let sooner = server.remind(alice.id, channelId: general.id, messageId: message.id, remindAt: "2026-10-02T00:00:00Z", note: "reply")
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: alice.id), connect: server.connector(for: alice.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        var nudges: [String] = []
        engine.onReminder = { nudges.append($0.id) }
        await engine.start()
        await settle(engine)
        XCTAssertEqual(store.listReminders().map(\.id), [sooner.id, later.id])
        let fired = ReminderOut(id: sooner.id, messageId: sooner.messageId, channelId: sooner.channelId, note: sooner.note, preview: sooner.preview,
                                remindAt: sooner.remindAt, status: "fired", firedAt: "2026-10-02T00:00:00Z", createdAt: sooner.createdAt)
        server.emitReminder(alice.id, fired)
        server.emitReminder(alice.id, fired) // a replayed event
        await settle(engine)
        XCTAssertEqual(nudges, [sooner.id])
        XCTAssertEqual(store.firedReminderCount, 1)
        XCTAssertEqual(store.listReminders().map(\.status), ["fired", "pending"])
        server.emitReminder(alice.id, ReminderOut(id: sooner.id, messageId: sooner.messageId, channelId: sooner.channelId, note: nil, preview: "", remindAt: sooner.remindAt,
                                                  status: "done", firedAt: nil, createdAt: sooner.createdAt))
        server.emitReminder(alice.id, ReminderOut(id: later.id, messageId: later.messageId, channelId: later.channelId, note: nil, preview: "", remindAt: later.remindAt,
                                                  status: "cancelled", firedAt: nil, createdAt: later.createdAt))
        await settle(engine)
        XCTAssertTrue(store.listReminders().isEmpty)
        engine.stop()
    }

    func testScheduledRowsLoadAfterBootstrapAndFollowEvents() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let general = server.createChannel("general", ownerId: alice.id)
        let row = server.schedule(alice.id, channelId: general.id, body: "later", sendAt: "2026-10-03T00:00:00Z")
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: alice.id), connect: server.connector(for: alice.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        await engine.start()
        await settle(engine)
        XCTAssertEqual(store.listScheduled().map(\.body), ["later"])
        let second = server.schedule(alice.id, channelId: general.id, body: "sooner", sendAt: "2026-10-02T00:00:00Z")
        server.emitScheduled(alice.id, second)
        await settle(engine)
        XCTAssertEqual(store.listScheduled().map(\.body), ["sooner", "later"]) // soonest first
        server.emitScheduled(alice.id, ScheduledOut(id: row.id, channelId: row.channelId, parentId: nil, clientMsgId: row.clientMsgId, body: row.body, attachments: [],
                                                     sendAt: row.sendAt, status: "sent", error: nil, sentMessageId: "m1", createdAt: row.createdAt))
        server.emitScheduled(alice.id, ScheduledOut(id: second.id, channelId: second.channelId, parentId: nil, clientMsgId: second.clientMsgId, body: second.body, attachments: [],
                                                     sendAt: second.sendAt, status: "cancelled", error: nil, sentMessageId: nil, createdAt: second.createdAt))
        await settle(engine)
        XCTAssertTrue(store.listScheduled().isEmpty)
        engine.stop()
    }

    func testFavoritesSyncAndReadAllClearsEveryChannel() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let general = server.createChannel("general", ownerId: alice.id)
        let random = server.createChannel("random", ownerId: alice.id)
        server.join(general.id, bob.id)
        server.join(random.id, bob.id)
        server.setFavorite(bob.id, channelId: random.id, on: true)
        _ = try server.post(channelId: general.id, senderId: alice.id, body: "one")
        _ = try server.post(channelId: general.id, senderId: alice.id, body: "two")
        _ = try server.post(channelId: random.id, senderId: alice.id, body: "three")
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        await engine.start()
        await settle(engine)
        XCTAssertEqual(store.favorites, [random.id])
        XCTAssertEqual(store.channel(general.id)?.unreadCount, 2)
        XCTAssertEqual(store.channel(random.id)?.unreadCount, 1)

        server.setFavorite(bob.id, channelId: general.id, on: true) // another device starred it
        await settle(engine)
        XCTAssertTrue(store.isFavorite(general.id))

        try await engine.markAllRead()
        XCTAssertEqual(store.channel(general.id)?.unreadCount, 0)
        XCTAssertEqual(store.channel(general.id)?.lastReadSeq, 2)
        XCTAssertEqual(store.channel(random.id)?.unreadCount, 0)
        engine.stop()
    }

    func testChannelSettingsKeepMyRoleAndHideChannelsMadePrivate() async throws {  // M15
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let general = server.createChannel("general", ownerId: alice.id)
        var options = EngineOptions()
        options.sleep = { _ in }
        let owner = Store()
        let outsider = Store()
        let engines = [(alice.id, owner), (bob.id, outsider)].map { id, store in
            SyncEngine(api: server.api(for: id), connect: server.connector(for: id), wsUrl: URL(string: "ws://fake")!, store: store,
                       getAccessToken: { "t" }, options: options)
        }
        for engine in engines {
            await engine.start()
            await settle(engine)
        }
        XCTAssertEqual(owner.channel(general.id)?.channel.membership?.role, "owner")
        XCTAssertEqual(outsider.channel(general.id)?.isMember, false)

        server.updateChannel(general.id, postingPolicy: "owners")
        for engine in engines { await settle(engine) }
        XCTAssertEqual(owner.channel(general.id)?.channel.isAnnouncement, true)
        XCTAssertEqual(owner.channel(general.id)?.canPostTopLevel(isAdmin: false), true) // the event carries no membership

        server.updateChannel(general.id, type: "private")
        for engine in engines { await settle(engine) }
        XCTAssertEqual(owner.channel(general.id)?.channel.type, "private")
        XCTAssertNil(outsider.channel(general.id))
        for engine in engines { engine.stop() }
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
        XCTAssertEqual(store.channel(general.id)?.channel.memberCount, 1) // M11h: shown by the channel browser
        XCTAssertNil(store.channel(secret.id))
        server.join(general.id, bob.id)
        server.emitMembership(general.id, bob.id)
        await settle(engine)
        XCTAssertEqual(store.channel(general.id)?.isMember, true)
        XCTAssertEqual(store.channel(general.id)?.channel.memberCount, 2) // member_added keeps the count current
        engine.stop()
    }

    // MARK: release fixes (SYNC_PROTOCOL.md §5.3, §7.2–§7.4, §9, §10, §11)

    func testOutboxSendsWhatIsQueuedMeanwhileAndBacksOffOnTemporaryFailures() async throws {  // §9
        let w = makeWorld(outboxRetry: 0.02)
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        await settle(w.engine)

        // A send queued while another one is in flight goes out in the same run, in order.
        var release: CheckedContinuation<Void, Never>?
        w.api.beforePost = {
            if w.api.calls.filter({ $0 == "post" }).count == 1 { await withCheckedContinuation { release = $0 } }
        }
        let first = Task { await w.engine.send(w.channel.id, body: "first") }
        for _ in 0..<100 where release == nil { await Task.yield() }
        XCTAssertNotNil(release)
        await w.engine.send(w.channel.id, body: "second")
        XCTAssertEqual(w.store.outbox.map(\.body), ["first", "second"])
        release?.resume()
        await first.value
        await settle(w.engine)
        XCTAssertTrue(w.store.outbox.isEmpty)
        XCTAssertEqual(w.server.channels[w.channel.id]?.messages.map(\.body), ["first", "second"])
        w.api.beforePost = nil

        // Temporary failures (503, no network) pause the queue; the backoff timer resumes it while connected.
        w.api.failures["post"] = [ApiError.api(status: 503, code: "unavailable", message: ""), ApiError.network(URLError(.timedOut))]
        await w.engine.send(w.channel.id, body: "third")
        XCTAssertEqual(w.store.outbox.map(\.body), ["third"])
        for _ in 0..<100 where !w.store.outbox.isEmpty {
            try await Task.sleep(nanoseconds: 20_000_000)
            await settle(w.engine)
        }
        XCTAssertTrue(w.store.outbox.isEmpty)
        XCTAssertEqual(w.api.calls.filter { $0 == "post" }.count, 5) // first, second, and third three times
        XCTAssertEqual(w.server.channels[w.channel.id]?.messages.map(\.body), ["first", "second", "third"])

        // A refused message stays failed (after a restart too) and the ones behind it still go out.
        w.engine.stop()
        await w.engine.send(w.channel.id, body: "refused")
        await w.engine.send(w.channel.id, body: "fourth")
        w.api.failures["post"] = [ApiError.api(status: 403, code: "posting_restricted", message: "")]
        await w.engine.start()
        await settle(w.engine)
        XCTAssertEqual(w.store.outbox.map(\.body), ["refused"])
        XCTAssertEqual(w.store.outbox.first?.failed, "posting_restricted")
        XCTAssertEqual(w.store.messages(w.channel.id).first { $0.body == "refused" }?.failed, true)
        XCTAssertEqual(Store.fromSnapshot(w.store.snapshot()).outbox.first?.failed, "posting_restricted")
        XCTAssertEqual(w.server.channels[w.channel.id]?.messages.last?.body, "fourth")
        w.engine.stop()
    }

    func testHalfOpenConnectionIsDroppedTwoIntervalsAfterTheLastFrame() async throws {  // §5.3
        let w = makeWorld(heartbeat: 0.2) // ping every 0.2 s, dead after 0.4 s of silence
        await w.engine.start()
        await settle(w.engine)
        let first = try XCTUnwrap(w.server.sockets(of: w.bob.id).first)
        first.silent = true // pings still go out, nothing comes back
        for _ in 0..<100 where w.engine.reconnects == 0 { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(first.closed)
        XCTAssertEqual(w.engine.reconnects, 1)
        await waitOnline(w.engine)
        XCTAssertEqual(w.engine.status, .online)

        // Answered pings keep a healthy connection up across many intervals.
        try await Task.sleep(nanoseconds: 1_200_000_000)
        await settle(w.engine)
        XCTAssertEqual(w.engine.reconnects, 1)
        XCTAssertEqual(w.engine.status, .online)
        w.engine.stop()
    }

    func testAuthRefusalRenewsTheTokenAndReconnectsInsteadOfSigningOut() async throws {  // §5.3, §7.2
        let w = makeWorld()
        var refreshes: [Bool] = []
        var signedOut = false
        w.engine.onSignedOut = { signedOut = true }
        w.engine.prepareConnection = { refresh in refreshes.append(refresh) }
        w.server.refuseAuths = ["auth_required"] // the auth frame reached the server after its 5 s window
        await w.engine.start()
        await waitOnline(w.engine)
        XCTAssertEqual(w.engine.status, .online)
        XCTAssertEqual(refreshes, [false, true])
        XCTAssertFalse(signedOut)

        // A live connection closed with 4001 does the same.
        w.server.disconnect(w.bob.id, code: closeAuthFailed)
        await waitOnline(w.engine)
        XCTAssertEqual(refreshes, [false, true, true])

        // An ordinary drop keeps a token that is still valid.
        w.server.disconnect(w.bob.id)
        await waitOnline(w.engine)
        XCTAssertEqual(refreshes, [false, true, true, false])
        XCTAssertFalse(signedOut)

        // Only a refresh the server rejects signs out.
        w.engine.prepareConnection = { refresh in
            refreshes.append(refresh)
            if refresh { throw ApiError.api(status: 401, code: "session_revoked", message: "revoked") }
        }
        w.server.refuseAuths = ["session_revoked"]
        w.server.disconnect(w.bob.id)
        for _ in 0..<50 where w.engine.status != .signedOut { await settle(w.engine) }
        XCTAssertEqual(w.engine.status, .signedOut)
        XCTAssertEqual(refreshes.suffix(2), [false, true])
        XCTAssertTrue(signedOut)
    }

    func testTimelineWindowKeepsOldRowsOutAndPagesFromItsStart() async throws {  // §7.3
        let w = makeWorld() // pages of 3
        for i in 1...6 { try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m\(i)") }
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m4", "m5", "m6"])
        XCTAssertEqual(w.store.channel(w.channel.id)?.oldestLoadedSeq, 4)

        // Older rows arrive on their own: a live reaction on m2, and (while away) a reply that bumps m1 into the delta.
        let m1 = try w.server.messageByBody(w.channel.id, "m1")
        let m2 = try w.server.messageByBody(w.channel.id, "m2")
        try w.server.react(channelId: w.channel.id, userId: w.alice.id, messageId: m2.id, emoji: "👍", present: true)
        await settle(w.engine)
        w.server.disconnect(w.bob.id)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "reply", parentId: m1.id)
        await waitOnline(w.engine)
        XCTAssertNotNil(w.store.message(w.channel.id, id: m2.id)) // kept …
        XCTAssertEqual(w.store.message(w.channel.id, id: m1.id)?.replyCount, 1)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m4", "m5", "m6"]) // … but outside the window: no hole

        await w.engine.loadOlder(w.channel.id) // before seq 4, not before m1
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m1", "m2", "m3", "m4", "m5", "m6"])
        XCTAssertEqual(w.store.messages(w.channel.id).first { $0.body == "m2" }?.reactions.map(\.emoji), ["👍"])
        XCTAssertEqual(w.store.channel(w.channel.id)?.oldestLoadedSeq, 0)
        XCTAssertEqual(w.store.channel(w.channel.id)?.hasOlder, false)
        XCTAssertEqual(Store.fromSnapshot(w.store.snapshot()).channel(w.channel.id)?.oldestLoadedSeq, 0) // persisted with the channel

        // A timeline stored before the window existed is read again from the newest page when it is caught up;
        // a message still waiting to be sent survives that.
        w.engine.stop()
        w.store.updateChannel(w.channel.id) { $0.oldestLoadedSeq = nil }
        await w.engine.send(w.channel.id, body: "unsent")
        w.api.failures["post"] = [ApiError.network(URLError(.notConnectedToInternet))]
        await w.engine.start()
        await settle(w.engine)
        XCTAssertEqual(w.engine.reloads, 1)
        XCTAssertEqual(w.store.channel(w.channel.id)?.oldestLoadedSeq, 4)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m4", "m5", "m6", "unsent"])
        XCTAssertEqual(w.store.messages(w.channel.id).last?.pending, true)
        w.engine.stop()
    }

    func testBootstrapReadStateIsTheServersAndUnsentMarksAreSentAgain() async throws {  // §10
        let w = makeWorld()
        w.engine.isActive = { true }
        for body in ["m1", "m2", "m3"] { try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: body) }
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        await settle(w.engine)

        // A mark whose PUT fails is remembered (persisted with the store) …
        w.api.failures["markRead"] = [ApiError.network(URLError(.notConnectedToInternet))]
        w.engine.markRead(w.channel.id, seq: 3)
        await w.engine.flushReads()
        XCTAssertEqual(w.server.readState(userId: w.bob.id, channelId: w.channel.id).lastReadSeq, 0)
        XCTAssertEqual(Store.fromSnapshot(w.store.snapshot()).unsentReads[w.channel.id], 3)
        // … and sent after reconnecting: bootstrap's position is taken as it is, then the mark goes on top again.
        w.server.disconnect(w.bob.id)
        await waitOnline(w.engine)
        XCTAssertEqual(w.server.readState(userId: w.bob.id, channelId: w.channel.id).lastReadSeq, 3)
        XCTAssertEqual(w.store.channel(w.channel.id).map { [$0.lastReadSeq, $0.unreadCount] }, [3, 0])
        XCTAssertTrue(w.store.unsentReads.isEmpty)

        // No max merge: another device moved the position back while this one was away …
        w.server.disconnect(w.bob.id)
        try w.server.markRead(userId: w.bob.id, channelId: w.channel.id, seq: 1, mode: "set")
        await waitOnline(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id).map { [$0.lastReadSeq, $0.unreadCount] }, [1, 2])
        // … so the rows on screen can be read again.
        w.engine.markRead(w.channel.id, seq: 3)
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertEqual(w.server.readState(userId: w.bob.id, channelId: w.channel.id).lastReadSeq, 3)
        w.engine.stop()
    }

    func testUnsentThreadReadsAndMarksMadeBeforeQuittingAreSentLater() async throws {  // §10
        let w = makeWorld()
        w.engine.isActive = { true }
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        await w.engine.send(w.channel.id, body: "topic") // bob's own post: he follows its thread
        await settle(w.engine)
        let topic = try w.server.messageByBody(w.channel.id, "topic")
        let (answer, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "answer", parentId: topic.id)
        await settle(w.engine)

        w.api.failures["markThreadRead"] = [ApiError.network(URLError(.timedOut))]
        w.engine.markThreadRead(topic.id, seq: answer.seq)
        await w.engine.flushReads()
        XCTAssertEqual(try w.server.threadState(userId: w.bob.id, parentId: topic.id).lastReadSeq, 0)
        w.server.disconnect(w.bob.id)
        await waitOnline(w.engine)
        XCTAssertEqual(try w.server.threadState(userId: w.bob.id, parentId: topic.id).lastReadSeq, answer.seq)
        XCTAssertTrue(w.store.unsentReads.isEmpty)

        // The app quits while a mark is still debouncing: the next launch sends it.
        let (late, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "late")
        await settle(w.engine)
        w.api.failures["markRead"] = [ApiError.network(URLError(.timedOut))]
        w.engine.markRead(w.channel.id, seq: late.seq)
        let saved = w.store.snapshot()
        w.engine.stop()
        var options = EngineOptions()
        options.sleep = { _ in }
        let restored = Store.fromSnapshot(saved)
        let next = SyncEngine(api: w.server.api(for: w.bob.id), connect: w.server.connector(for: w.bob.id), wsUrl: URL(string: "ws://fake")!,
                              store: restored, getAccessToken: { "t" }, options: options)
        await next.start()
        await waitOnline(next)
        XCTAssertEqual(w.server.readState(userId: w.bob.id, channelId: w.channel.id).lastReadSeq, late.seq)
        XCTAssertEqual(restored.channel(w.channel.id).map { [$0.lastReadSeq, $0.unreadCount] }, [late.seq, 0])
        XCTAssertTrue(restored.unsentReads.isEmpty)
        next.stop()
    }

    func testThreadOpenedWithoutItsTimelineStaysLive() async throws {  // §7.4
        let w = makeWorld()
        let (parent, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "topic")
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "r1", parentId: parent.id)
        await w.engine.start() // no conversation open: the channel's timeline is not loaded
        await settle(w.engine)
        XCTAssertNil(w.store.channel(w.channel.id)?.syncedSeq)
        await w.engine.loadReplies(w.channel.id, parentId: parent.id) // the thread opens from 「スレッド」
        XCTAssertEqual(w.store.replies(w.channel.id, parentId: parent.id).map(\.body), ["r1"])

        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "r2", parentId: parent.id)
        let r1 = try w.server.messageByBody(w.channel.id, "r1")
        try w.server.edit(channelId: w.channel.id, userId: w.alice.id, messageId: r1.id, body: "r1 edited")
        await settle(w.engine)
        XCTAssertEqual(w.store.replies(w.channel.id, parentId: parent.id).map(\.body), ["r1 edited", "r2"])

        // Rows nobody holds stay out, and the timeline is still not loaded.
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "elsewhere")
        await settle(w.engine)
        XCTAssertNil(w.store.message(w.channel.id, id: try w.server.messageByBody(w.channel.id, "elsewhere").id))
        XCTAssertNil(w.store.channel(w.channel.id)?.syncedSeq)
        XCTAssertEqual(w.store.channel(w.channel.id)?.lastSeq, 5)
        w.engine.stop()
    }

    func testMyThreadReplyLeavesTheChannelUnread() async throws {  // §10
        let w = makeWorld()
        let (parent, _) = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "topic")
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "later")
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id).map { [$0.lastReadSeq, $0.unreadCount] }, [0, 2])

        await w.engine.send(w.channel.id, body: "my reply", parentId: parent.id)
        await w.engine.send(w.channel.id, body: "shared reply", parentId: parent.id, options: SendOptions(alsoInChannel: true))
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id).map { [$0.lastReadSeq, $0.unreadCount] }, [0, 2])
        XCTAssertEqual(w.server.readState(userId: w.bob.id, channelId: w.channel.id).unreadCount, 2)

        await w.engine.send(w.channel.id, body: "top-level") // a post in the channel reads it
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(w.channel.id).map { [$0.lastReadSeq, $0.unreadCount] }, [5, 0])
        w.engine.stop()
    }

    func testLosingTheOpenChannelDoesNotBreakReconnecting() async throws {  // §7.3, §7.6
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        await settle(w.engine)

        // Removed while this device was away: bootstrap drops the channel and the browse list brings it back as a
        // public channel to join; the connection does not try to catch it up (403 not_a_member) and stays up.
        w.server.disconnect(w.bob.id)
        w.server.channels[w.channel.id]?.members.remove(w.bob.id)
        await waitOnline(w.engine)
        XCTAssertEqual(w.engine.status, .online)
        XCTAssertEqual(w.engine.reconnects, 1)
        XCTAssertNil(w.engine.currentChannelId)
        XCTAssertEqual(w.store.channel(w.channel.id)?.isMember, false)
        w.server.disconnect(w.bob.id)
        await waitOnline(w.engine)
        XCTAssertEqual(w.engine.reconnects, 2) // one reconnect per drop, no loop

        // Re-joined, then removed live: member_removed forgets it as the open conversation as well.
        w.server.join(w.channel.id, w.bob.id)
        w.server.emitMembership(w.channel.id, w.bob.id)
        await settle(w.engine)
        await w.engine.openChannel(w.channel.id)
        XCTAssertEqual(w.engine.currentChannelId, w.channel.id)
        w.server.removeMember(w.channel.id, w.bob.id)
        await settle(w.engine)
        XCTAssertNil(w.engine.currentChannelId)
        XCTAssertNil(w.store.channel(w.channel.id))

        // One conversation refusing its catch-up (403 / 404) does not fail the whole connection either.
        w.server.join(w.channel.id, w.bob.id)
        w.server.emitMembership(w.channel.id, w.bob.id)
        await settle(w.engine)
        await w.engine.openChannel(w.channel.id)
        XCTAssertNotNil(w.store.channel(w.channel.id)?.syncedSeq)
        w.api.failures["delta"] = [ApiError.api(status: 403, code: "not_a_member", message: "")]
        w.server.disconnect(w.bob.id)
        await waitOnline(w.engine)
        XCTAssertEqual(w.engine.status, .online)
        XCTAssertEqual(w.engine.reconnects, 3)
        XCTAssertEqual(w.api.failures["delta"]?.count, 0) // it was asked, and refused
        w.engine.stop()
    }

    func testNewTopLevelMessagesMoveTheConversationUp() async throws {  // §7.4
        let w = makeWorld()
        let dm = w.server.createChannel("", ownerId: w.alice.id, type: "dm")
        w.server.join(dm.id, w.bob.id)
        await w.engine.start()
        await settle(w.engine)
        XCTAssertNil(w.store.channel(dm.id)?.channel.lastMessageAt)
        let (first, _) = try w.server.post(channelId: dm.id, senderId: w.alice.id, body: "hi")
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(dm.id)?.channel.lastMessageAt, first.createdAt)
        try w.server.post(channelId: dm.id, senderId: w.alice.id, body: "in a thread", parentId: first.id)
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(dm.id)?.channel.lastMessageAt, first.createdAt) // a plain reply does not
        let (shared, _) = try w.server.post(channelId: dm.id, senderId: w.alice.id, body: "shared", parentId: first.id, options: SendOptions(alsoInChannel: true))
        await settle(w.engine)
        XCTAssertEqual(w.store.channel(dm.id)?.channel.lastMessageAt, shared.createdAt)
        w.engine.stop()
    }

    func testAccountStoreFileIsPerAccountAndGoesAtSignOut() throws {  // §11
        let a = try SQLitePersistence.location(profile: "https://chat.example.com|toru.k")
        let b = try SQLitePersistence.location(profile: "https://chat.example.com|toru-k")
        XCTAssertNotEqual(a, b) // the old sanitised names were both "…-toru-k"
        let profile = "https://test.invalid|" + UUID().uuidString
        let persistence = try SQLitePersistence.open(profile: profile)
        let store = Store(persistence: persistence)
        store.setDraft("c1") { $0.text = "secret draft" }
        let url = try SQLitePersistence.location(profile: profile)
        XCTAssertTrue(FileManager.default.fileExists(atPath: url.path))
        store.close()
        SQLitePersistence.destroy(profile: profile)
        for suffix in ["", "-wal", "-shm"] { XCTAssertFalse(FileManager.default.fileExists(atPath: url.path + suffix), suffix) }
        store.setDraft("c1") { $0.text = "after sign-out" } // a closed store fails quietly, it does not recreate the file
        XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
    }
}
