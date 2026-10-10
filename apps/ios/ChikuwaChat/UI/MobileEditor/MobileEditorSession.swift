import Foundation
import Observation

/// What the session asks the app for (AppController in the app; a fake in the tests).
@MainActor
protocol MobileEditorHost: AnyObject {
    /// The people and groups `@` offers.
    func editorPeople() -> [BridgePerson]
    /// The workspace's custom emoji.
    func editorEmoji() -> [BridgeEmoji]
    /// The pages `[[` / `@` offer for `query` (empty: a first page of them).
    func editorPages(query: String) -> [BridgePage]
    /// The locale the editor's texts are in ("ja" / "en" / "zh-Hans").
    var editorLocale: String { get }
}

/// M153a (docs/WIKI.md §30.4): one page's editing in the bundled editor — the bridge's messages on one side and the
/// page's save loop (CanvasSaver: the same debounce, merge, version and conflict handling as the Markdown editor) on
/// the other. The WebView is made and the page read when the page screen opens (warm-up); `attach` sends the people,
/// the emoji and `load` when 編集 is tapped. The saver's merged bodies go in as `replace`; the editor's `changed` goes
/// to `saver.edit`; leaving (完了, the Markdown switch, the app going inactive) asks the body back (`requestBody`) and
/// flushes.
@MainActor
@Observable
final class MobileEditorSession {
    let transport: EditorTransport
    @ObservationIgnored private weak var host: MobileEditorHost?
    @ObservationIgnored private(set) var saver: CanvasSaver?
    /// The body line the caret was last on (the Markdown editor opens there when switching).
    private(set) var caretLine: Int?
    /// The editor asked for a picture (`pickImage`): the screen shows the picker, then `insertImage(_:)`.
    var imageRequested = false
    /// A link the editor opened that the screen shows (`page:` goes to `onOpenPage`, `attachment:` and https here).
    var openedLink: String?
    var onOpenPage: ((String) -> Void)?
    /// The editor said so (`log`), or a message failed: for the console and the trace.
    var onLog: ((String) -> Void)?
    @ObservationIgnored private var theme: EditorTheme = .light
    @ObservationIgnored private var readOnly = false
    /// The `requestBody`s waiting for their answer, by id (an answer to another id — one from before a reload — is not
    /// theirs).
    @ObservationIgnored private var bodyWaiters: [Int: CheckedContinuation<EditorWebMessage?, Never>] = [:]
    @ObservationIgnored private var lastRequestId = 0
    /// The page's web process ended (review v0.1.49 #2): the page is read again and has no editor until the next
    /// `ready`, when the body (the saver's text) is loaded again. Until then nothing is asked of it.
    @ObservationIgnored private(set) var pageLost = false
    @ObservationIgnored private var watching: CanvasSaver?
    @ObservationIgnored private(set) var loadCount = 0
    /// Whether the editor holds the keyboard focus (the WebView's content view is the first responder). While it does,
    /// or right after it reported an edit or took a command, the save loop keeps a merged body to itself (see `attach`).
    @ObservationIgnored var editorFocused: () -> Bool = { false }
    /// The clock of `editorQuiet` (the tests move it).
    @ObservationIgnored var now: () -> Date = Date.init
    @ObservationIgnored private var lastActivity = Date.distantPast
    @ObservationIgnored private var catchUp: Task<Void, Never>?
    /// How long after the editor's last edit or command a merged body may go in.
    static let quietAfter: TimeInterval = 1

    /// No composition can be open and no edit can be waiting to be written in the editor: not focused, and nothing
    /// reported or commanded for `quietAfter`. Only then does the saver put a merged body in and send it as `replace`
    /// (the editor applies it at once then); while typing, every save goes on the version the editor's body was written
    /// on and the server merges it, and the merged body comes in when the editor lets go of the focus (`caret`).
    /// A `replace` the editor held back (IME, an edit about to be written) is dropped by its next edit, and that edit —
    /// written on the body before the merge — saved on the merged version deleted the other person's lines (seen on the
    /// simulator, 2026-10-10, docs/WIKI.md §30.4). This rule made that rare; what makes it impossible is the body's
    /// generation (`load.gen` / `replace.gen` → `baseGen`): a text written on an earlier body is saved on that body's
    /// version whatever this guessed (review v0.1.49 #1: focus not seen, typing begun as the `replace` was on its way).
    var editorQuiet: Bool {
        !editorFocused() && now().timeIntervalSince(lastActivity) >= Self.quietAfter
    }

    init(transport: EditorTransport, host: MobileEditorHost?) {
        self.transport = transport
        self.host = host
        transport.onMessage = { [weak self] message in self?.receive(message) }
        transport.onPageLost = { [weak self] in self?.lostPage() }
    }

    // MARK: the page's body in and out

    /// 編集: the body into the editor (a new one each time), with the people and emoji before it, the caret on
    /// `caretLine` (from the Markdown editor; nil: the start). The saver's later replacements are followed.
    func attach(saver: CanvasSaver, caretLine: Int?, theme: EditorTheme, readOnly: Bool = false) {
        detachWatching()
        self.saver = saver
        self.theme = theme
        self.caretLine = caretLine
        self.readOnly = readOnly
        pageLost = false // the load below goes to the page read again, once it is up
        // Not while the editor may be composing or about to write an edit (`editorQuiet`): the editor would hold the
        // replacement back and drop it at its next edit. Nothing would be lost then (the edit's `baseGen` names the body
        // it was written on and the loop saves it on that body's version), but the merge would come in only later.
        saver.canReplace = { [weak self] in self?.editorQuiet ?? true }
        sendLoad(saver)
        watch(saver)
    }

    /// The people, the emoji and the saver's text (with its generation) into a new editor.
    private func sendLoad(_ saver: CanvasSaver) {
        if let host {
            transport.send(.providePeople(host.editorPeople()))
            transport.send(.provideEmoji(host.editorEmoji()))
        }
        loadCount += 1
        let load = EditorNativeMessage.load(body: saver.text, title: nil, theme: theme, readOnly: readOnly, caretLine: caretLine,
                                            locale: host?.editorLocale, attachmentUrl: EditorBridge.attachmentURLTemplate,
                                            gen: saver.textLineage)
        if MobileEditorTrace.enabled, let controller = transport as? MobileEditorController, controller.isReady {
            // The measurements: `load` timed inside the page to the frame after the editor is painted.
            let chars = saver.text.count
            MobileEditorTrace.log("load.sent chars=\(chars) caretLine=\(caretLine.map(String.init) ?? "nil")")
            Task { @MainActor in
                do {
                    let painted = try await controller.evaluateAsync(try MobileEditorTrace.timedLoadScript(load))
                    MobileEditorTrace.log("load.painted chars=\(chars) ms=\(painted.map { String(describing: $0) } ?? "?")")
                } catch {
                    MobileEditorTrace.log("load.failed \(error)")
                }
            }
        } else {
            MobileEditorTrace.log("load.queued chars=\(saver.text.count)")
            transport.send(load)
        }
    }

    /// The saver's text changed by itself (a merge, someone else's version, a tick in the reading view): into the editor,
    /// with its generation (the editor's next `changed` says whether it took it).
    func textReplaced() {
        guard let saver else { return }
        transport.send(.replace(body: saver.text, gen: saver.textLineage))
    }

    /// The body as the editor holds it now, into the saver (and the caret line kept): 完了, the Markdown switch, the
    /// app going inactive. Waits for the editor's answer (`bodyRequested` with this request's id) up to `timeout`;
    /// without one (the page is gone), with a page that has no editor (`loaded: false`) or while the page is being read
    /// again after its process ended, the saver keeps what it has — never an empty body for a missing one.
    @discardableResult
    func commit(timeout: TimeInterval = 1.5) async -> Int? {
        guard let saver else { return caretLine }
        guard !pageLost else {
            MobileEditorTrace.log("requestBody skipped: the page is being read again")
            return caretLine
        }
        if MobileEditorTrace.enabled, let controller = transport as? MobileEditorController {
            // The typing latency the hook gathered (MobileEditorTrace.timedLoadScript), before the body is asked.
            if let frames = try? await controller.evaluate("JSON.stringify(window.__taylisFrames || [])") as? String {
                MobileEditorTrace.log("frames \(frames)")
            }
        }
        lastRequestId += 1
        let id = lastRequestId
        MobileEditorTrace.log("requestBody id=\(id)")
        let answer = await withCheckedContinuation { (continuation: CheckedContinuation<EditorWebMessage?, Never>) in
            bodyWaiters[id] = continuation
            transport.send(.requestBody(id: id))
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self?.answerWaiter(id, with: nil)
            }
        }
        if case .bodyRequested(let body, _, let line, let baseGen, _)? = answer, self.saver === saver {
            caretLine = line
            saver.edit(body, basedOn: baseGen)
        }
        return caretLine
    }

    /// 完了 / the Markdown switch / the screen closing: the body back into the saver and saved now.
    func detach() async {
        guard let saver else { return }
        await commit()
        detachWatching()
        catchUp?.cancel()
        catchUp = nil
        saver.canReplace = { true }
        self.saver = nil
        await saver.flush()
    }

    private func answerWaiter(_ id: Int, with answer: EditorWebMessage?) {
        bodyWaiters.removeValue(forKey: id)?.resume(returning: answer)
    }

    private func answerAllWaiters(with answer: EditorWebMessage?) {
        let waiters = bodyWaiters
        bodyWaiters = [:]
        for waiter in waiters.values { waiter.resume(returning: answer) }
    }

    /// The web process ended (MobileEditorController reads the page again): what was asked of it will not be answered,
    /// and the page has no editor until its `ready`, when the body is loaded again.
    private func lostPage() {
        pageLost = true
        answerAllWaiters(with: nil)
        onLog?("[warn] the editor's page ended; it is read again and the body loaded again")
    }

    // MARK: the screen's doings

    func setTheme(_ next: EditorTheme) {
        guard next != theme else { return }
        theme = next
        transport.send(.setTheme(next))
    }

    /// What the keyboard covers when the WebView is not resized above it (the screen resizes it: 0).
    func setViewport(keyboardHeight: Double, safeBottom: Double) {
        transport.send(.setViewport(keyboardHeight: keyboardHeight, safeBottom: safeBottom))
    }

    func command(_ name: EditorCommand) {
        lastActivity = now()
        transport.send(.command(name))
    }
    func focus() { transport.send(.focus) }
    func blur() { transport.send(.blur) }

    /// The picked picture is on the server: its block at the caret.
    func insertImage(_ attachmentId: String) {
        lastActivity = now()
        transport.send(.insertImage(attachmentId: attachmentId, url: EditorBridge.attachmentURL(attachmentId), alt: ""))
    }

    /// The people changed (the directory, a group): the `@` list follows.
    func peopleChanged() {
        guard let host, saver != nil else { return }
        transport.send(.providePeople(host.editorPeople()))
    }

    // MARK: the editor's messages

    private func receive(_ message: EditorWebMessage) {
        switch message {
        case .ready:
            // The page read again after its process ended: the people, the emoji and the body (the saver's text, the
            // caret's line) go in again — without them its editor does not exist and has nothing to give back.
            guard pageLost else { break }
            pageLost = false
            if let saver { sendLoad(saver) }
        case .changed(let body, let dirty, let baseGen):
            MobileEditorTrace.log("changed chars=\(body.count) dirty=\(dirty) baseGen=\(baseGen.map(String.init) ?? "nil")")
            lastActivity = now()
            saver?.edit(body, basedOn: baseGen)
        case .bodyRequested(let body, let dirty, let line, let baseGen, let id):
            MobileEditorTrace.log("bodyRequested chars=\(body.count) dirty=\(dirty) caretLine=\(line) baseGen=\(baseGen.map(String.init) ?? "nil") id=\(id.map(String.init) ?? "nil")")
            if let id {
                answerWaiter(id, with: message) // an id no one waits for (asked before a reload, given up): ignored
            } else {
                answerAllWaiters(with: message)
            }
        case .bodyUnavailable(let id):
            // A page without an editor: no body (never an empty one); the saver keeps its text.
            onLog?("[warn] requestBody answered by a page without an editor")
            if let id { answerWaiter(id, with: nil) } else { answerAllWaiters(with: nil) }
            if let saver, !pageLost { sendLoad(saver) } // it should have one: the body goes in again
        case .caret(let line):
            caretLine = line
            catchUpAfterBlur()
        case .height(let px):
            MobileEditorTrace.log("height px=\(Int(px))")
        case .needPeople:
            if let host { transport.send(.providePeople(host.editorPeople())) }
        case .needPages(let query):
            transport.send(.providePages(query: query, pages: host?.editorPages(query: query) ?? []))
        case .pickImage:
            imageRequested = true
        case .openLink(let url):
            if url.hasPrefix("page:") {
                onOpenPage?(String(url.dropFirst("page:".count)))
            } else {
                openedLink = url
            }
        case .focusTitle:
            break // the title is the navigation bar's (題名とアイコンを変更…)
        case .log(let level, let text, let detail):
            MobileEditorTrace.log("log [\(level)] \(text)")
            onLog?("[\(level)] \(text)" + (detail.map { "\n" + $0 } ?? ""))
        }
    }

    /// The editor let go of the focus (`caret`): once it is quiet, what the server merged meanwhile comes in (a read
    /// when nothing is unsaved; otherwise the pending save lands and brings it).
    private func catchUpAfterBlur() {
        catchUp?.cancel()
        catchUp = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64((Self.quietAfter + 0.1) * 1_000_000_000))
            guard let self, !Task.isCancelled, let saver = self.saver, self.editorQuiet else { return }
            await saver.flush() // unsaved: saved now (and merged); else, when the server merged meanwhile (stale), read
        }
    }

    // MARK: following the saver

    private func watch(_ saver: CanvasSaver) {
        watching = saver
        withObservationTracking {
            _ = saver.textRevision
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, self.watching === saver else { return }
                self.textReplaced()
                self.watch(saver)
            }
        }
    }

    private func detachWatching() {
        watching = nil
    }
}
