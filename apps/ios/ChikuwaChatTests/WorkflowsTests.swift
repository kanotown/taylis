import XCTest
@testable import ChikuwaChat

/// M95 (WORKFLOWS.md §8 6.): the form's rules against apps/shared/workflows.json (the server, the desktop and Android read
/// the same cases), `MessageOut.workflow` decoding, `/name` and `/wf name`, and a retried submit reusing its key.
@MainActor
final class WorkflowsTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Render: Decodable { let name: String; let fields: [WorkflowField]; let template: String; let values: [String: JSONValue]; let expected: String }
        struct Values: Decodable {
            let name: String
            var fields: [WorkflowField]? = nil
            let values: [String: JSONValue]
            let cleaned: [String: JSONValue]?
            let errors: [String: String]?
        }
        struct Keys: Decodable { let valid: [String]; let invalid: [String] }
        struct Default: Decodable {
            let name: String
            let type: String
            let `default`: WorkflowFieldDefault?
            let today: String
            var me: String? = nil
            let expected: JSONValue
        }
        let render: [Render]
        let valueFields: [WorkflowField]
        let values: [Values]
        let keys: Keys
        let defaults: [Default]
    }

    private func vectors() throws -> Vectors {
        // The repository's own file (the simulator reads the Mac's disk).
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/workflows.json")
        return try JSON.snakeDecoder.decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func day(_ text: String) throws -> Templates.Day { try XCTUnwrap(Workflows.parseDate(text)) }

    /// A vector's raw values as the form holds them (the render cases hold well-formed values only).
    private func formValues(_ raw: [String: JSONValue]) -> [String: Workflows.Value] {
        raw.compactMapValues { value -> Workflows.Value? in
            switch value {
            case .string(let text): return .text(text)
            case .bool(let on): return .flag(on)
            case .array(let items): return .users(items.compactMap(\.stringValue))
            default: return nil
            }
        }
    }

    func testSharedRenderVectors() throws {
        let vectors = try vectors()
        XCTAssertFalse(vectors.render.isEmpty)
        for c in vectors.render {
            XCTAssertEqual(Workflows.render(c.template, fields: c.fields, values: formValues(c.values)), c.expected, c.name)
            // The preview of values that check out is the message itself.
            XCTAssertEqual(Workflows.preview(c.template, fields: c.fields, values: formValues(c.values)), c.expected, c.name)
        }
    }

    func testSharedValueVectors() throws {
        let vectors = try vectors()
        XCTAssertFalse(vectors.values.isEmpty)
        for c in vectors.values {
            let result = Workflows.clean(c.fields ?? vectors.valueFields, c.values)
            if let errors = c.errors {
                XCTAssertEqual(result, .invalid(errors), c.name)
            } else if case .ok(let cleaned) = result {
                XCTAssertEqual(cleaned.mapValues(\.json), c.cleaned, c.name)
            } else {
                XCTFail("\(c.name): \(result)")
            }
        }
    }

    func testSharedKeysAndDefaults() throws {
        let vectors = try vectors()
        for key in vectors.keys.valid { XCTAssertTrue(Workflows.validKey(key), key) }
        for key in vectors.keys.invalid { XCTAssertFalse(Workflows.validKey(key), key) }
        XCTAssertFalse(vectors.defaults.isEmpty)
        for c in vectors.defaults {
            let field = WorkflowField(key: "k", label: "K", type: c.type, defaultValue: c.default)
            XCTAssertEqual(Workflows.defaultValue(field, today: try day(c.today), me: c.me).json, c.expected, c.name)
        }
    }

    func testPreviewTreatsUnfinishedValuesAsEmpty() {
        let fields = [WorkflowField(key: "日付", label: "日付", type: "date"), WorkflowField(key: "a", label: "A", type: "text")]
        XCTAssertEqual(Workflows.preview("日 {{日付}}\nA {{a}}", fields: fields, values: ["日付": .text("2026-02-30"), "a": .text("x")]), "A x")
    }

    func testDatePickerRoundTrip() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        for (value, type) in [("2026-10-06", "date"), ("13:05", "time"), ("2026-05-19T13:00", "datetime")] {
            let date = try XCTUnwrap(WorkflowDates.date(value, type: type, calendar: calendar))
            XCTAssertEqual(WorkflowDates.text(date, type: type, calendar: calendar), value)
        }
        XCTAssertNil(WorkflowDates.date("", type: "date"))
    }

    // MARK: MessageOut.workflow

    private func messageJSON(_ extra: String) -> Data {
        Data("""
        {"id":"m1","channel_id":"c1","sender_id":"u1","seq":3,"updated_seq":3,"client_msg_id":null,"body":"報告",
         "created_at":"2026-10-04T00:00:00Z","edited_at":null,"deleted":false\(extra)}
        """.utf8)
    }

    func testWorkflowDecodesMissingNullAndPresent() throws {
        XCTAssertNil(try JSON.snakeDecoder.decode(MessageOut.self, from: messageJSON("")).workflow)
        XCTAssertNil(try JSON.snakeDecoder.decode(MessageOut.self, from: messageJSON(#","workflow":null"#)).workflow)
        let message = try JSON.snakeDecoder.decode(MessageOut.self, from: messageJSON(#","workflow":{"id":"w1","name":"ゼミ欠席報告"}"#))
        XCTAssertEqual(message.workflow, MessageWorkflow(id: "w1", name: "ゼミ欠席報告"))
        // Kept through the store's row and back, and in the persisted row.
        let state = MessageState(message)
        XCTAssertEqual(state.workflow, message.workflow)
        XCTAssertEqual(MessageOut(state)?.workflow, message.workflow)
        let stored = try JSON.plainDecoder.decode(MessageState.self, from: JSON.plainEncoder.encode(state))
        XCTAssertEqual(stored.workflow, message.workflow)
        // A shape this version does not know does not lose the message.
        XCTAssertNil(try JSON.snakeDecoder.decode(MessageOut.self, from: messageJSON(#","workflow":"x""#)).workflow)
    }

    // MARK: `/name` and `/wf name`

    private func workflow(_ name: String, id: String? = nil, runBlocked: String? = nil) -> WorkflowOut {
        WorkflowOut(id: id ?? name, name: name, channelId: "c1", template: "x", canRun: runBlocked == nil, runBlocked: runBlocked)
    }

    func testSlashCommands() throws {
        let list = [workflow("欠席報告"), workflow("学部 ゼミ案内"), workflow("Bib")]
        func open(_ text: String) -> String? {
            guard let parsed = SlashCommands.parse(text) else { return nil }
            return Workflows.command(name: parsed.name, args: parsed.args, in: list)?.name
        }
        XCTAssertEqual(open("/欠席報告"), "欠席報告")
        XCTAssertEqual(open("/bib"), "Bib")  // any case
        XCTAssertNil(open("/欠席報告 理由"))  // words after the name: not a workflow
        XCTAssertEqual(open("/wf 欠席報告"), "欠席報告")
        XCTAssertEqual(open("/WF   学部   ゼミ案内 "), "学部 ゼミ案内")  // spaces fold
        XCTAssertNil(open("/学部"))  // a name with spaces opens through /wf only
        XCTAssertNil(open("/wf"))
        XCTAssertNil(open("/wf 無い"))

        XCTAssertEqual(Workflows.candidates("/", in: list).map(\.name), ["欠席報告", "Bib"])
        XCTAssertEqual(Workflows.candidates("/b", in: list).map(\.name), ["Bib"])
        XCTAssertEqual(Workflows.candidates("/wf 学部 ゼ", in: list).map(\.name), ["学部 ゼミ案内"])
        XCTAssertEqual(Workflows.candidates("/wf ", in: list).count, 3)
        XCTAssertEqual(Workflows.candidates("/欠席報告 ", in: list), [])
        XCTAssertEqual(Workflows.commandText(list[1]), "/wf 学部 ゼミ案内")
        XCTAssertEqual(Workflows.commandText(list[0]), "/欠席報告")
    }

    func testRunBlockedTexts() {
        XCTAssertNil(Workflows.runBlockedText(workflow("a"), target: "#報告"))
        XCTAssertEqual(Workflows.runBlockedText(workflow("a", runBlocked: "disabled"), target: "#報告"), "停止中")
        XCTAssertEqual(Workflows.runBlockedText(workflow("a", runBlocked: "archived"), target: "#報告"), "#報告 はアーカイブ済みです")
        XCTAssertEqual(Workflows.runBlockedText(workflow("a", runBlocked: "not_a_member"), target: "#報告"), "#報告 に参加すると使えます")
        XCTAssertEqual(Workflows.runBlockedText(workflow("a", runBlocked: "posting_restricted"), target: "#報告"),
                       "#報告 はオーナーと管理者だけが投稿できます")
    }

    func testWorkflowOutDecodes() throws {
        let json = """
        {"id":"w1","name":"ゼミ欠席報告","emoji":null,"description":"","channel_id":"c1","offered_channel_ids":["c1"],
         "fields":[{"key":"日付","label":"日付","type":"date","required":true,"help":"","options":[],"multiple":false,"default":{"kind":"today","value":null,"weekday":null,"time":null}}],
         "template":"{{日付}}","enabled":true,"created_by":"u1","created_at":"x","updated_at":"x","can_manage":false,"can_run":false,"run_blocked":"not_a_member"}
        """
        let workflow = try JSON.snakeDecoder.decode(WorkflowOut.self, from: Data(json.utf8))
        XCTAssertEqual(workflow.mark, "⚡")
        XCTAssertEqual(workflow.fields.first?.defaultValue?.kind, "today")
        XCTAssertEqual(workflow.runBlocked, "not_a_member")
        XCTAssertFalse(workflow.canRun)
    }

    // MARK: submitting

    private final class FakeWorkflowApi: WorkflowApi {
        var keys: [String] = []
        var sent: [[String: JSONValue]] = []
        var failures: [Error] = []

        func channelWorkflows(channelId: String) async throws -> [WorkflowOut] { [] }
        func workflow(id: String) async throws -> WorkflowOut { throw ApiError.api(status: 404, code: "workflow_not_found", message: "") }
        func submitWorkflow(id: String, clientMsgId: String, values: [String: JSONValue]) async throws -> MessageOut {
            keys.append(clientMsgId)
            sent.append(values)
            if !failures.isEmpty { throw failures.removeFirst() }
            return MessageOut(id: "m1", channelId: "c2", senderId: "u1", seq: 1, updatedSeq: 1, clientMsgId: clientMsgId, body: "b",
                              createdAt: "2026-10-04T00:00:00Z", editedAt: nil, deleted: false, workflow: MessageWorkflow(id: id, name: "n"))
        }
    }

    func testRetryReusesTheKey() async {
        let api = FakeWorkflowApi()
        api.failures = [ApiError.network(URLError(.timedOut)), WorkflowValuesInvalid(fields: ["a": "required"])]
        let workflow = WorkflowOut(id: "w1", name: "n", channelId: "c2", fields: [WorkflowField(key: "a", label: "A", type: "text")], template: "{{a}}")
        let submitter = WorkflowSubmitter(api: api)
        let first = await submitter.submit(workflow, values: ["a": .text("  x ")])
        XCTAssertEqual(first, .failed(ErrorMessages.network))
        let second = await submitter.submit(workflow, values: ["a": .text("x")])
        XCTAssertEqual(second, .invalid(["a": "required"]))
        let third = await submitter.submit(workflow, values: ["a": .text("x")])
        guard case .posted(let message) = third else { return XCTFail("\(third)") }
        XCTAssertEqual(api.keys.count, 3)
        XCTAssertEqual(Set(api.keys), [submitter.clientMsgId])
        XCTAssertEqual(message.clientMsgId, submitter.clientMsgId)
        XCTAssertEqual(api.sent.first, ["a": .string("x")])  // the cleaned values go
        // A form that does not check out sends nothing.
        let required = WorkflowOut(id: "w2", name: "n", channelId: "c2", fields: [WorkflowField(key: "a", label: "A", type: "text", required: true)], template: "{{a}}")
        let local = await submitter.submit(required, values: [:])
        XCTAssertEqual(local, .invalid(["a": "required"]))
        XCTAssertEqual(api.keys.count, 3)
        // A new form, a new key.
        XCTAssertNotEqual(WorkflowSubmitter(api: api).clientMsgId, submitter.clientMsgId)
    }

    // MARK: 「確認を求める」 (WORKFLOWS.md §11)

    func testConfirmDecodesAndDecidesWhetherToAsk() throws {
        func decode(_ extra: String) throws -> WorkflowOut {
            try JSON.snakeDecoder.decode(WorkflowOut.self, from: Data(#"{"id":"w1","name":"出勤","channel_id":"c1","template":"x","can_run":true\#(extra)}"#.utf8))
        }
        // An older server leaves it out: those always asked.
        XCTAssertTrue(try decode("").confirm)
        XCTAssertFalse(try decode("").postsWithoutAsking)
        XCTAssertFalse(try decode(#","confirm":false"#).confirm)
        XCTAssertTrue(try decode(#","confirm":false"#).postsWithoutAsking)
        let field = WorkflowField(key: "a", label: "A", type: "text")
        XCTAssertFalse(WorkflowOut(id: "w", name: "n", channelId: "c", fields: [field], template: "{{a}}", confirm: false).postsWithoutAsking)
        XCTAssertFalse(WorkflowOut(id: "w", name: "n", channelId: "c", template: "x", confirm: false, canRun: false, runBlocked: "disabled").postsWithoutAsking)
        XCTAssertFalse(WorkflowOut(id: "w", name: "n", channelId: "c", template: "x").postsWithoutAsking)
    }

    func testAWorkflowThatDoesNotAskPostsAtOnce() async {
        let controller = AppController(defaults: UserDefaults(suiteName: "wf-\(UUID())")!)
        let api = FakeWorkflowApi()
        let quick = WorkflowOut(id: "w9", name: "出勤", channelId: "c2", template: "出勤しました", confirm: false)
        await controller.postWithoutAsking(quick, here: "c1", api: api)
        XCTAssertEqual(api.keys.count, 1)
        XCTAssertEqual(api.sent, [[:]])
        XCTAssertNil(controller.workflowRun)  // no form
        XCTAssertEqual(controller.notice, "送り先のチャンネル に投稿しました")  // posted elsewhere than here

        // It fails: the form opens with the reason and the key that post used (投稿 there retries with it).
        api.failures = [ApiError.network(URLError(.timedOut))]
        await controller.postWithoutAsking(quick, here: "c2", api: api)
        XCTAssertEqual(controller.workflowRun?.workflow, quick)
        XCTAssertEqual(controller.workflowRun?.clientMsgId, api.keys.last)
        XCTAssertEqual(controller.workflowRun?.problem, ErrorMessages.network)
        let retry = WorkflowSubmitter(api: api, clientMsgId: controller.workflowRun!.clientMsgId!)
        _ = await retry.submit(quick, values: [:])
        XCTAssertEqual(api.keys.suffix(2).count, 2)
        XCTAssertEqual(Set(api.keys.suffix(2)), [api.keys.last!])

        // A workflow that asks opens its form, as before.
        controller.workflowRun = nil
        controller.runWorkflow(WorkflowOut(id: "w1", name: "n", channelId: "c2", template: "x"), here: "c2")
        XCTAssertNotNil(controller.workflowRun)
        XCTAssertNil(controller.workflowRun?.clientMsgId)
    }

    func testValuesInvalidDetailsAreRead() throws {
        let body = Data(#"{"error":{"code":"workflow_values_invalid","message":"m","details":{"fields":{"日付":"invalid","人":"user_not_found"}}}}"#.utf8)
        let error = ApiClient.workflowSubmitFailure(status: 400, data: body) as? WorkflowValuesInvalid
        XCTAssertEqual(error, WorkflowValuesInvalid(fields: ["日付": "invalid", "人": "user_not_found"]))
        XCTAssertNil(ApiClient.workflowSubmitFailure(status: 409, data: Data(#"{"error":{"code":"workflow_disabled","message":"m"}}"#.utf8)))
    }

    func testListIsKeptAMinute() async {
        let controller = AppController(defaults: UserDefaults(suiteName: "wf-\(UUID())")!)
        let list = [workflow("a")]
        controller.workflowLists["c1"] = (Date(), list)
        let cached = await controller.channelWorkflows("c1")
        XCTAssertEqual(cached, list)
        // Older than a minute and no client: read again, which cannot happen here.
        let stale = await controller.channelWorkflows("c1", now: Date().addingTimeInterval(61))
        XCTAssertNil(stale)
        XCTAssertEqual(controller.cachedWorkflows("c1"), list)
    }
}
