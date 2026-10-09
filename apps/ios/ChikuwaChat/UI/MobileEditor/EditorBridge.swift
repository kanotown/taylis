import Foundation

/// M153a (docs/WIKI.md §30.3): the messages between the bundled page editor (apps/shared/mobile-editor/dist, shown in a
/// WKWebView while a Docs page is edited, MobileEditorWebView) and the app — the Swift copy of
/// apps/shared/mobile-editor/src/bridge.ts. The editor never talks to the server: the body, the people, the pages, the
/// emoji, the pictures and the links all go through these messages, and the access token never reaches the WebView.
/// apps/shared/mobile-editor/bridge_messages.json holds one example of every message; MobileEditorBridgeTests encodes and
/// decodes them all.
enum EditorBridge {
    /// `ready.version`: a bundle of another version is refused (the messages' shapes changed).
    static let version = 1
    /// The WKScriptMessageHandler's name: `window.webkit.messageHandlers.taylis.postMessage(json)`.
    static let messageHandler = "taylis"
    /// The WKURLSchemeHandler's scheme and host: the bundle's files, the pictures and the custom emoji.
    static let scheme = "taylis-editor"
    static let host = "app"
    static let indexURL = URL(string: "taylis-editor://app/index.html")!
    /// `load.attachmentUrl`: where `![alt](attachment:<id>)` images load from (`{id}` for the id).
    static let attachmentURLTemplate = "taylis-editor://app/attachment/{id}"

    static func attachmentURL(_ id: String) -> String { "taylis-editor://app/attachment/\(id)" }

    /// A custom emoji's picture (`provideEmoji[].url`).
    static func emojiURL(_ name: String) -> String {
        "taylis-editor://app/emoji/\(name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name)"
    }

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.withoutEscapingSlashes]
        return encoder
    }()

    /// The message as the JSON the editor parses.
    static func json(_ message: EditorNativeMessage) throws -> String {
        String(decoding: try encoder.encode(message), as: UTF8.self)
    }

    /// `window.taylisEditor.receive("…")`: the JSON as one JS string literal (the editor parses it), evaluated in the
    /// WebView. A string literal, not an object literal: the body is any text and goes through the same escaping.
    static func receiveScript(_ message: EditorNativeMessage) throws -> String {
        "window.taylisEditor.receive(\(jsStringLiteral(try json(message))));"
    }

    /// `text` as a double-quoted JS string literal: `\`, `"`, the control characters and the line separators (U+2028 /
    /// U+2029, which older parsers refuse in a literal) escaped; everything else as it is (UTF-8 all the way).
    static func jsStringLiteral(_ text: String) -> String {
        var out = "\""
        out.reserveCapacity(text.utf8.count + 2)
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\\": out += "\\\\"
            case "\"": out += "\\\""
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{2028}": out += "\\u2028"
            case "\u{2029}": out += "\\u2029"
            default:
                if scalar.value < 0x20 || scalar.value == 0x7F {
                    out += String(format: "\\u%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
        return out
    }

    /// A message the editor posted (one JSON string per message), or nil with the reason when it is not one.
    static func decode(_ json: String) -> Result<EditorWebMessage, EditorBridgeError> {
        guard let data = json.data(using: .utf8) else { return .failure(.notJSON) }
        do {
            return .success(try JSONDecoder().decode(EditorWebMessage.self, from: data))
        } catch let error as EditorBridgeError {
            return .failure(error)
        } catch {
            return .failure(.notJSON)
        }
    }

    /// A web message as JSON (the tests' round trip; the app only decodes them).
    static func json(_ message: EditorWebMessage) throws -> String {
        String(decoding: try encoder.encode(message), as: UTF8.self)
    }
}

enum EditorBridgeError: Error, Equatable {
    case notJSON
    case unknownType(String)
    case badField(String)
}

enum EditorTheme: String, Codable, Equatable {
    case light, dark, system
}

/// A native toolbar's buttons (`command`): the same actions as the editor's own formatting row (bridge.ts EDITOR_COMMANDS).
enum EditorCommand: String, Codable, CaseIterable, Equatable {
    case bold, italic, strike, code
    case h1, h2, h3
    case bullet, ordered, task, quote, codeBlock, divider
    case link, mention, slash, image, table
    case undo, redo, indent, outdent
}

/// A person or a group `@` offers (`providePeople`); `<@id>` / `<@group:id>` chips show their names.
struct BridgePerson: Codable, Equatable {
    let id: String
    /// What is typed after `@` (a group's name for a group).
    let username: String
    let displayName: String
    /// "user" (the default) or "group".
    var kind: String? = nil
    /// An AI bot (shown with the 「AI」 badge).
    var ai: Bool? = nil
    /// A group's size, for its row's label.
    var members: Int? = nil
    var description: String? = nil

    enum CodingKeys: String, CodingKey { case id, username, displayName = "display_name", kind, ai, members, description }
}

/// A page `[[`, `@` and ⌘K offer (`providePages`), and the icon / title of `[label](page:id)` chips.
struct BridgePage: Codable, Equatable {
    let id: String
    let title: String
    var icon: String? = nil
    /// "page", "database" or "row".
    var kind: String? = nil
}

/// A custom emoji of the workspace (`provideEmoji`): `:name:` is drawn from `url` (an image) or as a text pill.
struct BridgeEmoji: Codable, Equatable {
    let name: String
    /// The picture's URL (the app's scheme, fetched with the session); none for a text emoji.
    var url: String? = nil
    var label: String? = nil
    /// "image" or "text".
    var kind: String? = nil
    /// A text emoji's palette colour (apps/shared/text-emoji.json).
    var color: String? = nil
    var width: Int? = nil
    var height: Int? = nil
}

/// Native → editor (`window.taylisEditor.receive`).
enum EditorNativeMessage: Equatable {
    /// A page's body into a new editor. `caretLine`: the body line to put the caret on (from the Markdown editor).
    /// `attachmentUrl`: where `![alt](attachment:<id>)` images load from, with `{id}` for the id.
    case load(body: String, title: String? = nil, theme: EditorTheme? = nil, readOnly: Bool? = nil, caretLine: Int? = nil, locale: String? = nil, attachmentUrl: String? = nil)
    /// The body as the server now holds it (a merge, someone else's version): the changed blocks are replaced, outside
    /// the undo history; the editor holds it back while an IME composition is open or an edit waits to be written.
    case replace(body: String)
    case setTheme(EditorTheme)
    /// What the keyboard covers, in CSS px, when the WebView is not resized above it (0 when it is).
    case setViewport(keyboardHeight: Double, safeBottom: Double? = nil)
    /// A picture the app uploaded (after `pickImage`): an image block at the caret.
    case insertImage(attachmentId: String, url: String? = nil, alt: String? = nil)
    /// The people `@` offers: the whole directory, sent before `load` and again whenever it changes.
    case providePeople([BridgePerson])
    /// The answer to `needPages` for `query` (nil: the whole tree; the editor then filters by title itself).
    case providePages(query: String?, pages: [BridgePage])
    case provideEmoji([BridgeEmoji])
    case focus
    case blur
    /// The body as the editor holds it now, at once (`bodyRequested`): before saving on leave, before switching to Markdown.
    case requestBody
    /// A native toolbar's button.
    case command(EditorCommand)

    var type: String {
        switch self {
        case .load: "load"
        case .replace: "replace"
        case .setTheme: "setTheme"
        case .setViewport: "setViewport"
        case .insertImage: "insertImage"
        case .providePeople: "providePeople"
        case .providePages: "providePages"
        case .provideEmoji: "provideEmoji"
        case .focus: "focus"
        case .blur: "blur"
        case .requestBody: "requestBody"
        case .command: "command"
        }
    }
}

extension EditorNativeMessage: Encodable {
    private enum Keys: String, CodingKey {
        case type, body, title, theme, readOnly, caretLine, locale, attachmentUrl, keyboardHeight, safeBottom
        case attachmentId, url, alt, people, query, pages, emoji, name
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(type, forKey: .type)
        switch self {
        case .load(let body, let title, let theme, let readOnly, let caretLine, let locale, let attachmentUrl):
            try c.encode(body, forKey: .body)
            try c.encodeIfPresent(title, forKey: .title)
            try c.encodeIfPresent(theme, forKey: .theme)
            try c.encodeIfPresent(readOnly, forKey: .readOnly)
            try c.encodeIfPresent(caretLine, forKey: .caretLine)
            try c.encodeIfPresent(locale, forKey: .locale)
            try c.encodeIfPresent(attachmentUrl, forKey: .attachmentUrl)
        case .replace(let body):
            try c.encode(body, forKey: .body)
        case .setTheme(let theme):
            try c.encode(theme, forKey: .theme)
        case .setViewport(let keyboardHeight, let safeBottom):
            try c.encode(keyboardHeight, forKey: .keyboardHeight)
            try c.encodeIfPresent(safeBottom, forKey: .safeBottom)
        case .insertImage(let attachmentId, let url, let alt):
            try c.encode(attachmentId, forKey: .attachmentId)
            try c.encodeIfPresent(url, forKey: .url)
            try c.encodeIfPresent(alt, forKey: .alt)
        case .providePeople(let people):
            try c.encode(people, forKey: .people)
        case .providePages(let query, let pages):
            // `null` on purpose: the whole tree (a missing key would be no query at all).
            try c.encode(query, forKey: .query)
            try c.encode(pages, forKey: .pages)
        case .provideEmoji(let emoji):
            try c.encode(emoji, forKey: .emoji)
        case .focus, .blur, .requestBody:
            break
        case .command(let command):
            try c.encode(command, forKey: .name)
        }
    }
}

/// Editor → native (one JSON string per message, through the "taylis" message handler).
enum EditorWebMessage: Equatable {
    /// The page is up and listening: `load` may follow.
    case ready(version: Int)
    /// The body changed (typing paused 300 ms, or the editor lost the focus). `dirty`: differs from the last load / replace.
    case changed(body: String, dirty: Bool)
    case bodyRequested(body: String, dirty: Bool, caretLine: Int)
    /// The body line the caret's block starts on (when the editor loses the focus; the Markdown editor opens there).
    case caret(line: Int)
    /// The document's height in CSS px, when it changed.
    case height(px: Double)
    /// `@` opened or its query changed.
    case needPeople(query: String)
    /// `[[`, `@` or ⌘K look for pages: answered with `providePages` for the same query.
    case needPages(query: String)
    /// The image button / `/画像`: the app picks a picture, uploads it and sends `insertImage`.
    case pickImage
    /// A link, page chip or file chip was tapped: `https://…`, `page:<id>` or `attachment:<id>`.
    case openLink(url: String)
    /// ↑ on the body's first line: the app may focus the title field.
    case focusTitle
    /// A line for the app's log (an error in the page, a message it did not understand, a refused action).
    case log(level: String, message: String, detail: String? = nil)

    var type: String {
        switch self {
        case .ready: "ready"
        case .changed: "changed"
        case .bodyRequested: "bodyRequested"
        case .caret: "caret"
        case .height: "height"
        case .needPeople: "needPeople"
        case .needPages: "needPages"
        case .pickImage: "pickImage"
        case .openLink: "openLink"
        case .focusTitle: "focusTitle"
        case .log: "log"
        }
    }
}

extension EditorWebMessage: Codable {
    private enum Keys: String, CodingKey {
        case type, version, body, dirty, caretLine, line, px, query, url, level, message, detail
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        let type = try c.decodeIfPresent(String.self, forKey: .type) ?? ""
        func field<T: Decodable>(_ key: Keys, _ kind: T.Type) throws -> T {
            do {
                return try c.decode(kind, forKey: key)
            } catch {
                throw EditorBridgeError.badField("\(type): \(key.rawValue)")
            }
        }
        switch type {
        case "ready": self = .ready(version: try field(.version, Int.self))
        case "changed": self = .changed(body: try field(.body, String.self), dirty: try field(.dirty, Bool.self))
        case "bodyRequested":
            self = .bodyRequested(body: try field(.body, String.self), dirty: try field(.dirty, Bool.self), caretLine: try field(.caretLine, Int.self))
        case "caret": self = .caret(line: try field(.line, Int.self))
        case "height": self = .height(px: try field(.px, Double.self))
        case "needPeople": self = .needPeople(query: try field(.query, String.self))
        case "needPages": self = .needPages(query: try field(.query, String.self))
        case "pickImage": self = .pickImage
        case "openLink": self = .openLink(url: try field(.url, String.self))
        case "focusTitle": self = .focusTitle
        case "log":
            self = .log(level: try field(.level, String.self), message: try field(.message, String.self),
                        detail: try c.decodeIfPresent(String.self, forKey: .detail))
        default: throw EditorBridgeError.unknownType(type)
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(type, forKey: .type)
        switch self {
        case .ready(let version): try c.encode(version, forKey: .version)
        case .changed(let body, let dirty):
            try c.encode(body, forKey: .body)
            try c.encode(dirty, forKey: .dirty)
        case .bodyRequested(let body, let dirty, let caretLine):
            try c.encode(body, forKey: .body)
            try c.encode(dirty, forKey: .dirty)
            try c.encode(caretLine, forKey: .caretLine)
        case .caret(let line): try c.encode(line, forKey: .line)
        case .height(let px): try c.encode(px, forKey: .px)
        case .needPeople(let query), .needPages(let query): try c.encode(query, forKey: .query)
        case .pickImage, .focusTitle: break
        case .openLink(let url): try c.encode(url, forKey: .url)
        case .log(let level, let message, let detail):
            try c.encode(level, forKey: .level)
            try c.encode(message, forKey: .message)
            try c.encodeIfPresent(detail, forKey: .detail)
        }
    }
}
