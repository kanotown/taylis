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
    @ObservationIgnored private var bodyWaiters: [CheckedContinuation<EditorWebMessage?, Never>] = []
    @ObservationIgnored private var watching: CanvasSaver?
    @ObservationIgnored private(set) var loadCount = 0

    init(transport: EditorTransport, host: MobileEditorHost?) {
        self.transport = transport
        self.host = host
        transport.onMessage = { [weak self] message in self?.receive(message) }
    }

    // MARK: the page's body in and out

    /// 編集: the body into the editor (a new one each time), with the people and emoji before it, the caret on
    /// `caretLine` (from the Markdown editor; nil: the start). The saver's later replacements are followed.
    func attach(saver: CanvasSaver, caretLine: Int?, theme: EditorTheme, readOnly: Bool = false) {
        detachWatching()
        self.saver = saver
        self.theme = theme
        self.caretLine = caretLine
        // The editor holds a merge back by itself while an IME composition is open or an edit waits to be written
        // (bridge.ts `replace`): the saver may always hand its text over.
        saver.canReplace = { true }
        if let host {
            transport.send(.providePeople(host.editorPeople()))
            transport.send(.provideEmoji(host.editorEmoji()))
        }
        loadCount += 1
        let load = EditorNativeMessage.load(body: saver.text, title: nil, theme: theme, readOnly: readOnly, caretLine: caretLine,
                                            locale: host?.editorLocale, attachmentUrl: EditorBridge.attachmentURLTemplate)
        if MobileEditorTrace.enabled, let controller = transport as? MobileEditorController, controller.isReady {
            // The measurements: `load` timed inside the page to the frame after the editor is painted.
            let chars = saver.text.count
            MobileEditorTrace.log("load.sent chars=\(chars)")
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
        watch(saver)
    }

    /// The saver's text changed by itself (a merge, someone else's version, a tick in the reading view): into the editor.
    func textReplaced() {
        guard let saver else { return }
        transport.send(.replace(body: saver.text))
    }

    /// The body as the editor holds it now, into the saver (and the caret line kept): 完了, the Markdown switch, the
    /// app going inactive. Waits for the editor's answer (`bodyRequested`) up to `timeout`; without one (the page is
    /// gone) the saver keeps what it has.
    @discardableResult
    func commit(timeout: TimeInterval = 1.5) async -> Int? {
        guard let saver else { return caretLine }
        if MobileEditorTrace.enabled, let controller = transport as? MobileEditorController {
            // The typing latency the hook gathered (MobileEditorTrace.timedLoadScript), before the body is asked.
            if let frames = try? await controller.evaluate("JSON.stringify(window.__taylisFrames || [])") as? String {
                MobileEditorTrace.log("frames \(frames)")
            }
        }
        MobileEditorTrace.log("requestBody")
        transport.send(.requestBody)
        let answer = await withCheckedContinuation { (continuation: CheckedContinuation<EditorWebMessage?, Never>) in
            bodyWaiters.append(continuation)
            Task { [weak self] in
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self?.giveUpWaiting()
            }
        }
        if case .bodyRequested(let body, _, let line)? = answer {
            caretLine = line
            saver.edit(body)
        }
        return caretLine
    }

    /// 完了 / the Markdown switch / the screen closing: the body back into the saver and saved now.
    func detach() async {
        guard let saver else { return }
        await commit()
        detachWatching()
        saver.canReplace = { true }
        self.saver = nil
        await saver.flush()
    }

    private func giveUpWaiting() {
        let waiters = bodyWaiters
        bodyWaiters = []
        for waiter in waiters { waiter.resume(returning: nil) }
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

    func command(_ name: EditorCommand) { transport.send(.command(name)) }
    func focus() { transport.send(.focus) }
    func blur() { transport.send(.blur) }

    /// The picked picture is on the server: its block at the caret.
    func insertImage(_ attachmentId: String) {
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
            break
        case .changed(let body, let dirty):
            MobileEditorTrace.log("changed chars=\(body.count) dirty=\(dirty)")
            saver?.edit(body)
        case .bodyRequested(let body, let dirty, let line):
            MobileEditorTrace.log("bodyRequested chars=\(body.count) dirty=\(dirty) caretLine=\(line)")
            let waiters = bodyWaiters
            bodyWaiters = []
            for waiter in waiters { waiter.resume(returning: message) }
        case .caret(let line):
            caretLine = line
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
