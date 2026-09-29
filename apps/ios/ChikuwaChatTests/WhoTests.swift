import XCTest
@testable import ChikuwaChat

/// M27: who voted (and anonymous polls), who reacted and confirmed, and the preview before joining.
@MainActor
final class WhoTests: XCTestCase {
    private func message(updatedSeq: Int, poll: String) throws -> MessageOut {
        let wire = """
        {"id": "m1", "channel_id": "c1", "sender_id": "u1", "seq": 3, "updated_seq": \(updatedSeq), "client_msg_id": null,
         "body": "📊 どこ?", "created_at": "2026-09-29T04:00:00Z", "edited_at": null, "deleted": false, "poll": \(poll)}
        """
        return try JSON.snakeDecoder.decode(MessageOut.self, from: Data(wire.utf8))
    }

    func testAPollFromAnOlderServerStillCountsFromItsVoters() throws {
        let poll = try XCTUnwrap(message(updatedSeq: 3, poll: #"{"question": "どこ?", "options": ["A", "B"], "multiple": false, "closed_at": null, "votes": [["u1", "u2"], ["u3"]]}"#).poll)
        XCTAssertFalse(poll.isAnonymous)
        XCTAssertEqual([poll.count(0), poll.count(1), poll.total], [2, 1, 3])
        XCTAssertTrue(poll.votedByMe(0, me: "u2"))
        XCTAssertFalse(poll.votedByMe(1, me: "u2"))
    }

    func testAnAnonymousPollCountsWithoutVotersAndKnowsMineOnlyFromTheServer() throws {
        let poll = try XCTUnwrap(message(updatedSeq: 3, poll: #"{"question": "どこ?", "options": ["A", "B"], "multiple": true, "anonymous": true, "closed_at": null, "votes": [[], []], "counts": [2, 5], "mine": [1]}"#).poll)
        XCTAssertTrue(poll.isAnonymous)
        XCTAssertEqual([poll.count(0), poll.count(1), poll.total], [2, 5, 7])
        XCTAssertEqual(poll.voters(1), [])
        XCTAssertEqual([poll.votedByMe(0, me: "u1"), poll.votedByMe(1, me: "u1")], [false, true])
    }

    /// SYNC_PROTOCOL.md §8: my own votes come only in a response to me; the event of the same change has none.
    func testMyVotesSurviveTheEventWhicheverComesFirst() throws {
        let event = #"{"question": "Q", "options": ["A", "B"], "multiple": false, "anonymous": true, "closed_at": null, "votes": [[], []], "counts": [0, 1], "mine": null}"#
        let response = #"{"question": "Q", "options": ["A", "B"], "multiple": false, "anonymous": true, "closed_at": null, "votes": [[], []], "counts": [0, 1], "mine": [1]}"#

        // The event first, then the response of the same updated_seq: the response still brings mine.
        let store = Store()
        store.upsertMessage(try message(updatedSeq: 4, poll: event))
        XCTAssertNil(store.message("c1", id: "m1")?.poll?.mine)
        XCTAssertTrue(store.upsertMessage(try message(updatedSeq: 4, poll: response)))
        XCTAssertEqual(store.message("c1", id: "m1")?.poll?.mine, [1])

        // The response first, then the event: the event does not take it away.
        let other = Store()
        other.upsertMessage(try message(updatedSeq: 4, poll: response))
        XCTAssertFalse(other.upsertMessage(try message(updatedSeq: 4, poll: event)))
        XCTAssertEqual(other.message("c1", id: "m1")?.poll?.mine, [1])

        // Someone else's later vote (an event, updated_seq 5) keeps what I voted for.
        let later = #"{"question": "Q", "options": ["A", "B"], "multiple": false, "anonymous": true, "closed_at": null, "votes": [[], []], "counts": [1, 1], "mine": null}"#
        XCTAssertTrue(other.upsertMessage(try message(updatedSeq: 5, poll: later)))
        XCTAssertEqual(other.message("c1", id: "m1")?.poll?.counts, [1, 1])
        XCTAssertEqual(other.message("c1", id: "m1")?.poll?.mine, [1])
    }

    func testNamesShowAFewThenHowManyMore() {
        XCTAssertEqual(PeopleList.compact(["山田"]), "山田")
        XCTAssertEqual(PeopleList.compact(["山田", "佐藤", "鈴木"]), "山田、佐藤、鈴木")
        XCTAssertEqual(PeopleList.compact(["山田", "佐藤", "鈴木", "田中", "高橋"]), "山田、佐藤、鈴木 ほか 2 人")
    }

    func testAPreviewPageReadsOldestFirstWithoutDeletedOnes() throws {
        func row(_ id: String, seq: Int, deleted: Bool = false) throws -> MessageOut {
            try JSON.snakeDecoder.decode(MessageOut.self, from: Data("""
            {"id": "\(id)", "channel_id": "c1", "sender_id": "u1", "seq": \(seq), "updated_seq": \(seq), "client_msg_id": null,
             "body": "\(id)", "created_at": "2026-09-29T04:00:00Z", "edited_at": null, "deleted": \(deleted)}
            """.utf8))
        }
        let page = [try row("c", seq: 3), try row("b", seq: 2, deleted: true), try row("a", seq: 1)] // the server: newest first
        XCTAssertEqual(ChannelPreviewView.rows(page).map(\.id), ["a", "c"])
    }
}

/// M27: a named poll's request has no `anonymous` (a server before M27 refuses fields it does not know).
@MainActor
final class PollRequestTests: XCTestCase {
    func testAnonymousIsSentOnlyWhenAskedFor() async throws {
        var bodies: [String] = []
        StubProtocol.handler = { request in
            let body = request.httpBodyStream.map { stream -> String in
                stream.open(); defer { stream.close() }
                var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                return String(decoding: data, as: UTF8.self)
            } ?? ""
            bodies.append(body)
            return (201, Data("""
            {"id": "m1", "channel_id": "c1", "sender_id": "u1", "seq": 1, "updated_seq": 1, "client_msg_id": null, "body": "📊 Q",
             "created_at": "2026-09-29T04:00:00Z", "edited_at": null, "deleted": false,
             "poll": {"question": "Q", "options": ["A", "B"], "multiple": false, "closed_at": null, "votes": [[], []]}}
            """.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        _ = try await client.postPoll(channelId: "c1", parentId: nil, question: "Q", options: ["A", "B"], multiple: false)
        _ = try await client.postPoll(channelId: "c1", parentId: nil, question: "Q", options: ["A", "B"], multiple: false, anonymous: true)
        XCTAssertFalse(bodies[0].contains("anonymous"), bodies[0])
        XCTAssertTrue(bodies[1].contains(#""anonymous":true"#), bodies[1])
    }
}
