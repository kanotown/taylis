import XCTest
@testable import ChikuwaChat

/// M34: the tab badges and the DM list (the same rules on the web and Android).
final class TabsTests: XCTestCase {
    private func channel(_ id: String, type: String = "public", unread: Int = 0, mentions: Int = 0, dm: [String]? = nil,
                         last: String? = nil, level: String? = nil) -> ChannelState {
        let out = ChannelOut(id: id, type: type, name: id, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                             lastMessageAt: last, createdAt: "2026-01-01T00:00:00Z", updatedAt: "", membership: nil, dmUserIds: dm, readState: nil,
                             notification: level.map { NotificationPreferenceOut(channelId: id, level: $0, mutedUntil: nil) })
        return ChannelState(channel: out, isMember: true, syncedSeq: nil, lastSeq: 0, lastReadSeq: 0, unreadCount: unread, mentionCount: mentions, hasOlder: true)
    }

    func testBadges() {
        let rows = [
            channel("general", unread: 3),
            channel("mentioned", unread: 1, mentions: 1),
            channel("muted", unread: 9, level: "none"),
            channel("dm-a", type: "dm", unread: 2, dm: ["me", "a"]),
            channel("dm-b", type: "dm", unread: 0, dm: ["me", "b"]),
            channel("group", type: "group_dm", unread: 1, dm: ["me", "a", "b"]),
        ]
        XCTAssertEqual(TabBadges.dms(rows, meId: "me"), 2)
        let activity = TabBadges.activity(rows, threads: ThreadSummary(unreadCount: 2, mentionCount: 0))
        XCTAssertEqual(activity.count, 3)
        XCTAssertTrue(activity.mention)
        XCTAssertFalse(TabBadges.activity([channel("x", unread: 4)], threads: ThreadSummary(unreadCount: 1, mentionCount: 0)).mention)
        XCTAssertTrue(TabBadges.homeDot(rows, meId: "me"))
        XCTAssertFalse(TabBadges.homeDot([channel("muted", unread: 9, level: "none"), channel("dm", type: "dm", unread: 4, dm: ["me", "a"])], meId: "me"))
    }

    func testDMOrderAndTimeLabels() {
        let rows = [
            channel("old", type: "dm", dm: ["me", "a"], last: "2026-09-01T00:00:00Z"),
            channel("new", type: "dm", dm: ["me", "b"], last: "2026-09-29T01:00:00Z"),
            channel("notes", type: "dm", dm: ["me"], last: nil),
            channel("general", last: "2026-09-29T02:00:00Z"),
        ]
        XCTAssertEqual(DMList.ordered(rows, meId: "me").map(\.id), ["notes", "new", "old"])
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let now = parseIsoDate("2026-09-29T12:00:00+09:00")! // Tuesday
        XCTAssertEqual(DMList.timeLabel("2026-09-29T09:05:00+09:00", now: now, calendar: calendar), "9:05")
        XCTAssertEqual(DMList.timeLabel("2026-09-28T23:59:00+09:00", now: now, calendar: calendar), "昨日")
        XCTAssertEqual(DMList.timeLabel("2026-09-26T10:00:00+09:00", now: now, calendar: calendar), "土曜日")
        XCTAssertEqual(DMList.timeLabel("2026-09-22T10:00:00+09:00", now: now, calendar: calendar), "9/22")
        XCTAssertEqual(DMList.timeLabel("2025-12-31T10:00:00+09:00", now: now, calendar: calendar), "2025/12/31")
        XCTAssertNil(DMList.timeLabel(nil, now: now, calendar: calendar))
    }
}
