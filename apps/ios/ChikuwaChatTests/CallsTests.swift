import XCTest
@testable import ChikuwaChat

/// M117 (docs/CALLS.md): the workspace's switch, a call message on the wire and in the store, its card's text, the 📞
/// rule and the retry key.
final class CallsTests: XCTestCase {
    private let url = "https://meet.jit.si/taylis-k3q7abcdefghijklmnopqrstu"

    private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
        try JSON.snakeDecoder.decode(T.self, from: Data(json.utf8))
    }

    private func channel(_ type: String = "public", dm: [String]? = nil, archived: Bool = false, member: Bool = true,
                         policy: String? = nil, role: String = "member") -> ChannelState {
        var out = ChannelOut(id: "c1", type: type, name: dm == nil ? "general" : nil, topic: nil, purpose: nil, archived: archived, createdBy: nil,
                             lastSeq: 0, lastMessageAt: nil, createdAt: "", updatedAt: "",
                             membership: member ? MembershipOut(role: role, joinedAt: "") : nil, dmUserIds: dm)
        out.postingPolicy = policy
        return ChannelState(channel: out, isMember: member, syncedSeq: nil, lastSeq: 0, hasOlder: false)
    }

    func testSettingsFromTheServer() throws {
        let on = try decode(WorkspaceSettings.self, #"{"show_membership_messages": true, "preview_before_join": true, "calls_enabled": true, "meeting_base_url": "https://meet.jit.si/"}"#)
        XCTAssertTrue(on.callsEnabled)
        XCTAssertEqual(on.meetingBaseUrl, "https://meet.jit.si/")
        let off = try decode(WorkspaceSettings.self, #"{"calls_enabled": false, "meeting_base_url": null}"#)
        XCTAssertFalse(off.callsEnabled)
        XCTAssertNil(off.meetingBaseUrl)
        // A server before M117 sends neither: no 📞.
        XCTAssertFalse(try decode(WorkspaceSettings.self, #"{"show_membership_messages": true}"#).callsEnabled)
        XCTAssertFalse(WorkspaceSettings.defaults.callsEnabled)
        // The switch survives the coder (the event's settings are compared with the held ones).
        let again = try decode(WorkspaceSettings.self, String(decoding: try JSON.snakeEncoder.encode(on), as: UTF8.self))
        XCTAssertEqual(again, on)
    }

    func testCallMessageDecodesAndKeepsItsCall() throws {
        let json = """
        {"id": "m1", "channel_id": "c1", "sender_id": "u1", "seq": 7, "updated_seq": 7, "client_msg_id": "k1",
         "body": "📞 通話を始めました\\n\(url)", "created_at": "2026-10-06T10:00:00Z", "edited_at": null, "deleted": false,
         "call": {"url": "\(url)", "started_by": "u1"}}
        """
        let message = try decode(MessageOut.self, json)
        XCTAssertEqual(message.call, MessageCall(url: url, startedBy: "u1"))
        // Into the store and back out (persisted rows, thread rows built from the timeline).
        let state = MessageState(message)
        XCTAssertEqual(state.call, message.call)
        let stored = try JSON.snakeDecoder.decode(MessageState.self, from: try JSON.snakeEncoder.encode(state))
        XCTAssertEqual(stored.call, message.call)
        XCTAssertEqual(MessageOut(stored)?.call, message.call)

        let plain = try decode(MessageOut.self, json.replacingOccurrences(of: #""call": {"url": "\#(url)", "started_by": "u1"}"#, with: #""call": null"#))
        XCTAssertNil(plain.call)
        // A row persisted before M117 has no key at all.
        XCTAssertNil(try decode(MessageOut.self, json.replacingOccurrences(of: #",\#n "call": {"url": "\#(url)", "started_by": "u1"}"#, with: "")).call)

        let answer = try decode(CallOut.self, #"{"url": "\#(url)", "message": \#(json)}"#)
        XCTAssertEqual(answer.url, url)
        XCTAssertEqual(answer.message.id, "m1")
    }

    func testCardTextAndBody() {
        XCTAssertEqual(CallRules.startedLine("加納"), "📞 加納 さんが通話を始めました")
        let call = MessageCall(url: url, startedBy: "u1")
        // The server's body is the card's: nothing more under it.
        XCTAssertEqual(CallRules.extraBody("📞 通話を始めました\n\(url)", call: call), "")
        // An edit's words stay.
        XCTAssertEqual(CallRules.extraBody("📞 通話を始めました\n\(url)\n5 分遅れます", call: call), "5 分遅れます")
        XCTAssertEqual(CallRules.joinUrl(call)?.absoluteString, url)
        XCTAssertNil(CallRules.joinUrl(MessageCall(url: "javascript:alert(1)", startedBy: "u1")))
        XCTAssertNil(CallRules.joinUrl(MessageCall(url: "not a url", startedBy: "u1")))
    }

    func testWhereTheButtonShows() {
        let on = WorkspaceSettings(callsEnabled: true, meetingBaseUrl: "https://meet.jit.si/")
        XCTAssertTrue(CallRules.canStart(channel(), settings: on, isAdmin: false, meId: "me"))
        XCTAssertTrue(CallRules.canStart(channel("private"), settings: on, isAdmin: false, meId: "me"))
        XCTAssertTrue(CallRules.canStart(channel("dm", dm: ["me", "u2"]), settings: on, isAdmin: false, meId: "me"))
        XCTAssertTrue(CallRules.canStart(channel("group_dm", dm: ["me", "u2", "u3"]), settings: on, isAdmin: false, meId: "me"))
        // Calls off, or a server before M117.
        XCTAssertFalse(CallRules.canStart(channel(), settings: WorkspaceSettings(), isAdmin: false, meId: "me"))
        XCTAssertFalse(CallRules.canStart(channel(archived: true), settings: on, isAdmin: false, meId: "me"))
        XCTAssertFalse(CallRules.canStart(channel(member: false), settings: on, isAdmin: false, meId: "me"))
        // An announcement channel: owners and admins.
        XCTAssertFalse(CallRules.canStart(channel(policy: "owners"), settings: on, isAdmin: false, meId: "me"))
        XCTAssertTrue(CallRules.canStart(channel(policy: "owners", role: "owner"), settings: on, isAdmin: false, meId: "me"))
        XCTAssertTrue(CallRules.canStart(channel(policy: "owners"), settings: on, isAdmin: true, meId: "me"))
        // Nobody to call in my DM with myself.
        XCTAssertFalse(CallRules.canStart(channel("dm", dm: ["me"]), settings: on, isAdmin: false, meId: "me"))
    }

    func testRetryKeepsTheKey() {
        var keys = CallKeys()
        var made = 0
        let make = { () -> String in made += 1; return "k\(made)" }
        let start = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(keys.key(for: "c1", now: start, make: make), "k1")
        // A retry after a failure: the same call.
        XCTAssertEqual(keys.key(for: "c1", now: start.addingTimeInterval(30), make: make), "k1")
        // Another conversation has its own.
        XCTAssertEqual(keys.key(for: "c2", now: start, make: make), "k2")
        // Posted (or refused): the next tap is a new call.
        keys.done("c1")
        XCTAssertEqual(keys.key(for: "c1", now: start.addingTimeInterval(60), make: make), "k3")
        // Much later: a new call too.
        XCTAssertEqual(keys.key(for: "c2", now: start.addingTimeInterval(CallKeys.lifetime + 1), make: make), "k4")
    }
}
