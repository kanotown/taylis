import Intents
import UserNotifications
import XCTest
@testable import ChikuwaChat

/// PUSH_NOTIFICATIONS.md §16: the payload → INSendMessageIntent mapping the Notification Service Extension uses.
final class CommunicationNotificationTests: XCTestCase {
    private let avatar = "https://chat.example.jp/api/v1/users/u1/avatar/signed?v=1&exp=2&sig=x"

    private func dm(_ extra: [String: Any] = [:]) -> [AnyHashable: Any] {
        var info: [AnyHashable: Any] = ["aps": ["alert": ["title": "Alice", "body": "hi"], "mutable-content": 1],
                                        "kind": "message", "channel_id": "c1", "message_id": "m1",
                                        "sender_id": "u1", "sender_name": "Alice", "channel_type": "dm",
                                        "sender_avatar_url": avatar]
        for (key, value) in extra { info[key] = value }
        return info
    }

    func testDirectMessageIsTheSendersOwnConversation() throws {
        let push = try XCTUnwrap(CommunicationPush(userInfo: dm(), title: "Alice"))
        XCTAssertEqual(push.senderId, "u1")
        XCTAssertEqual(push.senderName, "Alice")
        XCTAssertEqual(push.conversationId, "c1")
        XCTAssertFalse(push.isGroup)
        XCTAssertNil(push.groupName)
        XCTAssertEqual(push.avatarURL?.absoluteString, avatar)

        let intent = push.intent(image: nil, body: "hi")
        XCTAssertEqual(intent.conversationIdentifier, "c1")
        XCTAssertEqual(intent.content, "hi")
        XCTAssertNil(intent.speakableGroupName)
        XCTAssertNil(intent.recipients)
        XCTAssertEqual(intent.sender?.displayName, "Alice")
        XCTAssertEqual(intent.sender?.customIdentifier, "u1")
        XCTAssertEqual(intent.sender?.personHandle?.value, "u1")
    }

    func testChannelIsAGroupNamedAfterTheChannel() throws {
        let info = dm(["channel_type": "public", "channel_id": "c2"])
        let push = try XCTUnwrap(CommunicationPush(userInfo: info, title: "#general"))
        XCTAssertTrue(push.isGroup)
        XCTAssertEqual(push.groupName, "#general")
        let intent = push.intent(image: nil, body: "hello")
        XCTAssertEqual(intent.speakableGroupName?.spokenPhrase, "#general")
        XCTAssertEqual(intent.conversationIdentifier, "c2")
        XCTAssertEqual(intent.sender?.displayName, "Alice")
        // Two or more recipients (me and the channel) make iOS show it as a group.
        XCTAssertEqual(intent.recipients?.count, 2)
        XCTAssertEqual(intent.recipients?.first?.isMe, true)
    }

    func testGroupDmAndPrivateChannelsAreGroupsToo() throws {
        for type in ["private", "group_dm"] {
            let push = try XCTUnwrap(CommunicationPush(userInfo: dm(["channel_type": type]), title: "グループ DM"))
            XCTAssertTrue(push.isGroup, type)
            XCTAssertEqual(push.groupName, "グループ DM")
        }
    }

    func testThePictureGoesOnTheSender() throws {
        let push = try XCTUnwrap(CommunicationPush(userInfo: dm(), title: "Alice"))
        let image = INImage(imageData: Data([0x89, 0x50, 0x4E, 0x47]))
        XCTAssertNotNil(push.intent(image: image, body: "hi").sender?.image)
        XCTAssertNil(push.intent(image: nil, body: "hi").sender?.image)
    }

    func testOtherPushesAreLeftAlone() {
        XCTAssertNil(CommunicationPush(userInfo: dm(["kind": "reminder"]), title: "x"))
        XCTAssertNil(CommunicationPush(userInfo: dm(["kind": "reaction"]), title: "x"))
        XCTAssertNil(CommunicationPush(userInfo: dm(["sender_id": ""]), title: "x"))
        var noChannel = dm()
        noChannel["channel_id"] = nil
        XCTAssertNil(CommunicationPush(userInfo: noChannel, title: "x"))
        // An older server sends no sender: unchanged.
        var old = dm()
        old["sender_id"] = nil
        XCTAssertNil(CommunicationPush(userInfo: old, title: "Alice"))
    }

    func testMissingNameFallsBackToTheTitleForADm() throws {
        var info = dm()
        info["sender_name"] = nil
        XCTAssertEqual(CommunicationPush(userInfo: info, title: "Alice")?.senderName, "Alice")
        info["channel_type"] = "public"
        XCTAssertEqual(CommunicationPush(userInfo: info, title: "#general")?.senderName, "?")
    }

    func testOnlyWebAvatarURLsAreUsed() {
        XCTAssertNil(CommunicationPush(userInfo: dm(["sender_avatar_url": "file:///etc/passwd"]), title: "A")?.avatarURL)
        XCTAssertNil(CommunicationPush(userInfo: dm(["sender_avatar_url": "not a url"]), title: "A")?.avatarURL)
        XCTAssertNil(CommunicationPush(userInfo: dm(["sender_avatar_url": ""]), title: "A")?.avatarURL)
        var noURL = dm()
        noURL["sender_avatar_url"] = nil  // previews off, or no picture
        let push = CommunicationPush(userInfo: noURL, title: "Alice")
        XCTAssertNotNil(push)
        XCTAssertNil(push?.avatarURL)
    }

    /// The update never loses the notification: without the entitlement (the test host) iOS may refuse, and then the
    /// original content comes back; a non-message push is returned untouched without loading anything.
    func testUpdateFallsBackToTheOriginalContent() async {
        let content = UNMutableNotificationContent()
        content.title = "Alice"
        content.body = "hi"
        content.userInfo = dm()
        let updated = await CommunicationNotification.update(content) { _ in nil }
        XCTAssertEqual(updated.body, "hi")

        let reminder = UNMutableNotificationContent()
        reminder.title = "リマインダー"
        reminder.userInfo = ["kind": "reminder"]
        let untouched = await CommunicationNotification.update(reminder) { _ in
            XCTFail("a reminder loads no picture")
            return nil
        }
        XCTAssertTrue(untouched === reminder)
    }
}
