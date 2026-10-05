import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

// M58: the phone's canvas catches up with the desktop (CANVAS.md §4.8–§4.10 / §4.13, the desktop's M44): the history's
// comparison, restoring and naming a version, the search's 「キャンバス」 tab, pictures put in at the caret, and sharing
// to the conversation with its comments.

// MARK: - the comparison (the desktop's tests/canvasDiff.test.ts)

final class CanvasDiffTests: XCTestCase {
    private func kinds(_ before: String, _ after: String) -> [String] {
        CanvasDiff.lines(before, after).map { ($0.kind == .same ? " " : $0.kind == .add ? "+" : "-") + $0.text }
    }

    private func counts(_ lines: [CanvasDiff.Line]) -> [Int] {
        let c = CanvasDiff.counts(lines.map { .line($0) })
        return [c.added, c.removed]
    }

    func testKeepsAddsAndRemovesLinesWithTheirNumbers() {
        XCTAssertEqual(kinds("a\nb\nc", "a\nc\nd"), [" a", "-b", " c", "+d"])
        let lines = CanvasDiff.lines("a\nb\nc", "a\nc\nd")
        XCTAssertEqual(lines.map { [$0.oldNo ?? 0, $0.newNo ?? 0] }, [[1, 1], [2, 0], [3, 2], [0, 3]])
        XCTAssertEqual(counts(lines), [1, 1])
    }

    func testAnEmptySideIsAllAddedOrAllRemoved() {
        XCTAssertEqual(kinds("", "x\ny"), ["+x", "+y"])
        XCTAssertEqual(kinds("x\ny", ""), ["-x", "-y"])
        XCTAssertEqual(kinds("same", "same"), [" same"])
        XCTAssertEqual(kinds("", ""), [])
    }

    func testFindsTheShortestScriptAmongRepeatedLines() {
        let before = ["- [ ] a", "- [ ] b", "- [ ] a", "- [ ] b"].joined(separator: "\n")
        let after = ["- [ ] a", "- [ ] b", "- [ ] c", "- [ ] a", "- [ ] b"].joined(separator: "\n")
        XCTAssertEqual(counts(CanvasDiff.lines(before, after)), [1, 0])
    }

    func testALineTouchedUpShowsTheWordsThatChanged() throws {
        let lines = CanvasDiff.lines("# 議事録\n来週までに研究計画を提出する。", "# 議事録\n来週までに予稿を提出する。")
        let del = try XCTUnwrap(lines.first { $0.kind == .del })
        let add = try XCTUnwrap(lines.first { $0.kind == .add })
        XCTAssertEqual(del.words?.filter(\.changed).map(\.text), ["研究計画"])
        XCTAssertEqual(add.words?.filter(\.changed).map(\.text), ["予稿"])
        XCTAssertEqual(add.words?.map(\.text).joined(), "来週までに予稿を提出する。")
    }

    func testATickIsOneWordAndARewrittenLineHasNoWordView() {
        let lines = CanvasDiff.lines("- [ ] 旅費申請", "- [x] 旅費申請")
        XCTAssertEqual(lines[0].words?.filter(\.changed).map(\.text), [" "])
        XCTAssertEqual(lines[1].words?.filter(\.changed).map(\.text), ["x"])
        XCTAssertNil(CanvasDiff.wordDiff("全く別の内容です", "Completely different text"))
    }

    func testALargeRewriteStaysCorrect() {
        let before = (0..<4000).map { "line \($0)" }.joined(separator: "\n")
        let after = (0..<4000).map { "row \($0)" }.joined(separator: "\n")
        let started = Date()
        XCTAssertEqual(counts(CanvasDiff.lines(before, after)), [4000, 4000])
        XCTAssertLessThan(Date().timeIntervalSince(started), 5) // the desktop's 2 s, with room for a debug build
    }

    func testWordsAreCutByScriptSpaceAndPunctuation() {
        XCTAssertEqual(CanvasDiff.words("研究計画を来週までに提出する。"), ["研究計画", "を", "来週", "までに", "提出", "する", "。"])
        XCTAssertEqual(CanvasDiff.words("see PGroonga docs"), ["see", " ", "PGroonga", " ", "docs"])
        XCTAssertEqual(CanvasDiff.words("カタカナー漢字"), ["カタカナー", "漢字"])
    }

    func testLongStretchesOfKeptLinesFold() {
        let before = (0..<20).map { "l\($0)" }.joined(separator: "\n")
        let after = before.replacingOccurrences(of: "l10", with: "L10")
        let rows = CanvasDiff.rows(CanvasDiff.lines(before, after), context: 2).map { row -> String in
            switch row {
            case .skip(let count): return "…\(count)"
            case .line(let line): return line.kind == .same ? line.text : "\(line.kind == .add ? "add" : "del"):\(line.text)"
            }
        }
        XCTAssertEqual(rows, ["…8", "l8", "l9", "del:l10", "add:L10", "l11", "l12", "…7"])
    }

    func testTheChangedWordsAreMarkedForTheScreen() {
        let lines = CanvasDiff.lines("来週までに研究計画を提出する。", "来週までに予稿を提出する。")
        let removed = CanvasDiffView.text(lines[0])
        let marked = removed.runs.filter { $0.strikethroughStyle != nil }.map { String(removed[$0.range].characters) }
        XCTAssertEqual(marked, ["研究計画"])
        XCTAssertEqual(String(CanvasDiffView.text(CanvasDiff.Line(kind: .same, text: "", oldNo: 1, newNo: 1)).characters), " ")
    }
}

// MARK: - the history's choices

@MainActor
final class CanvasHistoryModelTests: XCTestCase {
    private func revision(_ id: String, kind: String = "save", parent: String? = nil, label: String? = nil) -> CanvasRevisionMeta {
        CanvasRevisionMeta(id: id, canvasId: "c1", version: nil, kind: kind, parentRevId: parent, authorId: "u1", title: "議事録", label: label,
                           linesAdded: 1, linesRemoved: 0, createdAt: "2026-10-01T01:00:00Z")
    }

    func testThePreviousVersionIsTheNextOlderOneListedElseItsParent() {
        let model = CanvasHistoryModel(canvasId: "c1", rows: [revision("r3", parent: "r2"), revision("r2", parent: "r1"), revision("r9", kind: "create")],
                                       bodies: [:])
        XCTAssertEqual(model.previousId(of: "r3"), "r2")
        XCTAssertEqual(model.previousId(of: "r2"), "r9")
        XCTAssertNil(model.previousId(of: "r9")) // the first version compares with nothing
        let partial = CanvasHistoryModel(canvasId: "c1", rows: [revision("r3", parent: "r2"), revision("r2", parent: "r1")], bodies: [:])
        XCTAssertEqual(partial.previousId(of: "r2"), "r1") // the oldest loaded: its parent
        partial.replace(revision("r2", parent: "r1", label: "提出版"))
        XCTAssertEqual(partial.revision("r2")?.label, "提出版")
        XCTAssertEqual(CanvasHistoryModel.kindLabel("merge"), "同時編集をまとめた版")
        XCTAssertEqual(CanvasHistoryModel.kindLabel("save"), "編集")
    }
}

// MARK: - images, snippets, rights

final class CanvasImageAndShareTests: XCTestCase {
    private let id = "01a0f790-c7ef-7c5a-8ff2-7045de3ae5fd"

    func testAPictureGoesOnALineOfItsOwnAtTheCaret() {
        typealias S = CanvasText.EditState
        // Mid-line: line breaks around it; the caret goes on the line below.
        let mid = CanvasText.insertImageLine(S(text: "前後", start: 1, end: 1), attachmentId: id)
        XCTAssertEqual(mid.text, "前\n![](attachment:\(id))\n後")
        XCTAssertEqual(mid.start, ("前\n![](attachment:\(id))\n" as NSString).length)
        // On an empty line: it takes that line (no line breaks added around it).
        let start = CanvasText.insertImageLine(S(text: "a\n\nb", start: 2, end: 2), attachmentId: id)
        XCTAssertEqual(start.text, "a\n![](attachment:\(id))\nb")
        // At the end of an empty body; a selection is replaced; the alt text keeps to one line.
        XCTAssertEqual(CanvasText.insertImageLine(S(text: "", start: 0, end: 0), attachmentId: id).text, "![](attachment:\(id))\n")
        XCTAssertEqual(CanvasText.insertImageLine(S(text: "abc", start: 1, end: 2), attachmentId: id, alt: "図]1\n").text,
                       "a\n![図 1 ](attachment:\(id))\nc")
    }

    func testAttachmentReferencesAreCountedOnceEach() {
        let body = "![](attachment:\(id))\n![x](attachment:\(id.uppercased()))\n[file](attachment:01a0f790-0000-7000-8000-000000000001)\nattachment:nope"
        XCTAssertEqual(CanvasText.attachmentRefs(body), [id, "01a0f790-0000-7000-8000-000000000001"])
        XCTAssertEqual(CanvasText.maxImages, 100)
    }

    func testAnImageInASnippetReadsAsWords() {
        XCTAssertEqual(CanvasSearchResults.readableSnippet("前 ![](attachment:\(id)) 後"), "前 [画像] 後")
        XCTAssertEqual(CanvasSearchResults.readableSnippet("![図1](attachment:01a0f790-c7ef"), "[画像：図1]") // cut by the excerpt
        XCTAssertEqual(CanvasSearchResults.readableSnippet("画像なし"), "画像なし")
    }

    private func channel(type: String = "public", role: String? = "member", archived: Bool = false, posting: String? = nil) -> ChannelState {
        var out = ChannelOut(id: "c", type: type, name: "lab", topic: nil, purpose: nil, archived: archived, createdBy: nil, lastSeq: 0,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: role.map { MembershipOut(role: $0, joinedAt: "") },
                             dmUserIds: type == "dm" ? ["me", "alice"] : nil)
        out.postingPolicy = posting
        return ChannelState(channel: out, isMember: true, syncedSeq: nil, lastSeq: 0, hasOlder: false)
    }

    private func meta(shared: Bool) -> CanvasMeta {
        CanvasMeta(id: "cv", channelId: "c", title: "議事録", version: 1, headRevId: "r1", isChannelTab: false, editPolicy: "members", templateKey: nil,
                   shareMessageId: shared ? "m1" : nil, taskTotal: 0, taskDone: 0, createdBy: "alice", updatedBy: "alice", createdAt: "", updatedAt: "")
    }

    func testShareAndCommentsFollowWhoMayPost() {
        let me = CanvasRights.Actor(id: "me", isAdmin: false, isGuest: false)
        let guest = CanvasRights.Actor(id: "me", isAdmin: false, isGuest: true)
        let member = CanvasRights.of(channel(), actor: me, meta: meta(shared: false))
        XCTAssertTrue(CanvasShare.offersShare(meta(shared: false), rights: member))
        XCTAssertFalse(CanvasShare.offersShare(meta(shared: true), rights: member)) // shared already
        XCTAssertTrue(CanvasShare.showsComments(meta(shared: false), rights: member)) // shares first
        // Where only owners post: a member sees the comments once shared, and neither choice before.
        let announcement = CanvasRights.of(channel(posting: "owners"), actor: me, meta: meta(shared: false))
        XCTAssertFalse(announcement.share)
        XCTAssertFalse(CanvasShare.showsComments(meta(shared: false), rights: announcement))
        XCTAssertTrue(CanvasShare.showsComments(meta(shared: true), rights: announcement))
        XCTAssertTrue(CanvasRights.of(channel(role: "owner", posting: "owners"), actor: me, meta: meta(shared: false)).share)
        // A guest posts in a channel they are in; an archived conversation takes nothing.
        XCTAssertTrue(CanvasRights.of(channel(), actor: guest, meta: meta(shared: false)).share)
        XCTAssertFalse(CanvasRights.of(channel(archived: true), actor: me, meta: meta(shared: false)).share)
        XCTAssertTrue(CanvasRights.of(channel(type: "dm", role: nil), actor: me, meta: meta(shared: false)).share)
    }
}

// MARK: - the requests

@MainActor
final class CanvasCatchUpApiTests: XCTestCase {
    private final class Recorder: @unchecked Sendable {
        var requests: [(method: String, path: String, query: String, body: String)] = []
    }

    private let recorder = Recorder()
    private let canvasJSON = ##"{"id":"cv","channel_id":"c","title":"議事録","version":5,"head_rev_id":"r5","is_channel_tab":false,"edit_policy":"members","template_key":null,"share_message_id":"m9","task_total":0,"task_done":0,"created_by":"u1","updated_by":"u1","created_at":"","updated_at":"","deleted_at":null,"body":"# 議事録"}"##

    private func client(reply: @escaping (URLRequest) -> (Int, Data)) -> ApiClient {
        let recorder = recorder
        StubProtocol.handler = { request in
            let body = request.httpBodyStream.map { stream -> String in
                stream.open(); defer { stream.close() }
                var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                return String(decoding: data, as: UTF8.self)
            } ?? ""
            recorder.requests.append((request.httpMethod ?? "", request.url?.path ?? "", request.url?.query ?? "", body))
            return reply(request)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "a"
        return client
    }

    private func json(_ text: String) throws -> [String: JSONValue] {
        try JSON.plainDecoder.decode([String: JSONValue].self, from: Data(text.utf8))
    }

    func testRequestBodies() async throws {
        let canvas = Data(canvasJSON.utf8)
        let revision = Data(#"{"id":"r1","canvas_id":"cv","version":1,"kind":"create","parent_rev_id":null,"author_id":"u1","title":"議事録","label":"提出版","lines_added":1,"lines_removed":0,"created_at":""}"#.utf8)
        let api = client { request in request.httpMethod == "PATCH" ? (200, revision) : (200, canvas) }
        let shared = try await api.shareCanvas(id: "cv")
        XCTAssertEqual(shared.shareMessageId, "m9")
        _ = try await api.restoreCanvasRevision(id: "cv", revisionId: "r1", clientSaveId: "k1")
        let named = try await api.labelCanvasRevision(id: "cv", revisionId: "r1", label: "提出版")
        XCTAssertEqual(named.label, "提出版")
        _ = try await api.labelCanvasRevision(id: "cv", revisionId: "r1", label: nil)
        let sent = recorder.requests
        XCTAssertEqual(sent.map { "\($0.method) \($0.path)" }, [
            "POST /api/v1/canvases/cv/share",
            "POST /api/v1/canvases/cv/revisions/r1/restore",
            "PATCH /api/v1/canvases/cv/revisions/r1",
            "PATCH /api/v1/canvases/cv/revisions/r1",
        ])
        XCTAssertEqual(try json(sent[1].body), ["client_save_id": .string("k1")])
        XCTAssertEqual(try json(sent[2].body), ["label": .string("提出版")])
        XCTAssertEqual(try json(sent[3].body), ["label": .null]) // removes the name
    }

    func testTheCanvasSearchSendsTheWordsPersonConversationAndDatesOnly() async throws {
        let api = client { _ in (200, Data(#"{"hits":[],"keywords":["議事録"],"filters":{"text":"議事録","unresolved":["has:pin"]},"limit":20,"offset":0,"has_more":false,"total":0}"#.utf8)) }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let now = ISO8601DateFormatter().date(from: "2026-10-01T03:00:00Z")!
        let params = SearchParams(q: " 議事録 ", fromUserId: "u2", channelId: "c1", date: .range(from: "2026-09-01", to: "2026-09-30"),
                                  has: [.file], isThread: true)
        let search = SearchLogic.request(params, now: now, calendar: calendar)
        let out = try await api.searchCanvases(search, limit: 20, offset: 40)
        XCTAssertEqual(out.filters?.unresolved, ["has:pin"])
        let query = try XCTUnwrap(URLComponents(string: "http://x/?" + recorder.requests[0].query)?.queryItems)
        XCTAssertEqual(recorder.requests[0].path, "/api/v1/search/canvases")
        XCTAssertEqual(query.map(\.name), ["q", "channel_id", "from_user_id", "after", "before", "sort", "tz_offset_minutes", "limit", "offset"])
        XCTAssertEqual(query.first { $0.name == "q" }?.value, "議事録")
        XCTAssertEqual(query.first { $0.name == "after" }?.value, "2026-09-01T00:00:00+09:00")
        XCTAssertEqual(query.first { $0.name == "before" }?.value, "2026-10-01T00:00:00+09:00")
        XCTAssertEqual(query.first { $0.name == "offset" }?.value, "40")
        // Nothing a canvas could be found by (a 種類 chip alone): not sent.
        XCTAssertTrue(SearchLogic.request(SearchParams(has: [.file])).canvasIsEmpty)
        XCTAssertFalse(SearchLogic.request(SearchParams(channelId: "c1")).canvasIsEmpty)
    }

    func testCommentsOpenTheSharedMessageAndShareFirstWhenThereIsNone() async throws {
        let canvas = Data(canvasJSON.utf8)
        let controller = AppController()
        controller.api = client { _ in (200, canvas) }
        var meta = try JSON.snakeDecoder.decode(CanvasOut.self, from: canvas).meta
        // Shared, and its message is here: no request.
        meta.shareMessageId = "m1"
        _ = controller.store.upsertMessage(MessageOut(id: "m1", channelId: "c", senderId: "u1", seq: 1, updatedSeq: 1, clientMsgId: nil,
                                                      body: "📄 議事録", createdAt: "", editedAt: nil, deleted: false))
        let known = await controller.canvasCommentsMessage(meta)
        XCTAssertEqual(known, "m1")
        XCTAssertTrue(recorder.requests.isEmpty)
        // Never shared: shared now (the server answers with its message).
        meta.shareMessageId = nil
        let fresh = await controller.canvasCommentsMessage(meta)
        XCTAssertEqual(fresh, "m9")
        XCTAssertEqual(recorder.requests.map(\.path), ["/api/v1/canvases/cv/share"])
    }

    func testARestoreLostOnTheWayIsSentAgainWithTheSameKey() async throws {
        let canvas = Data(canvasJSON.utf8)
        var attempts = 0
        let controller = AppController()
        controller.api = client { _ in
            attempts += 1
            return attempts == 1 ? (503, Data(#"{"error":{"code":"unavailable","message":"m"}}"#.utf8)) : (200, canvas)
        }
        let restored = await controller.restoreCanvasRevision("cv", revisionId: "r1")
        XCTAssertEqual(restored?.version, 5)
        XCTAssertNil(controller.error)
        let keys = try recorder.requests.map { try json($0.body)["client_save_id"] }
        XCTAssertEqual(keys.count, 2)
        XCTAssertEqual(keys[0], keys[1]) // one version, however many tries
        // A refusal is said, not retried.
        recorder.requests = []
        controller.api = client { _ in (403, Data(#"{"error":{"code":"canvas_edit_restricted","message":"m"}}"#.utf8)) }
        let refused = await controller.restoreCanvasRevision("cv", revisionId: "r1")
        XCTAssertNil(refused)
        XCTAssertEqual(recorder.requests.count, 1)
        XCTAssertNotNil(controller.error)
    }
}

// MARK: - snapshots (SNAPSHOT_DIR: history compare, the search's キャンバス tab, share / comments, the editor's 画像)

@MainActor
final class CanvasCatchUpSnapshotTests: XCTestCase {
    private var cleanups: [() -> Void] = []

    override func tearDown() {
        cleanups.forEach { $0() }
        cleanups = []
        super.tearDown()
    }

    private func render<V: View>(_ view: V, scheme: ColorScheme, size: CGSize = CGSize(width: 393, height: 760), name: String) throws -> UIImage {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        window.overrideUserInterfaceStyle = scheme == .dark ? .dark : .light
        let host = UIHostingController(rootView: view.environment(\.colorScheme, scheme))
        host.view.backgroundColor = .systemBackground
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.9))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
            if !window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) { window.layer.render(in: context.cgContext) }
        }
        window.isHidden = true
        let file = name + (scheme == .dark ? "-dark" : "") + ".png"
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], let data = image.pngData() {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(file)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
            print("snapshot written: \(url.path)")
        }
        return image
    }

    private func controller() -> AppController {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                           email: nil, mustChangePassword: false))
        store.upsertUser(UserPublic(id: "u2", username: "tanaka", displayName: "田中 太郎", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        store.upsertUser(UserPublic(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        store.upsertChannel(ChannelOut(id: "lab", type: "public", name: "lab", topic: nil, purpose: nil, archived: false, createdBy: "u2", lastSeq: 3,
                                       lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil),
                            isMember: true)
        return controller
    }

    private static let older = "# 議事録 10/1\n## 出席\n- 田中\n- 加納\n\n## 決定事項\n来週までに研究計画を提出する。\n\n## TODO\n- [ ] 旅費申請\n- [ ] 予稿の下書き"
    private static let newer = "# 議事録 10/1\n## 出席\n- 田中\n- 加納\n- 佐藤\n\n## 決定事項\n来週までに予稿を提出する。\n\n## TODO\n- [x] 旅費申請\n- [ ] 予稿の下書き"

    private func revision(_ id: String, kind: String, author: String, minute: Int, added: Int, removed: Int, label: String? = nil,
                          parent: String? = nil) -> CanvasRevisionMeta {
        CanvasRevisionMeta(id: id, canvasId: "cv", version: nil, kind: kind, parentRevId: parent, authorId: author, title: "議事録 10/1", label: label,
                           linesAdded: added, linesRemoved: removed, createdAt: String(format: "2026-10-01T05:%02d:00Z", minute))
    }

    private func meta(head: String, shared: Bool = false) -> CanvasMeta {
        CanvasMeta(id: "cv", channelId: "lab", title: "議事録 10/1", version: 4, headRevId: head, isChannelTab: true, editPolicy: "members", templateKey: nil,
                   shareMessageId: shared ? "m1" : nil, taskTotal: 2, taskDone: 1, createdBy: "u2", updatedBy: "u2",
                   createdAt: "2026-10-01T05:00:00Z", updatedAt: "2026-10-01T05:40:00Z")
    }

    func testHistoryListAndCompare() throws {
        for scheme in [ColorScheme.light, .dark] {
            let controller = controller()
            controller.store.setCanvases("lab", [meta(head: "r4")])
            let rows = [revision("r4", kind: "save", author: "u2", minute: 40, added: 3, removed: 2, parent: "r3"),
                        revision("r3", kind: "merge", author: "me", minute: 30, added: 1, removed: 0, label: "ゼミ発表前", parent: "r2"),
                        revision("r2", kind: "save", author: "me", minute: 20, added: 8, removed: 0, parent: "r1"),
                        revision("r1", kind: "create", author: "u2", minute: 0, added: 3, removed: 0)]
            let channel = try XCTUnwrap(controller.store.channel("lab"))
            let model = CanvasHistoryModel(canvasId: "cv", rows: rows, bodies: ["r4": Self.newer, "r3": Self.older, "r2": Self.older])
            _ = try render(CanvasHistorySheet(controller: controller, channel: channel, saver: nil, model: model), scheme: scheme, name: "canvas-history-list")
            let rights = CanvasRights.of(channel, actor: controller.canvasActor, meta: meta(head: "r4"))
            _ = try render(NavigationStack {
                CanvasRevisionDetail(controller: controller, model: model, revisionId: "r3", headId: "r4", rights: rights, mode: .current)
            }, scheme: scheme, name: "canvas-history-compare-current")
            _ = try render(NavigationStack {
                CanvasRevisionDetail(controller: controller, model: model, revisionId: "r4", headId: "r4", rights: rights, mode: .previous)
            }, scheme: scheme, name: "canvas-history-compare-previous")
        }
    }

    func testSearchCanvasTab() throws {
        for scheme in [ColorScheme.light, .dark] {
            let controller = controller()
            let hits = [
                CanvasSearchHit(canvas: meta(head: "r4"), snippet: "…来週までに予稿を提出する。\n![](attachment:01a0f790-c7ef-7c5a-8ff2-7045de3ae5fd)\n## TODO 予稿の下書き…", score: 2),
                CanvasSearchHit(canvas: CanvasMeta(id: "cv2", channelId: "lab", title: "予稿チェックリスト", version: 2, headRevId: "x", isChannelTab: false,
                                                   editPolicy: "members", templateKey: nil, shareMessageId: nil, taskTotal: 8, taskDone: 3, createdBy: "me",
                                                   updatedBy: "me", createdAt: "2026-09-20T05:00:00Z", updatedAt: "2026-09-28T09:15:00Z"),
                                snippet: "- [x] 予稿のテンプレートを確認\n- [ ] 図を差し替える", score: 1),
            ]
            let model = SearchModel(params: SearchParams(q: "予稿", fromUserId: "u2"), hits: [], keywords: [], total: 0)
            model.tab = .canvases
            model.canvases = CanvasSearchResults(hits: hits, keywords: ["予稿"], total: 2)
            _ = try render(NavigationStack {
                SearchResultsView(controller: controller, model: model, onUpdate: { _ in }, onPick: { _ in }, onOpen: { _, _, _ in })
            }, scheme: scheme, size: CGSize(width: 393, height: 560), name: "search-canvases")
        }
    }

    /// The canvas's bar: 「コメント」 beside the save state (a member, not shared yet: opening the comments shares it).
    func testShareAndCommentEntries() async throws {
        for scheme in [ColorScheme.light, .dark] {
            let controller = controller()
            let server = FakeCanvasServer()
            var created = server.create(by: "u2", channelId: "lab", title: "議事録 10/1", body: Self.newer)
            created.shareMessageId = scheme == .dark ? "m1" : nil
            server.canvases[created.id]?.canvas = created
            controller.store.setCanvases("lab", [created.meta])
            let saver = CanvasSaver(id: created.id, channelId: "lab", api: FakeCanvasApi(server: server, userId: "me"))
            saver.load()
            await saver.settled()
            cleanups.append { saver.dispose() }
            let channel = try XCTUnwrap(controller.store.channel("lab"))
            _ = try render(NavigationStack {
                CanvasDocument(controller: controller, channel: channel, saver: saver, onOpenList: {}, onTrashed: {}, onOpenThread: { _ in })
            }, scheme: scheme, size: CGSize(width: 393, height: 520), name: "canvas-comments-entry")
            // The editor's toolbar with 「画像」.
            _ = try render(CanvasEditor(controller: controller, saver: saver), scheme: scheme, size: CGSize(width: 393, height: 360), name: "canvas-editor-image")
        }
    }
}
