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
}
