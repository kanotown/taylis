import Foundation

/// M153a (docs/WIKI.md §30.4): the per-device switch 「ドキュメントの見たまま編集（試作）」 (自分 → 表示) and the editing
/// form last chosen on a page (見たまま / Markdown), both this device's only. The bundled editor is a prototype: off by
/// default, the Markdown editor stays the default.
enum MobileEditorSettings {
    static let enabledKey = "chikuwa.docs.wysiwyg"
    static let modeKey = "chikuwa.docs.editorMode"

    static var isEnabled: Bool {
        UserDefaults.standard.bool(forKey: enabledKey) && MobileEditorBundle.isAvailable
    }
}

/// The page's editing form while the switch is on (the page screen's 「見たまま / Markdown」).
enum MobileEditorMode: String, CaseIterable, Identifiable {
    case wysiwyg, markdown
    var id: String { rawValue }

    var label: String {
        switch self {
        case .wysiwyg: tr("見たまま")
        case .markdown: "Markdown"
        }
    }
}

/// What the editor gets from the app: the people, the emoji, the pages and the pictures (with the session; the editor
/// itself never has the token).
extension AppController: MobileEditorHost, EditorAssetSource {
    /// People (not deactivated) and AI bots, then the groups (Mentions.offered: the same list as the Markdown editor's `@`).
    func editorPeople() -> [BridgePerson] {
        let bots = aiHub?.knownBotUserIds
        let people = store.users.values
            .filter { Mentions.offered($0, aiBotIds: bots) }
            .sorted { $0.username < $1.username }
            .map { BridgePerson(id: $0.id, username: $0.username, displayName: $0.displayName, ai: $0.role == "bot" ? true : nil) }
        let groups = store.groups.values
            .sorted { $0.name < $1.name }
            .map { BridgePerson(id: $0.id, username: $0.name, displayName: $0.name, kind: "group", members: $0.memberIds.count, description: $0.description) }
        return people + groups
    }

    func editorEmoji() -> [BridgeEmoji] {
        store.customEmoji.values.sorted { $0.name < $1.name }.map { emoji in
            BridgeEmoji(name: emoji.name, url: emoji.isText ? nil : EditorBridge.emojiURL(emoji.name), label: emoji.label,
                        kind: emoji.isText ? "text" : "image", color: emoji.color, width: emoji.width, height: emoji.height)
        }
    }

    /// From the tree held on the device (no request): by title for a query, the latest pages for none. Rows and
    /// templates are left out, as the tree lists them.
    func editorPages(query: String) -> [BridgePage] {
        guard let tree = wiki?.tree else { return [] }
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let found: [WikiPageItem]
        if trimmed.isEmpty {
            found = tree.pages.values.filter(WikiTree.listed).sorted { $0.updatedAt > $1.updatedAt }
        } else {
            found = WikiText.filtered(tree, query: trimmed).filter(WikiTree.listed)
        }
        return found.prefix(20).map { BridgePage(id: $0.id, title: $0.displayTitle, icon: $0.icon, kind: $0.kind) }
    }

    var editorLocale: String { UILanguage.shared.effective.rawValue }

    func attachmentData(_ id: String) async throws -> Data {
        guard let api else { throw ApiError.network(URLError(.cancelled)) }
        return try await api.fetchData("/api/v1/attachments/\(id)/content")
    }

    func emojiData(_ name: String) async throws -> Data {
        guard let api, let emoji = store.customEmoji[name] else { throw ApiError.network(URLError(.cancelled)) }
        return try await api.fetchData("/api/v1/emoji/\(emoji.id)/image")
    }
}

/// M153a: the measurements of the prototype (WIKI.md §30.4). With the launch environment TAYLIS_EDITOR_TRACE=1 the
/// session appends one line per event (ms since the WebView was made) to <tmp>/editor-trace.log, and `load` is timed
/// inside the page to the frame after the editor is up; the UI harness reads the file.
enum MobileEditorTrace {
    static let enabled = ProcessInfo.processInfo.environment["TAYLIS_EDITOR_TRACE"] == "1"
    static let url = FileManager.default.temporaryDirectory.appendingPathComponent("editor-trace.log")
    nonisolated(unsafe) private static var started = Date()

    static func reset() { started = Date() }

    static func log(_ line: String) {
        guard enabled else { return }
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        let text = "t=\(ms) \(line)\n"
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(text.utf8))
            try? handle.close()
        } else {
            try? text.write(to: url, atomically: true, encoding: .utf8)
        }
    }

    /// `load` as the trace sends it: the message through `receive`, then the time to the second frame after it (the
    /// editor is mounted synchronously inside `receive`; the next frames paint it), and a hook timing every transaction
    /// to its next frame (`window.__taylisFrames`, the typing latency).
    static func timedLoadScript(_ message: EditorNativeMessage) throws -> String {
        let literal = EditorBridge.jsStringLiteral(try EditorBridge.json(message))
        return """
        const t0 = performance.now();
        window.taylisEditor.receive(\(literal));
        return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
          const painted = performance.now() - t0;
          window.__taylisFrames = [];
          const dom = document.querySelector(".page-editor");
          if (dom && dom.editor) dom.editor.on("transaction", () => {
            const s = performance.now();
            requestAnimationFrame(() => window.__taylisFrames.push(Math.round((performance.now() - s) * 10) / 10));
          });
          resolve(painted);
        })));
        """
    }
}
