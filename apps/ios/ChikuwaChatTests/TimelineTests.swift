import XCTest
@testable import ChikuwaChat

final class TimelineTests: XCTestCase {
    private var calendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }()
    private let now = parseIsoDate("2026-09-26T03:00:00Z")! // 12:00 JST

    private func message(_ id: String, sender: String, at: String, seq: Int) -> MessageState {
        var message = MessageState(placeholderFor: id, channelId: "c", senderId: sender, body: id, createdAt: at)
        message.id = id
        message.seq = seq
        message.updatedSeq = seq
        message.pending = false
        message.clientMsgId = nil
        return message
    }

    func testDayLabelsAreRelativeToToday() {
        XCTAssertEqual(Timeline.dayLabel(parseIsoDate("2026-09-26T00:00:00Z")!, now: now, calendar: calendar), "今日")
        XCTAssertEqual(Timeline.dayLabel(parseIsoDate("2026-09-25T14:00:00Z")!, now: now, calendar: calendar), "昨日")
        XCTAssertEqual(Timeline.dayLabel(parseIsoDate("2026-09-01T00:00:00Z")!, now: now, calendar: calendar), "9月1日 (火)")
        XCTAssertEqual(Timeline.dayLabel(parseIsoDate("2025-12-31T00:00:00Z")!, now: now, calendar: calendar), "2025年12月31日 (水)")
    }

    func testGroupsConsecutiveMessagesAndPlacesUnreadDividerOnce() {
        let items = Timeline.build(
            [
                message("a", sender: "u1", at: "2026-09-25T01:00:00Z", seq: 1),
                message("b", sender: "u1", at: "2026-09-25T01:02:00Z", seq: 2),
                message("c", sender: "u1", at: "2026-09-25T01:20:00Z", seq: 3),
                message("d", sender: "u2", at: "2026-09-26T00:00:00Z", seq: 4),
                message("e", sender: "u2", at: "2026-09-26T00:01:00Z", seq: 5),
            ],
            firstUnreadAfterSeq: 3, meId: "me", now: now, calendar: calendar
        )
        let shape = items.map { item -> String in
            switch item {
            case .date: return "date"
            case .unread: return "unread"
            case .message(let message, let compact): return message.id + (compact ? "*" : "")
            }
        }
        XCTAssertEqual(shape, ["date", "a", "b*", "c", "date", "unread", "d", "e*"])
    }

    func testInitialsAndHueAreStable() {
        XCTAssertEqual(Timeline.initials("Toru Kano"), "TK")
        XCTAssertEqual(Timeline.initials("かのう"), "か")
        XCTAssertEqual(Timeline.initials("  "), "?")
        XCTAssertEqual(Timeline.hue("user-1"), Timeline.hue("user-1"))
        XCTAssertNil(Timeline.muteLabel("2020-01-01T00:00:00Z", now: now))
        XCTAssertNotNil(Timeline.muteLabel("2026-09-26T10:00:00Z", now: now))
    }
}
