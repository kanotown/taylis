import XCTest
@testable import ChikuwaChat

// M45: canvases on iOS (docs/CANVAS.md §4.2 / §4.4 / §4.6 / §4.7 / §5). The save loop runs against an in-memory server
// with the desktop fake's line merge (apps/desktop/tests/fakeServer.ts) and a clock the tests move by hand.

private let BODY = "# 議事録\n## 出席\n- alice\n\n## 決定事項\n来週までに研究計画を提出する。\n\n## TODO\n- [ ] 資料\n- [ ] 練習"

// MARK: - the shared fixture (apps/shared/canvas_markdown.json)

final class CanvasMarkdownFixtureTests: XCTestCase {
    private func fixture() throws -> JSONValue {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/canvas_markdown.json")
        return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    }

    /// What the reader sees of inline tokens (a link shows its label; emphasis markers are gone).
    private func plain(_ tokens: [BodyToken]) -> String {
        tokens.map { token -> String in
            switch token {
            case .text(let s), .bold(let s), .italic(let s), .strike(let s), .code(let s): return s
            case .codeBlock(let s, _): return s
            case .link(let url, let label): return label ?? url
            case .mention(let id): return "@" + id
            case .mentionGroup(let id): return "@" + id
            case .mentionAll(let target): return "@" + target
            case .newline: return "\n"
            }
        }.joined()
    }

    private func describe(_ block: BodyBlock) -> JSONValue {
        switch block {
        case .heading(let level, let tokens):
            return .object(["kind": .string("heading"), "level": .number(Double(level)), "text": .string(plain(tokens))])
        case .paragraph(let lines):
            return .object(["kind": .string("paragraph"), "lines": .array(lines.map { .string(plain($0)) })])
        case .list(let ordered, _, let items):
            return .object(["kind": .string("list"), "ordered": .bool(ordered), "items": .array(items.map { .string(plain($0.tokens)) })])
        case .task(let items):
            return .object(["kind": .string("task"), "items": .array(items.map {
                .object(["level": .number(Double($0.level)), "done": .bool($0.done), "text": .string(plain($0.tokens)), "line": .number(Double($0.line))])
            })])
        case .image(let alt, let id, let line):
            return .object(["kind": .string("image"), "alt": .string(alt), "attachment_id": .string(id), "line": .number(Double(line))])
        case .rule:
            return .object(["kind": .string("hr")])
        case .codeBlock(let text, _):
            return .object(["kind": .string("codeblock"), "text": .string(text)])
        case .quote(let lines):
            return .object(["kind": .string("quote"), "lines": .array(lines.map { .string(plain($0)) })])
        case .table:
            return .object(["kind": .string("table")])
        }
    }

    func testBlocksOfTheCanvasDialect() throws {
        let cases = try XCTUnwrap(fixture()["blocks"]?.arrayValue)
        XCTAssertGreaterThanOrEqual(cases.count, 10)
        for item in cases {
            let name = item["name"]?.stringValue ?? "?"
            let body = try XCTUnwrap(item["body"]?.stringValue)
            var canvas = true
            if case .bool(let flag)? = item["canvas"] { canvas = flag }
            let blocks = BodyTokenizer.parseBlocks(body, canvas: canvas).map(describe)
            XCTAssertEqual(blocks, item["blocks"]?.arrayValue, name)
        }
    }

    func testTickingATaskLine() throws {
        for item in try XCTUnwrap(fixture()["toggle"]?.arrayValue) {
            let body = try XCTUnwrap(item["body"]?.stringValue)
            guard case .number(let line)? = item["line"] else { return XCTFail("no line") }
            XCTAssertEqual(CanvasText.toggleTaskLine(body, line: Int(line)), item["expected"]?.stringValue, "\(body) @\(line)")
        }
        XCTAssertEqual(CanvasText.toggleTaskLine("- [ ] a", line: 0, done: false), "- [ ] a") // already so: unchanged
    }

    func testKeepingTheCaret() throws {
        for item in try XCTUnwrap(fixture()["caret"]?.arrayValue) {
            guard case .number(let caret)? = item["caret"], case .number(let expected)? = item["expected"] else { return XCTFail("bad case") }
            XCTAssertEqual(CanvasText.preserveCaret(item["before"]?.stringValue ?? "", item["after"]?.stringValue ?? "", Int(caret)), Int(expected),
                           item["name"]?.stringValue ?? "")
        }
    }

    func testBlocksKnowTheirLinesForTheOutline() {
        let lined = BodyTokenizer.parseLinedBlocks(BODY, canvas: true)
        let headings = lined.compactMap { entry -> Int? in if case .heading = entry.block { return entry.line } else { return nil } }
        XCTAssertEqual(headings, [0, 1, 4, 7])
        XCTAssertEqual(CanvasText.outline(BODY).map(\.line), headings)
        XCTAssertEqual(CanvasText.outline("```\n# not\n```\n## **太字** 見出し").map(\.text), ["太字 見出し"])
    }
}

// MARK: - text helpers: sections, toolbar edits

final class CanvasTextTests: XCTestCase {
    func testSectionOfAHeadingRunsToTheNextOneOfItsLevel() throws {
        let body = "# 議事録\n## 出席\n- alice\n\n## 決定事項\n### 詳細\n本文\n## TODO\n- [ ] 資料"
        let attendance = try XCTUnwrap(CanvasText.section(body, headingLine: 1))
        XCTAssertEqual(CanvasText.slice(body, attendance), "## 出席\n- alice\n")
        let decisions = try XCTUnwrap(CanvasText.section(body, headingLine: 4))
        XCTAssertEqual(CanvasText.slice(body, decisions), "## 決定事項\n### 詳細\n本文") // the ### stays inside
        let todo = try XCTUnwrap(CanvasText.section(body, headingLine: 7))
        XCTAssertEqual(CanvasText.slice(body, todo), "## TODO\n- [ ] 資料") // to the end
        XCTAssertEqual(CanvasText.slice(body, try XCTUnwrap(CanvasText.section(body, headingLine: 0))), body)
        XCTAssertNil(CanvasText.section(body, headingLine: 2))
        // Replacing the section leaves the rest as it was.
        XCTAssertEqual(CanvasText.replacing(body, attendance, with: "## 出席\n- alice\n- bob"),
                       "# 議事録\n## 出席\n- alice\n- bob\n## 決定事項\n### 詳細\n本文\n## TODO\n- [ ] 資料")
    }

    func testSectionFollowsItsHeadingWhenOthersEditElsewhere() throws {
        let before = "# 議事録\n## 出席\n- alice\n## TODO\n- [ ] 資料"
        let section = try XCTUnwrap(CanvasText.section(before, headingLine: 3))
        // Someone added a line above and a line at the end of the section.
        let after = "# 議事録\nメモ\n## 出席\n- alice\n- carol\n## TODO\n- [ ] 資料\n- [ ] 練習"
        let moved = CanvasText.relocateSection(before, after, section)
        XCTAssertEqual(CanvasText.slice(after, moved), "## TODO\n- [ ] 資料\n- [ ] 練習")
        // A section in the middle takes the lines added at its end (before the heading that followed it).
        let attendance = try XCTUnwrap(CanvasText.section(before, headingLine: 1))
        XCTAssertEqual(CanvasText.slice(after, CanvasText.relocateSection(before, after, attendance)), "## 出席\n- alice\n- carol")
        // A heading typed inside the section does not cut it (the boundary is the heading that followed it).
        let typed = "# 議事録\n## 出席\n- alice\n## 欠席\n- dave\n## TODO\n- [ ] 資料"
        let own = CanvasText.replacing(before, attendance, with: "## 出席\n- alice\n## 欠席\n- dave")
        XCTAssertEqual(own, typed)
        let grown = NSRange(location: attendance.location, length: ("## 出席\n- alice\n## 欠席\n- dave" as NSString).length)
        let merged = typed + "\n- [ ] 練習"
        XCTAssertEqual(CanvasText.slice(merged, CanvasText.relocateSection(typed, merged, grown)), "## 出席\n- alice\n## 欠席\n- dave")
    }

    func testToolbarEdits() {
        typealias S = CanvasText.EditState
        XCTAssertEqual(CanvasText.setHeading(S(text: "見出し\n本文", start: 1, end: 1), level: 2), S(text: "## 見出し\n本文", start: 4, end: 4))
        XCTAssertEqual(CanvasText.setHeading(S(text: "## 見出し", start: 4, end: 4), level: 2).text, "見出し")
        XCTAssertEqual(CanvasText.toggleTasks(S(text: "- 資料\n練習", start: 0, end: 7)).text, "- [ ] 資料\n- [ ] 練習")
        XCTAssertEqual(CanvasText.toggleTasks(S(text: "- [ ] 資料\n- [x] 練習", start: 0, end: 15)).text, "資料\n練習")
        XCTAssertEqual(CanvasText.toggleLinePrefix(S(text: "a\nb", start: 0, end: 3), marker: "- ").text, "- a\n- b")
        XCTAssertEqual(CanvasText.toggleWrap(S(text: "abc", start: 1, end: 2), "**"), S(text: "a**b**c", start: 3, end: 4))
        XCTAssertEqual(CanvasText.toggleWrap(S(text: "a**b**c", start: 3, end: 4), "**"), S(text: "abc", start: 1, end: 2))
        XCTAssertEqual(CanvasText.insertLink(S(text: "", start: 0, end: 0)), S(text: "[リンク](https://)", start: 6, end: 14))
        XCTAssertEqual(CanvasText.insertMentionMark(S(text: "担当", start: 2, end: 2)), S(text: "担当 @", start: 4, end: 4))
        XCTAssertEqual(CanvasText.insertRule(S(text: "前", start: 1, end: 1)), S(text: "前\n\n---\n\n", start: 8, end: 8))
        // Return goes on with a new open box / bullet / number, and ends an empty one.
        XCTAssertEqual(CanvasText.continueStructure(S(text: "- [x] 資料", start: 8, end: 8)), S(text: "- [x] 資料\n- [ ] ", start: 15, end: 15))
        XCTAssertEqual(CanvasText.continueStructure(S(text: "- [ ] ", start: 6, end: 6)), S(text: "", start: 0, end: 0))
        XCTAssertEqual(CanvasText.continueStructure(S(text: "2. b", start: 4, end: 4))?.text, "2. b\n3. ")
        XCTAssertNil(CanvasText.continueStructure(S(text: "本文", start: 2, end: 2)))
        XCTAssertEqual(CanvasText.taskProgress(total: 8, done: 3), "3/8")
        XCTAssertNil(CanvasText.taskProgress(total: 0, done: 0))
    }

    func testCanvasLinksOfThisServer() {
        let base = URL(string: "https://chat.example.jp")!
        let id = "0190a2b4-0000-7000-8000-000000000001"
        XCTAssertEqual(CanvasLink.canvasId(base: base, url: "https://chat.example.jp/c/\(id)"), id)
        XCTAssertEqual(CanvasLink.canvasId(base: base, url: "https://CHAT.example.jp/c/\(id.uppercased())?x=1"), id)
        XCTAssertNil(CanvasLink.canvasId(base: base, url: "https://other.example.jp/c/\(id)"))
        XCTAssertNil(CanvasLink.canvasId(base: base, url: "https://chat.example.jp/m/\(id)"))
        XCTAssertEqual(CanvasLink.url(base: base, canvasId: id), "https://chat.example.jp/c/\(id)")
    }
}

// MARK: - permissions (§4.7)

final class CanvasRightsTests: XCTestCase {
    private func channel(type: String = "public", role: String? = "member", member: Bool = true, archived: Bool = false,
                         posting: String? = nil) -> ChannelState {
        var out = ChannelOut(id: "c", type: type, name: "lab", topic: nil, purpose: nil, archived: archived, createdBy: nil, lastSeq: 0,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: role.map { MembershipOut(role: $0, joinedAt: "") },
                             dmUserIds: type == "dm" ? ["me", "alice"] : nil)
        out.postingPolicy = posting
        return ChannelState(channel: out, isMember: member, syncedSeq: nil, lastSeq: 0, hasOlder: false)
    }

    private let me = CanvasRights.Actor(id: "me", isAdmin: false, isGuest: false)
    private let admin = CanvasRights.Actor(id: "me", isAdmin: true, isGuest: false)
    private let guest = CanvasRights.Actor(id: "me", isAdmin: false, isGuest: true)

    func testTheTableOfSection4_7() {
        let alices = (createdBy: "alice", editPolicy: "members")
        let owners = (createdBy: "alice", editPolicy: "owners")
        let mine = (createdBy: "me", editPolicy: "owners")
        // A member: edits a members canvas, only ticks an owners one, manages neither.
        XCTAssertEqual(CanvasRights.of(channel(), actor: me, canvas: alices), CanvasRights(create: true, edit: true, tick: true, manage: false, trash: false))
        XCTAssertEqual(CanvasRights.of(channel(), actor: me, canvas: owners), CanvasRights(create: true, edit: false, tick: true, manage: false, trash: false))
        // Its creator, the conversation's owner, an administrator: everything.
        let all = CanvasRights(create: true, edit: true, tick: true, manage: true, trash: true)
        XCTAssertEqual(CanvasRights.of(channel(), actor: me, canvas: mine), all)
        XCTAssertEqual(CanvasRights.of(channel(role: "owner"), actor: me, canvas: owners), all)
        XCTAssertEqual(CanvasRights.of(channel(), actor: admin, canvas: owners), all)
        // A guest reads only.
        XCTAssertEqual(CanvasRights.of(channel(), actor: guest, canvas: alices), .none)
        // An announcement channel: members do not make canvases nor edit a members one, but tick.
        XCTAssertEqual(CanvasRights.of(channel(posting: "owners"), actor: me, canvas: alices), CanvasRights(create: false, edit: false, tick: true, manage: false, trash: false))
        // Archived, or not a member: nothing.
        XCTAssertEqual(CanvasRights.of(channel(archived: true), actor: admin, canvas: mine), .none)
        XCTAssertEqual(CanvasRights.of(channel(member: false), actor: me, canvas: alices), .none)
        // A DM: its members do everything; only the creator trashes.
        XCTAssertEqual(CanvasRights.of(channel(type: "dm", role: nil), actor: me, canvas: owners), CanvasRights(create: true, edit: true, tick: true, manage: true, trash: false))
        XCTAssertTrue(CanvasRights.of(channel(type: "dm", role: nil), actor: me, canvas: mine).trash)
        // Making one: the conversation decides.
        XCTAssertTrue(CanvasRights.of(channel(), actor: me, canvas: nil).create)
        XCTAssertFalse(CanvasRights.of(channel(), actor: guest, canvas: nil).create)
    }
}

// MARK: - the save loop (§4.4)

/// A clock the tests move by hand: sleeps end when `advance` passes their time.
@MainActor
final class ManualCanvasClock: CanvasClock {
    private(set) var now: TimeInterval = 0
    private var waiters: [(deadline: TimeInterval, order: Int, continuation: CheckedContinuation<Void, Never>)] = []
    private var order = 0

    func sleep(_ seconds: TimeInterval) async {
        await withCheckedContinuation { continuation in
            order += 1
            waiters.append((now + seconds, order, continuation))
        }
    }

    private func yields() async { for _ in 0..<30 { await Task.yield() } }

    func advance(_ seconds: TimeInterval) async {
        await yields() // timers set just now start sleeping first
        let target = now + seconds + 1e-9
        while let next = waiters.filter({ $0.deadline <= target }).min(by: { ($0.deadline, $0.order) < ($1.deadline, $1.order) }) {
            waiters.removeAll { $0.order == next.order }
            now = max(now, next.deadline)
            next.continuation.resume()
            await yields()
        }
        now = max(now, target - 1e-9)
        await yields()
    }

    /// Ends every sleep (a test's end: the tasks find their saver disposed).
    func drain() {
        for waiter in waiters { waiter.continuation.resume() }
        waiters = []
    }
}

/// The server's save (§4.4) with the desktop fake's line merge; canvases by id with their versions (revision → body).
@MainActor
final class FakeCanvasServer {
    struct Record {
        var canvas: CanvasOut
        var deleted = false
        var revisions: [String: String]
    }
    var canvases: [String: Record] = [:]
    /// "user:client_save_id" → the revision a save made and whether it was a side version.
    private var keys: [String: (canvasId: String, revisionId: String, side: Bool)] = [:]
    private var next = 0

    func nextId() -> String {
        next += 1
        return String(format: "00000000-0000-7000-8000-%012d", next)
    }

    func create(by userId: String, channelId: String, title: String = "議事録", body: String, editPolicy: String = "members") -> CanvasOut {
        let id = nextId(), revision = nextId()
        let canvas = CanvasOut(id: id, channelId: channelId, title: title, version: 1, headRevId: revision, isChannelTab: true, editPolicy: editPolicy,
                               templateKey: nil, shareMessageId: nil, taskTotal: 0, taskDone: 0, createdBy: userId, updatedBy: userId,
                               createdAt: "2026-09-30T00:00:00Z", updatedAt: "2026-09-30T00:00:00Z", body: body)
        canvases[id] = Record(canvas: canvas, revisions: [revision: body])
        return canvas
    }

    func head(_ id: String) -> CanvasOut { canvases[id]!.canvas }

    func erase(_ id: String, revision: String) { canvases[id]!.revisions[revision] = nil }

    /// Someone else saves on the head (as another device would).
    @discardableResult
    func saveOnHead(_ userId: String, _ id: String, _ body: String) throws -> CanvasSaveOut {
        try save(userId, id, CanvasSaveIn(baseRevId: head(id).headRevId, body: body, clientSaveId: UUID().uuidString, onConflict: .fail))
    }

    func get(_ userId: String, _ id: String) throws -> CanvasOut {
        guard let record = canvases[id], !record.deleted else { throw ApiError.api(status: 404, code: "canvas_not_found", message: "") }
        return record.canvas
    }

    func save(_ userId: String, _ id: String, _ req: CanvasSaveIn) throws -> CanvasSaveOut {
        guard var record = canvases[id], !record.deleted else { throw ApiError.api(status: 404, code: "canvas_not_found", message: "") }
        if let done = keys["\(userId):\(req.clientSaveId)"] {
            return CanvasSaveOut(canvas: record.canvas, submittedRevId: done.revisionId, merged: done.side)
        }
        guard let base = record.revisions[req.baseRevId] else { throw CanvasSaveFailure.expired(record.canvas) }
        if record.canvas.editPolicy == "owners" && record.canvas.createdBy != userId {
            guard Self.onlyTicks(base, req.body) else { throw ApiError.api(status: 403, code: "canvas_edit_restricted", message: "") }
            if req.onConflict == .ours || req.onConflict == .both { throw ApiError.api(status: 403, code: "canvas_edit_restricted", message: "") }
        }
        func setHead(_ body: String, key: String?) -> String {
            let revision = nextId()
            record.revisions[revision] = body
            record.canvas.body = body
            record.canvas.headRevId = revision
            record.canvas.version += 1
            record.canvas.updatedBy = userId
            if let key { keys["\(userId):\(key)"] = (id, revision, false) }
            return revision
        }
        if req.baseRevId == record.canvas.headRevId || req.body == record.canvas.body {
            if req.body == record.canvas.body { return CanvasSaveOut(canvas: record.canvas, submittedRevId: record.canvas.headRevId, merged: false) }
            let revision = setHead(req.body, key: req.clientSaveId)
            canvases[id] = record
            return CanvasSaveOut(canvas: record.canvas, submittedRevId: revision, merged: false)
        }
        let result = Self.merge3(base, req.body, record.canvas.body, req.onConflict)
        if !result.conflicts.isEmpty && req.onConflict == .fail {
            throw CanvasSaveFailure.conflict(CanvasConflictDetails(head: record.canvas, conflicts: result.conflicts, timedOut: false))
        }
        let side = nextId()
        record.revisions[side] = req.body
        keys["\(userId):\(req.clientSaveId)"] = (id, side, true)
        if result.text != record.canvas.body { _ = setHead(result.text, key: nil) }
        canvases[id] = record
        return CanvasSaveOut(canvas: record.canvas, submittedRevId: side, merged: true)
    }

    private static let task = try! NSRegularExpression(pattern: #"^([ \t]*[-*] \[)([ xX])(\](?: .*)?)$"#)

    static func onlyTicks(_ before: String, _ after: String) -> Bool {
        let a = before.components(separatedBy: "\n"), b = after.components(separatedBy: "\n")
        guard a.count == b.count else { return false }
        return zip(a, b).allSatisfy { x, y in
            if x == y { return true }
            let nx = x as NSString, ny = y as NSString
            guard let mx = task.firstMatch(in: x, range: NSRange(location: 0, length: nx.length)),
                  let my = task.firstMatch(in: y, range: NSRange(location: 0, length: ny.length)) else { return false }
            return nx.substring(with: mx.range(at: 1)) == ny.substring(with: my.range(at: 1)) && nx.substring(with: mx.range(at: 3)) == ny.substring(with: my.range(at: 3))
        }
    }

    /// base index → other index of a longest common subsequence of lines.
    private static func matches(_ a: [String], _ b: [String]) -> [Int: Int] {
        var dp = Array(repeating: Array(repeating: 0, count: b.count + 1), count: a.count + 1)
        for i in stride(from: a.count - 1, through: 0, by: -1) {
            for j in stride(from: b.count - 1, through: 0, by: -1) {
                dp[i][j] = a[i] == b[j] ? dp[i + 1][j + 1] + 1 : max(dp[i + 1][j], dp[i][j + 1])
            }
        }
        var found: [Int: Int] = [:]
        var i = 0, j = 0
        while i < a.count && j < b.count {
            if a[i] == b[j] { found[i] = j; i += 1; j += 1 } else if dp[i + 1][j] >= dp[i][j + 1] { i += 1 } else { j += 1 }
        }
        return found
    }

    /// diff3 on lines: a region one side changed takes that side, insertions at the same place keep both (theirs, then
    /// ours), a line both changed is a conflict (the real merge also merges words within a line).
    static func merge3(_ base: String, _ ours: String, _ theirs: String, _ resolve: CanvasOnConflict) -> (text: String, conflicts: [CanvasConflict]) {
        if ours == base { return (theirs, []) }
        if theirs == base || ours == theirs { return (ours, []) }
        let B = base.components(separatedBy: "\n"), O = ours.components(separatedBy: "\n"), T = theirs.components(separatedBy: "\n")
        let mo = matches(B, O), mt = matches(B, T)
        var conflicts: [CanvasConflict] = []
        var out: [String] = []
        func region(_ b: ArraySlice<String>, _ o: ArraySlice<String>, _ t: ArraySlice<String>, _ oLine: Int, _ tLine: Int) {
            if Array(o) == Array(b) { out += t }
            else if Array(t) == Array(b) || Array(o) == Array(t) { out += o }
            else if b.isEmpty { out += t; out += o }
            else if resolve == .ours { out += o }
            else if resolve == .theirs { out += t }
            else if resolve == .both { out += t; out += o.map { "> " + $0 } }
            else {
                conflicts.append(CanvasConflict(base: b.joined(separator: "\n"), ours: o.joined(separator: "\n"), theirs: t.joined(separator: "\n"),
                                                oursLine: oLine, theirsLine: tLine))
                out += t
            }
        }
        var iB = 0, iO = 0, iT = 0
        while true {
            var j = iB
            while j < B.count && !(mo[j] != nil && mt[j] != nil) { j += 1 }
            if j >= B.count {
                region(B[iB...], O[iO...], T[iT...], iO, iT)
                break
            }
            let oj = mo[j]!, tj = mt[j]!
            if j > iB || oj > iO || tj > iT { region(B[iB..<j], O[iO..<oj], T[iT..<tj], iO, iT) }
            out.append(B[j])
            iB = j + 1
            iO = oj + 1
            iT = tj + 1
        }
        return (out.joined(separator: "\n"), conflicts)
    }
}

/// One user's calls, with failures to inject: "down" fails before the server, "lost" after it (the answer is lost).
@MainActor
final class FakeCanvasApi: CanvasApi {
    enum Failure { case down, lost, busy, rateLimited(Double), error(Error) }
    let server: FakeCanvasServer
    let userId: String
    var calls: [CanvasSaveIn] = []
    var gets: [Int?] = []
    var fail: [Failure] = []
    var lists = 0
    /// The next lists / reads fail with these, in turn.
    var listFail: [Error] = []
    var getFail: [Error] = []
    /// Called as a list is asked for (what the screen shows meanwhile).
    var onList: (() -> Void)?
    /// While set, saves wait for `release()`.
    var holding = false
    private var held: [CheckedContinuation<Void, Never>] = []

    init(server: FakeCanvasServer, userId: String) {
        self.server = server
        self.userId = userId
    }

    func release() {
        holding = false
        for continuation in held { continuation.resume() }
        held = []
    }

    func listCanvases(channelId: String, trashed: Bool) async throws -> [CanvasMeta] {
        lists += 1
        onList?()
        if !listFail.isEmpty { throw listFail.removeFirst() }
        return server.canvases.values.filter { $0.canvas.channelId == channelId && $0.deleted == trashed }.map(\.canvas.meta)
    }

    func getCanvas(id: String, knownVersion: Int?) async throws -> CanvasOut? {
        gets.append(knownVersion)
        if !getFail.isEmpty { throw getFail.removeFirst() }
        let canvas = try server.get(userId, id)
        return knownVersion == canvas.version ? nil : canvas
    }

    func saveCanvas(id: String, _ save: CanvasSaveIn) async throws -> CanvasSaveOut {
        calls.append(save)
        if holding { await withCheckedContinuation { held.append($0) } }
        let failure = fail.isEmpty ? nil : fail.removeFirst()
        switch failure {
        case .down?: throw ApiError.network(URLError(.notConnectedToInternet))
        case .busy?: throw ApiError.api(status: 503, code: "http_503", message: "busy")
        case .rateLimited(let seconds)?: throw CanvasSaveFailure.rateLimited(seconds: seconds)
        case .error(let error)?: throw error
        default: break
        }
        let answer = try server.save(userId, id, save)
        if case .lost? = failure { throw ApiError.network(URLError(.networkConnectionLost)) }
        return answer
    }
}

@MainActor
final class CanvasSaveTests: XCTestCase {
    @MainActor private struct Harness {
        let server: FakeCanvasServer
        let api: FakeCanvasApi
        let clock: ManualCanvasClock
        let saver: CanvasSaver
        let canvas: CanvasOut
        let persisted: Box
        var head: CanvasOut { server.head(canvas.id) }
    }

    final class Box { var states: [CanvasPendingState?] = [] }

    private var cleanups: [() -> Void] = []

    override func tearDown() async throws {
        for cleanup in cleanups { cleanup() }
        cleanups = []
    }

    private static func options() -> CanvasSaverOptions {
        var options = CanvasSaverOptions()
        options.debounce = 2
        options.refreshDebounce = 0.5
        options.retryDelays = [1, 2]
        return options
    }

    /// Bob's saver on alice's canvas.
    private func harness(restored: CanvasPendingState? = nil, body: String = BODY, editPolicy: String = "members",
                         server existing: FakeCanvasServer? = nil, canvas existingCanvas: CanvasOut? = nil) async -> Harness {
        let server = existing ?? FakeCanvasServer()
        let canvas = existingCanvas ?? server.create(by: "alice", channelId: "lab", body: body, editPolicy: editPolicy)
        let api = FakeCanvasApi(server: server, userId: "bob")
        let clock = ManualCanvasClock()
        let saver = CanvasSaver(id: canvas.id, channelId: "lab", api: api, clock: clock, options: Self.options(), restored: restored)
        let box = Box()
        saver.persist = { box.states.append($0) }
        saver.load()
        await saver.settled()
        cleanups.append {
            saver.dispose()
            clock.drain()
        }
        return Harness(server: server, api: api, clock: clock, saver: saver, canvas: canvas, persisted: box)
    }

    func testSavesTheWholeBodyOnceTypingPausesForTwoSeconds() async {
        let h = await harness()
        XCTAssertEqual(h.saver.status, .saved)
        XCTAssertEqual(h.saver.text, BODY)
        h.saver.edit(BODY + "\n- [ ] 予稿")
        XCTAssertEqual(h.saver.status, .editing)
        await h.clock.advance(1.5)
        h.saver.edit(BODY + "\n- [ ] 予稿を出す") // the pause starts again
        await h.clock.advance(1.999)
        XCTAssertEqual(h.api.calls.count, 0)
        await h.clock.advance(0.001)
        await h.saver.settled()
        XCTAssertEqual(h.api.calls.count, 1)
        XCTAssertEqual(h.api.calls.first?.baseRevId, h.canvas.headRevId)
        XCTAssertEqual(h.api.calls.first?.body, BODY + "\n- [ ] 予稿を出す")
        XCTAssertEqual(h.api.calls.first?.onConflict, .fail)
        XCTAssertEqual(h.saver.status, .saved)
        XCTAssertEqual(h.head.body, BODY + "\n- [ ] 予稿を出す")
        XCTAssertEqual(h.persisted.states.last, .some(nil)) // nothing left to keep
    }

    func testFlushSavesAtOnceAndNothingTypedSendsNothing() async {
        let h = await harness()
        await h.saver.flush()
        XCTAssertEqual(h.api.calls.count, 0)
        h.saver.edit("# 新しい本文")
        await h.saver.flush()
        XCTAssertEqual(h.api.calls.count, 1)
        XCTAssertEqual(h.head.body, "# 新しい本文")
    }

    func testTakesTheMergedBodyWhenNothingWasTypedMeanwhile() async throws {
        let h = await harness()
        try h.server.saveOnHead("alice", h.canvas.id, BODY.replacingOccurrences(of: "- alice", with: "- alice\n- carol"))
        let before = h.saver.textRevision
        h.saver.edit(BODY.replacingOccurrences(of: "- [ ] 練習", with: "- [ ] 練習 (bob)"))
        await h.saver.flush()
        let merged = BODY.replacingOccurrences(of: "- alice", with: "- alice\n- carol").replacingOccurrences(of: "- [ ] 練習", with: "- [ ] 練習 (bob)")
        XCTAssertEqual(h.saver.text, merged) // both lines stay
        XCTAssertEqual(h.saver.textRevision, before + 1) // the editor takes it
        XCTAssertEqual(h.saver.status, .saved)
        // The next save is written on the head (the merged version).
        let head = h.head.headRevId
        h.saver.edit(h.saver.text + "\n")
        await h.saver.flush()
        XCTAssertEqual(h.api.calls.last?.baseRevId, head)
        XCTAssertEqual(h.head.body, h.saver.text)
    }

    func testTypingDuringASaveKeepsTheTextAndTheNextSaveIsWrittenOnWhatWasSent() async throws {
        let h = await harness()
        try h.server.saveOnHead("alice", h.canvas.id, BODY.replacingOccurrences(of: "- alice", with: "- alice\n- carol"))
        h.api.holding = true
        let sent = BODY.replacingOccurrences(of: "研究計画", with: "発表資料")
        h.saver.edit(sent)
        let flushing = Task { await h.saver.flush() }
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(h.saver.status, .saving)
        h.saver.edit(sent + "\n追記") // typed while the save is on the wire
        h.api.release()
        await flushing.value
        XCTAssertEqual(h.saver.text, sent + "\n追記") // not replaced under the typing
        XCTAssertEqual(h.saver.status, .editing)
        await h.clock.advance(2)
        await h.saver.settled()
        let second = try XCTUnwrap(h.api.calls.dropFirst().first)
        XCTAssertNotEqual(second.baseRevId, h.canvas.headRevId)
        XCTAssertEqual(h.server.canvases[h.canvas.id]?.revisions[second.baseRevId], sent) // the side version
        let expected = BODY.replacingOccurrences(of: "- alice", with: "- alice\n- carol").replacingOccurrences(of: "研究計画", with: "発表資料") + "\n追記"
        XCTAssertEqual(h.head.body, expected)
        XCTAssertEqual(h.saver.text, expected) // the merge came in once typing stopped
    }

    func testASaveLostOnTheNetworkGoesAgainWithTheSameKeyBodyAndBase() async {
        let h = await harness()
        h.api.fail = [.lost, .down]
        h.saver.edit(BODY + "\n追記")
        await h.saver.flush()
        XCTAssertEqual(h.saver.status, .offline)
        let version = h.head.version
        await h.clock.advance(1) // the second attempt fails before the server
        await h.saver.settled()
        XCTAssertEqual(h.saver.status, .offline)
        await h.clock.advance(2)
        await h.saver.settled()
        XCTAssertEqual(h.api.calls.count, 3)
        XCTAssertEqual(Set(h.api.calls.map(\.clientSaveId)).count, 1)
        XCTAssertEqual(Set(h.api.calls.map(\.baseRevId)).count, 1)
        XCTAssertTrue(h.api.calls.allSatisfy { $0.body == BODY + "\n追記" })
        XCTAssertEqual(h.head.version, version) // the retry made no second version
        XCTAssertEqual(h.saver.status, .saved)
    }

    func testBusyAndRateLimitedRetryTheSameWayAndOnlineSendsAtOnce() async {
        let h = await harness()
        h.api.fail = [.busy]
        h.saver.edit(BODY + "\nx")
        await h.saver.flush()
        XCTAssertEqual(h.saver.status, .retrying)
        h.saver.online()
        await h.saver.settled()
        XCTAssertEqual(h.api.calls.count, 2)
        XCTAssertEqual(h.api.calls[1].clientSaveId, h.api.calls[0].clientSaveId)
        XCTAssertEqual(h.saver.status, .saved)

        // 429 waits as long as the server says (retry_after_seconds), not the usual 1 s.
        h.api.fail = [.rateLimited(5)]
        h.saver.edit(BODY + "\ny")
        await h.saver.flush()
        XCTAssertEqual(h.saver.status, .retrying)
        await h.clock.advance(4.9)
        XCTAssertEqual(h.api.calls.count, 3)
        await h.clock.advance(0.1)
        await h.saver.settled()
        XCTAssertEqual(h.api.calls.count, 4)
        XCTAssertEqual(h.api.calls[3].clientSaveId, h.api.calls[2].clientSaveId)
        XCTAssertEqual(h.saver.status, .saved)
    }

    func testTheUnsavedStateIsKeptAndARelaunchedSaverSendsItWithTheSameKey() async throws {
        let h = await harness()
        h.api.fail = [.lost, .down, .down, .down] // the answer is lost, then the network stays down
        h.saver.edit(BODY + "\n保存前に落ちた")
        await h.saver.flush()
        let kept = try XCTUnwrap(h.persisted.states.last ?? nil)
        XCTAssertEqual(kept.inFlight?.sent, BODY + "\n保存前に落ちた")
        h.saver.edit(BODY + "\n保存前に落ちた\nその後も書いた") // offline typing is kept too
        await h.clock.advance(2)
        XCTAssertEqual((h.persisted.states.last ?? nil)?.text, BODY + "\n保存前に落ちた\nその後も書いた")
        let state = try XCTUnwrap(h.persisted.states.last ?? nil)
        h.saver.dispose()
        // The app starts again: the same key goes out, then what was typed after it.
        let again = await harness(restored: state, server: h.server, canvas: h.canvas)
        XCTAssertEqual(again.api.calls.first?.clientSaveId, kept.inFlight?.clientSaveId)
        await again.saver.settled()
        XCTAssertEqual(again.saver.status, .saved)
        XCTAssertEqual(again.head.body, BODY + "\n保存前に落ちた\nその後も書いた")
        XCTAssertEqual(again.saver.text, again.head.body)
    }

    private func conflicted() async throws -> Harness {
        let h = await harness()
        try h.server.saveOnHead("alice", h.canvas.id, BODY.replacingOccurrences(of: "研究計画", with: "発表資料"))
        h.saver.edit(BODY.replacingOccurrences(of: "研究計画", with: "予稿"))
        await h.saver.flush()
        return h
    }

    func testAConflictWaitsForAChoiceAndSavesNothingMeanwhile() async throws {
        let h = try await conflicted()
        XCTAssertEqual(h.saver.status, .conflict)
        XCTAssertEqual(h.saver.conflict?.details.conflicts?.first?.ours, "来週までに予稿を提出する。")
        XCTAssertEqual(h.saver.conflict?.details.conflicts?.first?.theirs, "来週までに発表資料を提出する。")
        h.saver.edit(h.saver.text + "\n続き")
        await h.clock.advance(5)
        XCTAssertEqual(h.api.calls.count, 1)
        XCTAssertNotNil(h.persisted.states.last ?? nil) // kept until chosen
    }

    func testEachChoiceSendsTheTextAgainOnTheSameVersionWithANewKey() async throws {
        let cases: [(CanvasOnConflict, String)] = [
            (.ours, "来週までに予稿を提出する。"),
            (.theirs, "来週までに発表資料を提出する。"),
            (.both, "来週までに発表資料を提出する。\n> 来週までに予稿を提出する。"),
        ]
        for (choice, line) in cases {
            let h = try await conflicted()
            let first = h.api.calls[0]
            await h.saver.resolveConflict(choice)
            let second = h.api.calls[1]
            XCTAssertEqual(second.baseRevId, first.baseRevId)
            XCTAssertEqual(second.body, first.body)
            XCTAssertEqual(second.onConflict, choice)
            XCTAssertNotEqual(second.clientSaveId, first.clientSaveId)
            XCTAssertEqual(h.saver.status, .saved, "\(choice)")
            XCTAssertTrue(h.head.body.contains(line), "\(choice)")
            XCTAssertEqual(h.saver.text, h.head.body)
            // Saves after it go back to asking.
            h.saver.edit(h.saver.text + "\n")
            await h.saver.flush()
            XCTAssertEqual(h.api.calls.last?.onConflict, .fail)
        }
    }

    func testAMemberWhoMayOnlyTickTakesTheOtherVersion() async throws {
        let h = await harness(editPolicy: "owners")
        // Bob ticks 資料 while alice rewrites that line: the same line changed on both sides.
        try h.server.saveOnHead("alice", h.canvas.id, BODY.replacingOccurrences(of: "- [ ] 資料", with: "- [ ] 資料を集める"))
        let ticked = try XCTUnwrap(CanvasText.toggleTaskLine(h.saver.text, line: 8))
        h.saver.edit(ticked, external: true)
        await h.saver.flush()
        XCTAssertEqual(h.saver.status, .conflict)
        // 「自分の版」 is not theirs to take (the server refuses it: 403), 「相手の版」 is.
        await h.saver.resolveConflict(.theirs)
        XCTAssertEqual(h.saver.status, .saved)
        XCTAssertEqual(h.saver.text, BODY.replacingOccurrences(of: "- [ ] 資料", with: "- [ ] 資料を集める"))
        // A plain tick on the head goes through.
        let tick = try XCTUnwrap(CanvasText.toggleTaskLine(h.saver.text, line: 9))
        h.saver.edit(tick, external: true)
        await h.saver.flush()
        XCTAssertEqual(h.saver.status, .saved)
        XCTAssertTrue(h.head.body.hasSuffix("- [x] 練習"))
        // Anything more than a box is refused (403): saving stops, the text stays.
        h.saver.edit(h.saver.text + "\n勝手に追記")
        await h.saver.flush()
        XCTAssertEqual(h.saver.status, .blocked)
        XCTAssertTrue(h.saver.text.hasSuffix("勝手に追記"))
    }

    func testABaseThatIsGoneShowsTheCurrentBodyAndBothChoicesWork() async throws {
        let h = await harness()
        try h.server.saveOnHead("alice", h.canvas.id, BODY + "\nalice")
        h.server.erase(h.canvas.id, revision: h.canvas.headRevId) // pruned while bob was away
        h.saver.edit(BODY + "\nbob")
        await h.saver.flush()
        XCTAssertEqual(h.saver.status, .expired)
        XCTAssertEqual(h.saver.expired?.body, BODY + "\nalice")
        let current = h.head.headRevId
        await h.saver.resolveExpired(keepMine: true)
        XCTAssertEqual(h.api.calls.last?.baseRevId, current)
        XCTAssertEqual(h.head.body, BODY + "\nbob")
        XCTAssertEqual(h.saver.status, .saved)

        let g = await harness()
        try g.server.saveOnHead("alice", g.canvas.id, BODY + "\nalice")
        g.server.erase(g.canvas.id, revision: g.canvas.headRevId)
        g.saver.edit(BODY + "\nbob")
        await g.saver.flush()
        await g.saver.resolveExpired(keepMine: false)
        XCTAssertEqual(g.saver.text, BODY + "\nalice")
        XCTAssertEqual(g.saver.status, .saved)
        XCTAssertEqual(g.api.calls.count, 1)
    }

    func testCanvasUpdatedWhileIdleReadsAgainAfterAPauseWithIfNoneMatch() async throws {
        let h = await harness()
        let gets = h.api.gets.count
        try h.server.saveOnHead("alice", h.canvas.id, BODY + "\nalice")
        h.saver.remoteVersion(h.head.version)
        h.saver.remoteVersion(h.head.version) // a burst: one read
        await h.clock.advance(0.499)
        XCTAssertEqual(h.api.gets.count, gets)
        await h.clock.advance(0.001)
        await h.saver.settled()
        XCTAssertEqual(h.api.gets.count, gets + 1)
        XCTAssertEqual(h.api.gets.last, .some(h.canvas.version)) // If-None-Match with the version held
        XCTAssertEqual(h.saver.text, BODY + "\nalice")
        h.saver.remoteVersion(h.head.version) // nothing newer: no read
        await h.clock.advance(0.6)
        XCTAssertEqual(h.api.gets.count, gets + 1)
    }

    func testCanvasUpdatedWhileTypingReadsNothingAndTheNextSaveMerges() async throws {
        let h = await harness()
        let gets = h.api.gets.count
        h.saver.edit(BODY.replacingOccurrences(of: "- [ ] 練習", with: "- [ ] 練習!"))
        try h.server.saveOnHead("alice", h.canvas.id, BODY.replacingOccurrences(of: "- alice", with: "- alice\n- carol"))
        h.saver.remoteVersion(h.head.version)
        await h.clock.advance(0.6)
        XCTAssertEqual(h.api.gets.count, gets)
        XCTAssertEqual(h.saver.text, BODY.replacingOccurrences(of: "- [ ] 練習", with: "- [ ] 練習!"))
        await h.clock.advance(1.4)
        await h.saver.settled()
        XCTAssertEqual(h.saver.text, BODY.replacingOccurrences(of: "- alice", with: "- alice\n- carol").replacingOccurrences(of: "- [ ] 練習", with: "- [ ] 練習!"))
    }

    func testAnIMECompositionIsNotReplaced() async throws {
        let h = await harness()
        var composing = true
        h.saver.canReplace = { !composing }
        try h.server.saveOnHead("alice", h.canvas.id, BODY + "\nalice")
        h.saver.edit(BODY.replacingOccurrences(of: "研究計画", with: "研究計画書"))
        let revision = h.saver.textRevision
        await h.saver.flush()
        XCTAssertEqual(h.saver.text, BODY.replacingOccurrences(of: "研究計画", with: "研究計画書")) // left alone
        XCTAssertEqual(h.saver.textRevision, revision)
        composing = false
        await h.saver.flush() // nothing typed since: read again
        XCTAssertEqual(h.saver.text, BODY.replacingOccurrences(of: "研究計画", with: "研究計画書") + "\nalice")
    }

    func testARefusalStopsSavingAnEditTriesAgainAndTheTrashStopsItForGood() async {
        let h = await harness()
        h.api.fail = [.error(ApiError.api(status: 422, code: "canvas_too_large", message: "too large"))]
        h.saver.edit(BODY + "\n長すぎる")
        await h.saver.flush()
        XCTAssertEqual(h.saver.status, .blocked)
        XCTAssertEqual(h.saver.text, BODY + "\n長すぎる")
        await h.clock.advance(5)
        XCTAssertEqual(h.api.calls.count, 1)
        h.saver.edit(BODY + "\n短く")
        await h.saver.flush()
        XCTAssertEqual(h.saver.status, .saved)
        h.saver.gone()
        h.saver.edit(BODY + "\nもう保存されない")
        await h.saver.flush()
        XCTAssertEqual(h.saver.status, .gone)
        XCTAssertEqual(h.api.calls.count, 2)
    }
}

// MARK: - the hub: lists, events, the store, a relaunch (§4.6)

@MainActor
final class CanvasHubTests: XCTestCase {
    private func member(_ store: Store, _ id: String = "lab") {
        let out = ChannelOut(id: id, type: "public", name: id, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil)
        store.upsertChannel(out, isMember: true)
    }

    private func options() -> CanvasSaverOptions {
        var options = CanvasSaverOptions()
        options.retryDelays = [1]
        return options
    }

    func testTheListFollowsTheEventsAndAnOpenCanvasReadsAgain() async throws {
        let server = FakeCanvasServer()
        let canvas = server.create(by: "alice", channelId: "lab", body: BODY)
        let api = FakeCanvasApi(server: server, userId: "bob")
        let clock = ManualCanvasClock()
        let store = Store()
        member(store)
        let hub = CanvasHub(api: api, store: store, clock: clock, options: options())
        defer { hub.stop(); clock.drain() }
        XCTAssertNil(store.canvasesOf("lab"))
        await hub.loadList("lab")
        XCTAssertEqual(store.canvasesOf("lab")?.map(\.id), [canvas.id])
        let saver = try XCTUnwrap(hub.hold(canvas.id, channelId: "lab"))
        await saver.settled()
        // Another member saves: canvas.updated carries the metadata only; the open canvas reads the body again.
        let saved = try server.saveOnHead("alice", canvas.id, BODY + "\n追記")
        hub.applyEvent("canvas.updated", try JSONDecoder().decode(JSONValue.self, from: JSON.snakeEncoder.encode(["canvas": saved.canvas.meta])))
        XCTAssertEqual(store.canvasMeta(canvas.id)?.version, saved.canvas.version)
        await clock.advance(0.5)
        await saver.settled()
        XCTAssertEqual(saver.text, BODY + "\n追記")
        // An older version (an overtaken event) does not win.
        var older = saved.canvas.meta
        older.version = 1
        older.title = "古い"
        store.applyCanvasMeta(older)
        XCTAssertEqual(store.canvasMeta(canvas.id)?.title, "議事録")
        // A new one arrives; the trash takes one away and stops its saver.
        let other = server.create(by: "alice", channelId: "lab", title: "週報", body: "")
        hub.applyEvent("canvas.created", try JSONDecoder().decode(JSONValue.self, from: JSON.snakeEncoder.encode(["canvas": other.meta])))
        XCTAssertEqual(Set(store.canvasesOf("lab")?.map(\.id) ?? []), [canvas.id, other.id])
        hub.applyEvent("canvas.deleted", .object(["canvas_id": .string(canvas.id), "channel_id": .string("lab")]))
        XCTAssertEqual(store.canvasesOf("lab")?.map(\.id), [other.id])
        XCTAssertEqual(saver.status, .gone)
    }

    func testEditsKeptInTheStoreAreSentAfterARelaunchWithTheSameKey() async throws {
        let server = FakeCanvasServer()
        let canvas = server.create(by: "alice", channelId: "lab", body: BODY)
        let api = FakeCanvasApi(server: server, userId: "bob")
        let clock = ManualCanvasClock()
        let store = Store()
        member(store)
        let hub = CanvasHub(api: api, store: store, clock: clock, options: options())
        let saver = try XCTUnwrap(hub.hold(canvas.id, channelId: "lab"))
        await saver.settled()
        api.fail = [.down]
        saver.edit(BODY + "\nオフラインで書いた")
        await saver.flush()
        XCTAssertEqual(saver.status, .offline)
        let kept = try XCTUnwrap(store.pendingCanvas(canvas.id))
        XCTAssertEqual(kept.inFlight?.sent, BODY + "\nオフラインで書いた")
        hub.stop()
        clock.drain()

        // The app is killed; its SQLite store (the snapshot here) comes back with the channel and the pending save.
        let relaunched = Store.fromSnapshot(store.snapshot())
        XCTAssertEqual(relaunched.pendingCanvas(canvas.id), kept)
        let api2 = FakeCanvasApi(server: server, userId: "bob")
        let clock2 = ManualCanvasClock()
        let hub2 = CanvasHub(api: api2, store: relaunched, clock: clock2, options: options())
        defer { hub2.stop(); clock2.drain() }
        hub2.online() // connected: the kept save goes out without the canvas on screen
        for _ in 0..<5 { await clock2.advance(0) }
        await hub2.current(canvas.id)?.settled()
        for _ in 0..<5 { await clock2.advance(0) }
        XCTAssertEqual(api2.calls.map(\.clientSaveId), [kept.inFlight!.clientSaveId])
        XCTAssertEqual(server.head(canvas.id).body, BODY + "\nオフラインで書いた")
        XCTAssertNil(relaunched.pendingCanvas(canvas.id))
    }

    func testAListThatFailsIsKeptForTheTabUntilALoadSucceeds() async throws {
        let server = FakeCanvasServer()
        let canvas = server.create(by: "alice", channelId: "lab", body: BODY)
        let api = FakeCanvasApi(server: server, userId: "bob")
        let store = Store()
        member(store)
        let hub = CanvasHub(api: api, store: store, clock: ManualCanvasClock(), options: options())
        defer { hub.stop() }
        // A server from before canvases: the route is missing (FastAPI's 404 not_found, or the proxy's own).
        api.listFail = [ApiError.api(status: 404, code: "not_found", message: "Not Found")]
        await hub.loadList("lab")
        XCTAssertNil(store.canvasesOf("lab"))
        XCTAssertEqual(store.canvasListFailure("lab"), .unsupported)
        XCTAssertEqual(CanvasHub.listFailure(ApiError.api(status: 404, code: "http_404", message: "")), .unsupported)
        // Anything else can be tried again; a conversation I cannot see is not an old server.
        XCTAssertEqual(CanvasHub.listFailure(ApiError.api(status: 404, code: "channel_not_found", message: "")), .failed)
        XCTAssertEqual(CanvasHub.listFailure(ApiError.api(status: 503, code: "http_503", message: "")), .failed)
        api.listFail = [ApiError.network(URLError(.notConnectedToInternet))]
        await hub.loadList("lab")
        XCTAssertEqual(store.canvasListFailure("lab"), .failed)
        // 再読み込み: no failure while it asks (the spinner), none after it loads.
        var duringRetry: CanvasListFailure?? = .none
        api.onList = { duringRetry = store.canvasListFailure("lab") }
        await hub.loadList("lab")
        XCTAssertEqual(duringRetry, .some(nil))
        api.onList = nil
        XCTAssertNil(store.canvasListFailure("lab"))
        XCTAssertEqual(store.canvasesOf("lab")?.map(\.id), [canvas.id])
        // A later failure leaves the loaded list as it is; leaving the conversation forgets the failure.
        api.listFail = [ApiError.api(status: 503, code: "http_503", message: "")]
        await hub.loadList("lab")
        XCTAssertEqual(store.canvasesOf("lab")?.map(\.id), [canvas.id])
        store.removeChannel("lab")
        XCTAssertNil(store.canvasListFailure("lab"))
    }

    func testACanvasWhoseFirstReadFailsOffersAReloadInsteadOfAnEmptyCanvas() async throws {
        let server = FakeCanvasServer()
        let canvas = server.create(by: "alice", channelId: "lab", body: BODY)
        let api = FakeCanvasApi(server: server, userId: "bob")
        let store = Store()
        member(store)
        let hub = CanvasHub(api: api, store: store, clock: ManualCanvasClock(), options: options())
        defer { hub.stop() }
        api.getFail = [ApiError.api(status: 503, code: "http_503", message: ""), ApiError.api(status: 403, code: "not_a_member", message: "")]
        let saver = try XCTUnwrap(hub.hold(canvas.id, channelId: "lab"))
        await saver.settled()
        XCTAssertTrue(saver.loadFailed)
        XCTAssertEqual(saver.status, .offline)
        XCTAssertEqual(saver.text, "")
        await saver.reload() // refused this time
        XCTAssertTrue(saver.loadFailed)
        XCTAssertEqual(saver.status, .blocked)
        await saver.reload()
        XCTAssertFalse(saver.loadFailed)
        XCTAssertEqual(saver.status, .saved)
        XCTAssertEqual(saver.text, BODY)
        await saver.reload() // loaded: nothing more
        XCTAssertEqual(api.gets.count, 3)
        // A canvas in the trash is not a load failure (.gone says it).
        let trashed = server.create(by: "alice", channelId: "lab", body: "")
        server.canvases[trashed.id]?.deleted = true
        let gone = try XCTUnwrap(hub.hold(trashed.id, channelId: "lab"))
        await gone.settled()
        XCTAssertEqual(gone.status, .gone)
        XCTAssertFalse(gone.loadFailed)
    }

    func testLeavingTheConversationDropsItsCanvasesAndUnsavedEdits() async throws {
        let store = Store()
        member(store)
        store.setCanvases("lab", [FakeCanvasServer().create(by: "alice", channelId: "lab", body: "").meta])
        store.setPendingCanvas("x", CanvasPendingState(channelId: "lab", baseRevId: "r", synced: "", text: "a", version: 1, inFlight: nil))
        store.removeChannel("lab")
        XCTAssertNil(store.canvasesOf("lab"))
        XCTAssertNil(store.pendingCanvas("x"))
    }
}

// MARK: - the API's canvas answers

@MainActor
final class CanvasApiTests: XCTestCase {
    private func makeClient() -> ApiClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "a"
        return client
    }

    private let canvasJSON = ##"{"id":"c1","channel_id":"lab","title":"議事録","version":3,"head_rev_id":"r3","is_channel_tab":true,"edit_policy":"members","template_key":null,"share_message_id":null,"task_total":2,"task_done":1,"created_by":"u1","updated_by":"u2","created_at":"","updated_at":"","deleted_at":null,"body":"# 議事録"}"##

    func testConflictAndExpiredAndRateLimitComeBackWithTheirDetails() async throws {
        var answer: (Int, String) = (200, "")
        var sent: [String: JSONValue] = [:]
        StubProtocol.handler = { request in
            if let stream = request.httpBodyStream {
                stream.open()
                var data = Data()
                var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                stream.close()
                if case .object(let fields)? = try? JSONDecoder().decode(JSONValue.self, from: data) { sent = fields }
            }
            return (answer.0, Data(answer.1.utf8))
        }
        let client = makeClient()
        let save = CanvasSaveIn(baseRevId: "r1", body: "x", clientSaveId: "k1", onConflict: .both)
        answer = (409, #"{"error":{"code":"canvas_conflict","message":"m","details":{"head":\#(canvasJSON),"conflicts":[{"base":"b","ours":"o","theirs":"t","ours_line":4,"theirs_line":5}],"timed_out":false}}}"#)
        do {
            _ = try await client.saveCanvas(id: "c1", save)
            XCTFail("expected a conflict")
        } catch CanvasSaveFailure.conflict(let details) {
            XCTAssertEqual(details.head.headRevId, "r3")
            XCTAssertEqual(details.conflicts?.first?.oursLine, 4)
        }
        XCTAssertEqual(sent["on_conflict"], .string("both"))
        XCTAssertEqual(sent["client_save_id"], .string("k1"))
        answer = (409, #"{"error":{"code":"canvas_base_expired","message":"m","details":{"head":\#(canvasJSON)}}}"#)
        do {
            _ = try await client.saveCanvas(id: "c1", save)
            XCTFail("expected expired")
        } catch CanvasSaveFailure.expired(let head) {
            XCTAssertEqual(head.body, "# 議事録")
        }
        answer = (429, #"{"error":{"code":"rate_limited","message":"m","details":{"retry_after_seconds":7}}}"#)
        do {
            _ = try await client.saveCanvas(id: "c1", save)
            XCTFail("expected 429")
        } catch CanvasSaveFailure.rateLimited(let seconds) {
            XCTAssertEqual(seconds, 7)
        }
        answer = (403, #"{"error":{"code":"canvas_edit_restricted","message":"m","details":{}}}"#)
        do {
            _ = try await client.saveCanvas(id: "c1", save)
            XCTFail("expected 403")
        } catch ApiError.api(let status, let code, _) {
            XCTAssertEqual(status, 403)
            XCTAssertEqual(code, "canvas_edit_restricted")
        }
    }

    func testGetCanvasSendsIfNoneMatchAndA304IsNil() async throws {
        var ifNoneMatch: [String?] = []
        StubProtocol.handler = { [canvasJSON] request in
            ifNoneMatch.append(request.value(forHTTPHeaderField: "If-None-Match"))
            return request.value(forHTTPHeaderField: "If-None-Match") == "\"v3\"" ? (304, Data()) : (200, Data(canvasJSON.utf8))
        }
        let client = makeClient()
        let fresh = try await client.getCanvas(id: "c1", knownVersion: nil)
        XCTAssertEqual(fresh?.version, 3)
        let same = try await client.getCanvas(id: "c1", knownVersion: 3)
        XCTAssertNil(same)
        XCTAssertEqual(ifNoneMatch, [nil, "\"v3\""])
    }
}
