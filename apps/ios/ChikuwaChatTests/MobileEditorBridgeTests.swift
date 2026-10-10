import WebKit
import XCTest
@testable import ChikuwaChat

/// M153a (docs/WIKI.md §30.3 / §30.4): the Swift side of the editor bridge reads and writes every message of
/// apps/shared/mobile-editor/bridge_messages.json (the same file the JS and Android tests read), the JS string literal
/// the messages travel in is sound, and the scheme handler serves the bundle and the pictures.
final class MobileEditorBridgeTests: XCTestCase {
    private func fixture() throws -> [String: Any] {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/mobile-editor/bridge_messages.json")
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func object(_ json: String) throws -> NSDictionary {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? NSDictionary)
    }

    func testFixtureVersionIsTheAppsBridgeVersion() throws {
        XCTAssertEqual(try fixture()["version"] as? Int, EditorBridge.version)
    }

    /// Every web → native example decodes, and encodes back to the same JSON.
    func testDecodesEveryWebMessageOfTheFixture() throws {
        let examples = try XCTUnwrap(try fixture()["web_to_native"] as? [[String: Any]])
        XCTAssertEqual(examples.count, 14)
        var types: [String] = []
        for example in examples {
            let json = String(decoding: try JSONSerialization.data(withJSONObject: example), as: UTF8.self)
            guard case .success(let message) = EditorBridge.decode(json) else {
                XCTFail("refused: \(json)")
                continue
            }
            types.append(message.type)
            XCTAssertEqual(message.type, example["type"] as? String)
            XCTAssertEqual(try object(try EditorBridge.json(message)), example as NSDictionary, "round trip of \(message.type)")
        }
        XCTAssertEqual(types, ["ready", "changed", "changed", "bodyRequested", "bodyRequested", "caret", "height", "needPeople", "needPages", "pickImage", "openLink", "openLink", "focusTitle", "log"])
    }

    /// Every native → web example is what the Swift messages encode to.
    func testEncodesEveryNativeMessageOfTheFixture() throws {
        let examples = try XCTUnwrap(try fixture()["native_to_web"] as? [[String: Any]])
        let messages: [EditorNativeMessage] = [
            .load(body: "# 手順\n\n最初の行\n", title: "マニュアル", theme: .dark, readOnly: false, caretLine: 2, locale: "ja", attachmentUrl: "taylis-editor://app/attachment/{id}", gen: 3),
            .load(body: ""),
            .replace(body: "# 手順\n\n最初の行（直した）\n", gen: 4),
            .setTheme(.light),
            .setViewport(keyboardHeight: 336, safeBottom: 34),
            .setViewport(keyboardHeight: 0),
            .insertImage(attachmentId: "0190a2b4-0000-7000-8000-00000000a001", url: "taylis-editor://app/attachment/0190a2b4-0000-7000-8000-00000000a001", alt: ""),
            .providePeople([
                BridgePerson(id: "0190a2b4-0000-7000-8000-0000000000e2", username: "hanako", displayName: "花子"),
                BridgePerson(id: "0190a2b4-0000-7000-8000-0000000000e9", username: "assistant", displayName: "アシスタント", ai: true),
                BridgePerson(id: "0190a2b4-0000-7000-8000-0000000000f1", username: "m2", displayName: "M2", kind: "group", members: 4, description: "修士 2 年"),
            ]),
            .providePages(query: "設計", pages: [BridgePage(id: "0190a2b4-0000-7000-8000-0000000000c1", title: "設計メモ", icon: "📐", kind: "page")]),
            .providePages(query: nil, pages: []),
            .provideEmoji([
                BridgeEmoji(name: "lab", url: "taylis-editor://app/emoji/lab", label: "研究室", kind: "image", width: 32, height: 32),
                BridgeEmoji(name: "ok", label: "OK", kind: "text", color: "green"),
            ]),
            .focus,
            .blur,
            .requestBody(),
            .requestBody(id: 7),
            .command(.bold),
        ]
        XCTAssertEqual(messages.count, examples.count, "the fixture and this list name the same messages")
        for (message, example) in zip(messages, examples) {
            XCTAssertEqual(message.type, example["type"] as? String)
            XCTAssertEqual(try object(try EditorBridge.json(message)), example as NSDictionary, "encoding of \(message.type)")
        }
    }

    /// The refused examples: what the app would never produce cannot even be built, and the web ones are refused with
    /// the reason.
    func testRefusedExamples() throws {
        let refused = try XCTUnwrap(try fixture()["refused"] as? [[String: Any]])
        XCTAssertEqual(refused.count, 7)
        XCTAssertEqual(EditorBridge.decode("{not json"), .failure(.notJSON))
        XCTAssertEqual(EditorBridge.decode(#"{"type":"ping"}"#), .failure(.unknownType("ping")))
        XCTAssertNil(EditorTheme(rawValue: "sepia"))
        XCTAssertNil(EditorCommand(rawValue: "explode"))
        XCTAssertEqual(EditorCommand.allCases.count, 22)
        XCTAssertEqual(EditorBridge.decode(#"{"type":"changed","body":1,"dirty":true}"#), .failure(.badField("changed: body")))
        XCTAssertEqual(EditorBridge.decode(#"{"type":"caret"}"#), .failure(.badField("caret: line")))
        XCTAssertEqual(EditorBridge.decode(#"{"type":"changed","body":"x","dirty":true,"baseGen":"1"}"#), .failure(.badField("changed: baseGen")))
        XCTAssertEqual(EditorBridge.decode(#"{"type":"bodyRequested","body":"x","dirty":true,"caretLine":0,"id":1.5}"#), .failure(.badField("bodyRequested: id")))
        // `loaded: false` is never a body (even with one beside it); a body without `loaded` (version 1) still is.
        XCTAssertEqual(EditorBridge.decode(#"{"type":"bodyRequested","loaded":false}"#), .success(.bodyUnavailable()))
        XCTAssertEqual(EditorBridge.decode(#"{"type":"bodyRequested","loaded":false,"body":"","dirty":false,"caretLine":0,"id":3}"#), .success(.bodyUnavailable(id: 3)))
        XCTAssertEqual(EditorBridge.decode(#"{"type":"bodyRequested","body":"","dirty":false,"caretLine":0}"#), .success(.bodyRequested(body: "", dirty: false, caretLine: 0)))
        XCTAssertEqual(EditorBridge.decode(#"{"type":"bodyRequested","loaded":true}"#), .failure(.badField("bodyRequested: body")))
        XCTAssertEqual(EditorBridge.decode(#"[1]"#), .failure(.notJSON))
        XCTAssertEqual(EditorBridge.decode(""), .failure(.notJSON))
    }

    /// The body goes into the page as one JS string literal: quotes, backslashes, newlines, tabs, control characters,
    /// the line separators and `</script>` come out as they went in.
    func testJavaScriptStringLiteralRoundTrip() throws {
        let nasty = "a\"b\\c\nd\re\tf\u{0}g\u{2028}h\u{2029}i</script>j日本語😀`${x}`\u{7f}"
        let literal = EditorBridge.jsStringLiteral(nasty)
        XCTAssertFalse(literal.contains("\u{2028}"))
        XCTAssertFalse(literal.contains("\n"))
        XCTAssertTrue(literal.hasPrefix("\"") && literal.hasSuffix("\""))
        // A JSON string literal is a JS string literal: the JSON parser reads it back.
        XCTAssertEqual(try JSONDecoder().decode(String.self, from: Data(literal.utf8)), nasty)
        let script = try EditorBridge.receiveScript(.replace(body: nasty))
        XCTAssertTrue(script.hasPrefix("window.taylisEditor.receive(\""))
        XCTAssertTrue(script.hasSuffix("\");"))
        let inner = String(script.dropFirst("window.taylisEditor.receive(".count).dropLast(2))
        let json = try JSONDecoder().decode(String.self, from: Data(inner.utf8))
        XCTAssertEqual(try object(json), ["type": "replace", "body": nasty] as NSDictionary)
    }

    /// The literal evaluates in a real WebView to the same text (WebKit's parser, not only Foundation's).
    @MainActor
    func testJavaScriptStringLiteralEvaluatesInWebKit() async throws {
        let nasty = "x\"y\\z\n\u{2028}\u{2029}</script>日本語😀\t\u{1}"
        let web = WKWebView(frame: .zero)
        web.loadHTMLString("<html><body></body></html>", baseURL: nil)
        for _ in 0..<200 where web.isLoading { try await Task.sleep(nanoseconds: 10_000_000) }
        let value = try await web.evaluateJavaScript("(" + EditorBridge.jsStringLiteral(nasty) + ")")
        XCTAssertEqual(value as? String, nasty)
    }

    func testURLsOfTheScheme() {
        XCTAssertEqual(EditorBridge.attachmentURL("abc"), "taylis-editor://app/attachment/abc")
        XCTAssertEqual(EditorBridge.attachmentURLTemplate, "taylis-editor://app/attachment/{id}")
        XCTAssertEqual(EditorBridge.emojiURL("lab"), "taylis-editor://app/emoji/lab")
        XCTAssertEqual(EditorBridge.emojiURL("研究 室"), "taylis-editor://app/emoji/%E7%A0%94%E7%A9%B6%20%E5%AE%A4")
        XCTAssertEqual(EditorBridge.indexURL.absoluteString, "taylis-editor://app/index.html")
    }

    // MARK: the scheme handler

    /// A WKURLSchemeTask the test owns: what the handler answered.
    @MainActor
    final class FakeSchemeTask: NSObject, WKURLSchemeTask {
        let request: URLRequest
        var response: HTTPURLResponse?
        var data = Data()
        var finished = false
        var failure: Error?
        init(_ url: String) { request = URLRequest(url: URL(string: url)!) }
        func didReceive(_ response: URLResponse) { self.response = response as? HTTPURLResponse }
        func didReceive(_ data: Data) { self.data.append(data) }
        func didFinish() { finished = true }
        func didFailWithError(_ error: Error) { failure = error }
    }

    @MainActor
    final class FakeAssets: EditorAssetSource {
        var attachments: [String: Data] = [:]
        var emoji: [String: Data] = [:]
        var attachmentCalls: [String] = []
        var emojiCalls: [String] = []
        func attachmentData(_ id: String) async throws -> Data {
            attachmentCalls.append(id)
            guard let data = attachments[id] else { throw URLError(.fileDoesNotExist) }
            return data
        }
        func emojiData(_ name: String) async throws -> Data {
            emojiCalls.append(name)
            guard let data = emoji[name] else { throw URLError(.fileDoesNotExist) }
            return data
        }
    }

    private static let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3])

    @MainActor
    private func bundleDirectory() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("editor-bundle-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("fonts"), withIntermediateDirectories: true)
        try "<!doctype html><html></html>".write(to: dir.appendingPathComponent("index.html"), atomically: true, encoding: .utf8)
        try "console.log(1)".write(to: dir.appendingPathComponent("editor.js"), atomically: true, encoding: .utf8)
        try "body{}".write(to: dir.appendingPathComponent("editor.css"), atomically: true, encoding: .utf8)
        try Data([1, 2, 3]).write(to: dir.appendingPathComponent("fonts/KaTeX_Main-Regular.woff2"))
        try "secret".write(to: dir.deletingLastPathComponent().appendingPathComponent("outside-\(dir.lastPathComponent).txt"), atomically: true, encoding: .utf8)
        return dir
    }

    @MainActor
    private func serve(_ handler: EditorSchemeHandler, _ url: String) async -> FakeSchemeTask {
        let task = FakeSchemeTask(url)
        handler.webView(WKWebView(frame: .zero), start: task)
        for _ in 0..<100 where !task.finished { await Task.yield() }
        return task
    }

    @MainActor
    func testSchemeHandlerServesTheBundleWithContentTypes() async throws {
        let handler = EditorSchemeHandler(directory: try bundleDirectory())
        let index = await serve(handler, "taylis-editor://app/index.html")
        XCTAssertEqual(index.response?.statusCode, 200)
        XCTAssertEqual(index.response?.value(forHTTPHeaderField: "Content-Type"), "text/html; charset=utf-8")
        XCTAssertEqual(String(decoding: index.data, as: UTF8.self), "<!doctype html><html></html>")
        XCTAssertTrue(index.finished)
        let script = await serve(handler, "taylis-editor://app/editor.js")
        XCTAssertEqual(script.response?.value(forHTTPHeaderField: "Content-Type"), "text/javascript; charset=utf-8")
        let style = await serve(handler, "taylis-editor://app/editor.css")
        XCTAssertEqual(style.response?.value(forHTTPHeaderField: "Content-Type"), "text/css; charset=utf-8")
        let font = await serve(handler, "taylis-editor://app/fonts/KaTeX_Main-Regular.woff2")
        XCTAssertEqual(font.response?.value(forHTTPHeaderField: "Content-Type"), "font/woff2")
        XCTAssertEqual(font.data, Data([1, 2, 3]))
        XCTAssertEqual(font.response?.value(forHTTPHeaderField: "Content-Length"), "3")
    }

    @MainActor
    func testSchemeHandlerRefusesWhatIsNotTheBundle() async throws {
        let dir = try bundleDirectory()
        let handler = EditorSchemeHandler(directory: dir)
        for url in ["taylis-editor://app/missing.js", "taylis-editor://app/../outside-\(dir.lastPathComponent).txt",
                    "taylis-editor://app/fonts/../../outside-\(dir.lastPathComponent).txt", "taylis-editor://app/.hidden",
                    "taylis-editor://other/index.html", "taylis-editor://app/", "taylis-editor://app/attachment/",
                    "taylis-editor://app/attachment/x/y"] {
            let task = await serve(handler, url)
            XCTAssertEqual(task.response?.statusCode, 404, url)
            XCTAssertTrue(task.finished, url)
            XCTAssertEqual(task.data.count, 0, url)
        }
    }

    @MainActor
    func testSchemeHandlerFetchesPicturesThroughTheAppAndCachesThem() async throws {
        let handler = EditorSchemeHandler(directory: try bundleDirectory())
        let assets = FakeAssets()
        assets.attachments["a1"] = Self.png
        assets.emoji["研究室"] = Self.png
        handler.assets = assets
        let picture = await serve(handler, "taylis-editor://app/attachment/a1")
        XCTAssertEqual(picture.response?.statusCode, 200)
        XCTAssertEqual(picture.response?.value(forHTTPHeaderField: "Content-Type"), "image/png")
        XCTAssertEqual(picture.data, Self.png)
        let again = await serve(handler, "taylis-editor://app/attachment/a1")
        XCTAssertEqual(again.data, Self.png)
        XCTAssertEqual(assets.attachmentCalls, ["a1"], "the second request is answered from the cache")
        let emoji = await serve(handler, EditorBridge.emojiURL("研究室"))
        XCTAssertEqual(emoji.response?.statusCode, 200)
        XCTAssertEqual(assets.emojiCalls, ["研究室"])
        let unknown = await serve(handler, "taylis-editor://app/attachment/nope")
        XCTAssertEqual(unknown.response?.statusCode, 404)
        XCTAssertEqual(assets.attachmentCalls, ["a1", "nope"])
    }

    @MainActor
    func testSchemeHandlerSaysNothingToAStoppedTask() async throws {
        let handler = EditorSchemeHandler(directory: try bundleDirectory())
        let assets = FakeAssets()
        assets.attachments["slow"] = Self.png
        handler.assets = assets
        let web = WKWebView(frame: .zero)
        let task = FakeSchemeTask("taylis-editor://app/attachment/slow")
        handler.webView(web, start: task)
        handler.webView(web, stop: task)
        for _ in 0..<100 { await Task.yield() }
        XCTAssertNil(task.response)
        XCTAssertFalse(task.finished)
    }

    func testContentTypes() {
        XCTAssertEqual(MobileEditorBundle.contentType(forExtension: "HTML"), "text/html; charset=utf-8")
        XCTAssertEqual(MobileEditorBundle.contentType(forExtension: "woff"), "font/woff")
        XCTAssertEqual(MobileEditorBundle.contentType(forExtension: "bin"), "application/octet-stream")
        XCTAssertEqual(MobileEditorBundle.imageContentType(Self.png), "image/png")
        XCTAssertEqual(MobileEditorBundle.imageContentType(Data([0xFF, 0xD8, 0xFF, 0xE0])), "image/jpeg")
        XCTAssertEqual(MobileEditorBundle.imageContentType(Data("RIFF\u{0}\u{0}\u{0}\u{0}WEBPVP8 ".utf8)), "image/webp")
        XCTAssertEqual(MobileEditorBundle.imageContentType(Data("hello".utf8)), "application/octet-stream")
    }

    // MARK: the controller's message handling

    @MainActor
    func testControllerQueuesUntilReadyAndRefusesAnotherVersion() {
        let controller = MobileEditorController(schemeHandler: EditorSchemeHandler(directory: nil))
        var errors: [String] = []
        var received: [EditorWebMessage] = []
        controller.onError = { errors.append($0) }
        controller.onMessage = { received.append($0) }
        XCTAssertFalse(controller.isReady)
        controller.send(.focus) // queued: no page yet, no error
        XCTAssertEqual(errors, [])
        controller.receive(#"{"type":"ready","version":99}"#)
        XCTAssertFalse(controller.isReady)
        XCTAssertEqual(controller.readyVersion, 99)
        XCTAssertEqual(errors.count, 1)
        XCTAssertTrue(errors[0].contains("version 99"))
        XCTAssertEqual(received, [], "a bundle of another version is not listened to")
        controller.receive("{oops")
        XCTAssertEqual(errors.count, 2)
        controller.receive(#"{"type":"caret","line":4}"#)
        XCTAssertEqual(received, [.caret(line: 4)])
    }
}
