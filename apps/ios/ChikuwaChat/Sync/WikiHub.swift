import Foundation
import Observation

/// M122: the wiki calls the hub makes (ApiClient and the test fakes).
@MainActor
protocol WikiApi: AnyObject {
    /// nil: `etag` is still the answer (304).
    func wikiTree(etag: String?) async throws -> WikiTreeFetch?
    func wikiChanges(since: Int) async throws -> WikiChangesOut
    /// nil: `etag` (`"v<version>-<level>"`) is still current (304).
    func getPage(id: String, etag: String?) async throws -> WikiPageOut?
    func savePage(id: String, _ save: CanvasSaveIn) async throws -> WikiSaveOut
    func createPage(_ create: WikiPageCreate) async throws -> WikiPageOut
    func updatePage(id: String, title: String?, icon: String?) async throws -> WikiPageOut
    func pageBacklinks(id: String) async throws -> [WikiPageItem]
    func resolvePages(ids: [String]) async throws -> [WikiPageRef]
    /// M146: GET /wiki/templates, POST …/apply-template, POST …/duplicate.
    func wikiTemplates() async throws -> WikiTemplatesOut
    func applyTemplate(pageId: String, _ apply: WikiTemplateApply) async throws -> WikiPageOut
    func duplicatePage(id: String, _ duplicate: WikiDuplicate) async throws -> WikiDuplicateOut
}

/// GET /wiki/tree's answer with its ETag (the next read sends it as If-None-Match).
struct WikiTreeFetch: Equatable {
    let tree: WikiTreeOut
    let etag: String?
}

/// The pages I can read (docs/WIKI.md §3, §10; SYNC_PROTOCOL.md §17), as the change feed keeps them: by id, with the
/// feed's cursor. Pure: the hub applies the server's answers to it, the screens ask it for children and roots.
struct WikiTree: Codable, Equatable {
    private(set) var pages: [String: WikiPageItem] = [:]
    /// The next `since` of GET /wiki/changes.
    private(set) var cursor: Int
    /// The ETag of the GET /wiki/tree this came from; nil once the feed changed it.
    private(set) var etag: String?

    init(pages: [WikiPageItem], cursor: Int, etag: String? = nil) {
        for page in pages where Self.listed(page) { self.pages[page.id] = page }
        self.cursor = cursor
        self.etag = etag
    }

    init(_ fetch: WikiTreeFetch) {
        self.init(pages: fetch.tree.pages, cursor: fetch.tree.cursor, etag: fetch.etag)
    }

    /// Siblings in the server's order (§14.2): `position` compared byte by byte, then the id.
    static func precedes(_ a: WikiPageItem, _ b: WikiPageItem) -> Bool {
        if a.position != b.position { return Array(a.position.utf8).lexicographicallyPrecedes(Array(b.position.utf8)) }
        return Array(a.id.utf8).lexicographicallyPrecedes(Array(b.id.utf8))
    }

    func page(_ id: String) -> WikiPageItem? { pages[id] }

    /// The tree holds pages and databases: not database rows, not templates (M146, §22.3).
    static func listed(_ page: WikiPageItem) -> Bool { page.kind != "row" && !page.isTemplate }

    var isEmpty: Bool { pages.isEmpty }

    /// Top level for me: no parent, or a parent I cannot read (the server sends that as null; one that left the tree
    /// meanwhile counts the same).
    func isTopLevel(_ page: WikiPageItem) -> Bool { page.parentId.map { pages[$0] == nil } ?? true }

    func children(of id: String) -> [WikiPageItem] {
        pages.values.filter { $0.parentId == id }.sorted(by: Self.precedes)
    }

    func hasChildren(_ id: String) -> Bool { pages.values.contains { $0.parentId == id } }

    /// The sidebar's two headings (§3.1): 「共有」 the top-level pages others can read too, 「プライベート」 the ones only I can.
    func roots(private wanted: Bool) -> [WikiPageItem] {
        pages.values.filter { isTopLevel($0) && $0.isPrivate == wanted }.sorted(by: Self.precedes)
    }

    /// The readable ancestors of a page, root first (a parent I cannot read ends the chain).
    func ancestors(of id: String) -> [WikiPageItem] {
        var chain: [WikiPageItem] = []
        var seen: Set<String> = [id]
        var next = pages[id]?.parentId
        while let parentId = next, let parent = pages[parentId], seen.insert(parentId).inserted {
            chain.insert(parent, at: 0)
            next = parent.parentId
        }
        return chain
    }

    /// GET /wiki/changes applied: changed pages replace (or join), removed ids go (unknown ones are ignored), the cursor
    /// moves on. false: `reset` — the tree must be read again whole.
    mutating func apply(_ changes: WikiChangesOut) -> Bool {
        guard !changes.reset else { return false }
        for page in changes.pages {
            // M146: a page that became a template leaves the tree (the server also lists it in `removed`).
            guard Self.listed(page) else {
                pages[page.id] = nil
                continue
            }
            pages[page.id] = page
        }
        for id in changes.removed { pages[id] = nil }
        cursor = max(cursor, changes.cursor)
        if !changes.pages.isEmpty || !changes.removed.isEmpty { etag = nil }
        return true
    }

    /// A page as a read or a create answered (it is mine to show: my level, my parent).
    mutating func upsert(_ page: WikiPageItem) {
        guard Self.listed(page) else {
            // M146: a template opened (or one a page became) is not in the tree.
            if pages.removeValue(forKey: page.id) != nil { etag = nil }
            return
        }
        if let known = pages[page.id], known.version > page.version { return }
        pages[page.id] = page
        etag = nil
    }

    /// wiki.page.updated's metadata (a title, an icon, a new body): the place, level and privacy stay as the feed said.
    mutating func applyMeta(_ meta: WikiPageItem) {
        guard let known = pages[meta.id] else { return }
        let next = known.updated(with: meta)
        if next != known {
            pages[meta.id] = next
            etag = nil
        }
    }

    mutating func remove(_ id: String) {
        if pages.removeValue(forKey: id) != nil { etag = nil }
    }
}

/// What a page lets me do on the phone (§4.1, §7.4, §13 Q11): view reads only — no edit controls, no ticks (unlike a
/// canvas, viewers may not tick); edit and full change the body, tick, rename, set the icon and make child pages.
/// Sharing, moving and the trash are the desktop's.
struct WikiRights: Equatable {
    let edit: Bool

    var tick: Bool { edit }
    var rename: Bool { edit }
    var createChild: Bool { edit }

    static func of(_ level: WikiLevel?) -> WikiRights { WikiRights(edit: (level ?? .view) >= .edit) }

    /// A top-level page (the ＋ of 共有 / プライベート): anyone but a guest (§4.4).
    static func createsTopLevel(isGuest: Bool) -> Bool { !isGuest }
}

/// `page:<uuid>` links (§3.3) and the permalinks `<server>/p/<uuid>` (§9.3).
enum PageLink {
    static let scheme = "chikuwa-page"
    private static let uuid = try! NSRegularExpression(pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", options: [.caseInsensitive])
    private static let inBody = try! NSRegularExpression(pattern: #"\]\(page:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)"#)

    private static func isUuid(_ id: String) -> Bool {
        uuid.firstMatch(in: id, range: NSRange(location: 0, length: (id as NSString).length)) != nil
    }

    /// The page a link names: `page:<uuid>`, or a permalink on `base` (case-insensitive prefix, query / fragment ignored).
    static func pageId(base: URL?, url: String) -> String? {
        if url.lowercased().hasPrefix("page:") {
            let id = String(url.dropFirst(5))
            return isUuid(id) ? id.lowercased() : nil
        }
        guard let base else { return nil }
        var prefix = base.absoluteString
        while prefix.hasSuffix("/") { prefix.removeLast() }
        prefix += "/p/"
        guard url.count >= prefix.count, url.prefix(prefix.count).lowercased() == prefix.lowercased() else { return nil }
        var id = String(url.dropFirst(prefix.count))
        for stop in ["/", "?", "#"] { if let range = id.range(of: stop) { id = String(id[..<range.lowerBound]) } }
        return isUuid(id) ? id.lowercased() : nil
    }

    static func url(base: URL, pageId: String) -> String {
        var text = base.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text + "/p/" + pageId
    }

    /// The in-app link put into a body's attributed text; the screen's `openURL` handler opens the page.
    static func internalLink(pageId: String) -> URL? { URL(string: "\(scheme)://\(pageId)") }

    /// The distinct pages a body links to (`[…](page:<uuid>)`), in order.
    static func ids(in body: String) -> [String] {
        let ns = body as NSString
        var seen: Set<String> = []
        var out: [String] = []
        for match in inBody.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            let id = ns.substring(with: match.range(at: 1)).lowercased()
            if seen.insert(id).inserted { out.append(id) }
        }
        return out
    }
}

/// `[name](attachment:<uuid>)`: a page's file (not an image), shown as a chip that opens it (§2.3).
enum FileLink {
    static let scheme = "chikuwa-file"

    static func attachmentId(_ url: String) -> String? {
        guard url.lowercased().hasPrefix("attachment:") else { return nil }
        let id = String(url.dropFirst("attachment:".count))
        return id.count == 36 ? id.lowercased() : nil
    }

    static func internalLink(attachmentId: String) -> URL? { URL(string: "\(scheme)://\(attachmentId)") }
}

/// A page kept on this device to read offline (§10: the 20 read most recently), as the server last sent it.
struct WikiKeptPage: Codable, Equatable {
    var page: WikiPageOut
    var savedAt: Date
}

/// M122 (docs/WIKI.md §10, SYNC_PROTOCOL.md §17): the wiki on this device. The tree comes whole from GET /wiki/tree
/// (with its ETag) and then from the change feed (`wiki.changed` → GET /wiki/changes after 300 ms, `reset` → the tree
/// again); it is kept in SQLite to read offline with the pages read lately. Each page on screen (or with edits not saved
/// yet) has the canvas's save loop (CanvasSaver), talking to the wiki's endpoints through `WikiSaverApi`.
@MainActor
@Observable
final class WikiHub {
    /// At most this many pages are kept to read offline.
    static let keptPageLimit = 20
    static let treeKey = "wiki:tree"
    static let pagePrefix = "wiki:page:"
    static let pendingPrefix = "wiki:pending:"

    /// The server has the wiki (bootstrap's `wiki`); a kept tree says so before the first bootstrap.
    private(set) var available = false
    private(set) var tree: WikiTree?
    /// Why the tree could not be read (shown while there is none).
    private(set) var treeFailure: String?
    /// The tree on screen is the kept one and the server could not be reached.
    private(set) var offline = false
    private(set) var loadingTree = false
    /// The last read of each page opened (breadcrumbs, child pages, my level).
    private(set) var pages: [String: WikiPageOut] = [:]
    /// Titles of linked pages not in the tree (POST /wiki/pages/resolve), and the ones I cannot read.
    private(set) var refs: [String: WikiPageRef] = [:]
    private(set) var unreadable: Set<String> = []
    /// The tree list's open rows (kept while the app runs).
    var expanded: Set<String> = []
    /// M124: bumped by `wiki.rows.changed` per database (an open database page reads again), with the schema version
    /// the event named.
    private(set) var rowsSignal: [String: Int] = [:]
    private(set) var rowsSchema: [String: Int] = [:]
    /// M124: bumped by `wiki.page.updated` with change "props" per row (an open row page reads its cells again).
    private(set) var propsSignal: [String: Int] = [:]
    /// M124: bumped on every reconnect (open databases and rows read again: events may have been missed).
    private(set) var reconnects = 0

    @ObservationIgnored private let api: WikiApi?
    @ObservationIgnored private let store: Store
    @ObservationIgnored private let clock: CanvasClock
    @ObservationIgnored private let options: CanvasSaverOptions
    @ObservationIgnored private let feedDelay: TimeInterval
    @ObservationIgnored private var savers: [String: CanvasSaver] = [:]
    @ObservationIgnored private var holds: [String: Int] = [:]
    @ObservationIgnored private var feedTask: Task<Void, Never>?
    @ObservationIgnored private var fetching = false
    @ObservationIgnored private var fetchAgain = false
    @ObservationIgnored private var resolving: Set<String> = []
    @ObservationIgnored private var kept: [String: WikiKeptPage] = [:]
    @ObservationIgnored private var stopped = false

    init(api: WikiApi?, store: Store, clock: CanvasClock? = nil, options: CanvasSaverOptions = .init(), feedDelay: TimeInterval = 0.3) {
        self.api = api
        self.store = store
        self.clock = clock ?? SystemCanvasClock()
        self.options = options
        self.feedDelay = feedDelay
        if let raw = store.wikiValue(Self.treeKey), let kept = try? JSON.plainDecoder.decode(WikiTree.self, from: Data(raw.utf8)) {
            tree = kept
            available = api != nil
        }
        for key in store.wikiKeys(prefix: Self.pagePrefix) {
            guard let raw = store.wikiValue(key), let page = try? JSON.plainDecoder.decode(WikiKeptPage.self, from: Data(raw.utf8)) else { continue }
            kept[String(key.dropFirst(Self.pagePrefix.count))] = page
        }
    }

    // MARK: the tree

    /// After every bootstrap: a server without the wiki says nothing (nothing is read); else the tree is read the first
    /// time and the feed after that.
    func bootstrap(_ wiki: WikiBootstrap?) async {
        guard api != nil, !stopped else { return }
        guard wiki != nil else {
            available = false
            return
        }
        available = true
        if tree == nil {
            await loadTree()
        } else {
            await fetchChanges()
        }
    }

    /// GET /wiki/tree (If-None-Match: the kept one's ETag). Also after group.updated and a change of my role (§10).
    func loadTree() async {
        guard let api, !stopped else { return }
        loadingTree = true
        defer { loadingTree = false }
        do {
            if let fetch = try await api.wikiTree(etag: tree?.etag) {
                setTree(WikiTree(fetch))
            }
            treeFailure = nil
            offline = false
        } catch {
            if tree != nil, CanvasSaver.retryable(error) {
                offline = true
            } else {
                treeFailure = ErrorMessages.text(for: error)
            }
        }
    }

    /// Pull to refresh: the feed (or the tree when there is none).
    func refresh() async {
        if tree == nil { await loadTree() } else { await fetchChanges() }
    }

    /// GET /wiki/changes since the cursor; `reset` reads the tree again. One at a time (a change meanwhile reads again).
    func fetchChanges() async {
        guard let api, !stopped else { return }
        guard let current = tree else {
            await loadTree()
            return
        }
        if fetching {
            fetchAgain = true
            return
        }
        fetching = true
        defer { fetching = false }
        do {
            let changes = try await api.wikiChanges(since: current.cursor)
            guard var next = tree else { return }
            if next.apply(changes) {
                setTree(next)
                for id in changes.removed { forget(id) }
                offline = false
            } else {
                tree = nil
                await loadTree()
            }
        } catch {
            if CanvasSaver.retryable(error) { offline = true }
        }
        if fetchAgain {
            fetchAgain = false
            fetching = false
            await fetchChanges()
        }
    }

    /// wiki.changed: the feed moved; read it once after a short pause (several changes fold into one read).
    func changed(seq: Int?) {
        guard api != nil, available || tree != nil, feedTask == nil else { return }
        if let seq, let cursor = tree?.cursor, seq <= cursor { return }
        feedTask = Task { [weak self] in
            guard let delay = self?.feedDelay else { return }
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            guard let self, !Task.isCancelled else { return }
            self.feedTask = nil
            await self.fetchChanges()
        }
    }

    /// Resolves once the feed read a wiki.changed scheduled has finished (tests).
    func settled() async {
        await feedTask?.value
    }

    private func setTree(_ next: WikiTree) {
        tree = next
        let encoded = (try? JSON.plainEncoder.encode(next)).flatMap { String(data: $0, encoding: .utf8) }
        store.setWikiValue(Self.treeKey, encoded)
    }

    /// A page I can no longer read (removed by the feed, a 404): its kept copy and last read go; an open one stops saving.
    private func forget(_ id: String) {
        pages[id] = nil
        dropKeptPage(id)
        savers[id]?.gone()
        setPending(id, nil)
    }

    // MARK: events (§14.3)

    func applyEvent(_ event: String, _ data: JSONValue) {
        switch event {
        case "wiki.changed":
            changed(seq: data["seq"].flatMap { if case .number(let n) = $0 { Int(n) } else { nil } })
        case "wiki.page.updated":
            struct Payload: Decodable { let page: WikiPageItem; let change: String? }
            guard let payload = try? data.decode(Payload.self) else { return }
            if payload.change == "props" { propsSignal[payload.page.id, default: 0] += 1 }
            pageUpdated(payload.page)
        case "wiki.rows.changed":
            struct Payload: Decodable { let databaseId: String; let schemaVersion: Int? }
            guard let payload = try? data.decode(Payload.self) else { return }
            rowsChanged(databaseId: payload.databaseId, schemaVersion: payload.schemaVersion)
        default:
            break
        }
    }

    /// M124: wiki.rows.changed — the open database pages of `databaseId` read again (debounced there).
    func rowsChanged(databaseId: String, schemaVersion: Int?) {
        let id = databaseId.lowercased()
        if let schemaVersion { rowsSchema[id] = max(rowsSchema[id] ?? 0, schemaVersion) }
        rowsSignal[id, default: 0] += 1
    }

    /// wiki.page.updated: the tree's row takes the new title / icon; an open page reads again (one being edited merges
    /// with its next save, as a canvas).
    func pageUpdated(_ meta: WikiPageItem) {
        if var next = tree {
            next.applyMeta(meta)
            if next != tree { setTree(next) }
        }
        if refs[meta.id] != nil { refs[meta.id] = WikiPageRef(id: meta.id, title: meta.title, icon: meta.icon, kind: meta.kind) }
        if let saver = savers[meta.id] {
            saver.applyMeta(WikiPageContent(item: meta, body: "").canvas.meta)
            saver.remoteVersion(meta.version)
        }
    }

    // MARK: pages and their save loops

    /// My level on a page as last read (the page itself, else the tree).
    func level(of id: String) -> WikiLevel? { pages[id]?.item.myLevel ?? tree?.page(id)?.myLevel ?? kept[id]?.page.item.myLevel }

    /// The page's metadata as shown: the newer of the tree's row and the last read.
    func item(_ id: String) -> WikiPageItem? {
        let read = pages[id]?.item ?? kept[id]?.page.item
        guard let listed = tree?.page(id) else { return read }
        guard let read else { return listed }
        return listed.version > read.version ? listed : read
    }

    func keptPage(_ id: String) -> WikiKeptPage? { kept[id] }

    /// A screen shows the page; `release` lets go (saving what is typed).
    func hold(_ id: String) -> CanvasSaver? {
        let saver = saver(id)
        holds[id, default: 0] += 1
        return saver
    }

    func release(_ id: String) {
        let left = (holds[id] ?? 1) - 1
        holds[id] = left > 0 ? left : nil
        guard let saver = savers[id] else { return }
        Task {
            await saver.flush()
            self.dropIfIdle(id)
        }
    }

    func current(_ id: String) -> CanvasSaver? { savers[id] }
    func isShown(_ id: String) -> Bool { holds[id] != nil }

    private func saver(_ id: String) -> CanvasSaver? {
        guard let api, !stopped else { return nil }
        if let existing = savers[id] { return existing }
        let cached = kept[id].map { CachedCanvas(canvas: $0.page.content.canvas, savedAt: $0.savedAt) }
        let saver = CanvasSaver(id: id, channelId: WikiPageContent.channel, api: WikiSaverApi(api: api, hub: self), clock: clock,
                                options: options, restored: pending(id), cached: cached)
        saver.persist = { [weak self] state in self?.setPending(id, state) }
        saver.confirmed = { [weak self] in self?.touchKeptPage(id) }
        saver.vanished = { [weak self] in self?.vanished(id) }
        savers[id] = saver
        saver.load()
        return saver
    }

    private func dropIfIdle(_ id: String) {
        guard let saver = savers[id], holds[id] == nil, !saver.unsaved else { return }
        saver.dispose()
        savers[id] = nil
    }

    /// The server answered a page whole (a read): kept for the screen and offline, and the tree takes its row.
    func received(_ page: WikiPageOut) {
        pages[page.id] = page
        unreadable.remove(page.id)
        if var next = tree {
            next.upsert(page.item)
            if next != tree { setTree(next) }
        }
        keepPage(page)
    }

    /// A save's answer (or a conflict's head): the body and metadata over the last read.
    func receivedContent(_ content: WikiPageContent) {
        let id = content.item.id
        if let page = pages[id] ?? kept[id]?.page {
            let next = page.with(content: content)
            pages[id] = next
            keepPage(next)
        }
        if var next = tree {
            next.applyMeta(content.item)
            if next != tree { setTree(next) }
        }
    }

    /// The page answered 404: I cannot read it (or it is in the trash).
    private func vanished(_ id: String) {
        unreadable.insert(id)
        pages[id] = nil
        dropKeptPage(id)
        setPending(id, nil)
        if var next = tree {
            next.remove(id)
            if next != tree { setTree(next) }
        }
    }

    // MARK: making and renaming

    /// A new page: under `parentId` (its access), or at the top level with `access` (workspace / private, §4.2).
    /// `clientSaveId` is the screen's, kept across retries (the server answers a retry with the first page).
    /// M146: `template` starts it from a built-in or a page template.
    func create(parentId: String?, title: String?, icon: String?, access: String, clientSaveId: String,
                template: WikiTemplateChoice? = nil) async throws -> WikiPageOut {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        let page = try await api.createPage(WikiPageCreate(parentId: parentId, title: title, icon: icon, access: access, clientSaveId: clientSaveId,
                                                           template: template))
        received(page)
        if let parentId { expanded.insert(parentId) }
        return page
    }

    // MARK: templates and duplicates (M146, §24.3)

    /// The templates the create sheet offers (read each time it opens: they are not in the tree).
    func templates() async throws -> WikiTemplatesOut {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        return try await api.wikiTemplates()
    }

    /// 「テンプレートから始める」 on an empty page: the server writes the body (and the title / icon when the page has
    /// none); the open page's save loop reads it.
    func applyTemplate(_ id: String, template: WikiTemplateChoice, clientSaveId: String) async throws {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        let page = try await api.applyTemplate(pageId: id, WikiTemplateApply(template: template, clientSaveId: clientSaveId))
        received(page)
        // The save loop reads the new body itself (its known version is the old one, so the read is not a 304).
        await savers[id]?.refresh()
    }

    /// What a duplicate came to.
    enum DuplicateResult: Equatable {
        case made(WikiPageOut)
        /// 403 page_edit_restricted on the original's parent: the copy may go to the top level instead (a page only).
        case parentRestricted
    }

    /// 「複製」: beside the original (the server names it 「…（コピー）」), or at the top level. One `clientSaveId` per
    /// duplicate, kept across retries and the move to the top level (the server answers a retry with the first copy).
    func duplicate(_ id: String, clientSaveId: String, topLevel: Bool = false) async throws -> DuplicateResult {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        do {
            let out = try await api.duplicatePage(id: id, WikiDuplicate(clientSaveId: clientSaveId, topLevel: topLevel))
            received(out.page)
            if let parentId = out.page.item.parentId, out.page.item.kind != "row" { expanded.insert(parentId) }
            if out.page.item.kind == "row", let databaseId = out.row?.row.databaseId {
                rowsChanged(databaseId: databaseId, schemaVersion: nil)
            }
            return .made(out.page)
        } catch ApiError.api(let status, let code, _) where status == 403 && code == "page_edit_restricted" && !topLevel
                    && item(id)?.kind != "row" {
            return .parentRestricted
        }
    }

    /// The title and / or the icon (`icon: ""` removes it).
    func rename(_ id: String, title: String?, icon: String?) async throws {
        guard let api else { return }
        let page = try await api.updatePage(id: id, title: title, icon: icon)
        received(page)
        savers[id]?.applyMeta(page.content.canvas.meta)
    }

    func backlinks(_ id: String) async throws -> [WikiPageItem] {
        guard let api else { return [] }
        return try await api.pageBacklinks(id: id)
    }

    // MARK: links (§3.3)

    /// What a `page:` link shows: the page's icon and title when I can read it, nil while not known yet.
    enum LinkState: Equatable {
        case page(title: String, icon: String?)
        case unreadable
    }

    func linkState(_ id: String) -> LinkState? {
        if let page = item(id) { return .page(title: page.displayTitle, icon: page.icon) }
        if let ref = refs[id] { return .page(title: ref.title.isEmpty ? tr("無題") : ref.title, icon: ref.icon) }
        if unreadable.contains(id) { return .unreadable }
        return nil
    }

    /// The links of a body that are not known yet are asked for (200 at a time); the ones not answered I cannot read.
    func resolveLinks(in body: String) async {
        await resolve(PageLink.ids(in: body))
    }

    func resolve(_ ids: [String]) async {
        guard let api else { return }
        let unknown = ids.filter { item($0) == nil && refs[$0] == nil && !unreadable.contains($0) && !resolving.contains($0) }
        guard !unknown.isEmpty else { return }
        resolving.formUnion(unknown)
        defer { resolving.subtract(unknown) }
        var start = 0
        while start < unknown.count {
            let chunk = Array(unknown[start..<min(start + 200, unknown.count)])
            start += 200
            do {
                let answered = try await api.resolvePages(ids: chunk)
                for ref in answered { refs[ref.id.lowercased()] = ref }
                let found = Set(answered.map { $0.id.lowercased() })
                for id in chunk where !found.contains(id) { unreadable.insert(id) }
            } catch {
                return // the network: asked again the next time the page shows
            }
        }
    }

    // MARK: kept pages (offline reading, §10: the 20 read most recently)

    private func keepPage(_ page: WikiPageOut, now: Date = Date()) {
        if let known = kept[page.id], known.page.item.version > page.item.version { return }
        let entry = WikiKeptPage(page: page, savedAt: now)
        kept[page.id] = entry
        store.setWikiValue(Self.pagePrefix + page.id, (try? JSON.plainEncoder.encode(entry)).flatMap { String(data: $0, encoding: .utf8) })
        guard kept.count > Self.keptPageLimit else { return }
        let oldest = kept.values.sorted { a, b in a.savedAt != b.savedAt ? a.savedAt < b.savedAt : a.page.id < b.page.id }
        for entry in oldest.prefix(kept.count - Self.keptPageLimit) { dropKeptPage(entry.page.id) }
    }

    private func touchKeptPage(_ id: String, now: Date = Date()) {
        guard var entry = kept[id] else { return }
        entry.savedAt = now
        kept[id] = entry
        store.setWikiValue(Self.pagePrefix + id, (try? JSON.plainEncoder.encode(entry)).flatMap { String(data: $0, encoding: .utf8) })
    }

    private func dropKeptPage(_ id: String) {
        guard kept.removeValue(forKey: id) != nil else { return }
        store.setWikiValue(Self.pagePrefix + id, nil)
    }

    // MARK: unsaved edits (`wiki:pending:<id>`, sent again with the same key after a restart)

    func pending(_ id: String) -> CanvasPendingState? {
        guard let raw = store.wikiValue(Self.pendingPrefix + id) else { return nil }
        return try? JSON.plainDecoder.decode(CanvasPendingState.self, from: Data(raw.utf8))
    }

    private func setPending(_ id: String, _ state: CanvasPendingState?) {
        store.setWikiValue(Self.pendingPrefix + id, state.flatMap { try? JSON.plainEncoder.encode($0) }.flatMap { String(data: $0, encoding: .utf8) })
    }

    // MARK: connection

    /// After (re)connecting: failed saves go out, open pages are read again, edits kept from before a relaunch resume.
    func online() {
        guard api != nil, !stopped else { return }
        reconnects += 1
        for saver in savers.values { saver.online() }
        for key in store.wikiKeys(prefix: Self.pendingPrefix) {
            let id = String(key.dropFirst(Self.pendingPrefix.count))
            guard savers[id] == nil, let saver = saver(id) else { continue }
            Task {
                await saver.settled()
                self.dropIfIdle(id)
            }
        }
    }

    /// Save everything typed now (the app goes to the background, sign-out).
    func flushAll() async {
        for saver in Array(savers.values) { await saver.flush() }
    }

    func stop() {
        stopped = true
        feedTask?.cancel()
        feedTask = nil
        for saver in savers.values { saver.dispose() }
        savers = [:]
        holds = [:]
    }
}

/// The canvas's save loop on a page: reads and saves go to the wiki's endpoints, and the page travels as a CanvasOut
/// (WikiPageContent.canvas). What the server sends whole is handed to the hub (breadcrumbs, children, the kept copy).
@MainActor
final class WikiSaverApi: CanvasApi {
    private let api: WikiApi
    private weak var hub: WikiHub?

    init(api: WikiApi, hub: WikiHub) {
        self.api = api
        self.hub = hub
    }

    func listCanvases(channelId: String, trashed: Bool) async throws -> [CanvasMeta] { [] }

    /// The page's ETag is its version and my level (`"v3-edit"`): a changed level reads the page again.
    static func etag(version: Int?, level: WikiLevel?) -> String? {
        guard let version, let level else { return nil }
        return "\"v\(version)-\(level.rawValue)\""
    }

    func getCanvas(id: String, knownVersion: Int?) async throws -> CanvasOut? {
        let etag = Self.etag(version: knownVersion, level: hub?.level(of: id))
        guard let page = try await api.getPage(id: id, etag: etag) else { return nil }
        hub?.received(page)
        return page.content.canvas
    }

    func saveCanvas(id: String, _ save: CanvasSaveIn) async throws -> CanvasSaveOut {
        let out = try await api.savePage(id: id, save)
        hub?.receivedContent(out.page)
        return CanvasSaveOut(canvas: out.page.canvas, submittedRevId: out.submittedRevId, merged: out.merged)
    }
}
