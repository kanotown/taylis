import XCTest
@testable import ChikuwaChat

/// L8 (TIMES_FEED.md §2, §4, §5, §6): the Times feed's rows (order, paging, live events, which rows and channels count)
/// and the search's is:times.
@MainActor
final class TimesFeedTests: XCTestCase {
    private let now = ISO8601DateFormatter().date(from: "2026-10-02T12:00:00Z")!

    private func message(_ id: String, channel: String = "t1", at: String, seq: Int = 1, sender: String = "u2", type: String = "user",
                         deleted: Bool = false, parentId: String? = nil, alsoInChannel: Bool = false, body: String = "b") -> MessageOut {
        var out = MessageOut(id: id, channelId: channel, senderId: sender, seq: seq, updatedSeq: seq, clientMsgId: nil, body: body, createdAt: at,
                             editedAt: nil, deleted: deleted)
        out.type = type
        out.parentId = parentId
        out.alsoInChannel = alsoInChannel
        return out
    }

    private func channel(_ id: String, times owner: String? = "u2", member: Bool = true, lastRead: Int = 0, level: String = "mentions",
                         muted: Bool = false, mutedUntil: String? = nil) -> ChannelState {
        var out = ChannelOut(id: id, type: "public", name: "times-\(id)", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: member ? MembershipOut(role: "member", joinedAt: "") : nil,
                             dmUserIds: nil)
        out.timesOwnerId = owner
        out.notification = NotificationPreferenceOut(channelId: id, level: level, mutedUntil: mutedUntil, followsDefault: false, muted: muted)
        return ChannelState(channel: out, isMember: member, syncedSeq: nil, lastSeq: 0, lastReadSeq: lastRead, hasOlder: false)
    }

    private func ids(_ list: TimesFeedList) -> [String] { list.items.map(\.id) }

    // MARK: §2 which rows and channels

    func testFeedRowsAreUserTimelinePostsOfTimesIFollowAndHaveNotMuted() {
        let times = channel("t1")
        XCTAssertTrue(TimesFeedList.isFeedRow(message("a", at: "2026-10-02T10:00:00Z"), channel: times, now: now))
        // A reply also sent to the channel is a timeline row; a thread-only reply is not (its parent's 「返信 N 件」 shows it).
        XCTAssertTrue(TimesFeedList.isFeedRow(message("r1", at: "2026-10-02T10:00:00Z", parentId: "a", alsoInChannel: true), channel: times, now: now))
        XCTAssertFalse(TimesFeedList.isFeedRow(message("r2", at: "2026-10-02T10:00:00Z", parentId: "a"), channel: times, now: now))
        // System rows (joins and leaves) and deleted ones stay out.
        XCTAssertFalse(TimesFeedList.isFeedRow(message("s", at: "2026-10-02T10:00:00Z", type: "system"), channel: times, now: now))
        XCTAssertFalse(TimesFeedList.isFeedRow(message("d", at: "2026-10-02T10:00:00Z", deleted: true), channel: times, now: now))
        // Not a times, not a member, unknown, muted (level none, muted, a timed mute running): none of them.
        let post = message("a", at: "2026-10-02T10:00:00Z")
        XCTAssertFalse(TimesFeedList.isFeedRow(post, channel: channel("t1", times: nil), now: now))
        XCTAssertFalse(TimesFeedList.isFeedRow(post, channel: channel("t1", member: false), now: now))
        XCTAssertFalse(TimesFeedList.isFeedRow(post, channel: nil, now: now))
        XCTAssertFalse(TimesFeedList.isFeedRow(post, channel: channel("t1", level: "none"), now: now))
        XCTAssertFalse(TimesFeedList.isFeedRow(post, channel: channel("t1", muted: true), now: now))
        XCTAssertFalse(TimesFeedList.isFeedRow(post, channel: channel("t1", mutedUntil: "2026-10-02T13:00:00Z"), now: now))
        // A timed mute that has ended, my own times, a level of all: in the feed.
        XCTAssertTrue(TimesFeedList.isFeedRow(post, channel: channel("t1", mutedUntil: "2026-10-02T11:00:00Z"), now: now))
        XCTAssertTrue(TimesFeedList.isFeedRow(post, channel: channel("t1", times: "me"), now: now))
        XCTAssertTrue(TimesFeedList.isFeedRow(post, channel: channel("t1", level: "all"), now: now))
    }

    /// 2026-10-09: the home's 「Times」 is bright only while a feed times has something unread.
    func testHasUnreadAsksTheFeedChannelsOnly() {
        func unread(_ state: ChannelState, _ count: Int) -> ChannelState {
            var state = state
            state.unreadCount = count
            return state
        }
        XCTAssertFalse(TimesFeedList.hasUnread([channel("t1"), channel("t2")], now: now))
        XCTAssertTrue(TimesFeedList.hasUnread([channel("t1"), unread(channel("t2"), 2)], now: now))
        XCTAssertTrue(TimesFeedList.hasUnread([unread(channel("t1", times: "me"), 1)], now: now))  // a comment on mine
        // Not a times, muted, not a member: their unread does not light it.
        XCTAssertFalse(TimesFeedList.hasUnread([unread(channel("c", times: nil), 5), unread(channel("t1", muted: true), 3),
                                                unread(channel("t2", member: false), 1)], now: now))
    }

    // MARK: order and paging

    func testRowsAreNewestFirstThenByIdAcrossChannels() {
        let a = message("0190-a", channel: "t1", at: "2026-10-02T10:00:00Z")
        let b = message("0190-b", channel: "t2", at: "2026-10-02T10:00:00Z") // same instant: the larger id first
        let c = message("0190-c", channel: "t1", at: "2026-10-02T11:00:00.5Z")
        let d = message("0190-d", channel: "t3", at: "2026-10-02T09:59:59.999999+00:00")
        var list = TimesFeedList()
        list.replace(with: TimesFeedOut(items: [a, d, c, b], nextCursor: "next"))
        XCTAssertEqual(ids(list), ["0190-c", "0190-b", "0190-a", "0190-d"])
        XCTAssertTrue(list.hasMore)
        // Microseconds count (the server's times), and a time without a fraction compares as the same instant.
        XCTAssertTrue(TimesFeedList.precedes(message("x", at: "2026-10-02T10:00:00.000002Z"), message("y", at: "2026-10-02T10:00:00.000001Z")))
        XCTAssertTrue(TimesFeedList.precedes(message("y", at: "2026-10-02T10:00:00Z"), message("x", at: "2026-10-02T10:00:00.000000Z")))
    }

    func testPagingAddsTheNextPageWithoutDuplicatesAndAFirstPageReplaces() {
        var list = TimesFeedList()
        list.replace(with: TimesFeedOut(items: [message("3", at: "2026-10-02T10:03:00Z"), message("2", at: "2026-10-02T10:02:00Z")], nextCursor: "c1"))
        // The next page repeats a row (a post came in between): it is not added twice.
        list.append(TimesFeedOut(items: [message("2", at: "2026-10-02T10:02:00Z"), message("1", at: "2026-10-02T10:01:00Z")], nextCursor: nil))
        XCTAssertEqual(ids(list), ["3", "2", "1"])
        XCTAssertFalse(list.hasMore)
        list.replace(with: TimesFeedOut(items: [message("4", at: "2026-10-02T10:04:00Z")], nextCursor: "c2"))
        XCTAssertEqual(ids(list), ["4"])
        XCTAssertEqual(list.nextCursor, "c2")
    }

    // MARK: §5 live events

    func testLiveEventsAddUpdateAndRemoveRows() {
        var list = TimesFeedList()
        list.replace(with: TimesFeedOut(items: [message("2", at: "2026-10-02T10:02:00Z"), message("1", at: "2026-10-02T10:01:00Z")], nextCursor: nil))
        // A new post goes where its time puts it (the top for a new one).
        list.apply(event: "message.created", message: message("3", at: "2026-10-02T10:03:00Z"), isFeedRow: true, adding: true)
        XCTAssertEqual(ids(list), ["3", "2", "1"])
        // Not a feed row, or the feed is not on screen: nothing is added.
        list.apply(event: "message.created", message: message("4", at: "2026-10-02T10:04:00Z"), isFeedRow: false, adding: true)
        list.apply(event: "message.created", message: message("5", at: "2026-10-02T10:05:00Z"), isFeedRow: true, adding: false)
        XCTAssertEqual(ids(list), ["3", "2", "1"])
        // The same created event again (a replay) does not add it twice.
        list.apply(event: "message.created", message: message("3", at: "2026-10-02T10:03:00Z"), isFeedRow: true, adding: true)
        XCTAssertEqual(ids(list), ["3", "2", "1"])
        // An edit replaces the row in place; an update of a row not held adds nothing.
        list.apply(event: "message.updated", message: message("2", at: "2026-10-02T10:02:00Z", seq: 2, body: "edited"), isFeedRow: true, adding: true)
        list.apply(event: "message.updated", message: message("9", at: "2026-10-02T09:00:00Z"), isFeedRow: true, adding: true)
        XCTAssertEqual(ids(list), ["3", "2", "1"])
        XCTAssertEqual(list.items[1].body, "edited")
        // Deleted (either event): the row goes.
        list.apply(event: "message.deleted", message: message("3", at: "2026-10-02T10:03:00Z", seq: 2, deleted: true), isFeedRow: false, adding: true)
        list.apply(event: "message.updated", message: message("1", at: "2026-10-02T10:01:00Z", seq: 2, deleted: true), isFeedRow: false, adding: true)
        XCTAssertEqual(ids(list), ["2"])
    }

    func testLeavingOrMutingATimesRemovesItsRows() {
        var list = TimesFeedList()
        list.replace(with: TimesFeedOut(items: [message("a", channel: "t1", at: "2026-10-02T10:02:00Z"),
                                               message("b", channel: "t2", at: "2026-10-02T10:01:00Z"),
                                               message("c", channel: "t3", at: "2026-10-02T10:00:00Z")], nextCursor: nil))
        let channels = ["t1": channel("t1"), "t2": channel("t2", muted: true)] // t3: left (not in the store)
        list.keepChannels { TimesFeedList.isFeedChannel(channels[$0], now: now) }
        XCTAssertEqual(ids(list), ["a"])
    }

    func testTheModelAddsLiveRowsOnlyWhileTheFeedIsShownAndKeepsThoseThatCameDuringALoad() async {
        let model = TimesFeedModel()
        let times = channel("t1")
        let first = TimesFeedOut(items: [message("1", at: "2026-10-02T10:01:00Z")], nextCursor: "c")
        await model.refresh(fetch: { _ in first }, channel: { _ in times })
        XCTAssertTrue(model.loaded)
        // Not shown: a new post is not added (the next open reads the first page again)…
        model.live("message.created", message("2", at: "2026-10-02T10:02:00Z"), channel: times, now: now)
        XCTAssertEqual(ids(model.list), ["1"])
        // …but an edit or a delete still applies to the rows held (they show offline).
        model.live("message.updated", message("1", at: "2026-10-02T10:01:00Z", seq: 2, body: "edited"), channel: times, now: now)
        XCTAssertEqual(model.list.items.first?.body, "edited")
        model.visible = true
        model.live("message.created", message("3", at: "2026-10-02T10:03:00Z"), channel: times, now: now)
        // A thread-only reply and a post of a muted times stay out.
        model.live("message.created", message("r", at: "2026-10-02T10:04:00Z", parentId: "3"), channel: times, now: now)
        model.live("message.created", message("m", channel: "t2", at: "2026-10-02T10:05:00Z"), channel: channel("t2", muted: true), now: now)
        XCTAssertEqual(ids(model.list), ["3", "1"])

        // A post that arrives while the first page is read, which the page does not have yet, stays.
        let late = message("5", at: "2026-10-02T10:05:00Z")
        await model.refresh(fetch: { _ in
            model.live("message.created", late, channel: times, now: self.now)
            return TimesFeedOut(items: [self.message("4", at: "2026-10-02T10:04:00Z")], nextCursor: "c2")
        }, channel: { _ in times }, now: { self.now })
        XCTAssertEqual(ids(model.list), ["5", "4"])

        // The next page; then a muted channel's rows go.
        await model.loadMore(fetch: { cursor in
            XCTAssertEqual(cursor, "c2")
            return TimesFeedOut(items: [self.message("4", at: "2026-10-02T10:04:00Z"), self.message("0", channel: "t2", at: "2026-10-02T10:00:00Z")],
                                nextCursor: nil)
        }, channel: { _ in times }, now: { self.now })
        XCTAssertEqual(ids(model.list), ["5", "4", "0"])
        await model.loadMore(fetch: { _ in XCTFail("no more pages"); return first }, channel: { _ in times })
        model.prune(channel: { $0 == "t1" ? times : self.channel("t2", muted: true) }, now: now)
        XCTAssertEqual(ids(model.list), ["5", "4"])
    }

    func testAFailedReadKeepsTheRowsAndSaysWhy() async {
        let model = TimesFeedModel()
        await model.refresh(fetch: { _ in TimesFeedOut(items: [self.message("1", at: "2026-10-02T10:01:00Z")], nextCursor: nil) },
                            channel: { _ in self.channel("t1") })
        await model.refresh(fetch: { _ in throw URLError(.notConnectedToInternet) }, channel: { _ in nil })
        XCTAssertEqual(ids(model.list), ["1"])
        XCTAssertNotNil(model.failure)
        XCTAssertFalse(model.loading)
    }

    // MARK: review v0.1.15 (#2, #3, #4, #8, #9, #10, #11)

    /// #2: a page read before a leave (a private times I was removed from) brings none of its rows back, first or next.
    func testAPageThatLandsAfterALeaveBringsNoneOfThatChannelsRows() async {
        let model = TimesFeedModel()
        var channels: [String: ChannelState] = ["t1": channel("t1"), "t2": channel("t2")]
        await model.refresh(fetch: { _ in
            channels["t2"] = nil // removed while the page was read
            model.prune(channel: { channels[$0] }, now: self.now)
            return TimesFeedOut(items: [self.message("b", channel: "t2", at: "2026-10-02T10:02:00Z"),
                                        self.message("a", channel: "t1", at: "2026-10-02T10:01:00Z")], nextCursor: "c")
        }, channel: { channels[$0] }, now: { self.now })
        XCTAssertEqual(ids(model.list), ["a"])
        channels["t2"] = channel("t2")
        await model.loadMore(fetch: { _ in
            channels["t2"] = self.channel("t2", muted: true)
            model.prune(channel: { channels[$0] }, now: self.now)
            return TimesFeedOut(items: [self.message("y", channel: "t2", at: "2026-10-02T09:02:00Z"),
                                        self.message("x", channel: "t1", at: "2026-10-02T09:01:00Z")], nextCursor: nil)
        }, channel: { channels[$0] }, now: { self.now })
        XCTAssertEqual(ids(model.list), ["a", "x"])
    }

    /// #3: an edit or a delete that comes while a page is read is not undone by the page's older copy.
    func testChangesDuringAPageReadAreAppliedAgainAfterIt() async {
        let model = TimesFeedModel()
        model.visible = true
        let times = channel("t1")
        await model.refresh(fetch: { _ in TimesFeedOut(items: [self.message("m", at: "2026-10-02T10:00:00Z")], nextCursor: "c") },
                            channel: { _ in times }, now: { self.now })
        // The first page again: meanwhile m is edited, n is posted and deleted, k is deleted; the page has their old copies.
        await model.refresh(fetch: { _ in
            model.live("message.updated", self.message("m", at: "2026-10-02T10:00:00Z", seq: 5, body: "edited"), channel: times, now: self.now)
            model.live("message.created", self.message("n", at: "2026-10-02T10:05:00Z", seq: 6), channel: times, now: self.now)
            model.live("message.deleted", self.message("n", at: "2026-10-02T10:05:00Z", seq: 7, deleted: true), channel: times, now: self.now)
            model.live("message.deleted", self.message("k", at: "2026-10-02T09:59:00Z", seq: 8, deleted: true), channel: times, now: self.now)
            return TimesFeedOut(items: [self.message("n", at: "2026-10-02T10:05:00Z", seq: 6),
                                        self.message("m", at: "2026-10-02T10:00:00Z", seq: 1, body: "old"),
                                        self.message("k", at: "2026-10-02T09:59:00Z", seq: 4)], nextCursor: "c2")
        }, channel: { _ in times }, now: { self.now })
        XCTAssertEqual(ids(model.list), ["m"])
        XCTAssertEqual(model.list.items.first?.body, "edited")
        // The next page: a row deleted while it was read does not come back.
        await model.loadMore(fetch: { _ in
            model.live("message.deleted", self.message("j", at: "2026-10-02T09:00:00Z", seq: 9, deleted: true), channel: times, now: self.now)
            return TimesFeedOut(items: [self.message("j", at: "2026-10-02T09:00:00Z", seq: 3), self.message("i", at: "2026-10-02T08:00:00Z", seq: 2)],
                                nextCursor: nil)
        }, channel: { _ in times }, now: { self.now })
        XCTAssertEqual(ids(model.list), ["m", "i"])
    }

    /// #9: an older version (a late event, a page) never replaces a newer row.
    func testAnOlderVersionNeverReplacesANewerRow() {
        var list = TimesFeedList()
        list.replace(with: TimesFeedOut(items: [message("m", at: "2026-10-02T10:00:00Z", seq: 2, body: "edited")], nextCursor: "c"))
        list.apply(event: "message.created", message: message("m", at: "2026-10-02T10:00:00Z", seq: 1, body: "old"), isFeedRow: true, adding: true)
        list.apply(event: "message.deleted", message: message("m", at: "2026-10-02T10:00:00Z", seq: 1, deleted: true), isFeedRow: false, adding: true)
        list.append(TimesFeedOut(items: [message("m", at: "2026-10-02T10:00:00Z", seq: 1, body: "old")], nextCursor: nil))
        XCTAssertEqual(list.items.map(\.body), ["edited"])
        XCTAssertEqual(list.items.first?.updatedSeq, 2)
    }

    /// #10: another member's event keeps my own poll part; the answer to my vote brings it.
    func testMyPollPartSurvivesEventsAndMyAnswersBringIt() {
        func poll(mine: [Int]?) -> PollOut {
            var poll = PollOut(question: "q", options: ["a", "b"])
            poll.anonymous = true
            poll.mine = mine
            return poll
        }
        var row = message("p", at: "2026-10-02T10:00:00Z", seq: 1)
        row.poll = poll(mine: [0])
        var list = TimesFeedList()
        list.replace(with: TimesFeedOut(items: [row], nextCursor: nil))
        var event = message("p", at: "2026-10-02T10:00:00Z", seq: 2)
        event.poll = poll(mine: nil)
        list.apply(event: "message.updated", message: event, isFeedRow: true, adding: true)
        XCTAssertEqual(list.items.first?.poll?.mine, [0])
        XCTAssertEqual(list.items.first?.updatedSeq, 2)
        // My vote's answer at the version the event already brought: only my part changes.
        var answer = event
        answer.poll = poll(mine: [1])
        list.apply(event: TimesFeedList.stored, message: answer, isFeedRow: true, adding: true)
        XCTAssertEqual(list.items.first?.poll?.mine, [1])
        XCTAssertTrue(list.applyMyPart(of: { var a = answer; a.poll = poll(mine: [0, 1]); return a }()))
        XCTAssertEqual(list.items.first?.poll?.mine, [0, 1])
    }

    /// #11: a thread-only reply moves its feed parent's counters (newer only).
    func testAReplyMovesItsFeedParentsCounters() async {
        let model = TimesFeedModel()
        model.visible = true
        let times = channel("t1")
        await model.refresh(fetch: { _ in TimesFeedOut(items: [self.message("p", at: "2026-10-02T10:00:00Z", seq: 1)], nextCursor: nil) },
                            channel: { _ in times }, now: { self.now })
        let reply = message("r", at: "2026-10-02T10:01:00Z", seq: 2, parentId: "p")
        model.live("message.created", reply, thread: ParentThread(id: "p", replyCount: 1, lastReplyAt: reply.createdAt, updatedSeq: 3,
                                                                replyUserIds: ["u2"]), channel: times, now: now)
        XCTAssertEqual(ids(model.list), ["p"])
        XCTAssertEqual(model.list.items.first?.replyCount, 1)
        XCTAssertEqual(model.list.items.first?.replyUserIds, ["u2"])
        // An older one (a late event) does not move them back.
        model.thread(ParentThread(id: "p", replyCount: 0, lastReplyAt: nil, updatedSeq: 2))
        XCTAssertEqual(model.list.items.first?.replyCount, 1)
    }

    /// #4: a row the store took (the delta after a gap, my own action's answer) reaches the feed: a held row takes it, a
    /// new one inside the rows read is added; the store hands every server row and my poll part over.
    func testRowsTheStoreTakesReachTheFeed() async {
        let store = Store()
        let model = TimesFeedModel()
        model.visible = true
        let times = channel("t1")
        store.onMessageTaken = { model.stored($0, channel: times, now: self.now) }
        store.onMyPart = { model.myPart($0) }
        await model.refresh(fetch: { _ in TimesFeedOut(items: [self.message("b", at: "2026-10-02T10:02:00Z"),
                                                               self.message("a", at: "2026-10-02T10:00:00Z")], nextCursor: "c") },
                            channel: { _ in times }, now: { self.now })
        store.upsertMessage(message("lost", at: "2026-10-02T10:01:00Z", seq: 3)) // recovered by the delta
        store.upsertMessage(message("old", at: "2026-10-02T09:00:00Z", seq: 1)) // older than the rows read: the next page has it
        store.upsertMessage(message("b", at: "2026-10-02T10:02:00Z", seq: 4, body: "edited")) // my edit's answer
        XCTAssertEqual(ids(model.list), ["b", "lost", "a"])
        XCTAssertEqual(model.list.items.first?.body, "edited")
        var poll = PollOut(question: "q", options: ["a"])
        poll.mine = []
        var withPoll = message("a", at: "2026-10-02T10:00:00Z", seq: 5)
        withPoll.poll = poll
        store.upsertMessage(withPoll)
        var answer = withPoll
        answer.poll?.mine = [0]
        store.setMyVotes(answer)
        XCTAssertEqual(model.list.items.last?.poll?.mine, [0])
    }

    /// #8: the parent of a thread opened from the feed: a feed row, or one fetched for it.
    func testAThreadsParentComesFromTheFeed() async {
        let model = TimesFeedModel()
        await model.refresh(fetch: { _ in TimesFeedOut(items: [self.message("p", at: "2026-10-02T10:00:00Z")], nextCursor: nil) },
                            channel: { _ in self.channel("t1") }, now: { self.now })
        XCTAssertEqual(model.parent("p")?.id, "p")
        XCTAssertNil(model.parent("q"))
        model.keepParent(message("q", at: "2026-10-02T09:00:00Z", seq: 2, body: "parent"))
        model.keepParent(message("q", at: "2026-10-02T09:00:00Z", seq: 1, body: "older"))
        XCTAssertEqual(model.parent("q")?.body, "parent")
        model.thread(ParentThread(id: "q", replyCount: 4, lastReplyAt: nil, updatedSeq: 3))
        XCTAssertEqual(model.parent("q")?.replyCount, 4)
    }

    // MARK: §4 the dot

    func testANewDotIsAPostPastThatTimesReadPositionNotMine() {
        let times = channel("t1", lastRead: 10)
        XCTAssertTrue(TimesFeedList.isNew(message("a", at: "", seq: 11), channel: times, meId: "me"))
        XCTAssertFalse(TimesFeedList.isNew(message("a", at: "", seq: 10), channel: times, meId: "me"))
        XCTAssertFalse(TimesFeedList.isNew(message("a", at: "", seq: 11, sender: "me"), channel: times, meId: "me"))
        XCTAssertFalse(TimesFeedList.isNew(message("a", at: "", seq: 11), channel: nil, meId: "me"))
    }

    // MARK: API shapes

    func testTheFeedAndTheSearchAdditionsDecodeAndOlderServersStillDo() throws {
        let feed = try JSON.snakeDecoder.decode(TimesFeedOut.self, from: Data(#"""
        {"items": [{"id": "m1", "channel_id": "t1", "sender_id": "u2", "seq": 3, "updated_seq": 3, "client_msg_id": null, "body": "hi",
                    "created_at": "2026-10-02T10:00:00.123456Z", "edited_at": null, "deleted": false}],
         "next_cursor": "2026-10-02T10:00:00.123456+00:00_m1"}
        """#.utf8))
        XCTAssertEqual(feed.items.map(\.id), ["m1"])
        XCTAssertEqual(feed.nextCursor, "2026-10-02T10:00:00.123456+00:00_m1")
        let end = try JSON.snakeDecoder.decode(TimesFeedOut.self, from: Data(#"{"items": [], "next_cursor": null}"#.utf8))
        XCTAssertNil(end.nextCursor)

        let search = try JSON.snakeDecoder.decode(SearchOut.self, from: Data(#"""
        {"hits": [], "keywords": [], "filters": {"text": "", "is_times": true}, "limit": 30, "offset": 0, "has_more": false,
         "channels": [{"id": "t9", "type": "public", "name": "times-old", "topic": null, "purpose": null, "archived": true, "created_by": null,
                       "last_seq": 4, "last_message_at": null, "created_at": "", "updated_at": "", "membership": null, "dm_user_ids": null,
                       "times_owner_id": "u9"}]}
        """#.utf8))
        XCTAssertEqual(search.filters?.isTimes, true)
        XCTAssertEqual(search.channels?.map(\.id), ["t9"])
        XCTAssertEqual(search.channels?.first?.timesOwnerId, "u9")
        let older = try JSON.snakeDecoder.decode(SearchOut.self, from: Data(#"""
        {"hits": [], "keywords": [], "filters": {"text": ""}, "limit": 30, "offset": 0, "has_more": false}
        """#.utf8))
        XCTAssertNil(older.filters?.isTimes)
        XCTAssertNil(older.channels)
    }

    // MARK: §6 search

    func testIsTimesIsAChipASuggestionAndAQueryParameter() {
        let params = SearchParams(q: "実験", isTimes: true)
        XCTAssertTrue(params.hasFilters)
        XCTAssertEqual(params.withoutFilters, SearchParams(q: "実験"))
        let items = SearchLogic.request(params).queryItems(limit: 30, offset: 0)
        XCTAssertTrue(items.contains(URLQueryItem(name: "is_times", value: "true")))
        XCTAssertFalse(SearchLogic.request(SearchParams(q: "a")).queryItems(limit: 30, offset: 0).contains { $0.name == "is_times" })
        // A canvas has no times: the canvas search does not send it.
        XCTAssertFalse(SearchLogic.request(params).canvasQueryItems(limit: 30, offset: 0).contains { $0.name == "is_times" })
        XCTAssertEqual(SearchLogic.describe(params, userName: { _ in nil }, channelTitle: { _ in nil }), "実験 · Times")

        let empty = SearchSuggestions.build("", users: [], channels: [], recent: [], title: { _ in "" })
        XCTAssertEqual(empty.last, .times)
        XCTAssertEqual(SearchSuggestion.times.group, .filters)

        // Remembered searches keep it; ones saved before it read as off.
        let encoded = try! JSONEncoder().encode(params)
        XCTAssertEqual(try JSONDecoder().decode(SearchParams.self, from: encoded), params)
        XCTAssertEqual(try JSONDecoder().decode(SearchParams.self, from: Data(#"{"q":"a","isThread":true}"#.utf8)), SearchParams(q: "a", isThread: true))
    }

    func testAHitInAChannelIAmNotInIsNamedFromTheAnswer() {
        var archived = channel("t9", member: false).channel
        archived.archived = true
        XCTAssertEqual(SearchLogic.otherChannelName(archived), "times-t9（アーカイブ済み）")
        XCTAssertEqual(SearchLogic.otherChannelName(channel("t8", member: false).channel), "times-t8")
        XCTAssertEqual(SearchLogic.otherChannelName(nil), "?")
    }
}
