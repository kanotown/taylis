import XCTest
@testable import ChikuwaChat

/// Runs the shared contract fixtures (server/tests/contract/*.json, SYNC_PROTOCOL.md §13).
@MainActor
final class ContractTests: XCTestCase {
    @MainActor
    private struct Scenario {
        let server = FakeServer()
        var channelId = ""
        var store = Store()
        var engine: SyncEngine?
        var clientUser = ""
        var options: [String: JSONValue] = [:]
        var posted = 0
    }

    private func fixtures() throws -> [(String, [String: JSONValue])] {
        let bundle = Bundle(for: ContractTests.self)
        guard let directory = bundle.url(forResource: "contract", withExtension: nil) else {
            XCTFail("contract fixtures are not bundled")
            return []
        }
        let files = try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
            .sorted { $0.lastPathComponent < $1.lastPathComponent }
        return try files.map { url in
            let spec = try JSON.plainDecoder.decode([String: JSONValue].self, from: Data(contentsOf: url))
            return (url.lastPathComponent, spec)
        }
    }

    func testContractFixtures() async throws {
        let all = try fixtures()
        XCTAssertGreaterThanOrEqual(all.count, 7)
        for (name, spec) in all {
            var scenario = Scenario()
            for step in spec["steps"]?.arrayValue ?? [] {
                do {
                    try await run(step, &scenario)
                } catch {
                    XCTFail("\(name): \(error)")
                    break
                }
            }
            scenario.engine?.stop()
        }
    }

    private func newEngine(_ s: Scenario, store: Store) -> SyncEngine {
        let user = s.server.user(named: s.clientUser)
        var options = EngineOptions()
        options.pageSize = Int(s.options["page_size"]?.doubleValue ?? 50)
        options.gapLimit = Int(s.options["gap_limit"]?.doubleValue ?? 5000)
        options.sleep = { _ in }
        return SyncEngine(api: s.server.api(for: user.id), connect: s.server.connector(for: user.id), wsUrl: URL(string: "ws://fake")!,
                          store: store, getAccessToken: { "t" }, options: options)
    }

    private func settle(_ engine: SyncEngine?) async {
        guard let engine else { return }
        for _ in 0..<50 {
            await engine.idle()
            await Task.yield()
        }
    }

    private func key(_ step: JSONValue) -> String {
        "00000000-0000-5000-8000-" + String(repeating: "0", count: max(0, 12 - (step["key"]?.stringValue ?? "").count)) + (step["key"]?.stringValue ?? "")
    }

    private func run(_ step: JSONValue, _ s: inout Scenario) async throws {
        let op = step["op"]?.stringValue ?? ""
        switch op {
        case "users":
            for name in step["names"]?.arrayValue ?? [] { s.server.addUser(name.stringValue ?? "") }
        case "channel":
            let owner = s.server.user(named: step["owner"]?.stringValue ?? "")
            s.channelId = s.server.createChannel(step["name"]?.stringValue ?? "", ownerId: owner.id).id
            for member in step["members"]?.arrayValue ?? [] { s.server.join(s.channelId, s.server.user(named: member.stringValue ?? "").id) }
        case "post":
            let sender = s.server.user(named: step["as"]?.stringValue ?? "")
            for _ in 0..<Int(step["count"]?.doubleValue ?? 1) {
                s.posted += 1
                try s.server.post(channelId: s.channelId, senderId: sender.id, body: (step["body"]?.stringValue ?? "").replacingOccurrences(of: "{i}", with: String(s.posted)))
            }
        case "client.start":
            s.clientUser = step["as"]?.stringValue ?? ""
            if case .object(let options) = step { s.options = options }
            s.store = Store()
            let engine = newEngine(s, store: s.store)
            s.engine = engine
            await engine.openChannel(s.channelId)
            await engine.start()
            await settle(engine)
        case "client.stop":
            s.engine?.stop()
        case "client.restart":
            let snapshot = s.store.snapshot()
            s.engine?.stop()
            s.store = Store.fromSnapshot(snapshot)
            let engine = newEngine(s, store: s.store)
            s.engine = engine
            await engine.openChannel(s.channelId)
            await engine.start()
            await settle(engine)
        case "client.receive":
            await settle(s.engine)
        case "client.drop_next":
            let user = s.server.user(named: s.clientUser)
            for socket in s.server.sockets(of: user.id) { socket.dropNext += Int(step["count"]?.doubleValue ?? 0) }
        case "client.send":
            await s.engine?.send(s.channelId, body: step["body"]?.stringValue ?? "", clientMsgId: key(step))
            await settle(s.engine)
        case "client.send_event_first":
            let user = s.server.user(named: s.clientUser)
            let clientKey = key(step)
            s.store.putPlaceholder(MessageState(placeholderFor: clientKey, channelId: s.channelId, senderId: user.id, body: step["body"]?.stringValue ?? "", createdAt: "9999"))
            let (message, _) = try s.server.post(channelId: s.channelId, senderId: user.id, body: step["body"]?.stringValue ?? "", clientMsgId: clientKey)
            await settle(s.engine)
            s.store.upsertMessage(message)
        case "expect":
            let bodies = s.store.messages(s.channelId).map(\.body)
            let channel = s.store.channel(s.channelId)
            if let expected = step["messages"]?.arrayValue { XCTAssertEqual(bodies, expected.compactMap(\.stringValue)) }
            if let count = step["message_count"]?.doubleValue { XCTAssertEqual(bodies.count, Int(count)) }
            if let first = step["first_body"]?.stringValue { XCTAssertEqual(bodies.first, first) }
            if let last = step["last_body"]?.stringValue { XCTAssertEqual(bodies.last, last) }
            if let synced = step["synced_seq"]?.doubleValue { XCTAssertEqual(channel?.syncedSeq, Int(synced)) }
            if let catchUps = step["catch_ups"]?.doubleValue { XCTAssertEqual(s.engine?.catchUps, Int(catchUps)) }
            if let reloads = step["reloads"]?.doubleValue { XCTAssertEqual(s.engine?.reloads, Int(reloads)) }
            if let serverCount = step["server_message_count"]?.doubleValue { XCTAssertEqual(s.server.channels[s.channelId]?.messages.count, Int(serverCount)) }
        default:
            XCTFail("unknown op \(op)")
        }
    }
}

extension JSONValue {
    var doubleValue: Double? { if case .number(let n) = self { return n } else { return nil } }
}
