import XCTest
@testable import ChikuwaChat

/// Runs the real ApiClient + SyncEngine + WebSocketTransport against a live backend.
/// Enabled with TEST_RUNNER_LIVE_URL / TEST_RUNNER_LIVE_PASS (users dtuser1 / dtuser2), e.g. the compose stack.
@MainActor
final class LiveBackendTests: XCTestCase {
    func testLoginSyncRealtimeAndSend() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let liveUrl = environment["LIVE_URL"], let url = URL(string: liveUrl) else {
            throw XCTSkip("LIVE_URL not set")
        }
        let password = environment["LIVE_PASS"] ?? ""
        let alice = ApiClient(baseUrl: url)
        let bob = ApiClient(baseUrl: url)
        _ = try await alice.login(username: "dtuser1", password: password, device: DeviceInfo(platform: "ios", deviceName: "live-test", appVersion: "0.1.0"))
        _ = try await bob.login(username: "dtuser2", password: password, device: DeviceInfo(platform: "ios", deviceName: "live-test", appVersion: "0.1.0"))
        let channel = try await alice.createChannel(name: "ios-" + String(Int(Date().timeIntervalSince1970)), type: "public")
        _ = try await bob.joinChannel(id: channel.id)

        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: bob, connect: { url, _ in try await WebSocketTransport.connect(url: url) }, wsUrl: bob.wsUrl,
                                store: store, getAccessToken: { bob.accessToken }, options: options)
        await engine.openChannel(channel.id)
        await engine.start()
        await engine.idle()
        XCTAssertEqual(engine.status, .online)
        XCTAssertEqual(store.me?.username, "dtuser2")
        XCTAssertEqual(store.channel(channel.id)?.isMember, true)

        _ = try await alice.postMessage(channelId: channel.id, clientMsgId: UUID().uuidString.lowercased(), body: "hello from the real server")
        for _ in 0..<100 where store.messages(channel.id).count < 1 {
            try await Task.sleep(nanoseconds: 50_000_000)
            await engine.idle()
        }
        XCTAssertEqual(store.messages(channel.id).map(\.body), ["hello from the real server"])
        XCTAssertEqual(store.channel(channel.id)?.syncedSeq, 1)

        await engine.send(channel.id, body: "reply from the iOS engine")
        for _ in 0..<100 where store.channel(channel.id)?.syncedSeq != 2 {
            try await Task.sleep(nanoseconds: 50_000_000)
            await engine.idle()
        }
        let history = try await alice.history(channelId: channel.id, beforeSeq: nil, limit: 10)
        XCTAssertEqual(history.messages.map(\.body), ["reply from the iOS engine", "hello from the real server"])
        XCTAssertTrue(store.messages(channel.id).allSatisfy { !$0.pending })

        engine.stop()
        await alice.logout()
        await bob.logout()
    }

    /// L8 (TIMES_FEED.md): the Times feed against a live server: someone's post reaches my feed page and, live, the model
    /// the engine feeds; is:times finds it; 「すべて既読にする」 (scope times) reads that times to its end. Enabled with
    /// TEST_RUNNER_LIVE_TIMES_URL / TEST_RUNNER_LIVE_TIMES_PASS (users LIVE_TIMES_USERS, "me,owner").
    func testTimesFeed() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let liveUrl = environment["LIVE_TIMES_URL"], let url = URL(string: liveUrl) else { throw XCTSkip("LIVE_TIMES_URL not set") }
        let password = environment["LIVE_TIMES_PASS"] ?? ""
        let names = (environment["LIVE_TIMES_USERS"] ?? "dtuser1,dtuser2").split(separator: ",").map(String.init)
        let me = ApiClient(baseUrl: url)
        let owner = ApiClient(baseUrl: url)
        let device = DeviceInfo(platform: "ios", deviceName: "live-test", appVersion: "0.1.0")
        _ = try await me.login(username: names[0], password: password, device: device)
        _ = try await owner.login(username: names[1], password: password, device: device)
        let times = try await owner.ensureTimes()
        _ = try? await me.joinChannel(id: times.id)

        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: me, connect: { url, _ in try await WebSocketTransport.connect(url: url) }, wsUrl: me.wsUrl,
                                store: store, getAccessToken: { me.accessToken }, options: options)
        let model = TimesFeedModel()
        engine.onTimelineMessage = { event, message, thread in model.live(event, message, thread: thread, channel: store.channel(message.channelId)) }
        await engine.start()
        await engine.idle()
        XCTAssertEqual(store.channel(times.id)?.channel.timesOwnerId, times.timesOwnerId)
        model.visible = true
        await model.refresh(fetch: { try await me.timesFeed(cursor: $0, limit: 5) }, channel: { store.channel($0) })
        XCTAssertTrue(model.loaded)

        let word = "feedcheck\(Int(Date().timeIntervalSince1970))"
        let (posted, _) = try await owner.postMessage(channelId: times.id, clientMsgId: UUID().uuidString.lowercased(), body: "作業ログ \(word)")
        for _ in 0..<100 where model.list.items.first?.id != posted.id {
            try await Task.sleep(nanoseconds: 50_000_000)
            await engine.idle()
        }
        XCTAssertEqual(model.list.items.first?.id, posted.id) // live, at the top
        let page = try await me.timesFeed(limit: 5)
        XCTAssertEqual(page.items.first?.id, posted.id)
        XCTAssertTrue(TimesFeedList.isNew(posted, channel: store.channel(times.id), meId: store.me?.id))

        var params = SearchParams(q: word, isTimes: true)
        params.sort = .newest
        let found = try await me.searchMessages(SearchLogic.request(params))
        XCTAssertEqual(found.filters?.isTimes, true)
        XCTAssertEqual(found.hits.map(\.message.id), [posted.id])

        engine.applyReadAll(try await me.readAll(scope: "times"))
        XCTAssertEqual(store.channel(times.id)?.lastReadSeq, posted.seq)
        XCTAssertFalse(TimesFeedList.isNew(posted, channel: store.channel(times.id), meId: store.me?.id))

        engine.stop()
        await me.logout()
        await owner.logout()
    }

    /// M52: the calendar against a live server (CALENDAR.md §4, §5): a shared event made twice with one key, seen by the other
    /// member through calendar.event.updated (can_edit from editor_ids), my alarm, the tab count, the deletion, a personal
    /// all-day event. Enabled with TEST_RUNNER_LIVE_CAL_URL / TEST_RUNNER_LIVE_CAL_PASS (users LIVE_CAL_USERS, "a,b").
    func testCalendar() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let liveUrl = environment["LIVE_CAL_URL"], let url = URL(string: liveUrl) else { throw XCTSkip("LIVE_CAL_URL not set") }
        let password = environment["LIVE_CAL_PASS"] ?? ""
        let names = (environment["LIVE_CAL_USERS"] ?? "dtuser1,dtuser2").split(separator: ",").map(String.init)
        let device = DeviceInfo(platform: "ios", deviceName: "live-test", appVersion: "0.1.0")
        let alice = ApiClient(baseUrl: url), bob = ApiClient(baseUrl: url)
        _ = try await alice.login(username: names[0], password: password, device: device)
        _ = try await bob.login(username: names[1], password: password, device: device)
        let channel = try await alice.createChannel(name: "ios-cal-" + String(Int(Date().timeIntervalSince1970)), type: "public")
        _ = try await bob.joinChannel(id: channel.id)

        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: bob, connect: { url, _ in try await WebSocketTransport.connect(url: url) }, wsUrl: bob.wsUrl,
                                store: store, getAccessToken: { bob.accessToken }, options: options)
        await engine.start()
        await engine.idle()
        let hub = try XCTUnwrap(engine.calendar)
        let today = CalendarDates.today()
        await hub.open("view", from: CalendarDates.parseDay(today), to: CalendarDates.parseDay(CalendarDates.addDays(today, 30)))
        XCTAssertEqual(hub.window("view")?.state, .ready)
        await engine.openChannel(channel.id)

        var draft = EventDraft.new(on: CalendarDates.addDays(today, 1), channelId: channel.id)
        draft.title = "iOS のライブ確認"
        draft.location = "5 号館"
        let key = UUID().uuidString.lowercased()
        let made = try await alice.createCalendarEvent(draft.create(tz: CalendarDates.zoneId, clientEventId: key))
        let again = try await alice.createCalendarEvent(draft.create(tz: CalendarDates.zoneId, clientEventId: key))
        XCTAssertEqual(made.id, again.id) // one event for one key
        XCTAssertTrue(made.canEdit)
        for _ in 0..<100 where hub.find(made.id) == nil { try await Task.sleep(nanoseconds: 50_000_000) }
        let seen = try XCTUnwrap(hub.find(made.id))
        XCTAssertEqual(seen.title, "iOS のライブ確認")
        XCTAssertFalse(seen.canEdit) // bob made none of it
        XCTAssertEqual(seen.channelName, channel.name)
        for _ in 0..<100 where hub.upcomingOf(channel.id)?.contains(where: { $0.id == made.id }) != true {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(hub.upcomingOf(channel.id)?.map(\.id), [made.id])

        try await hub.setAlarm(made.id, minutes: 10)
        XCTAssertEqual(hub.find(made.id)?.alarm?.minutesBefore, 10)
        XCTAssertEqual(hub.find(made.id)?.alarm?.status, "pending")
        var patch = EventDraft(event: made)
        patch.title = "iOS のライブ確認 (変更)"
        _ = try await alice.updateCalendarEvent(id: made.id, patch.patch)
        for _ in 0..<100 where hub.find(made.id)?.title != patch.title { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertEqual(hub.find(made.id)?.title, patch.title)
        XCTAssertEqual(hub.find(made.id)?.alarm?.minutesBefore, 10) // mine stays through the shared event

        try await alice.deleteCalendarEvent(id: made.id)
        for _ in 0..<100 where hub.find(made.id) != nil { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertNil(hub.find(made.id))

        var personal = EventDraft.new(on: today)
        personal.title = "iOS の自分用"
        personal = personal.settingAllDay(true)
        personal.alarm = -480
        let mine = try await hub.create(personal.create(tz: CalendarDates.zoneId, clientEventId: UUID().uuidString.lowercased()))
        XCTAssertNil(mine.channelId)
        XCTAssertTrue(mine.allDay)
        XCTAssertEqual(mine.startDate, today)
        XCTAssertEqual(mine.alarm?.minutesBefore, -480)
        XCTAssertTrue(hub.window("view")?.events.contains { $0.id == mine.id } == true)
        let fetched = try await bob.calendarEvent(id: mine.id)
        XCTAssertEqual(fetched.title, "iOS の自分用")
        try await hub.remove(mine.id)

        engine.stop()
        _ = try? await alice.archiveChannel(id: channel.id)
        await alice.logout()
        await bob.logout()
    }

    /// M56: tasks against a live server (TASKS.md §3, §4, §8): a board task made from a message twice with one key, seen
    /// by its assignee through task.updated (can_delete from deleter_ids) and task.assigned, in 「自分のタスク」 and the
    /// calendar range; moved, its source cut when the message is deleted, deleted by the assignee; a personal task
    /// completed and deleted. Everything made is removed again. Enabled with TEST_RUNNER_LIVE_TASK_URL /
    /// TEST_RUNNER_LIVE_TASK_PASS, users LIVE_TASK_USERS ("a,b"), in LIVE_TASK_CHANNEL (a public channel both are in).
    func testTasks() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let liveUrl = environment["LIVE_TASK_URL"], let url = URL(string: liveUrl) else { throw XCTSkip("LIVE_TASK_URL not set") }
        guard let channelId = environment["LIVE_TASK_CHANNEL"] else { throw XCTSkip("LIVE_TASK_CHANNEL not set") }
        let password = environment["LIVE_TASK_PASS"] ?? ""
        let names = (environment["LIVE_TASK_USERS"] ?? "dtuser1,dtuser2").split(separator: ",").map(String.init)
        let device = DeviceInfo(platform: "ios", deviceName: "live-test", appVersion: "0.1.0")
        let alice = ApiClient(baseUrl: url), bob = ApiClient(baseUrl: url)
        _ = try await alice.login(username: names[0], password: password, device: device)
        _ = try await bob.login(username: names[1], password: password, device: device)
        let bobId = try await bob.me().id

        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: bob, connect: { url, _ in try await WebSocketTransport.connect(url: url) }, wsUrl: bob.wsUrl,
                                store: store, getAccessToken: { bob.accessToken }, options: options)
        var notices: [TaskNotice] = []
        engine.onTaskNotice = { notices.append($0) }
        await engine.start()
        await engine.idle()
        XCTAssertNotNil(store.me?.notifyTasks) // a server with tasks says so in UserMe
        let hub = try XCTUnwrap(engine.tasks)
        let today = CalendarDates.today()
        await hub.openBoard(channelId)
        await hub.openMine()
        await hub.openDue("calendar", from: today, to: CalendarDates.addDays(today, 30))
        XCTAssertEqual(hub.board(channelId)?.state, .ready)
        XCTAssertEqual(hub.mine?.state, .ready)

        let (message, _) = try await alice.postMessage(channelId: channelId, clientMsgId: UUID().uuidString.lowercased(),
                                                       body: "iOS のライブ確認: **資料**をまとめる")
        var draft = TaskDraft(title: "iOS のライブ確認", channelId: channelId)
        draft.dueOn = CalendarDates.addDays(today, 1)
        draft.assigneeIds = [bobId]
        draft.sourceMessageId = message.id
        let key = UUID().uuidString.lowercased()
        let made = try await alice.createTask(draft.create(clientTaskId: key, tz: CalendarDates.zoneId))
        let again = try await alice.createTask(draft.create(clientTaskId: key, tz: CalendarDates.zoneId))
        XCTAssertEqual(made.id, again.id) // one task for one key
        XCTAssertEqual(made.source?.excerpt, "iOS のライブ確認: 資料をまとめる")
        for _ in 0..<100 where hub.board(channelId)?.tasks.contains(where: { $0.id == made.id }) != true {
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let seen = try XCTUnwrap(hub.board(channelId)?.tasks.first { $0.id == made.id })
        XCTAssertTrue(seen.canDelete) // an assignee may delete
        XCTAssertTrue(hub.mine?.tasks.contains { $0.id == made.id } == true)
        XCTAssertTrue(hub.dueWindow("calendar")?.tasks.contains { $0.id == made.id } == true)
        for _ in 0..<100 where notices.isEmpty { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertEqual(notices.first, .assigned(TaskAssigned(taskId: made.id, channelId: channelId, channelName: made.channelName ?? "",
                                                             title: "iOS のライブ確認", byUserId: made.ownerId)))

        let moved = try await hub.move(made.id, to: .doing, .none)
        XCTAssertEqual(moved.status, .doing)
        XCTAssertEqual(hub.find(made.id)?.status, .doing)

        _ = try await alice.deleteMessage(id: message.id)
        for _ in 0..<100 where hub.find(made.id)?.source?.messageId != nil { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertEqual(TaskRules.sourceState(hub.find(made.id)?.source), .deleted)

        try await hub.remove(made.id)
        XCTAssertNil(hub.find(made.id))
        await XCTAssertThrowsErrorAsync(try await alice.task(id: made.id))

        var personal = TaskDraft(title: "iOS の自分用")
        personal.dueOn = today
        let mine = try await hub.create(personal.create(clientTaskId: UUID().uuidString.lowercased(), tz: CalendarDates.zoneId))
        XCTAssertNil(mine.channelId)
        XCTAssertTrue(mine.canDelete)
        XCTAssertTrue(hub.mine?.tasks.contains { $0.id == mine.id } == true)
        XCTAssertTrue(hub.dueWindow("calendar")?.tasks.contains { $0.id == mine.id } == true)
        let done = try await hub.update(mine.id, TaskPatch(status: .done))
        XCTAssertEqual(done.status, .done)
        XCTAssertNotNil(done.completedAt)
        try await hub.remove(mine.id)
        XCTAssertNil(hub.find(mine.id))

        engine.stop()
        await alice.logout()
        await bob.logout()
    }

    /// L6 (M60): recurring posts against a live server (RECURRING.md §3, §7): the owner's create (this client's body), the
    /// list a member reads, 今すぐ投稿, the collection reaching the other member's engine (message.updated, change
    /// collection) and following its reply, 止める, a member refused, 削除. Enabled with TEST_RUNNER_LIVE_REC_URL /
    /// TEST_RUNNER_LIVE_REC_PASS (users LIVE_REC_USERS, "a,b"); the channel is archived afterwards.
    func testRecurring() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let liveUrl = environment["LIVE_REC_URL"], let url = URL(string: liveUrl) else { throw XCTSkip("LIVE_REC_URL not set") }
        let password = environment["LIVE_REC_PASS"] ?? ""
        let names = (environment["LIVE_REC_USERS"] ?? "dtuser1,dtuser2").split(separator: ",").map(String.init)
        let device = DeviceInfo(platform: "ios", deviceName: "live-test", appVersion: "0.1.0")
        let alice = ApiClient(baseUrl: url), bob = ApiClient(baseUrl: url)
        _ = try await alice.login(username: names[0], password: password, device: device)
        _ = try await bob.login(username: names[1], password: password, device: device)
        let aliceMe = try await alice.me(), bobMe = try await bob.me()
        let channel = try await alice.createChannel(name: "ios-rec-" + String(Int(Date().timeIntervalSince1970)), type: "public")
        _ = try await bob.joinChannel(id: channel.id)

        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: bob, connect: { url, _ in try await WebSocketTransport.connect(url: url) }, wsUrl: bob.wsUrl,
                                store: store, getAccessToken: { bob.accessToken }, options: options)
        await engine.openChannel(channel.id)
        await engine.start()
        await engine.idle()

        var draft = RecurringDraft.empty()
        draft.name = "週報"
        draft.body = "**週報 {date}** ({weekday}, {week})"
        draft.collect = true
        draft.allMembers = true
        draft.afterDays = 1
        let post = try await alice.createRecurringPost(channelId: channel.id, draft.create(tz: CalendarDates.zoneId))
        XCTAssertEqual(post.schedule, draft.schedule)
        XCTAssertEqual(post.collect, draft.collectSpec)
        XCTAssertTrue(post.enabled)
        XCTAssertFalse(post.nextRunAt.isEmpty)
        let listed = try await bob.recurringPosts(channelId: channel.id)
        XCTAssertEqual(listed.map(\.id), [post.id])
        await XCTAssertThrowsErrorAsync(try await bob.runRecurringPost(id: post.id)) // a member: 403 recurring_manage_restricted

        let run = try await alice.runRecurringPost(id: post.id)
        func row() -> MessageState? { store.message(channel.id, id: run.messageId) }
        for _ in 0..<100 where row()?.collection == nil {
            try await Task.sleep(nanoseconds: 50_000_000)
            await engine.idle()
        }
        let collection = try XCTUnwrap(row()?.collection)
        XCTAssertEqual(Set(collection.targetUserIds), [aliceMe.id, bobMe.id])
        XCTAssertEqual(collection.submittedUserIds, [])
        XCTAssertFalse(row()?.body.contains("{date}") ?? true)
        XCTAssertEqual(RecurringRules.chip(collection, meId: bobMe.id).mine, .pending)

        _ = try await bob.postMessage(channelId: channel.id, clientMsgId: UUID().uuidString.lowercased(), body: "今週は実験", parentId: run.messageId)
        for _ in 0..<100 where row()?.collection?.submittedUserIds != [bobMe.id] {
            try await Task.sleep(nanoseconds: 50_000_000)
            await engine.idle()
        }
        XCTAssertEqual(row()?.collection?.submittedUserIds, [bobMe.id])
        XCTAssertEqual(RecurringRules.chip(try XCTUnwrap(row()?.collection), meId: bobMe.id).mine, .submitted)
        XCTAssertEqual(store.channel(channel.id)?.syncedSeq, store.channel(channel.id)?.lastSeq)

        let paused = try await alice.updateRecurringPost(id: post.id, RecurringPostPatch(enabled: false))
        XCTAssertFalse(paused.enabled)
        var edited = RecurringDraft(post: paused)
        edited.collect = false
        let plain = try await alice.updateRecurringPost(id: post.id, edited.update)
        XCTAssertNil(plain.collect)
        try await alice.deleteRecurringPost(id: post.id)
        let after = try await alice.recurringPosts(channelId: channel.id)
        XCTAssertTrue(after.isEmpty)

        engine.stop()
        _ = try? await alice.archiveChannel(id: channel.id)
        await alice.logout()
        await bob.logout()
    }
}

private func XCTAssertThrowsErrorAsync<T>(_ expression: @autoclosure () async throws -> T, file: StaticString = #filePath, line: UInt = #line) async {
    do {
        _ = try await expression()
        XCTFail("no error", file: file, line: line)
    } catch {}
}
