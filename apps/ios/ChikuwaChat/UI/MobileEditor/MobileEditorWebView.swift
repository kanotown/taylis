import Foundation
import ObjectiveC
import UIKit
import WebKit

/// M153a (docs/WIKI.md §30.3 / §30.4): the bundled page editor in the app bundle (`dist/`: index.html, editor.js,
/// editor.css, fonts/ — a folder reference to apps/shared/mobile-editor/dist (project.yml), which Xcode copies under
/// its on-disk name whatever the reference is called).
enum MobileEditorBundle {
    nonisolated(unsafe) static var directory: URL? = Bundle.main.url(forResource: "dist", withExtension: nil)
        ?? Bundle.main.url(forResource: "editor", withExtension: nil)

    /// Whether the app carries the editor (a build without the bundle keeps the Markdown editor).
    static var isAvailable: Bool {
        guard let directory else { return false }
        return FileManager.default.fileExists(atPath: directory.appendingPathComponent("index.html").path)
    }

    /// The media type the WebView is told for a bundle file (a wrong one would not run as a script or load as a font).
    static func contentType(forExtension ext: String) -> String {
        switch ext.lowercased() {
        case "html": "text/html; charset=utf-8"
        case "js", "mjs": "text/javascript; charset=utf-8"
        case "css": "text/css; charset=utf-8"
        case "json": "application/json; charset=utf-8"
        case "woff2": "font/woff2"
        case "woff": "font/woff"
        case "ttf": "font/ttf"
        case "svg": "image/svg+xml"
        case "png": "image/png"
        case "jpg", "jpeg": "image/jpeg"
        case "gif": "image/gif"
        case "webp": "image/webp"
        default: "application/octet-stream"
        }
    }

    /// An image's media type by its first bytes (the attachment API answers with the bytes only).
    static func imageContentType(_ data: Data) -> String {
        if let kind = ImageUpload.kind(of: data) { return kind.mime }
        let head = [UInt8](data.prefix(12))
        if head.count >= 12, head[0..<4] == [0x52, 0x49, 0x46, 0x46], head[8..<12] == [0x57, 0x45, 0x42, 0x50] { return "image/webp" }
        return "application/octet-stream"
    }
}

/// What the scheme handler asks the app for: the bytes of a page's picture or a custom emoji, with the session.
@MainActor
protocol EditorAssetSource: AnyObject {
    func attachmentData(_ id: String) async throws -> Data
    func emojiData(_ name: String) async throws -> Data
}

/// Serves `taylis-editor://app/…` to the WebView: the bundle's files, `/attachment/<id>` (the app's authenticated
/// fetch, cached) and `/emoji/<name>`. Everything else is 404. The WebView never reaches the network (the page's CSP
/// has connect-src 'none' and only this scheme), and the access token stays in the app.
@MainActor
final class EditorSchemeHandler: NSObject, WKURLSchemeHandler {
    weak var assets: EditorAssetSource?
    private let directory: URL?
    private let cache = NSCache<NSString, NSData>()
    /// The tasks still wanted (a stopped task must not be answered: WebKit raises).
    private var active: Set<ObjectIdentifier> = []

    init(directory: URL? = MobileEditorBundle.directory) {
        self.directory = directory
        cache.totalCostLimit = 48 * 1024 * 1024
    }

    nonisolated func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        MainActor.assumeIsolated { begin(task) }
    }

    nonisolated func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        MainActor.assumeIsolated { active.remove(ObjectIdentifier(task)) }
    }

    private func begin(_ task: WKURLSchemeTask) {
        let id = ObjectIdentifier(task)
        active.insert(id)
        guard let url = task.request.url, url.scheme == EditorBridge.scheme, url.host == EditorBridge.host else {
            finish(task, status: 404, type: "text/plain", data: Data())
            return
        }
        let parts = url.pathComponents.filter { $0 != "/" }
        if parts.count == 2, parts[0] == "attachment" {
            let attachmentId = parts[1]
            fetch(task, key: "attachment:" + attachmentId) { [weak self] in
                guard let assets = self?.assets else { throw EditorAssetError.noSession }
                return try await assets.attachmentData(attachmentId)
            } type: { MobileEditorBundle.imageContentType($0) }
            return
        }
        if parts.count == 2, parts[0] == "emoji" {
            let name = parts[1].removingPercentEncoding ?? parts[1]
            fetch(task, key: "emoji:" + name) { [weak self] in
                guard let assets = self?.assets else { throw EditorAssetError.noSession }
                return try await assets.emojiData(name)
            } type: { MobileEditorBundle.imageContentType($0) }
            return
        }
        // A bundle file: index.html, editor.js, editor.css, fonts/<name>. Never outside the folder.
        guard let directory, !parts.isEmpty, !parts.contains(".."), !parts.contains(where: { $0.hasPrefix(".") }) else {
            finish(task, status: 404, type: "text/plain", data: Data())
            return
        }
        let file = parts.reduce(directory) { $0.appendingPathComponent($1) }
        guard let data = try? Data(contentsOf: file) else {
            finish(task, status: 404, type: "text/plain", data: Data())
            return
        }
        finish(task, status: 200, type: MobileEditorBundle.contentType(forExtension: file.pathExtension), data: data)
    }

    private func fetch(_ task: WKURLSchemeTask, key: String, _ load: @escaping @MainActor () async throws -> Data, type: @escaping (Data) -> String) {
        if let kept = cache.object(forKey: key as NSString) {
            finish(task, status: 200, type: type(kept as Data), data: kept as Data)
            return
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let data = try await load()
                self.cache.setObject(data as NSData, forKey: key as NSString, cost: data.count)
                self.finish(task, status: 200, type: type(data), data: data)
            } catch {
                self.finish(task, status: 404, type: "text/plain", data: Data())
            }
        }
    }

    private func finish(_ task: WKURLSchemeTask, status: Int, type: String, data: Data) {
        let id = ObjectIdentifier(task)
        guard active.contains(id), let url = task.request.url else { return }
        active.remove(id)
        let headers = ["Content-Type": type, "Content-Length": String(data.count), "Cache-Control": "no-store"]
        guard let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers) else { return }
        task.didReceive(response)
        if !data.isEmpty { task.didReceive(data) }
        task.didFinish()
    }

    enum EditorAssetError: Error { case noSession }
}

/// Where the session's messages go (the WebView, or a test's fake).
@MainActor
protocol EditorTransport: AnyObject {
    /// Delivered once the page said `ready` (queued before).
    func send(_ message: EditorNativeMessage)
    var onMessage: ((EditorWebMessage) -> Void)? { get set }
}

/// Owns the WKWebView that shows the editor: the scheme handler, the message handler, the queue of messages until the
/// page is `ready`, and the navigation policy (nothing but the bundle's own page; links come back as `openLink`).
@MainActor
final class MobileEditorController: NSObject, EditorTransport, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let webView: WKWebView
    let schemeHandler: EditorSchemeHandler
    private(set) var isReady = false
    private(set) var readyVersion: Int?
    private var queue: [EditorNativeMessage] = []
    var onMessage: ((EditorWebMessage) -> Void)?
    /// Something to look at when a message could not be sent (the page is gone, the script failed).
    var onError: ((String) -> Void)?
    /// MobileEditorTrace: when the WebView was made (the warm-up's clock).
    let createdAt = Date()
    /// Whether WebKit's own bar above the keyboard (‹ › 完了) is hidden: the app's own row stands there (§30.4).
    nonisolated(unsafe) static var hidesInputAccessory = true
    /// Whether the page's own formatting row (PageEditor's `env.toolbar: "bottom"`) is hidden for the app's row.
    nonisolated(unsafe) static var hidesWebToolbar = true
    static let hideWebToolbarScript = """
    (() => { const s = document.createElement("style"); s.textContent = "[data-page-editor] .pe-toolbar-bottom { display: none !important; } body { padding-bottom: calc(var(--keyboard-height, 0px) + 1rem + var(--safe-bottom, 0px)) !important; }"; document.head.appendChild(s); })();
    """

    init(schemeHandler: EditorSchemeHandler? = nil) {
        let schemeHandler = schemeHandler ?? EditorSchemeHandler()
        self.schemeHandler = schemeHandler
        let configuration = WKWebViewConfiguration()
        configuration.setURLSchemeHandler(schemeHandler, forURLScheme: EditorBridge.scheme)
        configuration.allowsInlineMediaPlayback = true
        configuration.dataDetectorTypes = []
        configuration.suppressesIncrementalRendering = false
        // The messages: the handler holds the controller weakly (WKUserContentController keeps its handlers).
        let proxy = ScriptMessageProxy()
        configuration.userContentController.add(proxy, name: EditorBridge.messageHandler)
        // The editor's own formatting row at the bottom of the page is hidden: the app's row (MobileEditorToolbar)
        // stands above the keyboard instead (§30.4). A style put in by the app, not a change of the bundle.
        if Self.hidesWebToolbar {
            configuration.userContentController.addUserScript(WKUserScript(source: Self.hideWebToolbarScript, injectionTime: .atDocumentEnd, forMainFrameOnly: true))
        }
        webView = NoAccessoryWebView(frame: .zero, configuration: configuration)
        super.init()
        proxy.target = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.keyboardDismissMode = .interactive
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        webView.isOpaque = false
        webView.backgroundColor = .systemBackground
        webView.scrollView.backgroundColor = .systemBackground
        webView.accessibilityIdentifier = "mobile-editor"
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif
    }

    /// The page, read once (the warm-up: as soon as the page screen opens; `load` follows on 編集).
    func start() {
        guard webView.url == nil else { return }
        webView.load(URLRequest(url: EditorBridge.indexURL))
    }

    func send(_ message: EditorNativeMessage) {
        guard isReady else {
            queue.append(message)
            return
        }
        let script: String
        do {
            script = try EditorBridge.receiveScript(message)
        } catch {
            onError?("encode \(message.type): \(error)")
            return
        }
        webView.evaluateJavaScript(script) { [weak self] _, error in
            if let error { self?.onError?("\(message.type): \(error.localizedDescription)") }
        }
    }

    /// A script of the page, for the measurements (MobileEditorTrace) and the tests.
    func evaluate(_ script: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            webView.evaluateJavaScript(script) { value, error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: value) }
            }
        }
    }

    /// A function body that may return a promise (awaited), for the measurements.
    func evaluateAsync(_ body: String) async throws -> Any? {
        try await withCheckedThrowingContinuation { continuation in
            webView.callAsyncJavaScript(body, arguments: [:], in: nil, in: .page) { result in
                switch result {
                case .success(let value): continuation.resume(returning: value)
                case .failure(let error): continuation.resume(throwing: error)
                }
            }
        }
    }

    // MARK: WKScriptMessageHandler

    nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let json = message.body as? String else { return }
        MainActor.assumeIsolated { receive(json) }
    }

    func receive(_ json: String) {
        switch EditorBridge.decode(json) {
        case .success(let message):
            if case .ready(let version) = message {
                readyVersion = version
                guard version == EditorBridge.version else {
                    onError?("bundle version \(version), app expects \(EditorBridge.version)")
                    return
                }
                MobileEditorTrace.log("ready version=\(version) sinceWebView=\(Int(Date().timeIntervalSince(createdAt) * 1000))ms")
                isReady = true
                let pending = queue
                queue = []
                for item in pending { send(item) }
            }
            onMessage?(message)
        case .failure(let error):
            onError?("message refused: \(error)")
        }
    }

    // MARK: WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, url.scheme == EditorBridge.scheme, url.host == EditorBridge.host,
              navigationAction.targetFrame?.isMainFrame != false else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        onError?("navigation failed: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        onError?("page failed: \(error.localizedDescription)")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The web process is gone (memory): the page is read again; the next `load` comes from the screen.
        isReady = false
        queue = []
        onError?("web content process terminated")
        webView.load(URLRequest(url: EditorBridge.indexURL))
    }

    // MARK: WKUIDelegate (nothing opens from the page)

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil
    }
}

/// WKUserContentController retains its handlers: this stands between it and the controller.
private final class ScriptMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: MobileEditorController?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

/// A WKWebView without WebKit's bar above the keyboard (‹ › 完了, which a `contenteditable` page gets like a form):
/// the app's own formatting row stands there instead (MobileEditorView). The bar is the `inputAccessoryView` of
/// WebKit's content view (the first responder); it is answered nil from a subclass made at run time — the same
/// technique rich text editors on iOS use, no private symbol is called.
final class NoAccessoryWebView: WKWebView {
    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil, MobileEditorController.hidesInputAccessory else { return }
        Self.hideAccessory(in: scrollView)
    }

    private static let subclassName = "TaylisEditorContentView"

    private static func hideAccessory(in scrollView: UIScrollView) {
        for view in scrollView.subviews where NSStringFromClass(type(of: view)).hasPrefix("WKContent") {
            guard let original = object_getClass(view), NSStringFromClass(original) != subclassName else { continue }
            let subclass: AnyClass
            if let existing = NSClassFromString(subclassName) {
                subclass = existing
            } else {
                guard let made = objc_allocateClassPair(original, subclassName, 0) else { return }
                let selector = #selector(getter: UIResponder.inputAccessoryView)
                let implementation: @convention(block) (AnyObject) -> UIView? = { _ in nil }
                if let method = class_getInstanceMethod(original, selector) {
                    class_addMethod(made, selector, imp_implementationWithBlock(implementation), method_getTypeEncoding(method))
                }
                objc_registerClassPair(made)
                subclass = made
            }
            object_setClass(view, subclass)
        }
    }
}
