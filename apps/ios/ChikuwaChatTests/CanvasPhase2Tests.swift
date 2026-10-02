import XCTest
@testable import ChikuwaChat

/// M73 (CANVAS.md §18.5): Canvas Phase 2 on the phone — 「編集中」 (`canvas_presence`), canvas mentions, checklist items
/// to tasks and a task's 元のキャンバス.
@MainActor
final class CanvasPresenceTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func testTheSenderSaysChangesAtOnceAndRepeatsEvery20Seconds() {
        var sender = CanvasPresenceSender()
        XCTAssertNil(sender.next("c1", editing: false, section: nil, now: t0)) // a stop before any start says nothing
        XCTAssertEqual(sender.next("c1", editing: true, section: "TODO", now: t0), CanvasPresenceOut(canvasId: "c1", editing: true, section: "TODO"))
        XCTAssertNil(sender.next("c1", editing: true, section: "TODO", now: t0.addingTimeInterval(5)))
        XCTAssertNil(sender.next("c1", editing: true, section: " TODO ", now: t0.addingTimeInterval(19.9)))
        // Another heading goes out at once; the same one again after 20 s.
        XCTAssertEqual(sender.next("c1", editing: true, section: "決定事項", now: t0.addingTimeInterval(21))?.section, "決定事項")
        XCTAssertNil(sender.next("c1", editing: true, section: "決定事項", now: t0.addingTimeInterval(40)))
        XCTAssertNotNil(sender.next("c1", editing: true, section: "決定事項", now: t0.addingTimeInterval(41)))
        // Another canvas is its own; a stop goes out once.
        XCTAssertNotNil(sender.next("c2", editing: true, section: nil, now: t0.addingTimeInterval(41)))
        XCTAssertEqual(sender.next("c1", editing: false, section: "x", now: t0.addingTimeInterval(42)), CanvasPresenceOut(canvasId: "c1", editing: false, section: nil))
        XCTAssertNil(sender.next("c1", editing: false, section: nil, now: t0.addingTimeInterval(43)))
        // A new connection: the next start goes out at once.
        XCTAssertNil(sender.next("c2", editing: true, section: nil, now: t0.addingTimeInterval(45)))
        sender.reset()
        XCTAssertNotNil(sender.next("c2", editing: true, section: nil, now: t0.addingTimeInterval(45)))
    }

    func testTheHeadingIsOneLineOf120Characters() {
        XCTAssertNil(CanvasPresence.shownSection(nil))
        XCTAssertNil(CanvasPresence.shownSection("  \n "))
        XCTAssertEqual(CanvasPresence.shownSection("  議事録\n 2 章 "), "議事録 2 章")
        XCTAssertEqual(CanvasPresence.shownSection(String(repeating: "あ", count: 200))?.count, 120)
    }

    func testEditorsExpireAfter45SecondsUnlessRefreshed() {
        var editors = CanvasEditors()
        editors.note("c1", userId: "u-a", editing: true, section: "TODO", now: t0)
        editors.note("c1", userId: "u-b", editing: true, section: nil, now: t0.addingTimeInterval(10))
        XCTAssertEqual(editors.of("c1", now: t0.addingTimeInterval(11)), [CanvasEditingUser(userId: "u-a", section: "TODO"), CanvasEditingUser(userId: "u-b", section: nil)])
        XCTAssertEqual(editors.of("c2", now: t0), [])
        XCTAssertEqual(editors.nextExpiry("c1", now: t0), t0.addingTimeInterval(45))
        // u-a's entry runs out at 45 s; a refresh (with another heading) keeps it, in its place.
        XCTAssertEqual(editors.of("c1", now: t0.addingTimeInterval(45)).map(\.userId), ["u-b"])
        editors.note("c1", userId: "u-a", editing: true, section: "決定事項", now: t0.addingTimeInterval(30))
        XCTAssertEqual(editors.of("c1", now: t0.addingTimeInterval(50)), [CanvasEditingUser(userId: "u-a", section: "決定事項"), CanvasEditingUser(userId: "u-b", section: nil)])
        XCTAssertEqual(editors.of("c1", now: t0.addingTimeInterval(56)).map(\.userId), ["u-a"])
        // false ends it at once.
        editors.note("c1", userId: "u-a", editing: false, section: nil, now: t0.addingTimeInterval(60))
        XCTAssertEqual(editors.of("c1", now: t0.addingTimeInterval(60)), [])
        XCTAssertNil(editors.nextExpiry("c1", now: t0.addingTimeInterval(60)))
    }

    func testTheLabelNamesOneTwoOrTheFirstAndTheRest() {
        XCTAssertEqual(CanvasPresence.editingLabel([]), "")
        XCTAssertEqual(CanvasPresence.editingLabel(["加納"]), "加納 が編集中")
        XCTAssertEqual(CanvasPresence.editingLabel(["加納", "海老"]), "加納、海老 が編集中")
        XCTAssertEqual(CanvasPresence.editingLabel(["加納", "海老", "竹輪"]), "加納 ほか 2 人が編集中")
    }

    func testFramesBothWays() throws {
        let out = try XCTUnwrap(JSON.plainDecoder.decode([String: JSONValue].self, from: Data(ClientFrame.canvasPresence(canvasId: "c1", editing: true, section: "TODO").utf8)))
        XCTAssertEqual(out, ["type": .string("canvas_presence"), "canvas_id": .string("c1"), "editing": .bool(true), "section": .string("TODO")])
        let stop = try XCTUnwrap(JSON.plainDecoder.decode([String: JSONValue].self, from: Data(ClientFrame.canvasPresence(canvasId: "c1", editing: false, section: nil).utf8)))
        XCTAssertEqual(stop["section"], .null)
        XCTAssertEqual(stop["editing"], .bool(false))

        XCTAssertEqual(ServerFrame.parse(#"{"type":"canvas_presence","canvas_id":"c1","channel_id":"ch","user_id":"u-a","editing":true,"section":"TODO"}"#),
                       .canvasPresence(canvasId: "c1", channelId: "ch", userId: "u-a", editing: true, section: "TODO"))
        XCTAssertEqual(ServerFrame.parse(#"{"type":"canvas_presence","canvas_id":"c1","channel_id":"ch","user_id":"u-a","editing":false,"section":null}"#),
                       .canvasPresence(canvasId: "c1", channelId: "ch", userId: "u-a", editing: false, section: nil))
        XCTAssertEqual(ServerFrame.parse(#"{"type":"canvas_presence","canvas_id":"c1","user_id":"u-a"}"#),
                       .canvasPresence(canvasId: "c1", channelId: nil, userId: "u-a", editing: false, section: nil))
        XCTAssertNil(ServerFrame.parse(#"{"type":"canvas_presence","user_id":"u-a","editing":true}"#)) // no canvas
    }

    func testTheCaretsHeading() {
        let text = "前置き\n# 議事録\n本文\n## TODO\n- [ ] 資料\n```\n# コード\n```\n終わり"
        let ns = text as NSString
        XCTAssertNil(CanvasText.sectionAt(text, caret: 1))
        XCTAssertEqual(CanvasText.sectionAt(text, caret: ns.range(of: "本文").location), "議事録")
        XCTAssertEqual(CanvasText.sectionAt(text, caret: ns.range(of: "資料").location), "TODO")
        XCTAssertEqual(CanvasText.sectionAt(text, caret: ns.length), "TODO") // a heading in a code block is not one
        XCTAssertEqual(CanvasText.lineIndex(text, at: 0), 0)
        XCTAssertEqual(CanvasText.lineIndex(text, at: ns.range(of: "本文").location), 2)
        XCTAssertEqual(CanvasText.lineIndex(text, at: 10_000), 8)
    }
}

@MainActor
final class CanvasPresenceEngineTests: XCTestCase {
    private func makeEngine() -> (FakeServer, UserPublic, UserPublic, Store, SyncEngine) {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("general", ownerId: alice.id)
        server.join(channel.id, bob.id)
        _ = channel
        let store = Store()
        var options = EngineOptions()
        options.reconnectMin = 0
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "token" }, options: options)
        engine.isActive = { false }
        return (server, alice, bob, store, engine)
    }

    private func settle(_ engine: SyncEngine) async {
        for _ in 0..<30 {
            await engine.idle()
            await Task.yield()
        }
    }

    func testFramesGoOutThrottledAndOthersFramesAreKept() async throws {
        let (server, alice, bob, store, engine) = makeEngine()
        engine.setCanvasEditing("c1", editing: true, section: "TODO") // offline: nothing
        await engine.start()
        await settle(engine)
        let socket = try XCTUnwrap(server.sockets.first { $0.userId == bob.id })
        let t0 = Date()
        engine.setCanvasEditing("c1", editing: true, section: "TODO", now: t0)
        engine.setCanvasEditing("c1", editing: true, section: "TODO", now: t0.addingTimeInterval(3))
        engine.setCanvasEditing("c1", editing: true, section: "決定事項", now: t0.addingTimeInterval(4))
        engine.setCanvasEditing("c1", editing: false, now: t0.addingTimeInterval(5))
        await settle(engine)
        XCTAssertEqual(socket.canvasPresence.map { $0["section"] }, [.string("TODO"), .string("決定事項"), .null])
        XCTAssertEqual(socket.canvasPresence.map { $0["editing"] }, [.bool(true), .bool(true), .bool(false)])

        // Someone else's frame shows; my own (another device of mine) does not.
        socket.deliver(.object(["type": .string("canvas_presence"), "canvas_id": .string("c1"), "channel_id": .string("ch"), "user_id": .string(alice.id),
                                "editing": .bool(true), "section": .string("TODO")]))
        socket.deliver(.object(["type": .string("canvas_presence"), "canvas_id": .string("c1"), "channel_id": .string("ch"), "user_id": .string(bob.id),
                                "editing": .bool(true), "section": .null]))
        await settle(engine)
        XCTAssertEqual(store.canvasEditors("c1"), [CanvasEditingUser(userId: alice.id, section: "TODO")])
        XCTAssertEqual(store.canvasEditors("c1", now: Date().addingTimeInterval(46)), [])
        socket.deliver(.object(["type": .string("canvas_presence"), "canvas_id": .string("c1"), "user_id": .string(alice.id), "editing": .bool(false)]))
        await settle(engine)
        XCTAssertEqual(store.canvasEditors("c1"), [])
        engine.stop()
    }

    func testACanvasMentionIsSaidForOthersInMyConversations() async throws {
        let (server, alice, bob, store, engine) = makeEngine()
        var said: [CanvasMentioned] = []
        engine.onCanvasMention = { mention, _ in said.append(mention) }
        await engine.start()
        await settle(engine)
        let socket = try XCTUnwrap(server.sockets.first { $0.userId == bob.id })
        let channelId = try XCTUnwrap(store.channels.keys.first)
        func mention(_ id: Int, by: String, channel: String) {
            socket.deliver(.object(["type": .string("event"), "id": .number(Double(10_000 + id)), "event": .string("canvas.mentioned"), "ts": .string("2026-10-02T00:00:00Z"),
                                    "channel_id": .null, "seq": .null,
                                    "data": .object(["canvas_id": .string("c1"), "channel_id": .string(channel), "rev_id": .string("r\(id)"),
                                                     "title": .string("議事録"), "by_user_id": .string(by)])]))
        }
        mention(1, by: alice.id, channel: channelId)
        mention(2, by: bob.id, channel: channelId) // my own save
        mention(3, by: alice.id, channel: "c-unknown") // not a conversation of mine here
        await settle(engine)
        XCTAssertEqual(said, [CanvasMentioned(canvasId: "c1", channelId: channelId, revId: "r1", title: "議事録", byUserId: alice.id)])
        XCTAssertEqual(said.first?.noticeText { $0 == alice.id ? "アリス" : nil }, "アリス が「議事録」であなたをメンションしました")
        engine.stop()
    }
}

@MainActor
final class CanvasMentionPushTests: XCTestCase {
    func testTheMentionDecodesLeniently() throws {
        let full = try JSONValue.object(["canvas_id": .string("c1"), "channel_id": .string("ch"), "rev_id": .string("r1"), "title": .string("週報"),
                                         "by_user_id": .string("u-a")]).decode(CanvasMentioned.self)
        XCTAssertEqual(full, CanvasMentioned(canvasId: "c1", channelId: "ch", revId: "r1", title: "週報", byUserId: "u-a"))
        let bare = try JSONValue.object(["canvas_id": .string("c1"), "channel_id": .string("ch"), "title": .number(3)]).decode(CanvasMentioned.self)
        XCTAssertEqual(bare.title, "")
        XCTAssertEqual(bare.noticeText { _ in nil }, "メンバー が「キャンバス」であなたをメンションしました")
        XCTAssertThrowsError(try JSONValue.object(["channel_id": .string("ch")]).decode(CanvasMentioned.self))
    }

    func testACanvasPushOpensTheCanvasAndShowsInFront() {
        let payload = PushPayload(userInfo: ["kind": "canvas", "channel_id": "ch", "canvas_id": "c1", "workspace_id": "w"])
        XCTAssertEqual(payload.canvasId, "c1")
        XCTAssertTrue(payload.opensCanvas)
        XCTAssertFalse(payload.opensTask)
        XCTAssertFalse(PushPayload(userInfo: ["kind": "canvas", "channel_id": "ch"]).opensCanvas)
        XCTAssertFalse(PushPayload(userInfo: ["kind": "message", "canvas_id": "c1"]).opensCanvas)
        let here = Workspace(serverUrl: "https://a", username: "me")
        // Not the conversation's messages: shown even while that conversation is open.
        XCTAssertTrue(Workspaces.shouldPresent(payload, target: here, active: "https://a", openChannelId: "ch"))
        XCTAssertFalse(Workspaces.shouldPresent(PushPayload(userInfo: ["kind": "message", "channel_id": "ch"]), target: here, active: "https://a", openChannelId: "ch"))
    }
}

@MainActor
final class CanvasChecklistTaskTests: XCTestCase {
    private let bob = "0b0b0b0b-0000-4000-8000-000000000001"
    private let kano = "0c0c0c0c-0000-4000-8000-000000000002"

    private var users: [String: UserPublic] {
        [bob: UserPublic(id: bob, username: "bob", displayName: "ボブ", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""),
         kano: UserPublic(id: kano, username: "kano", displayName: "加納", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")]
    }

    private func store() -> Store {
        let store = Store()
        func add(_ id: String, type: String = "public", policy: String? = nil, archived: Bool = false, dmUserIds: [String]? = nil) {
            var out = ChannelOut(id: id, type: type, name: type == "public" ? id : nil, topic: nil, purpose: nil, archived: archived, createdBy: nil,
                                 lastSeq: 0, lastMessageAt: nil, createdAt: "", updatedAt: "",
                                 membership: type == "public" ? MembershipOut(role: "member", joinedAt: "") : nil, dmUserIds: dmUserIds)
            out.postingPolicy = policy
            store.upsertChannel(out, isMember: true)
        }
        add("lab")
        add("news", policy: "owners")
        add("dm", type: "dm", dmUserIds: ["u-me", kano])
        return store
    }

    func testChecklistItems() {
        let body = "# 議事録\n- [ ] 資料を送る\n  * [x] 済み\n- [ ]\n- 普通の行\n- [X] 大文字"
        XCTAssertNil(TaskRules.checklistItem(body, line: 0))
        XCTAssertEqual(TaskRules.checklistItem(body, line: 1), TaskRules.ChecklistItem(line: "- [ ] 資料を送る", text: "資料を送る", done: false))
        XCTAssertEqual(TaskRules.checklistItem(body, line: 2), TaskRules.ChecklistItem(line: "  * [x] 済み", text: "済み", done: true))
        XCTAssertEqual(TaskRules.checklistItem(body, line: 3), TaskRules.ChecklistItem(line: "- [ ]", text: "", done: false))
        XCTAssertNil(TaskRules.checklistItem(body, line: 4))
        XCTAssertEqual(TaskRules.checklistItem(body, line: 5)?.done, true)
        XCTAssertNil(TaskRules.checklistItem(body, line: 6))
        XCTAssertNil(TaskRules.checklistItem(body, line: -1))
    }

    func testAnItemOfAChannelsCanvasGoesToItsBoardWithDateAndAssignees() throws {
        let store = store()
        let body = "## TODO\n- [ ] <@\(bob)> と **資料** を送る 📅 2026-10-05 <@\(kano)> <@\(bob)> <@group:0d0d0d0d-0000-4000-8000-000000000003>"
        let draft = try XCTUnwrap(TaskRules.canvasTaskInit(canvasId: "cv1", body: body, line: 1, channel: store.channel("lab"), users: users, groups: [:], isAdmin: false))
        XCTAssertEqual(draft.title, "@ボブ と 資料 を送る @加納 @ボブ @グループ")
        XCTAssertEqual(draft.dueOn, "2026-10-05")
        XCTAssertEqual(draft.assigneeIds, [bob, kano]) // once each, groups not expanded
        XCTAssertEqual(draft.channelId, "lab")
        XCTAssertEqual(draft.boardChoices, ["lab"])
        XCTAssertNil(draft.dmChannelId)
        XCTAssertEqual(draft.sourceCanvasId, "cv1")
        XCTAssertEqual(draft.sourceCanvasLine, body.components(separatedBy: "\n")[1])
        XCTAssertEqual(draft.sourceCanvasExcerpt, "@ボブ と 資料 を送る 📅 2026-10-05 @加納 @ボブ @グループ")
        XCTAssertNil(draft.sourceMessageId)

        let create = draft.create(clientTaskId: "k", tz: "Asia/Tokyo")
        XCTAssertEqual(create.json["source_canvas_id"], .string("cv1"))
        XCTAssertEqual(create.json["source_canvas_line"], .string(draft.sourceCanvasLine!))
        XCTAssertEqual(create.json["due_on"], .string("2026-10-05"))
        XCTAssertEqual(create.json["assignee_ids"], .array([.string(bob), .string(kano)]))
        XCTAssertNil(create.json["source_message_id"])
    }

    func testWhereTheTaskGoesAndWhatIsLeftOut() throws {
        let store = store()
        let body = "- [ ] 会場を予約 <@\(kano)> 📅 2026-02-30\n- [x] 済んだ\n本文"
        // A board I may not add to: mine, no assignees.
        let news = try XCTUnwrap(TaskRules.canvasTaskInit(canvasId: "cv", body: body, line: 0, channel: store.channel("news"), users: users, groups: [:], isAdmin: false))
        XCTAssertNil(news.channelId)
        XCTAssertEqual(news.assigneeIds, [])
        XCTAssertEqual(news.dueOn, "") // not a real day
        XCTAssertEqual(news.title, "会場を予約 @加納")
        XCTAssertNil(news.create(clientTaskId: "k", tz: "Asia/Tokyo").json["channel_id"])
        // A DM's canvas: mine, shared in the DM with the people it mentions.
        let dm = try XCTUnwrap(TaskRules.canvasTaskInit(canvasId: "cv", body: body, line: 0, channel: store.channel("dm"), users: users, groups: [:], isAdmin: false))
        XCTAssertNil(dm.channelId)
        XCTAssertEqual(dm.dmChannelId, "dm")
        XCTAssertEqual(dm.assigneeIds, [kano])
        XCTAssertEqual(dm.create(clientTaskId: "k", tz: "Asia/Tokyo").channelId, "dm")
        // Unknown people are not assignees; a done item is still an item (the menus offer open ones only); other lines are not.
        let stranger = try XCTUnwrap(TaskRules.canvasTaskInit(canvasId: "cv", body: "- [ ] <@\(bob)>", line: 0, channel: store.channel("lab"), users: [:],
                                                              groups: [:], isAdmin: false))
        XCTAssertEqual(stranger.assigneeIds, [])
        XCTAssertNotNil(TaskRules.canvasTaskInit(canvasId: "cv", body: body, line: 1, channel: nil, users: users, groups: [:], isAdmin: false))
        XCTAssertNil(TaskRules.canvasTaskInit(canvasId: "cv", body: body, line: 2, channel: nil, users: users, groups: [:], isAdmin: false))
        // A long item: the title is cut to 200.
        let long = try XCTUnwrap(TaskRules.canvasTaskInit(canvasId: "cv", body: "- [ ] " + String(repeating: "あ", count: 300), line: 0, channel: nil,
                                                          users: users, groups: [:], isAdmin: false))
        XCTAssertEqual(long.title.count, 200)
    }

    func testRealDays() {
        XCTAssertTrue(TaskRules.validDay("2026-10-05"))
        XCTAssertTrue(TaskRules.validDay("2028-02-29"))
        XCTAssertFalse(TaskRules.validDay("2026-02-29"))
        XCTAssertFalse(TaskRules.validDay("2026-13-01"))
        XCTAssertFalse(TaskRules.validDay("2026-1-1x"))
    }

    func testATasksCanvasSourceDecodesLeniently() throws {
        func task(_ source: JSONValue?) throws -> TaskOut {
            var fields: [String: JSONValue] = ["id": .string("t1"), "channel_id": .string("lab"), "owner_id": .string("u-me"), "title": .string("資料"),
                                               "status": .string("todo"), "position": .number(1), "assignee_ids": .array([]), "created_at": .string(""),
                                               "updated_at": .string("")]
            if let source { fields["canvas_source"] = source }
            return try JSONValue.object(fields).decode(TaskOut.self)
        }
        XCTAssertEqual(try task(.object(["canvas_id": .string("cv1"), "excerpt": .string("資料を送る")])).canvasSource,
                       TaskCanvasSourceOut(canvasId: "cv1", excerpt: "資料を送る"))
        XCTAssertNil(try task(nil).canvasSource) // a server before M72, or a task not made from a canvas
        XCTAssertNil(try task(.null).canvasSource)
        XCTAssertNil(try task(.string("odd")).canvasSource) // an odd value never drops the task
        XCTAssertEqual(try task(.object(["canvas_id": .null, "excerpt": .string("資料")])).canvasSource, TaskCanvasSourceOut(canvasId: nil, excerpt: "資料"))
        XCTAssertEqual(try task(.object(["canvas_id": .number(1)])).canvasSource, TaskCanvasSourceOut(canvasId: nil, excerpt: nil))
    }

    func testWhatATaskSaysOfItsCanvas() {
        XCTAssertEqual(TaskRules.canvasSourceState(nil), .none)
        XCTAssertEqual(TaskRules.canvasSourceState(TaskCanvasSourceOut(canvasId: "cv1", excerpt: "抜粋")), .link(canvasId: "cv1", excerpt: "抜粋"))
        XCTAssertEqual(TaskRules.canvasSourceState(TaskCanvasSourceOut(canvasId: "cv1", excerpt: "")), .link(canvasId: "cv1", excerpt: nil))
        XCTAssertEqual(TaskRules.canvasSourceState(TaskCanvasSourceOut(canvasId: nil, excerpt: "抜粋")), .deleted(excerpt: "抜粋"))
        XCTAssertEqual(TaskRules.canvasSourceState(TaskCanvasSourceOut(canvasId: "", excerpt: nil)), .deleted(excerpt: nil))
    }

    func testOnlyBothCanvasFieldsGoOut() {
        var draft = TaskDraft(title: "x")
        draft.sourceCanvasId = "cv1"
        XCTAssertNil(draft.create(clientTaskId: "k", tz: "Asia/Tokyo").json["source_canvas_id"])
        draft.sourceCanvasLine = "- [ ] x"
        XCTAssertEqual(draft.create(clientTaskId: "k", tz: "Asia/Tokyo").json["source_canvas_id"], .string("cv1"))
        XCTAssertNil(TaskDraft(title: "x").create(clientTaskId: "k", tz: "Asia/Tokyo").json["source_canvas_line"])
    }
}
