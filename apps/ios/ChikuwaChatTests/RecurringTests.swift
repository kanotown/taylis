import XCTest
@testable import ChikuwaChat

/// L6 (M60, RECURRING.md): the summaries, the form's checks and bodies and the collection chip (the web's
/// tests/recurring.test.ts, case for case, in Asia/Tokyo), decoding (also from servers before M59), the request bodies,
/// and a collection change reaching the stored post (message.updated, change "collection", with a new seq).
@MainActor
final class RecurringTests: XCTestCase {
    private typealias R = RecurringRules

    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() { CalendarDates.zoneOverride = nil }

    /// A local time in Tokyo.
    private func local(_ year: Int, _ month: Int, _ day: Int, _ hour: Int = 12) -> Date {
        CalendarDates.local.date(from: DateComponents(year: year, month: month, day: day, hour: hour))!
    }

    // MARK: summaries

    func testSchedulesReadTheWayPeopleSayThem() {
        XCTAssertEqual(R.clockLabel("09:00"), "9:00")
        XCTAssertEqual(R.clockLabel("18:30"), "18:30")
        XCTAssertEqual(R.scheduleSummary(.weekly([3, 0], time: "09:00")), "毎週 月・木 9:00")
        XCTAssertEqual(R.scheduleSummary(.weekly([0, 1, 2, 3, 4, 5, 6], time: "08:15")), "毎日 8:15")
        XCTAssertEqual(R.scheduleSummary(.weekly([6], time: "23:59")), "毎週 日 23:59")
        XCTAssertEqual(R.scheduleSummary(.monthly(1, time: "09:00")), "毎月 1 日 9:00")
        XCTAssertEqual(R.scheduleSummary(.monthly(30, time: "09:00")), "毎月 30 日 (ない月は末日) 9:00")
        XCTAssertEqual(R.scheduleSummary(.monthly(31, time: "18:00")), "毎月 末日 18:00")
        // Another zone than this device's is named.
        XCTAssertEqual(R.scheduleSummary(.monthly(1, time: "09:00"), tz: "America/New_York", localTz: "Asia/Tokyo"), "毎月 1 日 9:00 (America/New_York)")
        XCTAssertEqual(R.scheduleSummary(.monthly(1, time: "09:00"), tz: "Asia/Tokyo", localTz: "Asia/Tokyo"), "毎月 1 日 9:00")
    }

    func testDueDatesAndTargets() {
        XCTAssertEqual(R.dueSummary(CollectDue(afterDays: 0, time: "18:00")), "当日 18:00 締切")
        XCTAssertEqual(R.dueSummary(CollectDue(afterDays: 3, time: "09:30")), "3 日後 9:30 締切")
        XCTAssertEqual(R.shortDateTime("2026-10-09T09:00:00Z"), "10/9 (金) 18:00")
        XCTAssertEqual(R.shortDateTime("2026-10-04T15:05:00Z"), "10/5 (月) 0:05")
        XCTAssertEqual(R.shortDateTime("2026-10-09T09:00:00.123456Z"), "10/9 (金) 18:00")
        let groups = ["g1": "students"]
        let users = ["u1": "ボブ", "u2": "キャロル"]
        let due = CollectDue(afterDays: 1, time: "18:00")
        func summary(_ targets: CollectTargets) -> String {
            R.targetsSummary(CollectSpec(targets: targets, due: due), groupName: { groups[$0] }, userName: { users[$0] })
        }
        XCTAssertEqual(summary(CollectTargets(allMembers: true, groupIds: ["g1"])), "チャンネルの全員")
        XCTAssertEqual(summary(CollectTargets(groupIds: ["g1"], userIds: ["u1", "u2"])), "@students、ボブ、キャロル")
        XCTAssertEqual(summary(CollectTargets(userIds: ["u1", "u2", "u1", "u2", "u1", "u2"])), "ボブ、キャロル、ボブ、キャロル ほか 2")
        XCTAssertEqual(summary(CollectTargets(groupIds: ["gone"], userIds: ["gone"])), "@グループ、?")
    }

    func testThePlaceholdersReadWithTodaysValues() {
        XCTAssertEqual(R.placeholderHint(today: local(2026, 9, 28)),
                       "{date} → 2026/09/28 (月)、{weekday} → 月、{week} → 週番号 (例 2026-W40)。投稿した日に置き換わります")
        XCTAssertTrue(R.placeholderHint(today: local(2027, 1, 1)).contains("(例 2026-W53)"))
        // Late in the evening in Tokyo is still that day (not the UTC one).
        XCTAssertTrue(R.placeholderHint(today: local(2026, 10, 1, 23)).hasPrefix("{date} → 2026/10/01 (木)"))
    }

    // MARK: who manages

    func testOwnersAndAdministratorsWhoAreMembersInChannelsOnly() {
        func channel(type: String = "public", role: String? = "member", member: Bool = true) -> ChannelState {
            let out = ChannelOut(id: "c", type: type, name: "c", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0, lastMessageAt: nil,
                                 createdAt: "", updatedAt: "", membership: role.map { MembershipOut(role: $0, joinedAt: "") }, dmUserIds: nil)
            let store = Store()
            store.upsertChannel(out, isMember: member)
            return store.channel("c")!
        }
        XCTAssertTrue(R.canManage(channel(role: "owner"), isAdmin: false))
        XCTAssertTrue(R.canManage(channel(), isAdmin: true))
        XCTAssertTrue(R.canManage(channel(type: "private", role: "owner"), isAdmin: false))
        XCTAssertFalse(R.canManage(channel(), isAdmin: false))
        XCTAssertFalse(R.canManage(channel(member: false), isAdmin: true))
        XCTAssertFalse(R.canManage(channel(type: "dm"), isAdmin: true))
        XCTAssertFalse(R.canManage(channel(type: "group_dm", role: "owner"), isAdmin: false))
        XCTAssertFalse(R.canManage(nil, isAdmin: true))
    }

    // MARK: the form's draft

    private func valid(_ change: (inout RecurringDraft) -> Void = { _ in }) -> RecurringDraft {
        var draft = RecurringDraft.empty(now: local(2026, 10, 1))
        draft.name = "週報"
        draft.body = "**週報 {date}**"
        change(&draft)
        return draft
    }

    func testANewDraftStartsOnTodaysWeekdayAtNine() {
        let draft = RecurringDraft.empty(now: local(2026, 10, 1)) // a Thursday
        XCTAssertEqual(draft.kind, .weekly)
        XCTAssertEqual(draft.weekdays, [3])
        XCTAssertEqual(draft.time, "09:00")
        XCTAssertFalse(draft.collect)
        XCTAssertEqual(draft.afterDays, 3)
        XCTAssertEqual(draft.dueTime, "18:00")
        XCTAssertEqual(RecurringDraft.empty(now: local(2026, 10, 4)).weekdays, [6]) // Sunday
        XCTAssertEqual(RecurringDraft.empty(now: local(2026, 10, 5)).weekdays, [0]) // Monday
    }

    func testTheDraftNamesWhatIsMissing() {
        XCTAssertNil(valid().problem)
        XCTAssertEqual(valid { $0.name = "  " }.problem, "名前を入力してください")
        XCTAssertEqual(valid { $0.name = String(repeating: "あ", count: 41) }.problem, "名前は 40 文字までです")
        // Spaces fold, as on the server.
        XCTAssertNil(valid { $0.name = "  " + String(repeating: "あ", count: 20) + "   " + String(repeating: "い", count: 19) + " " }.problem)
        XCTAssertEqual(valid { $0.body = "\n " }.problem, "本文を入力してください")
        XCTAssertEqual(valid { $0.body = String(repeating: "x", count: 4001) }.problem, "本文は 4000 文字までです")
        XCTAssertEqual(valid { $0.weekdays = [] }.problem, "曜日を 1 つ以上選んでください")
        XCTAssertNil(valid { $0.kind = .monthly; $0.weekdays = []; $0.day = 31 }.problem)
        XCTAssertEqual(valid { $0.kind = .monthly; $0.day = 0 }.problem, "日は 1〜31 で選んでください")
        XCTAssertEqual(valid { $0.time = "" }.problem, "時刻を選んでください")
        XCTAssertEqual(valid { $0.time = "24:00" }.problem, "時刻を選んでください")
        XCTAssertEqual(valid { $0.collect = true }.problem, "提出する人を選んでください")
        XCTAssertNil(valid { $0.collect = true; $0.allMembers = true }.problem)
        XCTAssertNil(valid { $0.collect = true; $0.groupIds = ["g"] }.problem)
        XCTAssertEqual(valid { $0.collect = true; $0.userIds = ["u"]; $0.afterDays = 31 }.problem, "締切は 0〜30 日後で選んでください")
        XCTAssertEqual(valid { $0.collect = true; $0.userIds = ["u"]; $0.dueTime = "" }.problem, "締切の時刻を選んでください")
        // Collecting off: its fields do not matter.
        XCTAssertNil(valid { $0.collect = false; $0.dueTime = "" }.problem)
    }

    func testTheRequestBodies() throws {
        XCTAssertEqual(valid { $0.weekdays = [4, 0, 4] }.create(tz: "Asia/Tokyo").json, try json("""
            {"name": "週報", "body": "**週報 {date}**", "schedule": {"kind": "weekly", "weekdays": [0, 4], "time": "09:00"},
             "tz": "Asia/Tokyo", "collect": null, "enabled": true}
            """))
        let monthly = valid { $0.kind = .monthly; $0.day = 15; $0.collect = true; $0.groupIds = ["g"]; $0.userIds = ["u"]; $0.afterDays = 0; $0.dueTime = "17:00" }
        XCTAssertEqual(monthly.update.json, try json("""
            {"name": "週報", "body": "**週報 {date}**", "schedule": {"kind": "monthly", "day": 15, "time": "09:00"},
             "collect": {"targets": {"all_members": false, "group_ids": ["g"], "user_ids": ["u"]}, "due": {"after_days": 0, "time": "17:00"}}}
            """))
        // 「チャンネルの全員」 sends no names.
        XCTAssertEqual(valid { $0.collect = true; $0.allMembers = true; $0.userIds = ["u"] }.create(tz: "Asia/Tokyo").collect,
                       CollectSpec(targets: CollectTargets(allMembers: true), due: CollectDue(afterDays: 3, time: "18:00")))
        // Turning collecting off sends null; the name is trimmed (the server folds the inner spaces).
        let off = valid { $0.name = "  週報  " }.update.json
        guard case .object(let fields) = off else { return XCTFail("not an object") }
        XCTAssertEqual(fields["collect"], .null)
        XCTAssertEqual(fields["name"], .string("週報"))
        XCTAssertNil(fields["tz"]) // an edit keeps the post's zone
        // 止める / 再開 send only the flag.
        XCTAssertEqual(RecurringPostPatch(enabled: false).json, .object(["enabled": .bool(false)]))
        XCTAssertEqual(RecurringPostPatch().json, .object([:]))
    }

    func testAPostReadsBack() throws {
        let post = try decodePost("""
            {"id": "p", "channel_id": "c", "bot_user_id": "b", "created_by": "u", "name": "日報", "body": "{date}", "tz": "Asia/Tokyo",
             "enabled": true, "schedule": {"kind": "monthly", "day": 31, "time": "18:00"},
             "collect": {"targets": {"all_members": false, "group_ids": ["g"], "user_ids": []}, "due": {"after_days": 2, "time": "12:00"}},
             "next_run_at": "2026-10-31T09:00:00Z", "last_run_at": null, "created_at": "", "updated_at": ""}
            """)
        let draft = RecurringDraft(post: post)
        XCTAssertEqual(draft.name, "日報")
        XCTAssertEqual(draft.kind, .monthly)
        XCTAssertEqual(draft.day, 31)
        XCTAssertEqual(draft.time, "18:00")
        XCTAssertTrue(draft.collect)
        XCTAssertEqual(draft.groupIds, ["g"])
        XCTAssertEqual(draft.afterDays, 2)
        XCTAssertEqual(draft.dueTime, "12:00")
        XCTAssertEqual(draft.update.collect, .some(post.collect))
        // A weekly one keeps its weekdays; one that does not collect keeps the defaults for when it is turned on.
        let weekly = RecurringDraft(post: try decodePost("""
            {"id": "q", "name": "週報", "body": "x", "schedule": {"kind": "weekly", "weekdays": [0, 4], "time": "09:00"}, "tz": "Asia/Tokyo",
             "collect": null, "enabled": false, "next_run_at": "2026-10-05T00:00:00Z"}
            """))
        XCTAssertEqual(weekly.weekdays, [0, 4])
        XCTAssertFalse(weekly.collect)
        XCTAssertEqual(weekly.afterDays, 3)
    }

    // MARK: the chip

    private func collection(_ submitted: [String], targets: [String] = ["a", "b", "c"], due: String = "2026-10-09T09:00:00Z") -> CollectionOut {
        CollectionOut(dueAt: due, targetUserIds: targets, targetCount: targets.count, submittedUserIds: submitted, remindedAt: nil)
    }
    private let before = parseIsoDate("2026-10-08T00:00:00Z")!
    private let after = parseIsoDate("2026-10-09T09:00:01Z")!

    func testTheChipCountsAndDates() {
        XCTAssertEqual(R.chip(collection(["a"]), meId: nil, now: before),
                       R.Chip(label: "提出 1/3 · 締切 10/9 (金) 18:00", mine: nil, overdue: false, complete: false))
        let all = R.chip(collection(["a", "b", "c"]), meId: "z", now: after)
        XCTAssertEqual(all.label, "提出 3/3 · 締切 10/9 (金) 18:00")
        XCTAssertTrue(all.overdue)
        XCTAssertTrue(all.complete)
        let none = R.chip(collection([], targets: []), meId: "a", now: before)
        XCTAssertEqual(none.label, "提出 0/0 · 締切 10/9 (金) 18:00")
        XCTAssertNil(none.mine)
        XCTAssertFalse(none.complete)
        // Exactly at the due time it has passed.
        XCTAssertTrue(R.chip(collection([]), meId: nil, now: parseIsoDate("2026-10-09T09:00:00Z")!).overdue)
    }

    func testTheChipSaysWhetherIOweOne() {
        XCTAssertEqual(R.chip(collection(["a"]), meId: "b", now: before).mine, .pending)
        XCTAssertEqual(R.chip(collection(["a"]), meId: "a", now: before).mine, .submitted)
        let late = R.chip(collection(["a"]), meId: "b", now: after)
        XCTAssertEqual(late.mine, .pending)
        XCTAssertTrue(late.overdue)
        XCTAssertEqual(late.accessibilityLabel, "提出 1/3 · 締切 10/9 (金) 18:00 (未提出、締切を過ぎています)")
        XCTAssertEqual(R.chip(collection(["a"]), meId: "a", now: before).accessibilityLabel, "提出 1/3 · 締切 10/9 (金) 18:00 (提出済み)")
    }

    func testTheListsKeepTheTargetsOrder() {
        let lists = R.lists(collection(["c", "a"]))
        XCTAssertEqual(lists.submitted, ["a", "c"])
        XCTAssertEqual(lists.missing, ["b"])
    }

    // MARK: decoding

    func testAMessageCarriesItsCollectionAndOlderServersNone() throws {
        let base = """
            "id": "m", "channel_id": "c", "sender_id": "bot", "seq": 4, "updated_seq": 5, "client_msg_id": null, "body": "週報",
            "created_at": "2026-10-01T00:00:00Z", "edited_at": null, "deleted": false
            """
        let message = try JSON.snakeDecoder.decode(MessageOut.self, from: Data("""
            {\(base), "collection": {"due_at": "2026-10-09T09:00:00Z", "target_user_ids": ["a", "b"], "target_count": 2,
             "submitted_user_ids": ["b"], "reminded_at": null}}
            """.utf8))
        XCTAssertEqual(message.collection, CollectionOut(dueAt: "2026-10-09T09:00:00Z", targetUserIds: ["a", "b"], targetCount: 2, submittedUserIds: ["b"]))
        XCTAssertNil(try JSON.snakeDecoder.decode(MessageOut.self, from: Data("{\(base)}".utf8)).collection)
        XCTAssertNil(try JSON.snakeDecoder.decode(MessageOut.self, from: Data("{\(base), \"collection\": null}".utf8)).collection)
        // A short collection still reads (the count from the targets); the state keeps it and persists it.
        let short = try JSON.snakeDecoder.decode(MessageOut.self, from: Data("{\(base), \"collection\": {\"due_at\": \"2026-10-09T09:00:00Z\", \"target_user_ids\": [\"a\"]}}".utf8))
        XCTAssertEqual(short.collection?.targetCount, 1)
        XCTAssertEqual(short.collection?.submittedUserIds, [])
        let state = MessageState(message)
        let stored = try JSONDecoder().decode(MessageState.self, from: JSONEncoder().encode(state))
        XCTAssertEqual(stored.collection, message.collection)
        XCTAssertEqual(MessageOut(stored)?.collection, message.collection)
        // A row persisted before M60 has none.
        var raw = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(state)) as? [String: Any])
        raw.removeValue(forKey: "collection")
        XCTAssertNil(try JSONDecoder().decode(MessageState.self, from: JSONSerialization.data(withJSONObject: raw)).collection)
    }

    func testRecurringPostsDecodeTolerantly() throws {
        let post = try decodePost("""
            {"id": "p", "channel_id": "c", "bot_user_id": "b", "created_by": "u", "name": "週報", "body": "{date}",
             "schedule": {"kind": "weekly", "weekdays": [4], "time": "09:00"}, "tz": "Asia/Tokyo",
             "collect": {"targets": {"all_members": true}, "due": {"after_days": 3, "time": "18:00"}},
             "enabled": true, "next_run_at": "2026-10-02T00:00:00Z", "last_run_at": null, "created_at": "x", "updated_at": "y", "later": 1}
            """)
        XCTAssertEqual(post.schedule, .weekly([4], time: "09:00"))
        XCTAssertEqual(post.collect, CollectSpec(targets: CollectTargets(allMembers: true), due: CollectDue(afterDays: 3, time: "18:00")))
        XCTAssertEqual(post.nextRunAt, "2026-10-02T00:00:00Z")
        // A later server's schedule kind still reads (its time shown), and a collect it cannot read is none.
        let odd = try decodePost("""
            {"id": "q", "name": "x", "schedule": {"kind": "yearly", "month": 4, "time": "08:00"}, "collect": {"targets": 3}}
            """)
        XCTAssertEqual(odd.schedule.kind, "yearly")
        XCTAssertNil(odd.collect)
        XCTAssertTrue(odd.enabled)
        XCTAssertEqual(R.scheduleSummary(odd.schedule), "8:00")
        let reminder = try JSON.snakeDecoder.decode(ReminderOut.self, from: Data("""
            {"id": "r", "message_id": "m", "channel_id": "c", "note": "週報 の提出をお願いします (締切 10/9 (金) 18:00)", "preview": "週報",
             "remind_at": "2026-10-09T09:00:00Z", "status": "fired", "fired_at": "2026-10-09T09:00:05Z", "created_at": "", "kind": "collect"}
            """.utf8))
        XCTAssertEqual(reminder.kind, "collect")
    }

    // MARK: the collection follows the thread

    func testACollectionChangeReachesTheStoredPost() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("週報", ownerId: alice.id)
        server.join(channel.id, bob.id)
        let store = Store()
        var options = EngineOptions()
        options.reconnectMin = 0
        options.sleep = { _ in }
        options.random = { 0.5 }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "token" }, options: options)
        engine.isActive = { false }
        await engine.start()
        await engine.openChannel(channel.id)
        await settle(engine)

        // The post goes out (message.created), then its collection (message.updated, change collection, a new seq).
        let (post, _) = try server.post(channelId: channel.id, senderId: alice.id, body: "**週報 2026/10/01 (木)**")
        await settle(engine)
        XCTAssertNil(store.message(channel.id, id: post.id)?.collection)
        let open = CollectionOut(dueAt: "2026-10-09T09:00:00Z", targetUserIds: [alice.id, bob.id], submittedUserIds: [])
        server.setCollection(channelId: channel.id, messageId: post.id, open)
        await settle(engine)
        XCTAssertEqual(store.message(channel.id, id: post.id)?.collection, open)
        XCTAssertEqual(R.chip(open, meId: bob.id).mine, .pending)

        // Bob replies in the thread: the reply's parent_thread moves the counters, then the collection follows.
        _ = try server.post(channelId: channel.id, senderId: bob.id, body: "今週は実験", parentId: post.id)
        await settle(engine)
        var submitted = open
        submitted.submittedUserIds = [bob.id]
        let updated = try XCTUnwrap(server.setCollection(channelId: channel.id, messageId: post.id, submitted))
        await settle(engine)
        let row = try XCTUnwrap(store.message(channel.id, id: post.id))
        XCTAssertEqual(row.collection?.submittedUserIds, [bob.id])
        XCTAssertEqual(row.updatedSeq, updated.updatedSeq)
        XCTAssertEqual(row.replyCount, 1)
        XCTAssertEqual(store.channel(channel.id)?.syncedSeq, updated.updatedSeq)
        XCTAssertEqual(R.chip(row.collection!, meId: bob.id).mine, .submitted)

        // An older version arriving late (a page read before the change) never takes it back.
        var stale = MessageOut(row)!
        stale = MessageOut(id: stale.id, channelId: stale.channelId, senderId: stale.senderId, seq: stale.seq, updatedSeq: updated.updatedSeq - 1,
                           clientMsgId: stale.clientMsgId, body: stale.body, createdAt: stale.createdAt, editedAt: nil, deleted: false, collection: open)
        XCTAssertFalse(store.upsertMessage(stale))
        XCTAssertEqual(store.message(channel.id, id: post.id)?.collection?.submittedUserIds, [bob.id])
        engine.stop()
    }

    private func settle(_ engine: SyncEngine) async {
        for _ in 0..<50 {
            await engine.idle()
            await Task.yield()
        }
    }

    // MARK: helpers

    private func json(_ text: String) throws -> JSONValue { try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)) }

    private func decodePost(_ text: String) throws -> RecurringPostOut { try JSON.snakeDecoder.decode(RecurringPostOut.self, from: Data(text.utf8)) }
}
