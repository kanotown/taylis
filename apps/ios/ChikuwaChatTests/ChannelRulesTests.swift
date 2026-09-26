import XCTest
@testable import ChikuwaChat

final class ChannelRulesTests: XCTestCase {
    private func channel(_ id: String, type: String = "public", unread: Int = 0, mentions: Int = 0,
                         level: String? = nil, mutedUntil: String? = nil) -> ChannelState {
        let out = ChannelOut(id: id, type: type, name: id, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: nil, dmUserIds: nil, readState: nil,
                             notification: level.map { NotificationPreferenceOut(channelId: id, level: $0, mutedUntil: mutedUntil) })
        return ChannelState(channel: out, isMember: true, syncedSeq: nil, lastSeq: 0, lastReadSeq: 0, unreadCount: unread, mentionCount: mentions, hasOlder: true)
    }

    func testMutedChannelsCountOnlyMentions() {
        let muted = channel("a", unread: 5, level: "none")
        XCTAssertTrue(muted.isMuted)
        XCTAssertFalse(muted.showsUnread)
        XCTAssertEqual(muted.badgeContribution, 0)
        let future = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
        let mentioned = channel("b", unread: 5, mentions: 2, level: "mentions", mutedUntil: future)
        XCTAssertTrue(mentioned.isMuted)
        XCTAssertTrue(mentioned.showsUnread)
        XCTAssertEqual(mentioned.badgeContribution, 2)
        let expired = channel("c", unread: 1, level: "mentions", mutedUntil: "2020-01-01T00:00:00Z")
        XCTAssertFalse(expired.isMuted)
        XCTAssertTrue(expired.showsUnread)
        XCTAssertEqual(channel("d", type: "dm", unread: 3).badgeContribution, 3)
    }
}
