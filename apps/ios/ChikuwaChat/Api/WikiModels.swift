import Foundation

/// M122 (docs/WIKI.md §9.2 / §14): 「ドキュメント」 — the workspace's tree of pages (the server's `wiki`, M120). A page's
/// body is the canvas dialect, saved like a canvas's (§7.1), so the canvas's save loop, renderer and editor are reused:
/// a page goes through them as a `CanvasOut` (`WikiPageContent.canvas`).

/// What I may do with a page (§4.1): view reads (not even a tick), edit changes the body, title, icon and makes child
/// pages, full also shares, moves and trashes (the desktop's; the phone only shows sharing).
enum WikiLevel: String, Codable, Equatable, Comparable {
    case view, edit, full

    private var rank: Int {
        switch self {
        case .view: 1
        case .edit: 2
        case .full: 3
        }
    }

    static func < (a: WikiLevel, b: WikiLevel) -> Bool { a.rank < b.rank }

    /// An unknown level (a newer server's) reads as view: nothing is offered that the server might refuse.
    init(raw: String?) { self = raw.flatMap(WikiLevel.init(rawValue:)) ?? .view }
}

/// A page without its body, as I see it (`PageItem`: the tree, the change feed, search, child pages, backlinks). The
/// `wiki.page.updated` event carries the same without `my_level` / `private` (`PageMeta`): they decode as view / false
/// and the tree keeps its own.
struct WikiPageItem: Codable, Identifiable, Equatable {
    let id: String
    /// nil: top level, or (for me) a page whose parent I cannot read (it shows at the top level, §4.6).
    var parentId: String?
    /// The order among siblings: compared byte by byte, ties by id (WikiTree.precedes).
    var position: String
    /// page | database | row (database and row come with M123/M124).
    var kind: String
    var title: String
    /// One emoji or a `:custom:` name.
    var icon: String?
    var version: Int
    var headRevId: String
    var metaSeq: Int
    var inheritAccess: Bool
    var taskTotal: Int
    var taskDone: Int
    let createdBy: String
    var updatedBy: String
    let createdAt: String
    var updatedAt: String
    var deletedAt: String?
    var myLevel: WikiLevel
    /// Only I can see it: top level for me, it is listed under 「プライベート」 (§3.1).
    var isPrivate: Bool
    /// M146 (§22.3 / §24.3): a page template (top level, never in the tree) or a database's row template.
    var isTemplate: Bool

    enum CodingKeys: String, CodingKey {
        case id, parentId, position, kind, title, icon, version, headRevId, metaSeq, inheritAccess, taskTotal, taskDone, createdBy, updatedBy
        case createdAt, updatedAt, deletedAt, myLevel, isTemplate
        case isPrivate = "private"
    }

    init(id: String, parentId: String? = nil, position: String = "a0", kind: String = "page", title: String, icon: String? = nil,
         version: Int = 1, headRevId: String = "", metaSeq: Int = 1, inheritAccess: Bool = true, taskTotal: Int = 0, taskDone: Int = 0,
         createdBy: String = "", updatedBy: String = "", createdAt: String = "", updatedAt: String = "", deletedAt: String? = nil,
         myLevel: WikiLevel = .edit, isPrivate: Bool = false, isTemplate: Bool = false) {
        self.id = id
        self.parentId = parentId
        self.position = position
        self.kind = kind
        self.title = title
        self.icon = icon
        self.version = version
        self.headRevId = headRevId
        self.metaSeq = metaSeq
        self.inheritAccess = inheritAccess
        self.taskTotal = taskTotal
        self.taskDone = taskDone
        self.createdBy = createdBy
        self.updatedBy = updatedBy
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.deletedAt = deletedAt
        self.myLevel = myLevel
        self.isPrivate = isPrivate
        self.isTemplate = isTemplate
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        parentId = try c.decodeIfPresent(String.self, forKey: .parentId)
        position = try c.decodeIfPresent(String.self, forKey: .position) ?? ""
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "page"
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        icon = try c.decodeIfPresent(String.self, forKey: .icon)
        version = try c.decode(Int.self, forKey: .version)
        headRevId = try c.decode(String.self, forKey: .headRevId)
        metaSeq = try c.decodeIfPresent(Int.self, forKey: .metaSeq) ?? 0
        inheritAccess = try c.decodeIfPresent(Bool.self, forKey: .inheritAccess) ?? true
        taskTotal = try c.decodeIfPresent(Int.self, forKey: .taskTotal) ?? 0
        taskDone = try c.decodeIfPresent(Int.self, forKey: .taskDone) ?? 0
        createdBy = try c.decodeIfPresent(String.self, forKey: .createdBy) ?? ""
        updatedBy = try c.decodeIfPresent(String.self, forKey: .updatedBy) ?? ""
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
        deletedAt = try c.decodeIfPresent(String.self, forKey: .deletedAt)
        myLevel = WikiLevel(raw: try c.decodeIfPresent(String.self, forKey: .myLevel))
        isPrivate = try c.decodeIfPresent(Bool.self, forKey: .isPrivate) ?? false
        isTemplate = try c.decodeIfPresent(Bool.self, forKey: .isTemplate) ?? false
    }

    /// The title as lists show it (an untitled page: 「無題」, as the server names a new one).
    var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? tr("無題") : trimmed
    }

    /// The newer metadata of an event (wiki.page.updated has no level, privacy or place: those stay mine).
    func updated(with meta: WikiPageItem) -> WikiPageItem {
        guard meta.version >= version else { return self }
        var next = meta
        next.myLevel = myLevel
        next.isPrivate = isPrivate
        next.parentId = parentId
        next.position = position
        next.metaSeq = max(metaSeq, meta.metaSeq)
        return next
    }
}

/// An ancestor in the breadcrumbs, root first. One I cannot read has no id, title or icon (「…」, §4.6).
struct WikiCrumb: Codable, Equatable {
    var id: String?
    var title: String?
    var icon: String?
    var readable: Bool
}

/// A page with its body (`PageContent`: the answer to a save, a conflict's head).
struct WikiPageContent: Codable, Equatable {
    var item: WikiPageItem
    var body: String

    private enum Keys: String, CodingKey { case body }

    init(item: WikiPageItem, body: String) {
        self.item = item
        self.body = body
    }

    init(from decoder: Decoder) throws {
        item = try WikiPageItem(from: decoder)
        body = try decoder.container(keyedBy: Keys.self).decode(String.self, forKey: .body)
    }

    func encode(to encoder: Encoder) throws {
        try item.encode(to: encoder)
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(body, forKey: .body)
    }

    /// The page as the canvas's save loop holds a document. `channelId` names no conversation; `editPolicy` carries my
    /// level (the loop never reads either).
    var canvas: CanvasOut {
        CanvasOut(id: item.id, channelId: WikiPageContent.channel, title: item.title, version: item.version, headRevId: item.headRevId,
                  isChannelTab: false, editPolicy: item.myLevel.rawValue, templateKey: nil, shareMessageId: nil, taskTotal: item.taskTotal,
                  taskDone: item.taskDone, createdBy: item.createdBy, updatedBy: item.updatedBy, createdAt: item.createdAt,
                  updatedAt: item.updatedAt, deletedAt: nil, body: body)
    }

    /// The save loop's `channelId` for pages (its unsaved state is kept under `wiki:pending:<id>`, not `canvas:<id>`).
    static let channel = "wiki"
}

/// GET /wiki/pages/{id}: the page, its breadcrumbs (root first) and the child pages I can read, in order.
struct WikiPageOut: Codable, Equatable {
    var content: WikiPageContent
    var breadcrumbs: [WikiCrumb]
    var children: [WikiPageItem]

    var item: WikiPageItem { content.item }
    var id: String { content.item.id }
    var body: String { content.body }

    private enum Keys: String, CodingKey { case breadcrumbs, children }

    init(content: WikiPageContent, breadcrumbs: [WikiCrumb] = [], children: [WikiPageItem] = []) {
        self.content = content
        self.breadcrumbs = breadcrumbs
        self.children = children
    }

    init(from decoder: Decoder) throws {
        content = try WikiPageContent(from: decoder)
        let c = try decoder.container(keyedBy: Keys.self)
        breadcrumbs = try c.decodeIfPresent([WikiCrumb].self, forKey: .breadcrumbs) ?? []
        children = try c.decodeIfPresent([WikiPageItem].self, forKey: .children) ?? []
    }

    func encode(to encoder: Encoder) throws {
        try content.encode(to: encoder)
        var c = encoder.container(keyedBy: Keys.self)
        try c.encode(breadcrumbs, forKey: .breadcrumbs)
        try c.encode(children, forKey: .children)
    }

    /// A save's answer (or a conflict's head) over what was read: the body and metadata are the newer ones.
    func with(content newer: WikiPageContent) -> WikiPageOut {
        guard newer.item.version >= content.item.version else { return self }
        var next = self
        next.content = newer
        return next
    }
}

/// GET /wiki/tree: every page I can read (not database rows) and the change feed's position.
struct WikiTreeOut: Codable, Equatable {
    let pages: [WikiPageItem]
    let cursor: Int
}

/// GET /wiki/changes?since=: pages I can read that changed, ids to drop, the next `since`; `reset`: read the tree again.
struct WikiChangesOut: Codable, Equatable {
    var pages: [WikiPageItem] = []
    var removed: [String] = []
    var cursor: Int
    var reset: Bool = false
}

/// POST /wiki/pages/resolve: a `page:` link's current title and icon (only pages I can read are answered).
struct WikiPageRef: Codable, Equatable, Identifiable {
    let id: String
    var title: String
    var icon: String?
    var kind: String
}

/// PUT /wiki/pages/{id}/content (the canvas's save, CANVAS.md §4.4).
struct WikiSaveOut: Codable, Equatable {
    let page: WikiPageContent
    let submittedRevId: String
    let merged: Bool
}

/// The details of 409 page_conflict / page_base_expired (the canvas's shape with a page as the head).
struct WikiConflictDetails: Decodable {
    let head: WikiPageContent
    var conflicts: [CanvasConflict]? = nil
    var timedOut: Bool? = nil
}

/// A new page (POST /wiki/pages). `access` only for a top-level page: workspace (everyone edits, I manage it) or private
/// (me only), §4.2 / Q2; a child page takes its parent's.
struct WikiPageCreate: Equatable {
    var parentId: String?
    var title: String?
    var icon: String?
    var access: String = "workspace"
    var clientSaveId: String
    var tz: String? = TimeZone.current.identifier
    /// M146: start from a template (GET /wiki/templates); the server fills the title, icon and body (placeholders put in
    /// with `tz`, files copied). Left out: blank.
    var template: WikiTemplateChoice? = nil

    var json: JSONValue {
        var fields: [String: JSONValue] = ["client_save_id": .string(clientSaveId), "kind": .string("page")]
        if let parentId { fields["parent_id"] = .string(parentId) } else { fields["access"] = .string(access) }
        if let title, !title.isEmpty { fields["title"] = .string(title) }
        if let icon, !icon.isEmpty { fields["icon"] = .string(icon) }
        if let tz { fields["tz"] = .string(tz) }
        template?.add(to: &fields)
        return .object(fields)
    }
}

// MARK: templates and duplicates (M146, docs/WIKI.md §22.3 / §24.3)

/// A template to start a page from: a built-in one (`template_key`, the canvases' templates) or a page template I can
/// read (`template_page_id`). The two are never sent together.
enum WikiTemplateChoice: Equatable, Hashable {
    case builtin(key: String)
    case page(id: String)

    func add(to fields: inout [String: JSONValue]) {
        switch self {
        case .builtin(let key): fields["template_key"] = .string(key)
        case .page(let id): fields["template_page_id"] = .string(id)
        }
    }
}

/// GET /wiki/templates: the page templates I can read (newest first) and the built-in templates not hidden.
struct WikiTemplatesOut: Codable, Equatable {
    var pages: [WikiPageItem] = []
    var builtins: [CanvasTemplateOut] = []

    init(pages: [WikiPageItem] = [], builtins: [CanvasTemplateOut] = []) {
        self.pages = pages
        self.builtins = builtins
    }

    private enum CodingKeys: String, CodingKey { case pages, builtins }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pages = try c.decodeIfPresent([WikiPageItem].self, forKey: .pages) ?? []
        builtins = (try c.decodeIfPresent([CanvasTemplateOut].self, forKey: .builtins) ?? []).filter { !$0.hidden }
    }
}

/// POST /wiki/pages/{id}/apply-template: 「テンプレートから始める」 on an empty page (409 wiki_page_not_empty otherwise).
struct WikiTemplateApply: Equatable {
    var template: WikiTemplateChoice
    var clientSaveId: String
    var tz: String? = TimeZone.current.identifier

    var json: JSONValue {
        var fields: [String: JSONValue] = ["client_save_id": .string(clientSaveId)]
        template.add(to: &fields)
        if let tz { fields["tz"] = .string(tz) }
        return .object(fields)
    }
}

/// POST /wiki/pages/{id}/duplicate: 「複製」. Left out, the copy goes beside the original (same parent) with the server's
/// 「（コピー）」 title; `topLevel` sends `parent_id: null` (after 403 page_edit_restricted on the parent).
struct WikiDuplicate: Equatable {
    var clientSaveId: String
    var topLevel = false

    var json: JSONValue {
        var fields: [String: JSONValue] = ["client_save_id": .string(clientSaveId)]
        if topLevel { fields["parent_id"] = .null }
        return .object(fields)
    }
}

/// The duplicate's answer: the copy, and for a row its cells.
struct WikiDuplicateOut: Decodable, Equatable {
    var page: WikiPageOut
    var row: DbRowWithRefs?
}

/// One version in a page's history (`PageRevisionMeta`), as the canvas's history list shows it.
struct WikiRevisionMeta: Decodable {
    let id: String
    let pageId: String
    let version: Int?
    let kind: String
    let parentRevId: String?
    let authorId: String
    let title: String
    let label: String?
    let linesAdded: Int
    let linesRemoved: Int
    let createdAt: String

    var canvas: CanvasRevisionMeta {
        CanvasRevisionMeta(id: id, canvasId: pageId, version: version, kind: kind, parentRevId: parentRevId, authorId: authorId, title: title,
                           label: label, linesAdded: linesAdded, linesRemoved: linesRemoved, createdAt: createdAt)
    }
}

struct WikiRevisionPage: Decodable {
    let items: [WikiRevisionMeta]
    let nextCursor: String?
}

struct WikiRevisionOut: Decodable {
    let id: String
    let kind: String
    let authorId: String
    let title: String
    let label: String?
    let createdAt: String
    let body: String
}

/// One hit of `GET /search/pages` (§8.1).
struct PageSearchHit: Codable, Identifiable, Equatable {
    let page: WikiPageItem
    let snippet: String
    var score: Double = 0
    var id: String { page.id }
}

struct PageSearchOut: Codable {
    let hits: [PageSearchHit]
    let keywords: [String]
    var filters: SearchFilters? = nil
    let limit: Int
    let offset: Int
    let hasMore: Bool
    var total: Int? = nil
    var totalCapped: Bool? = nil
}

/// In bootstrap: the change feed's position; absent from a server without the wiki.
struct WikiBootstrap: Codable, Equatable {
    let changeSeq: Int
}

/// A `page_mention` / `page_shared` activity item's page (§14.2), listed while I can read the page.
struct ActivityPage: Codable, Equatable {
    let itemId: String
    let pageId: String
    var title: String = ""
    var icon: String? = nil
    var excerpt: String = ""
    var revId: String? = nil
    var level: String? = nil

    init(itemId: String, pageId: String, title: String = "", icon: String? = nil, excerpt: String = "", revId: String? = nil, level: String? = nil) {
        self.itemId = itemId
        self.pageId = pageId
        self.title = title
        self.icon = icon
        self.excerpt = excerpt
        self.revId = revId
        self.level = level
    }

    private enum CodingKeys: String, CodingKey { case itemId, pageId, title, icon, excerpt, revId, level }

    /// The ids are required (the row opens the page); the words read as empty when missing.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        itemId = try c.decode(String.self, forKey: .itemId)
        pageId = try c.decode(String.self, forKey: .pageId)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        icon = try? c.decodeIfPresent(String.self, forKey: .icon)
        excerpt = (try? c.decodeIfPresent(String.self, forKey: .excerpt)) ?? ""
        revId = try? c.decodeIfPresent(String.self, forKey: .revId)
        level = try? c.decodeIfPresent(String.self, forKey: .level)
    }
}

/// wiki.mentioned / wiki.shared (to me, while I can read the page): the in-app notice's words.
struct WikiNotice: Decodable, Equatable {
    let pageId: String
    var title: String
    var byUserId: String
    /// wiki.shared only.
    var level: String?

    init(pageId: String, title: String, byUserId: String, level: String? = nil) {
        self.pageId = pageId
        self.title = title
        self.byUserId = byUserId
        self.level = level
    }

    private enum CodingKeys: String, CodingKey { case pageId, title, byUserId, level }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pageId = try c.decode(String.self, forKey: .pageId)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        byUserId = (try? c.decodeIfPresent(String.self, forKey: .byUserId)) ?? ""
        level = try? c.decodeIfPresent(String.self, forKey: .level)
    }

    /// 「〇〇 が「題名」であなたをメンションしました」 / 「〇〇 が「題名」を共有しました」 (the push's words, §9.3).
    func text(shared: Bool, nameOf: (String) -> String?) -> String {
        let who = nameOf(byUserId) ?? tr("メンバー")
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? tr("ページ") : title
        return shared ? tr("\(who) が「\(title)」を共有しました") : tr("\(who) が「\(title)」であなたをメンションしました")
    }
}
