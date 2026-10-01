import SwiftUI
import XCTest
@testable import ChikuwaChat

/// M54 (SCHEDULING.md): scheduling polls on the phone — the candidates (the web's schedulePolls.test.tsx cases), reading
/// the answers, the store's merge of my answers (SYNC_PROTOCOL.md §8), the requests, and the form's starting point.
@MainActor
final class SchedulePollTests: XCTestCase {
    private typealias S = SchedulePoll

    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() { CalendarDates.zoneOverride = nil }

    private func timed(_ day: DayKey, _ start: String, _ minutes: Int = 60) -> S.SlotDraft { .timed(day, S.minutes(start)!, minutes: minutes) }
    private func allDay(_ day: DayKey) -> S.SlotDraft { .wholeDay(day) }

    // MARK: the candidates

    func testLabelsAsTheServerDoes() {
        XCTAssertEqual(S.slotLabel(timed("2026-10-03", "14:00")), "10/3 (土) 14:00〜15:00")
        XCTAssertEqual(S.slotLabel(timed("2026-10-03", "09:05", 90)), "10/3 (土) 9:05〜10:35")
        XCTAssertEqual(S.slotLabel(allDay("2026-10-05")), "10/5 (月) 終日")
        XCTAssertEqual(S.slotLabel(timed("2026-10-06", "22:00", 120)), "10/6 (火) 22:00〜24:00")
        XCTAssertEqual(S.slotLabel(timed("2026-10-07", "23:00", 150)), "10/7 (水) 23:00〜翌1:30")
    }

    func testSendsLocalTimesAsUtcInstantsAndAllDayAsDates() {
        XCTAssertEqual(S.slotIn(timed("2026-10-03", "14:00")), S.SlotIn(startsAt: "2026-10-03T05:00:00Z", endsAt: "2026-10-03T06:00:00Z"))
        XCTAssertEqual(S.slotIn(allDay("2026-10-05")), S.SlotIn(date: "2026-10-05"))
        XCTAssertEqual(S.slotIn(allDay("2026-10-05")).json, .object(["date": .string("2026-10-05")]))
    }

    func testChecksTheFormBeforeSending() {
        let two = [timed("2026-10-03", "14:00"), allDay("2026-10-05")]
        XCTAssertEqual(S.problem(question: " ", slots: two), "題名を入れてください")
        XCTAssertEqual(S.problem(question: "ゼミ", slots: Array(two.prefix(1))), "候補を 2 つ以上選んでください")
        let many = (1...21).map { allDay(String(format: "2026-11-%02d", $0)) }
        XCTAssertEqual(S.problem(question: "ゼミ", slots: many), "候補は 20 個までです")
        XCTAssertEqual(S.problem(question: "ゼミ", slots: [timed("2026-10-03", "14:00", 10), allDay("2026-10-05")]), "時間の長さは 15 分〜12 時間にしてください")
        XCTAssertEqual(S.problem(question: "ゼミ", slots: [timed("2026-10-03", "14:00", 721), allDay("2026-10-05")]), "時間の長さは 15 分〜12 時間にしてください")
        XCTAssertEqual(S.problem(question: "ゼミ", slots: [S.SlotDraft(day: "2026-10-03", allDay: false, start: -1, minutes: 60), allDay("2026-10-05")]),
                       "時刻を入れてください")
        XCTAssertEqual(S.problem(question: "ゼミ", slots: [allDay("2026-10-05"), allDay("2026-10-05")]), "同じ候補が複数あります")
        XCTAssertNil(S.problem(question: "ゼミ", slots: [timed("2026-10-05", "10:00"), allDay("2026-10-05")]))
        XCTAssertNil(S.problem(question: "ゼミ", slots: [timed("2026-10-03", "14:00", 15), timed("2026-10-03", "14:00", 720)]))
    }

    func testOrdersThemAndReadsTheCommandsDates() throws {
        XCTAssertEqual(S.sortSlots([timed("2026-10-05", "13:00"), allDay("2026-10-05"), timed("2026-10-03", "9:00")]).map(S.slotLabel),
                       ["10/3 (土) 9:00〜10:00", "10/5 (月) 終日", "10/5 (月) 13:00〜14:00"])
        let today = Templates.Day(year: 2026, month: 9, day: 29)
        let read = try XCTUnwrap(Templates.readSchedule("ゼミ 10/3-10/4 13:00 10/6 9:30-12:00 10/3", today: today))
        XCTAssertEqual(read.question, "ゼミ")
        XCTAssertEqual(S.slots(from: read.entries).map(S.slotLabel), ["10/3 (土) 終日", "10/3 (土) 13:00〜14:00", "10/4 (日) 13:00〜14:00", "10/6 (火) 9:30〜12:00"])
        XCTAssertEqual(S.durationLabel(30), "30 分")
        XCTAssertEqual(S.durationLabel(60), "1 時間")
        XCTAssertEqual(S.durationLabel(90), "1 時間半")
        XCTAssertEqual(S.durationLabel(135), "2 時間 15 分")
        XCTAssertEqual(S.lengthChoices(80), [15, 30, 45, 60, 80, 90, 120, 180, 240, 360])
    }

    /// The web's form test, step by step on the pure rules the phone's form calls.
    func testTheFormsRulesForDaysTimesAndCandidates() {
        var slots: [S.SlotDraft] = []
        slots = S.toggle("2026-10-03", in: slots, allDay: false, start: 600, minutes: 60)
        slots = S.toggle("2026-09-30", in: slots, allDay: false, start: 600, minutes: 60)
        XCTAssertEqual(slots.map(S.slotLabel), ["9/30 (水) 10:00〜11:00", "10/3 (土) 10:00〜11:00"])
        // The time above goes to every candidate.
        slots = S.applyToAll(slots, start: S.minutes("14:00"))
        slots = S.applyToAll(slots, minutes: 90)
        XCTAssertEqual(slots.map(S.slotLabel), ["9/30 (水) 14:00〜15:30", "10/3 (土) 14:00〜15:30"])
        // One changed on its own; another time on the same day; picking a day again removes it.
        slots[1].start = S.minutes("13:00")!
        slots = S.addAfter(1, in: slots)
        XCTAssertEqual(slots.map(S.slotLabel), ["9/30 (水) 14:00〜15:30", "10/3 (土) 13:00〜14:30", "10/3 (土) 14:30〜16:00"])
        slots = S.toggle("2026-09-30", in: slots, allDay: false, start: 600, minutes: 60)
        XCTAssertEqual(slots.map(S.slotLabel), ["10/3 (土) 13:00〜14:30", "10/3 (土) 14:30〜16:00"])
        XCTAssertEqual(slots.map(S.slotIn), [S.SlotIn(startsAt: "2026-10-03T04:00:00Z", endsAt: "2026-10-03T05:30:00Z"),
                                             S.SlotIn(startsAt: "2026-10-03T05:30:00Z", endsAt: "2026-10-03T07:00:00Z")])
        // 終日 makes one candidate per day.
        XCTAssertEqual(S.applyToAll(slots, allDay: true).map(S.slotLabel), ["10/3 (土) 終日"])
        // Past midnight the next candidate starts at 10:00.
        XCTAssertEqual(S.addAfter(0, in: [timed("2026-10-06", "23:00", 120)]).map(S.slotLabel), ["10/6 (火) 10:00〜12:00", "10/6 (火) 23:00〜翌1:00"])
    }

    func testTheCommandOpensTheFormFilledInOrNothing() throws {
        let today = Templates.Day(year: 2026, month: 9, day: 29)
        XCTAssertEqual(ScheduleFormInitial.reading("", today: today)?.slots, [])
        let filled = try XCTUnwrap(ScheduleFormInitial.reading("ゼミ 10/3 10/4 13:00-14:30 10/6", today: today))
        XCTAssertEqual(filled.question, "ゼミ")
        XCTAssertEqual(filled.slots.map(S.slotLabel), ["10/3 (土) 終日", "10/4 (日) 13:00〜14:30", "10/6 (火) 終日"])
        XCTAssertNil(ScheduleFormInitial.reading("ゼミ 10/1 10/2 午後", today: today))
        // More than the old poll's 10 options is the form's to judge (the web's readSchedule has no limit).
        XCTAssertEqual(ScheduleFormInitial.reading("合宿 10/1-10/12", today: today)?.slots.count, 12)
    }

    // MARK: decoding and reading the answers

    private static let me = "u-me"

    private func message(_ updatedSeq: Int, poll: String) throws -> MessageOut {
        try JSON.snakeDecoder.decode(MessageOut.self, from: Data("""
        {"id": "m1", "channel_id": "c1", "sender_id": "u-alice", "seq": 3, "updated_seq": \(updatedSeq), "client_msg_id": null,
         "body": "📊 発表練習", "created_at": "2026-10-01T04:00:00Z", "edited_at": null, "deleted": false, "poll": \(poll)}
        """.utf8))
    }

    /// A scheduling poll as the server sends it (the dev server's own reply, 2026-10-01, trimmed).
    static func wire(anonymous: Bool = false, myAnswers: String = "null", myComment: String = "null", decided: String = "null",
                     answers: String? = nil, comments: String? = nil) -> String {
        let named = #"[{"yes": ["u-me", "u-bob"], "maybe": [], "no": ["u-carol"], "yes_count": 2, "maybe_count": 0, "no_count": 1},"#
            + #" {"yes": [], "maybe": ["u-me"], "no": [], "yes_count": 0, "maybe_count": 1, "no_count": 0}]"#
        let hidden = #"[{"yes": [], "maybe": [], "no": [], "yes_count": 2, "maybe_count": 0, "no_count": 1},"#
            + #" {"yes": [], "maybe": [], "no": [], "yes_count": 2, "maybe_count": 1, "no_count": 0}]"#
        return """
        {"question": "発表練習", "options": ["10/3 (土) 14:00〜15:00", "10/5 (月) 終日"], "multiple": true, "anonymous": \(anonymous),
         "closed_at": null, "votes": [[], []], "counts": [2, 0], "mine": null, "kind": "schedule",
         "slots": [{"starts_at": "2026-10-03T05:00:00Z", "ends_at": "2026-10-03T06:00:00Z", "date": null}, {"starts_at": null, "ends_at": null, "date": "2026-10-05"}],
         "tz": "Asia/Tokyo", "decided": \(decided), "answers": \(answers ?? (anonymous ? hidden : named)),
         "respondents": \(anonymous ? "[]" : #"["u-bob", "u-me", "u-carol"]"#),
         "comments": \(comments ?? (anonymous ? #"[{"user_id": null, "text": "どちらでも"}]"# : #"[{"user_id": "u-me", "text": "午後なら"}]"#)),
         "my_answers": \(myAnswers), "my_comment": \(myComment)}
        """
    }

    func testDecodesASchedulingPoll() throws {
        let poll = try XCTUnwrap(message(1, poll: Self.wire(decided: #"{"index": 1, "event_id": "e1", "by": "u-alice", "at": "2026-10-01T05:00:00Z"}"#)).poll)
        XCTAssertTrue(poll.isSchedule)
        XCTAssertEqual(poll.tz, "Asia/Tokyo")
        XCTAssertEqual(poll.slots?[1].date, "2026-10-05")
        XCTAssertEqual(poll.slots?[0].startsAt, "2026-10-03T05:00:00Z")
        XCTAssertEqual(poll.decided, PollDecidedOut(index: 1, eventId: "e1", by: "u-alice", at: "2026-10-01T05:00:00Z"))
        XCTAssertEqual(S.counts(poll), [S.Counts(yes: 2, maybe: 0, no: 1), S.Counts(yes: 0, maybe: 1, no: 0)])
        XCTAssertEqual(S.myAnswers(poll, me: Self.me), [.yes, .maybe])
        XCTAssertEqual(S.myComment(poll, me: Self.me), "午後なら")
        XCTAssertEqual(S.bestSlots(poll), [0])
        XCTAssertEqual(S.respondentCount(poll), 3)
        XCTAssertEqual(S.answer(of: "u-carol", 0, in: poll), .no)
    }

    /// Older servers (and rows stored before M53) have no kind: a choice poll, as before.
    func testAPollWithoutAKindIsAChoicePoll() throws {
        let poll = try XCTUnwrap(message(1, poll: #"{"question": "Q", "options": ["A", "B"], "multiple": false, "closed_at": null, "votes": [["u1"], []]}"#).poll)
        XCTAssertFalse(poll.isSchedule)
        XCTAssertNil(poll.answers)
        XCTAssertEqual(S.counts(poll), [S.Counts(), S.Counts()])
        XCTAssertEqual(S.myAnswers(poll, me: "u1"), [nil, nil])
        // An answer a later server might add does not fail the message.
        let later = try XCTUnwrap(message(1, poll: Self.wire(anonymous: true, myAnswers: #"["perhaps", "yes"]"#)).poll)
        XCTAssertEqual(S.myAnswers(later, me: Self.me), [nil, .yes])
    }

    func testAnAnonymousPollKnowsMineOnlyFromTheServer() throws {
        let poll = try XCTUnwrap(message(1, poll: Self.wire(anonymous: true, myAnswers: #"[null, "yes"]"#, myComment: #""どちらでも""#)).poll)
        XCTAssertEqual(S.myAnswers(poll, me: Self.me), [nil, .yes])
        XCTAssertEqual(S.myComment(poll, me: Self.me), "どちらでも")
        XCTAssertEqual(S.bestSlots(poll), [0, 1]) // a tie stars both
        XCTAssertEqual(S.respondentCount(poll), 3)
        XCTAssertEqual(poll.comments, [PollCommentOut(userId: nil, text: "どちらでも")])
        var event = poll
        event.myAnswers = nil
        event.myComment = nil
        XCTAssertEqual(S.myAnswers(event, me: Self.me), [nil, nil]) // an event's copy says nothing of mine
        let none = try XCTUnwrap(message(1, poll: Self.wire(answers: #"[{"yes": [], "maybe": ["x"], "no": []}, {}]"#)).poll)
        XCTAssertEqual(S.bestSlots(none), []) // no ○ yet: no star
    }

    func testPressingAnAnswerSetsItAndPressingItAgainTakesItBack() {
        XCTAssertEqual(S.press([.yes, nil, .no], index: 1, answer: .maybe), [.yes, .maybe, .no])
        XCTAssertEqual(S.press([.yes, nil, .no], index: 0, answer: .yes), [nil, nil, .no])
        XCTAssertEqual(S.answersBody([.yes, nil, .no]).map { "\($0.index)=\($0.answer.rawValue)" }, ["0=yes", "2=no"])
        XCTAssertEqual([nil, .yes, .maybe, .no].map(S.Answer.next(after:)), [.yes, .maybe, .no, nil])
    }

    // MARK: the store (SYNC_PROTOCOL.md §8)

    func testMyAnswersSurviveTheEventsWhicheverComesFirst() throws {
        let response = Self.wire(anonymous: true, myAnswers: #"[null, "yes"]"#, myComment: #""どちらでも""#)
        let event = Self.wire(anonymous: true)

        // The event first, then the response of the same updated_seq: the response still brings mine.
        let store = Store()
        store.upsertMessage(try message(4, poll: event))
        XCTAssertNil(store.message("c1", id: "m1")?.poll?.myAnswers)
        XCTAssertTrue(store.upsertMessage(try message(4, poll: response)))
        XCTAssertEqual(store.message("c1", id: "m1")?.poll?.myAnswers, [nil, "yes"])
        XCTAssertEqual(store.message("c1", id: "m1")?.poll?.myComment, "どちらでも")

        // The response first, then the event: the event does not take it away; a later member's answer keeps it too.
        let other = Store()
        other.upsertMessage(try message(4, poll: response))
        XCTAssertFalse(other.upsertMessage(try message(4, poll: event)))
        XCTAssertTrue(other.upsertMessage(try message(5, poll: Self.wire(anonymous: true, answers: #"[{"yes_count": 3}, {"yes_count": 2}]"#))))
        let kept = try XCTUnwrap(other.message("c1", id: "m1")?.poll)
        XCTAssertEqual(S.counts(kept).map(\.yes), [3, 2])
        XCTAssertEqual(S.myAnswers(kept, me: Self.me), [nil, .yes])
        XCTAssertEqual(kept.myComment, "どちらでも")

        // A newer event came before the answer to mine: setMyVotes still puts my answers in.
        let late = Store()
        late.upsertMessage(try message(6, poll: event))
        let answer = try message(5, poll: Self.wire(anonymous: true, myAnswers: #"["no", null]"#, myComment: #""""#))
        XCTAssertFalse(late.upsertMessage(answer))
        late.setMyVotes(answer)
        XCTAssertEqual(late.message("c1", id: "m1")?.poll?.myAnswers, ["no", nil])
        XCTAssertEqual(late.message("c1", id: "m1")?.poll?.myComment, "")
        XCTAssertEqual(late.message("c1", id: "m1")?.updatedSeq, 6)
    }

    // MARK: the requests

    /// What the stub saw (written on URLSession's thread).
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [(method: String, path: String, body: String)] = []
        func add(_ item: (String, String, String)) { lock.lock(); items.append(item); lock.unlock() }
        var all: [(method: String, path: String, body: String)] { lock.lock(); defer { lock.unlock() }; return items }
    }

    private let recorder = Recorder()
    private var requests: [(method: String, path: String, body: String)] { recorder.all }

    private func client(reply: @escaping (URLRequest, String) -> (Int, Data)) -> ApiClient {
        let recorder = recorder
        StubProtocol.handler = { request in
            let body = request.httpBodyStream.map { stream -> String in
                stream.open(); defer { stream.close() }
                var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                return String(decoding: data, as: UTF8.self)
            } ?? ""
            recorder.add((request.httpMethod ?? "", request.url?.path ?? "", body))
            return reply(request, body)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
    }

    private func json(_ text: String) throws -> [String: JSONValue] {
        try JSON.plainDecoder.decode([String: JSONValue].self, from: Data(text.utf8))
    }

    private var okMessage: Data {
        Data("""
        {"id": "m1", "channel_id": "c1", "sender_id": "u-alice", "seq": 3, "updated_seq": 7, "client_msg_id": null, "body": "📊 発表練習",
         "created_at": "2026-10-01T04:00:00Z", "edited_at": null, "deleted": false, "poll": \(Self.wire(myAnswers: #"["yes", null]"#, myComment: #""""#))}
        """.utf8)
    }

    func testRequestBodies() async throws {
        let ok = okMessage
        let api = client { _, _ in (200, ok) }
        _ = try await api.postSchedulePoll(channelId: "c1", parentId: nil, question: "発表練習",
                                           slots: [S.slotIn(timed("2026-10-03", "14:00")), S.slotIn(allDay("2026-10-05"))], tz: "Asia/Tokyo")
        _ = try await api.postSchedulePoll(channelId: "c1", parentId: "p1", question: "匿名", slots: [], tz: "Asia/Tokyo", anonymous: true)
        _ = try await api.answerPoll(messageId: "m1", answers: [.yes, nil, .no])
        _ = try await api.answerPoll(messageId: "m1", answers: [nil], comment: "午後なら")
        _ = try await api.answerPoll(messageId: "m1", answers: [], comment: "")
        _ = try await api.decidePoll(messageId: "m1", index: 2)
        _ = try await api.decidePoll(messageId: "m1", index: 0, createEvent: false)
        _ = try await api.undecidePoll(messageId: "m1")
        XCTAssertEqual(requests.map { "\($0.method) \($0.path)" }, [
            "POST /api/v1/channels/c1/messages", "POST /api/v1/channels/c1/messages",
            "PUT /api/v1/messages/m1/poll/answers", "PUT /api/v1/messages/m1/poll/answers", "PUT /api/v1/messages/m1/poll/answers",
            "POST /api/v1/messages/m1/poll/decide", "POST /api/v1/messages/m1/poll/decide", "DELETE /api/v1/messages/m1/poll/decide",
        ])
        let created = try json(requests[0].body)
        XCTAssertEqual(created["body"], .string(""))
        XCTAssertEqual(created["parent_id"], .null)
        XCTAssertEqual(created["poll"], .object([
            "kind": .string("schedule"), "question": .string("発表練習"), "tz": .string("Asia/Tokyo"),
            "slots": .array([.object(["starts_at": .string("2026-10-03T05:00:00Z"), "ends_at": .string("2026-10-03T06:00:00Z")]),
                             .object(["date": .string("2026-10-05")])]),
        ])) // no options, no multiple, no anonymous when named
        XCTAssertEqual(try json(requests[1].body)["poll"]?["anonymous"], .bool(true))
        XCTAssertEqual(try json(requests[1].body)["parent_id"], .string("p1"))
        XCTAssertEqual(try json(requests[2].body), ["answers": .array([.object(["index": .number(0), "answer": .string("yes")]),
                                                                        .object(["index": .number(2), "answer": .string("no")])])])
        XCTAssertEqual(try json(requests[3].body), ["answers": .array([]), "comment": .string("午後なら")])
        XCTAssertEqual(try json(requests[4].body), ["answers": .array([]), "comment": .null]) // "" removes my comment
        XCTAssertEqual(try json(requests[5].body), ["index": .number(2), "create_event": .bool(true)])
        XCTAssertEqual(try json(requests[6].body), ["index": .number(0), "create_event": .bool(false)])
    }

    /// SCHEDULING.md §7 3.: the event cannot be made (posting_restricted) → the card offers to decide without it.
    func testADecisionRefusedForTheEventIsOfferedWithoutIt() async throws {
        let ok = okMessage
        let refused = Data(#"{"error": {"code": "posting_restricted", "message": "Only owners and admins can post here"}}"#.utf8)
        let controller = AppController()
        controller.api = client { request, body in
            request.url?.path.hasSuffix("/poll/decide") == true && body.contains(#""create_event":true"#) ? (403, refused) : (200, ok)
        }
        let state = MessageState(try message(6, poll: Self.wire()))
        controller.store.upsertMessage(try message(6, poll: Self.wire()))
        let first = await controller.decideSchedule(state, index: 0)
        XCTAssertEqual(first, .eventRefused)
        XCTAssertNil(controller.error) // no toast: the card asks instead
        let second = await controller.decideSchedule(state, index: 0, createEvent: false)
        XCTAssertEqual(second, .decided)
        XCTAssertEqual(controller.notice, "日程を決定しました")
        XCTAssertEqual(controller.store.message("c1", id: "m1")?.poll?.myAnswers, ["yes", nil])
        // Any other refusal is said in the toast.
        controller.api = client { _, _ in (403, Data(#"{"error": {"code": "poll_decide_restricted", "message": "no"}}"#.utf8)) }
        let third = await controller.decideSchedule(state, index: 0)
        XCTAssertEqual(third, .failed)
        XCTAssertEqual(controller.error, ErrorMessages.text(for: ApiError.api(status: 403, code: "poll_decide_restricted", message: "no")))
    }
}
