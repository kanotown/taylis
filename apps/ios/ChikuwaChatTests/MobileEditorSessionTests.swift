import XCTest
@testable import ChikuwaChat

/// M153a (docs/WIKI.md §30.4): the session between the bundled editor's bridge and the page's save loop (CanvasSaver):
/// what goes into the editor (people, emoji, the body, merges), what comes out of it (`changed` → the loop, the body
/// asked back on leave, the caret line, the pages and pictures it asks for, the links). The editor is a fake transport
/// that records the messages and lets the test answer; the server and the clock are the canvas tests' fakes.
final class MobileEditorSessionTests: XCTestCase {
    private static let body = "# 手順\n\n最初の行\n\n- [ ] 資料\n- [ ] 練習\n"

    @MainActor
    final class FakeTransport: EditorTransport {
        var sent: [EditorNativeMessage] = []
        var onMessage: ((EditorWebMessage) -> Void)?
        func send(_ message: EditorNativeMessage) { sent.append(message) }
        /// The editor says so.
        func web(_ message: EditorWebMessage) { onMessage?(message) }
        var types: [String] { sent.map(\.type) }
    }

    @MainActor
    final class FakeHost: MobileEditorHost {
        var people = [BridgePerson(id: "u1", username: "hanako", displayName: "花子")]
        var emoji = [BridgeEmoji(name: "lab", url: EditorBridge.emojiURL("lab"), label: "研究室", kind: "image", width: 32, height: 32)]
        var pages = [BridgePage(id: "p1", title: "設計メモ", icon: "📐", kind: "page")]
        var pageQueries: [String] = []
        func editorPeople() -> [BridgePerson] { people }
        func editorEmoji() -> [BridgeEmoji] { emoji }
        func editorPages(query: String) -> [BridgePage] {
            pageQueries.append(query)
            return pages
        }
        var editorLocale: String { "ja" }
    }

    @MainActor
    private struct Harness {
        let server: FakeCanvasServer
        let api: FakeCanvasApi
        let clock: ManualCanvasClock
        let saver: CanvasSaver
        let canvas: CanvasOut
        let transport: FakeTransport
        let host: FakeHost
        let session: MobileEditorSession
        var head: CanvasOut { server.head(canvas.id) }
    }

    private var cleanups: [() -> Void] = []

    override func tearDown() async throws {
        for cleanup in cleanups { cleanup() }
        cleanups = []
    }

    @MainActor
    private func harness(body: String = MobileEditorSessionTests.body, attach: Bool = true, caretLine: Int? = nil) async -> Harness {
        let server = FakeCanvasServer()
        let canvas = server.create(by: "alice", channelId: "lab", body: body)
        let api = FakeCanvasApi(server: server, userId: "bob")
        let clock = ManualCanvasClock()
        var options = CanvasSaverOptions()
        options.debounce = 2
        options.refreshDebounce = 0.5
        options.retryDelays = [1, 2]
        let saver = CanvasSaver(id: canvas.id, channelId: "lab", api: api, clock: clock, options: options)
        saver.load()
        await saver.settled()
        let transport = FakeTransport()
        let host = FakeHost()
        let session = MobileEditorSession(transport: transport, host: host)
        if attach { session.attach(saver: saver, caretLine: caretLine, theme: .dark) }
        cleanups.append {
            saver.dispose()
            clock.drain()
        }
        return Harness(server: server, api: api, clock: clock, saver: saver, canvas: canvas, transport: transport, host: host, session: session)
    }

    /// The observation of the saver's text lands on the main actor a tick later.
    @MainActor
    private func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }

    // MARK: into the editor

    @MainActor
    func testAttachSendsPeopleEmojiThenTheBody() async {
        let h = await harness(caretLine: 4)
        XCTAssertEqual(h.transport.types, ["providePeople", "provideEmoji", "load"])
        XCTAssertEqual(h.transport.sent[0], .providePeople(h.host.people))
        XCTAssertEqual(h.transport.sent[1], .provideEmoji(h.host.emoji))
        XCTAssertEqual(h.transport.sent[2], .load(body: Self.body, title: nil, theme: .dark, readOnly: false, caretLine: 4, locale: "ja",
                                                  attachmentUrl: "taylis-editor://app/attachment/{id}"))
        XCTAssertEqual(h.session.caretLine, 4)
        XCTAssertEqual(h.session.loadCount, 1)
    }

    @MainActor
    func testAMergedBodyFromTheServerGoesInAsReplace() async throws {
        let h = await harness()
        // Bob types on one line; alice saves another line on the head meanwhile.
        let typed = Self.body.replacingOccurrences(of: "最初の行", with: "最初の行を直した")
        h.transport.web(.changed(body: typed, dirty: true))
        XCTAssertEqual(h.saver.text, typed)
        XCTAssertEqual(h.saver.status, .editing)
        try h.server.saveOnHead("alice", h.canvas.id, Self.body.replacingOccurrences(of: "- [ ] 練習", with: "- [x] 練習"))
        await h.clock.advance(2)
        await h.saver.settled()
        await settle()
        XCTAssertEqual(h.saver.status, .saved)
        let merged = h.head.body
        XCTAssertTrue(merged.contains("最初の行を直した") && merged.contains("- [x] 練習"), merged)
        XCTAssertEqual(h.saver.text, merged)
        XCTAssertEqual(h.transport.types.last, "replace")
        XCTAssertEqual(h.transport.sent.last, .replace(body: merged))
    }

    @MainActor
    func testSomeoneElsesVersionWhileIdleGoesInAsReplace() async throws {
        let h = await harness()
        let theirs = Self.body + "\n追記\n"
        try h.server.saveOnHead("alice", h.canvas.id, theirs)
        h.saver.remoteVersion(2)
        await h.clock.advance(0.5)
        await h.saver.settled()
        await settle()
        XCTAssertEqual(h.saver.text, theirs)
        XCTAssertEqual(h.transport.sent.last, .replace(body: theirs))
        // The editor's own `changed` never comes back as a replace.
        let count = h.transport.sent.count
        h.transport.web(.changed(body: theirs + "x", dirty: true))
        await settle()
        XCTAssertEqual(h.transport.sent.count, count)
    }

    @MainActor
    func testATickInTheReadingViewGoesInAsReplace() async {
        let h = await harness()
        let ticked = Self.body.replacingOccurrences(of: "- [ ] 資料", with: "- [x] 資料")
        h.saver.edit(ticked, external: true)
        await settle()
        XCTAssertEqual(h.transport.sent.last, .replace(body: ticked))
    }

    @MainActor
    func testThemeIsSentOnlyWhenItChanges() async {
        let h = await harness()
        let count = h.transport.sent.count
        h.session.setTheme(.dark)
        XCTAssertEqual(h.transport.sent.count, count)
        h.session.setTheme(.light)
        XCTAssertEqual(h.transport.sent.last, .setTheme(.light))
        h.session.setViewport(keyboardHeight: 0, safeBottom: 34)
        XCTAssertEqual(h.transport.sent.last, .setViewport(keyboardHeight: 0, safeBottom: 34))
        h.session.command(.bold)
        XCTAssertEqual(h.transport.sent.last, .command(.bold))
    }

    // MARK: out of the editor

    @MainActor
    func testChangedGoesToTheSaveLoopAndIsSavedAfterThePause() async {
        let h = await harness()
        let typed = Self.body + "\n書き足した\n"
        h.transport.web(.changed(body: typed, dirty: true))
        XCTAssertEqual(h.saver.status, .editing)
        XCTAssertEqual(h.api.calls.count, 0)
        await h.clock.advance(2)
        await h.saver.settled()
        XCTAssertEqual(h.api.calls.count, 1)
        XCTAssertEqual(h.head.body, typed)
        XCTAssertEqual(h.saver.status, .saved)
    }

    @MainActor
    func testCommitAsksTheBodyBackAndKeepsTheCaretLine() async {
        let h = await harness()
        let typed = Self.body + "\n最後の言葉\n"
        async let line = h.session.commit(timeout: 1)
        await settle()
        XCTAssertEqual(h.transport.sent.last, .requestBody)
        h.transport.web(.bodyRequested(body: typed, dirty: true, caretLine: 7))
        let got = await line
        XCTAssertEqual(got, 7)
        XCTAssertEqual(h.session.caretLine, 7)
        XCTAssertEqual(h.saver.text, typed)
        XCTAssertEqual(h.saver.status, .editing)
    }

    @MainActor
    func testCommitGivesUpWhenTheEditorDoesNotAnswer() async {
        let h = await harness()
        h.transport.web(.caret(line: 3))
        let started = Date()
        let line = await h.session.commit(timeout: 0.05)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1)
        XCTAssertEqual(line, 3)
        XCTAssertEqual(h.saver.text, Self.body)
    }

    @MainActor
    func testDetachTakesTheBodyAndSavesAtOnce() async {
        let h = await harness()
        let typed = Self.body + "\n閉じる前\n"
        async let done: Void = h.session.detach()
        await settle()
        h.transport.web(.bodyRequested(body: typed, dirty: true, caretLine: 1))
        await done
        XCTAssertEqual(h.head.body, typed, "saved without waiting for the pause")
        XCTAssertEqual(h.saver.status, .saved)
        // Detached: nothing more goes in.
        let count = h.transport.sent.count
        h.saver.edit(typed + "x", external: true)
        await settle()
        XCTAssertEqual(h.transport.sent.count, count)
    }

    @MainActor
    func testPagesPeopleAndPicturesAreAnswered() async {
        let h = await harness()
        h.transport.web(.needPages(query: "設計"))
        XCTAssertEqual(h.host.pageQueries, ["設計"])
        XCTAssertEqual(h.transport.sent.last, .providePages(query: "設計", pages: h.host.pages))
        h.host.people.append(BridgePerson(id: "g1", username: "m2", displayName: "M2", kind: "group", members: 4))
        h.transport.web(.needPeople(query: "m"))
        XCTAssertEqual(h.transport.sent.last, .providePeople(h.host.people))
        XCTAssertFalse(h.session.imageRequested)
        h.transport.web(.pickImage)
        XCTAssertTrue(h.session.imageRequested)
        h.session.insertImage("a1")
        XCTAssertEqual(h.transport.sent.last, .insertImage(attachmentId: "a1", url: "taylis-editor://app/attachment/a1", alt: ""))
    }

    @MainActor
    func testLinksGoToThePageOrTheScreen() async {
        let h = await harness()
        var opened: [String] = []
        h.session.onOpenPage = { opened.append($0) }
        h.transport.web(.openLink(url: "page:p1"))
        XCTAssertEqual(opened, ["p1"])
        XCTAssertNil(h.session.openedLink)
        h.transport.web(.openLink(url: "attachment:a1"))
        XCTAssertEqual(h.session.openedLink, "attachment:a1")
        h.transport.web(.openLink(url: "https://example.com/"))
        XCTAssertEqual(h.session.openedLink, "https://example.com/")
        XCTAssertEqual(opened, ["p1"])
    }

    @MainActor
    func testLogLinesReachTheApp() async {
        let h = await harness()
        var lines: [String] = []
        h.session.onLog = { lines.append($0) }
        h.transport.web(.log(level: "warn", message: "message refused: unknown type \"ping\""))
        XCTAssertEqual(lines, ["[warn] message refused: unknown type \"ping\""])
        h.transport.web(.focusTitle)
        h.transport.web(.height(px: 1240))
        XCTAssertEqual(lines.count, 1)
    }

    @MainActor
    func testASecondAttachLoadsAgain() async {
        let h = await harness()
        h.session.attach(saver: h.saver, caretLine: nil, theme: .light)
        XCTAssertEqual(h.session.loadCount, 2)
        XCTAssertEqual(h.transport.types, ["providePeople", "provideEmoji", "load", "providePeople", "provideEmoji", "load"])
        if case .load(_, _, let theme, _, let caretLine, _, _) = h.transport.sent[5] {
            XCTAssertEqual(theme, .light)
            XCTAssertNil(caretLine)
        } else {
            XCTFail("load expected")
        }
    }
}
