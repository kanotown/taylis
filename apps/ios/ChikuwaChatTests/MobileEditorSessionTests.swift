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
        var onPageLost: (() -> Void)?
        func send(_ message: EditorNativeMessage) { sent.append(message) }
        /// The editor says so.
        func web(_ message: EditorWebMessage) { onMessage?(message) }
        /// The web process ended (the page is read again).
        func lose() { onPageLost?() }
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
                                                  attachmentUrl: "taylis-editor://app/attachment/{id}", gen: 1))
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
        // The editor is not focused and the edit is older than `quietAfter` when the save lands.
        h.session.now = { Date().addingTimeInterval(MobileEditorSession.quietAfter + 1) }
        try h.server.saveOnHead("alice", h.canvas.id, Self.body.replacingOccurrences(of: "- [ ] 練習", with: "- [x] 練習"))
        await h.clock.advance(2)
        await h.saver.settled()
        await settle()
        XCTAssertEqual(h.saver.status, .saved)
        let merged = h.head.body
        XCTAssertTrue(merged.contains("最初の行を直した") && merged.contains("- [x] 練習"), merged)
        XCTAssertEqual(h.saver.text, merged)
        XCTAssertEqual(h.transport.types.last, "replace")
        XCTAssertEqual(h.transport.sent.last, .replace(body: merged, gen: h.saver.textLineage))
    }

    /// The simulator's data loss (2026-10-10, §30.4): a merge sent as `replace` while the editor composed was held back
    /// by the editor and dropped at its next edit, and that edit (written on the body before the merge) was saved on the
    /// merged version, deleting the other person's line. While the editor is focused the loop keeps the merge back and
    /// saves on the version the editor's body was written on; the merge comes in after the blur.
    @MainActor
    func testWhileTheEditorIsFocusedAMergeWaitsAndNothingIsLost() async throws {
        let h = await harness()
        var focused = true
        h.session.editorFocused = { focused }
        let composing = Self.body.replacingOccurrences(of: "最初の行", with: "最初の行にほん")
        h.transport.web(.changed(body: composing, dirty: true))
        try h.server.saveOnHead("alice", h.canvas.id, Self.body + "\n相手の行\n")
        await h.clock.advance(2)
        await h.saver.settled()
        await settle()
        XCTAssertTrue(h.head.body.contains("相手の行") && h.head.body.contains("最初の行にほん"), h.head.body)
        XCTAssertFalse(h.transport.types.contains("replace"), "nothing goes in while the editor is focused")
        // The composition is converted: the editor's body is still the one before the merge.
        let converted = Self.body.replacingOccurrences(of: "最初の行", with: "最初の行日本")
        h.transport.web(.changed(body: converted, dirty: true))
        await h.clock.advance(2)
        await h.saver.settled()
        await settle()
        XCTAssertTrue(h.head.body.contains("相手の行"), "the other person's line survives: \(h.head.body)")
        XCTAssertTrue(h.head.body.contains("最初の行日本") && !h.head.body.contains("にほん"), h.head.body)
        XCTAssertFalse(h.transport.types.contains("replace"))
        // The keyboard goes away (`caret`): once quiet, the merged body comes in.
        focused = false
        h.session.now = { Date().addingTimeInterval(MobileEditorSession.quietAfter + 1) }
        h.transport.web(.caret(line: 3))
        try await Task.sleep(nanoseconds: UInt64((MobileEditorSession.quietAfter + 0.4) * 1_000_000_000))
        await h.saver.settled()
        await settle()
        XCTAssertEqual(h.saver.text, h.head.body)
        XCTAssertEqual(h.transport.sent.last, .replace(body: h.head.body, gen: h.saver.textLineage))
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
        XCTAssertEqual(h.transport.sent.last, .replace(body: theirs, gen: 2))
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
        XCTAssertEqual(h.transport.sent.last, .replace(body: ticked, gen: 2))
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
        XCTAssertEqual(h.transport.sent.last, .requestBody(id: 1))
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
        if case .load(_, _, let theme, _, let caretLine, _, _, _) = h.transport.sent[5] {
            XCTAssertEqual(theme, .light)
            XCTAssertNil(caretLine)
        } else {
            XCTFail("load expected")
        }
    }

    // MARK: review v0.1.49 #1 — a merge the editor drops never deletes the other person's lines

    /// The generation the editor took last (`load.gen` / the `replace.gen` it applied), as the bundled editor tracks it.
    @MainActor
    private func gen(of message: EditorNativeMessage?) -> Int? {
        switch message {
        case .load(_, _, _, _, _, _, _, let gen)?: gen
        case .replace(_, let gen)?: gen
        default: nil
        }
    }

    @MainActor
    private func lastReplace(_ h: Harness) -> EditorNativeMessage? {
        h.transport.sent.last { $0.type == "replace" }
    }

    /// The reviewer's scenario up to the answer: base `a\nb\nc`, I save `A\nb\nc` (on gen 1, the body of the first
    /// read), someone else saves `a\nb\nREMOTE` before the answer, the answer merges to `A\nb\nREMOTE`. `quiet`: whether the session takes the
    /// editor for quiet when the answer lands (focus not seen / typing begun just as the replace goes out) — then the
    /// merge goes out as `replace` and the editor may still hold and drop it; else (focused) it is kept back.
    /// The session's clock (`editorQuiet`), moved by hand.
    @MainActor
    final class Time {
        var now = Date()
        func pass(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
    }

    @MainActor
    private func mergeLands(quiet: Bool) async throws -> (Harness, Time) {
        let h = await harness(body: "a\nb\nc")
        let time = Time()
        h.session.now = { time.now }
        h.session.editorFocused = { !quiet }
        XCTAssertEqual(gen(of: h.transport.sent.last), 1, "gen 1: the first read put the body in")
        h.transport.web(.changed(body: "A\nb\nc", dirty: true, baseGen: 1))
        try h.server.saveOnHead("alice", h.canvas.id, "a\nb\nREMOTE")
        if quiet { time.pass(MobileEditorSession.quietAfter + 1) }
        await h.clock.advance(2)
        await h.saver.settled()
        await settle()
        XCTAssertEqual(h.head.body, "A\nb\nREMOTE")
        return (h, time)
    }

    /// Typing on during the save (the edit still in the web view's 300 ms write-out when the answer lands).
    @MainActor
    func testReview1TypingOnWhileTheSaveIsOutKeepsTheOtherPersonsLine() async throws {
        for quiet in [false, true] {
            let (h, time) = try await mergeLands(quiet: quiet)
            if quiet {
                XCTAssertEqual(lastReplace(h), .replace(body: "A\nb\nREMOTE", gen: 2))
            } else {
                XCTAssertNil(lastReplace(h), "kept back while the editor is focused")
            }
            // The editor held the replace back (an edit waited to be written) and dropped it: its text is on gen 1.
            h.transport.web(.changed(body: "AA\nb\nc", dirty: true, baseGen: 1))
            if quiet { time.pass(MobileEditorSession.quietAfter + 1) }
            await h.clock.advance(2)
            await h.saver.settled()
            await settle()
            XCTAssertEqual(h.head.body, "AA\nb\nREMOTE", "quiet=\(quiet)")
            XCTAssertEqual(h.saver.status, .saved)
            if quiet {
                // The merged body comes in again with a new gen; taken this time, the next edit is saved on the head.
                let again = try XCTUnwrap(lastReplace(h))
                XCTAssertEqual(again, .replace(body: "AA\nb\nREMOTE", gen: 3))
                h.transport.web(.changed(body: "AAA\nb\nREMOTE", dirty: true, baseGen: gen(of: again)))
                try h.server.saveOnHead("alice", h.canvas.id, "AA\nb\nREMOTE2")
                await h.clock.advance(2)
                await h.saver.settled()
                XCTAssertEqual(h.head.body, "AAA\nb\nREMOTE2")
            }
        }
    }

    /// An IME composition held the replace: dropped by the converted text (on gen 1), or let in when it ends (gen 2).
    @MainActor
    func testReview1AMergeHeldThroughACompositionKeepsTheOtherPersonsLine() async throws {
        for quiet in [false, true] {
            let (h, _) = try await mergeLands(quiet: quiet)
            h.transport.web(.changed(body: "A日本\nb\nc", dirty: true, baseGen: 1))
            await h.clock.advance(2)
            await h.saver.settled()
            await settle()
            XCTAssertEqual(h.head.body, "A日本\nb\nREMOTE", "quiet=\(quiet)")
        }
        // The composition ended without an edit of its own and the editor let the held body in: written on gen 2.
        let (h, _) = try await mergeLands(quiet: true)
        XCTAssertEqual(gen(of: lastReplace(h)), 2)
        h.transport.web(.changed(body: "A\nb\nREMOTE。", dirty: true, baseGen: 2))
        await h.clock.advance(2)
        await h.saver.settled()
        XCTAssertEqual(h.head.body, "A\nb\nREMOTE。")
    }

    /// 完了 / the Markdown switch / the app going away right after typing: `requestBody` writes the edit at once.
    @MainActor
    func testReview1RequestBodyRightAfterTypingKeepsTheOtherPersonsLine() async throws {
        for quiet in [false, true] {
            let (h, _) = try await mergeLands(quiet: quiet)
            async let done: Void = h.session.detach()
            await settle()
            XCTAssertEqual(h.transport.sent.last, .requestBody(id: 1))
            h.transport.web(.bodyRequested(body: "AA\nb\nc", dirty: true, caretLine: 0, baseGen: 1, id: 1))
            await done
            XCTAssertEqual(h.head.body, "AA\nb\nREMOTE", "quiet=\(quiet)")
            XCTAssertFalse(h.saver.unsaved)
        }
    }

    /// Someone else's version read while idle goes in as `replace`; a text the editor wrote on the body before it is
    /// merged with it (not saved over it).
    @MainActor
    func testReview1AnEditOnTheBodyBeforeSomeoneElsesVersionIsMergedWithIt() async throws {
        let h = await harness(body: "a\nb\nc")
        try h.server.saveOnHead("alice", h.canvas.id, "a\nb\nREMOTE")
        h.saver.remoteVersion(2)
        await h.clock.advance(0.5)
        await h.saver.settled()
        await settle()
        XCTAssertEqual(lastReplace(h), .replace(body: "a\nb\nREMOTE", gen: 2))
        h.transport.web(.changed(body: "A\nb\nc", dirty: true, baseGen: 1))
        await h.clock.advance(2)
        await h.saver.settled()
        XCTAssertEqual(h.head.body, "A\nb\nREMOTE")
    }

    /// A text that names no generation (a bundle of bridge version 1) is taken as before: on the saver's base.
    @MainActor
    func testATextWithoutBaseGenIsWrittenOnTheCurrentBody() async throws {
        let (h, _) = try await mergeLands(quiet: true)
        h.transport.web(.changed(body: "A\nb\nREMOTE!", dirty: true))
        await h.clock.advance(2)
        await h.saver.settled()
        XCTAssertEqual(h.head.body, "A\nb\nREMOTE!")
    }

    // MARK: review v0.1.49 #2 — a page read again never gives an empty body

    @MainActor
    func testAfterThePageEndedTheBodyIsLoadedAgainOnReady() async throws {
        let h = await harness(caretLine: 2)
        h.transport.web(.changed(body: Self.body + "\n打った\n", dirty: true, baseGen: 1))
        h.transport.lose()
        XCTAssertTrue(h.session.pageLost)
        // 完了 while the page is read again: nothing is asked of it, the saver keeps its text.
        let count = h.transport.sent.count
        let line = await h.session.commit(timeout: 1)
        XCTAssertEqual(line, 2)
        XCTAssertEqual(h.transport.sent.count, count)
        XCTAssertEqual(h.saver.text, Self.body + "\n打った\n")
        // The page is up again: the people, the emoji and the saver's text with its generation and the caret's line.
        h.transport.web(.ready(version: EditorBridge.version))
        XCTAssertFalse(h.session.pageLost)
        XCTAssertEqual(Array(h.transport.types.suffix(3)), ["providePeople", "provideEmoji", "load"])
        XCTAssertEqual(h.transport.sent.last, .load(body: Self.body + "\n打った\n", title: nil, theme: .dark, readOnly: false, caretLine: 2,
                                                    locale: "ja", attachmentUrl: EditorBridge.attachmentURLTemplate, gen: 1))
        XCTAssertEqual(h.session.loadCount, 2)
        // A second ready (not after a loss) loads nothing.
        h.transport.web(.ready(version: EditorBridge.version))
        XCTAssertEqual(h.session.loadCount, 2)
    }

    @MainActor
    func testARequestWaitingWhenThePageEndsGivesUpAndKeepsTheText() async throws {
        let h = await harness()
        async let line = h.session.commit(timeout: 5)
        await settle()
        XCTAssertEqual(h.transport.sent.last, .requestBody(id: 1))
        h.transport.lose()
        _ = await line
        XCTAssertEqual(h.saver.text, Self.body)
        // A late answer of the old page is no one's.
        h.transport.web(.bodyRequested(body: "", dirty: true, caretLine: 0, baseGen: 1, id: 1))
        XCTAssertEqual(h.saver.text, Self.body)
    }

    @MainActor
    func testAnAnswerWithoutABodyIsNeverSavedAndTheBodyGoesInAgain() async throws {
        let h = await harness()
        async let line = h.session.commit(timeout: 5)
        await settle()
        h.transport.web(.bodyUnavailable(id: 1))
        _ = await line
        XCTAssertEqual(h.saver.text, Self.body)
        XCTAssertFalse(h.saver.unsaved)
        XCTAssertEqual(h.transport.types.last, "load")
        XCTAssertEqual(h.session.loadCount, 2)
    }

    @MainActor
    func testAnAnswerToAnotherRequestIsIgnored() async throws {
        let h = await harness()
        async let line = h.session.commit(timeout: 5)
        await settle()
        h.transport.web(.bodyRequested(body: "", dirty: true, caretLine: 9, baseGen: 1, id: 99))
        await settle()
        XCTAssertEqual(h.saver.text, Self.body)
        h.transport.web(.bodyRequested(body: Self.body + "x", dirty: true, caretLine: 3, baseGen: 1, id: 1))
        let got = await line
        XCTAssertEqual(got, 3)
        XCTAssertEqual(h.saver.text, Self.body + "x")
    }

    /// The reviewer's `testReloadedRealWebViewCanSaveEmptyBody` with the real bundle, WKWebView, controller, session and
    /// saver: after the web process's end (the product's callback, the page read again for real) the body is loaded
    /// again and 完了 keeps it; a page that has no editor answers `loaded: false`.
    @MainActor
    func testReloadedRealWebViewKeepsTheBody() async throws {
        try XCTSkipUnless(MobileEditorBundle.isAvailable, "the bundled editor is not built (cd apps/desktop && npm run build:mobile-editor)")
        let server = FakeCanvasServer()
        let original = "# 保存してある本文\n\n消してはいけない段落\n"
        let canvas = server.create(by: "alice", channelId: "lab", body: original)
        let saver = CanvasSaver(id: canvas.id, channelId: "lab", api: FakeCanvasApi(server: server, userId: "bob"))
        saver.load()
        await saver.settled()
        defer { saver.dispose() }
        let controller = MobileEditorController()
        let session = MobileEditorSession(transport: controller, host: FakeHost())
        controller.start()
        func ready() async throws {
            for _ in 0..<1000 where !controller.isReady { try await Task.sleep(nanoseconds: 10_000_000) }
            XCTAssertTrue(controller.isReady)
        }
        func editorShown() async throws -> Bool {
            for _ in 0..<300 {
                if try await controller.evaluate("!!document.querySelector('.page-editor')") as? Bool == true { return true }
                try await Task.sleep(nanoseconds: 10_000_000)
            }
            return false
        }
        try await ready()
        session.attach(saver: saver, caretLine: nil, theme: .light)
        let shown = try await editorShown()
        XCTAssertTrue(shown)
        await session.commit()
        XCTAssertEqual(saver.text, original)

        controller.webViewWebContentProcessDidTerminate(controller.webView)
        XCTAssertFalse(controller.isReady)
        XCTAssertTrue(session.pageLost)
        await session.commit() // during the reload: nothing asked, nothing taken
        XCTAssertEqual(saver.text, original)
        try await ready()
        let shownAgain = try await editorShown()
        XCTAssertTrue(shownAgain, "the body is loaded again into the page read again")
        await session.commit()
        await saver.flush()
        await saver.settled()
        XCTAssertEqual(saver.text, original)
        XCTAssertEqual(server.head(canvas.id).body, original)
        XCTAssertEqual(server.head(canvas.id).version, 1, "nothing saved")

        // The page itself: requestBody before any load answers `loaded: false` (never an empty body).
        let bare = MobileEditorController()
        var answers: [EditorWebMessage] = []
        bare.onMessage = { answers.append($0) }
        bare.start()
        for _ in 0..<1000 where !bare.isReady { try await Task.sleep(nanoseconds: 10_000_000) }
        bare.send(.requestBody(id: 42))
        for _ in 0..<300 where !answers.contains(where: { $0.type == "bodyRequested" }) { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertEqual(answers.last { $0.type == "bodyRequested" }, .bodyUnavailable(id: 42))
    }
}
