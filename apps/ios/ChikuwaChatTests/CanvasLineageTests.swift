@testable import ChikuwaChat
import UIKit
import XCTest

private let BODY = "# 議事録\n## 出席\n- alice\n\n## 決定事項\n来週までに研究計画を提出する。\n\n## TODO\n- [ ] 資料\n- [ ] 練習"
private let CAROL = BODY.replacingOccurrences(of: "- alice", with: "- alice\n- carol")

/// CANVAS.md §24: an editor behind the save loop (the desktop's canvasSave.test.ts 「an editor behind the loop」), a
/// canvas.updated that came while a save was on the wire, and a phone's own save that must stay on its own screen.
@MainActor
final class CanvasLineageTests: XCTestCase {
    private var cleanups: [() -> Void] = []

    override func tearDown() async throws {
        for cleanup in cleanups { cleanup() }
        cleanups = []
    }

    @MainActor private struct Harness {
        let server: FakeCanvasServer
        let api: FakeCanvasApi
        let clock: ManualCanvasClock
        let saver: CanvasSaver
        let canvas: CanvasOut
        var head: CanvasOut { server.head(canvas.id) }
    }

    private func harness(body: String = BODY) async -> Harness {
        let server = FakeCanvasServer()
        let canvas = server.create(by: "alice", channelId: "lab", body: body)
        let api = FakeCanvasApi(server: server, userId: "bob")
        let clock = ManualCanvasClock()
        var options = CanvasSaverOptions()
        options.debounce = 2
        options.refreshDebounce = 0.5
        let saver = CanvasSaver(id: canvas.id, channelId: "lab", api: api, clock: clock, options: options)
        saver.load()
        await saver.settled()
        cleanups.append {
            saver.dispose()
            clock.drain()
        }
        return Harness(server: server, api: api, clock: clock, saver: saver, canvas: canvas)
    }

    // MARK: the save loop (as the desktop's vitest cases)

    func testATextTypedOnTheBodyShownBeforeTheMergedOneReachedTheEditorKeepsTheMerge() async throws {
        let h = await harness()
        let shown = h.saver.textLineage // the editor shows the first body
        try h.server.saveOnHead("alice", h.canvas.id, CAROL)
        let mine = BODY.replacingOccurrences(of: "- [ ] 練習", with: "- [ ] 練習!")
        h.saver.edit(mine, basedOn: shown)
        await h.saver.flush() // merged with carol; the loop puts the merged body in …
        XCTAssertEqual(h.saver.text, CAROL.replacingOccurrences(of: "- [ ] 練習", with: "- [ ] 練習!"))
        XCTAssertNotEqual(h.saver.textLineage, shown)
        // … but a key reaches the loop first: its text is the body the editor shows plus the key.
        h.saver.edit(mine + "\n- [ ] 予稿", basedOn: shown)
        await h.saver.flush()
        let second = try XCTUnwrap(h.api.calls.dropFirst().first)
        XCTAssertEqual(h.server.canvases[h.canvas.id]?.revisions[second.baseRevId], mine) // on what was sent, not the merged head
        XCTAssertEqual(h.head.body, CAROL.replacingOccurrences(of: "- [ ] 練習", with: "- [ ] 練習!") + "\n- [ ] 予稿") // carol stays
        XCTAssertEqual(h.saver.text, h.head.body)
    }

    func testWithoutSayingWhichBodyItWasWrittenOnTheSameTextIsSavedOverTheMerge() async throws {
        let h = await harness()
        try h.server.saveOnHead("alice", h.canvas.id, CAROL)
        let mine = BODY.replacingOccurrences(of: "- [ ] 練習", with: "- [ ] 練習!")
        h.saver.edit(mine)
        await h.saver.flush()
        h.saver.edit(mine + "\n- [ ] 予稿") // no generation: taken as written on the merged body (the bug the lineage fixes)
        await h.saver.flush()
        XCTAssertFalse(h.head.body.contains("carol"))
    }

    func testSomeoneElsesVersionReadWhileIdleAKeyTypedBeforeTheEditorTookItKeepsThatVersion() async throws {
        let h = await harness()
        let shown = h.saver.textLineage
        try h.server.saveOnHead("alice", h.canvas.id, CAROL)
        h.saver.remoteVersion(h.head.version)
        await h.clock.advance(0.5)
        await h.saver.settled()
        XCTAssertEqual(h.saver.text, CAROL)
        h.saver.edit(BODY + "\n- [ ] 予稿", basedOn: shown) // typed on the body the editor still showed
        await h.saver.flush()
        XCTAssertEqual(h.head.body, CAROL + "\n- [ ] 予稿")
    }

    func testAnEditorThatTookTheNewerBodyWritesOnItAsBefore() async throws {
        let h = await harness()
        try h.server.saveOnHead("alice", h.canvas.id, CAROL)
        h.saver.remoteVersion(h.head.version)
        await h.clock.advance(0.5)
        await h.saver.settled()
        let before = h.head.headRevId
        h.saver.edit(CAROL.replacingOccurrences(of: "carol", with: "carol!"), basedOn: h.saver.textLineage)
        await h.saver.flush()
        XCTAssertEqual(h.api.calls.last?.baseRevId, before)
        XCTAssertEqual(h.head.body, CAROL.replacingOccurrences(of: "carol", with: "carol!"))
    }

    func testACanvasUpdatedThatCameWhileASaveWasOnTheWireIsReadOnceTheSaveLands() async throws {
        let h = await harness()
        h.api.holdingAnswer = true
        let mine = BODY.replacingOccurrences(of: "研究計画", with: "発表資料")
        h.saver.edit(mine)
        let flushing = Task { await h.saver.flush() } // reaches the server first …
        for _ in 0..<30 { await Task.yield() }
        try h.server.saveOnHead("alice", h.canvas.id, mine.replacingOccurrences(of: "- alice", with: "- alice\n- carol")) // … then alice
        h.saver.remoteVersion(h.head.version)
        await h.clock.advance(0.6) // the read is skipped: a save is on the wire
        h.api.release()
        await flushing.value
        await h.clock.advance(0)
        await h.saver.settled()
        XCTAssertEqual(h.saver.text, mine.replacingOccurrences(of: "- alice", with: "- alice\n- carol"))
        XCTAssertEqual(h.saver.status, .saved)
    }

    /// TASK 1 (2026-10-24): URLSession turned the server's 304 to a hand-made If-None-Match into a 200 carrying the copy
    /// it had cached from an earlier read; the loop took that older body over its own save.
    func testAnAnswerOlderThanTheVersionHeldNeverPutsAnOlderBodyBack() async throws {
        let h = await harness()
        let mine = BODY + "\n- [ ] スマホで追記"
        h.saver.edit(mine)
        await h.saver.flush()
        XCTAssertEqual(h.saver.text, mine)
        let revision = h.saver.textRevision
        h.api.staleGets = [h.canvas] // version 1, the body before the save
        await h.saver.refresh()
        XCTAssertEqual(h.saver.text, mine)
        XCTAssertEqual(h.saver.textRevision, revision)
        XCTAssertEqual(h.saver.canvas?.version, h.head.version)
        // The next edit is still written on the saved version.
        h.saver.edit(mine + "!")
        await h.saver.flush()
        XCTAssertEqual(h.api.calls.last?.baseRevId, h.server.canvases[h.canvas.id]?.revisions.first { $0.value == mine }?.key)
        XCTAssertEqual(h.head.body, mine + "!")
    }

    // MARK: the native editor says which body it writes on

    private func editor(_ h: Harness, sectionLine: Int? = nil) -> (CanvasEditorModel, UITextView) {
        let model = CanvasEditorModel()
        let tv = UITextView()
        model.textView = tv
        model.attach(saver: h.saver, store: Store(), sectionLine: sectionLine)
        return (model, tv)
    }

    func testAKeystrokeBeforeTheEditorTookTheMergedBodyKeepsTheOthersEdits() async throws {
        let h = await harness()
        let (model, tv) = editor(h)
        try h.server.saveOnHead("alice", h.canvas.id, CAROL)
        h.saver.remoteVersion(h.head.version)
        await h.clock.advance(0.5)
        await h.saver.settled()
        XCTAssertEqual(h.saver.text, CAROL) // the loop holds carol; the text view has not taken it yet
        tv.text = BODY + "\n- [ ] 予稿"
        model.userChanged(tv.text)
        await h.saver.flush()
        XCTAssertEqual(h.head.body, CAROL + "\n- [ ] 予稿")
        model.external()
        XCTAssertEqual(tv.text, CAROL + "\n- [ ] 予稿")
    }

    func testTheSectionSheetWritesOnTheBodyItShows() async throws {
        let h = await harness()
        let line = BODY.components(separatedBy: "\n").firstIndex(of: "## TODO")!
        let (model, tv) = editor(h, sectionLine: line)
        XCTAssertEqual(tv.text, "## TODO\n- [ ] 資料\n- [ ] 練習")
        try h.server.saveOnHead("alice", h.canvas.id, CAROL)
        h.saver.remoteVersion(h.head.version)
        await h.clock.advance(0.5)
        await h.saver.settled()
        tv.text = "## TODO\n- [ ] 資料\n- [ ] 練習\n- [ ] 予稿"
        model.userChanged(tv.text)
        await h.saver.flush()
        XCTAssertEqual(h.head.body, CAROL + "\n- [ ] 予稿")
    }

    func testTheEditorFollowsTheLineageOfTheBodyItTook() async throws {
        let h = await harness()
        let (model, tv) = editor(h)
        XCTAssertEqual(model.lineage, h.saver.textLineage)
        try h.server.saveOnHead("alice", h.canvas.id, CAROL)
        h.saver.remoteVersion(h.head.version)
        await h.clock.advance(0.5)
        await h.saver.settled()
        XCTAssertNotEqual(model.lineage, h.saver.textLineage)
        model.external()
        XCTAssertEqual(tv.text, CAROL)
        XCTAssertEqual(model.lineage, h.saver.textLineage)
        // Its own save that came back unchanged keeps it on the same body.
        tv.text = CAROL + "\nx"
        model.userChanged(tv.text)
        await h.saver.flush()
        model.external()
        XCTAssertEqual(model.lineage, h.saver.textLineage)
        XCTAssertEqual(tv.text, h.head.body)
    }

    // MARK: the HTTP layer

    func testAConditionalGetIsNeverAnsweredFromTheUrlCache() async throws {
        var policies: [URLRequest.CachePolicy] = []
        StubProtocol.handler = { request in
            policies.append(request.cachePolicy)
            return (304, Data())
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "a"
        let answer = try await client.getCanvas(id: "c1", knownVersion: 3)
        XCTAssertNil(answer)
        XCTAssertEqual(policies, [.reloadIgnoringLocalCacheData])
    }
}
