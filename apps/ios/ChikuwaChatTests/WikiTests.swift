import XCTest
@testable import ChikuwaChat

/// M122 (docs/WIKI.md §9.2 / §10 / §14): the wiki on the phone — the tree and its order, the change feed, the hub with a
/// fake server (bootstrap, wiki.changed, reset, ETag, kept state), routing, the level rules, the save requests and the
/// activity items.

private func page(_ id: String, parent: String? = nil, position: String = "a0", title: String? = nil, level: WikiLevel = .edit,
                  isPrivate: Bool = false, version: Int = 1) -> WikiPageItem {
    WikiPageItem(id: id, parentId: parent, position: position, title: title ?? id, version: version, headRevId: "r-\(id)-\(version)",
                 myLevel: level, isPrivate: isPrivate)
}

private func out(_ item: WikiPageItem, body: String = "", crumbs: [WikiCrumb] = [], children: [WikiPageItem] = []) -> WikiPageOut {
    WikiPageOut(content: WikiPageContent(item: item, body: body), breadcrumbs: crumbs, children: children)
}

@MainActor
final class WikiTreeTests: XCTestCase {
    func testSiblingsAreOrderedByPositionBytesThenId() {
        // "a0" < "a0V" < "aZ" < "b" byte by byte (uppercase sorts before lowercase), ties by id.
        let tree = WikiTree(pages: [
            page("p3", position: "b"), page("p1", position: "a0V"), page("p0", position: "a0"),
            page("p2", position: "aZ"), page("p5", position: "b"), page("p4", position: "b"),
        ], cursor: 1)
        XCTAssertEqual(tree.roots(private: false).map(\.id), ["p0", "p1", "p2", "p3", "p4", "p5"])
        XCTAssertTrue(WikiTree.precedes(page("x", position: "Z"), page("y", position: "a")))
    }

    func testRootsChildrenAndAncestors() {
        let tree = WikiTree(pages: [
            page("manual", position: "a1"), page("gpu", parent: "manual", position: "a2"), page("rules", parent: "manual", position: "a1"),
            page("booking", parent: "gpu"), page("memo", isPrivate: true),
            // Its parent is not mine to read: it shows at the top level (§4.6).
            page("orphan", parent: "hidden", position: "a0"),
            page("row", parent: "manual", position: "a3"),
        ], cursor: 5)
        XCTAssertEqual(tree.roots(private: false).map(\.id), ["orphan", "manual"])
        XCTAssertEqual(tree.roots(private: true).map(\.id), ["memo"])
        XCTAssertEqual(tree.children(of: "manual").map(\.id), ["rules", "gpu", "row"])
        XCTAssertEqual(tree.ancestors(of: "booking").map(\.id), ["manual", "gpu"])
        XCTAssertEqual(tree.ancestors(of: "orphan").map(\.id), [])
        XCTAssertTrue(tree.hasChildren("gpu"))
        XCTAssertFalse(tree.hasChildren("booking"))
    }

    func testDatabaseRowsStayOutOfTheTree() {
        var row = page("r1", parent: "db")
        row.kind = "row"
        var tree = WikiTree(pages: [page("db"), row], cursor: 1)
        XCTAssertNil(tree.page("r1"))
        _ = tree.apply(WikiChangesOut(pages: [row], removed: [], cursor: 2))
        XCTAssertNil(tree.page("r1"))
    }

    func testTheChangeFeedReplacesAddsRemovesAndMovesTheCursor() {
        var tree = WikiTree(pages: [page("a"), page("b", parent: "a"), page("c")], cursor: 10, etag: "\"e1\"")
        let applied = tree.apply(WikiChangesOut(pages: [page("a", title: "新しい題名", version: 2), page("d", parent: "a", position: "a5")],
                                                removed: ["c", "unknown"], cursor: 14))
        XCTAssertTrue(applied)
        XCTAssertEqual(tree.page("a")?.title, "新しい題名")
        XCTAssertEqual(tree.children(of: "a").map(\.id), ["b", "d"])
        XCTAssertNil(tree.page("c"))
        XCTAssertEqual(tree.cursor, 14)
        XCTAssertNil(tree.etag) // the tree is no longer the one the ETag named
        // Nothing changed: the cursor still moves, the ETag stays.
        var quiet = WikiTree(pages: [page("a")], cursor: 3, etag: "\"e\"")
        XCTAssertTrue(quiet.apply(WikiChangesOut(cursor: 4)))
        XCTAssertEqual(quiet.cursor, 4)
        XCTAssertEqual(quiet.etag, "\"e\"")
        // reset: read the tree again.
        XCTAssertFalse(tree.apply(WikiChangesOut(cursor: 20, reset: true)))
        XCTAssertEqual(tree.cursor, 14)
    }

    func testAnEventsMetadataKeepsMyPlaceLevelAndPrivacy() {
        var tree = WikiTree(pages: [page("a", parent: "p", position: "a3", level: .view, isPrivate: true)], cursor: 1)
        // wiki.page.updated: parent_id null, no my_level / private.
        var meta = page("a", parent: nil, position: "a3", title: "改名", level: .view, version: 2)
        meta.icon = "📘"
        tree.applyMeta(meta)
        let after = tree.page("a")
        XCTAssertEqual(after?.title, "改名")
        XCTAssertEqual(after?.icon, "📘")
        XCTAssertEqual(after?.parentId, "p")
        XCTAssertEqual(after?.myLevel, .view)
        XCTAssertEqual(after?.isPrivate, true)
        // An older one does not win.
        tree.applyMeta(page("a", title: "古い", version: 1))
        XCTAssertEqual(tree.page("a")?.title, "改名")
    }

    func testTreeRowsFollowWhatIsOpen() {
        let tree = WikiTree(pages: [page("m", position: "a1"), page("g", parent: "m"), page("b", parent: "g"), page("n", position: "a2")], cursor: 1)
        let closed = WikiText.rows(tree, roots: tree.roots(private: false), expanded: [])
        XCTAssertEqual(closed.map(\.id), ["m", "n"])
        XCTAssertEqual(closed.map(\.hasChildren), [true, false])
        let open = WikiText.rows(tree, roots: tree.roots(private: false), expanded: ["m", "g"])
        XCTAssertEqual(open.map(\.id), ["m", "g", "b", "n"])
        XCTAssertEqual(open.map(\.depth), [0, 1, 2, 0])
        // A closed parent hides an open child.
        XCTAssertEqual(WikiText.rows(tree, roots: tree.roots(private: false), expanded: ["g"]).map(\.id), ["m", "n"])
        XCTAssertEqual(WikiText.spoken(open[0]), "m、サブページを表示中")
    }

    func testTitleFilterIconAndTitleRules() {
        let tree = WikiTree(pages: [page("1", title: "ＧＰＵサーバの予約"), page("2", title: "研究室の決まり"), page("3", title: "gpu メモ")], cursor: 1)
        XCTAssertEqual(WikiText.filtered(tree, query: "gpu").map(\.id), ["3", "1"])
        XCTAssertEqual(WikiText.filtered(tree, query: "  "), [])
        XCTAssertEqual(WikiText.icon("📘 本"), "📘")
        XCTAssertEqual(WikiText.icon("👨‍👩‍👧"), "👨‍👩‍👧") // one character, several scalars
        XCTAssertEqual(WikiText.icon(":lab_logo:"), ":lab_logo:")
        XCTAssertNil(WikiText.icon("  "))
        XCTAssertEqual(WikiText.title("  新入生   ガイド "), "新入生 ガイド")
        XCTAssertNil(WikiText.title("   "))
        XCTAssertEqual(WikiText.place(page("g", parent: "m"), tree: WikiTree(pages: [page("m", title: "マニュアル"), page("g", parent: "m")], cursor: 1)),
                       "マニュアル")
        XCTAssertEqual(WikiText.place(page("m"), tree: nil), "ドキュメント")
    }
}

@MainActor
final class WikiRulesTests: XCTestCase {
    func testTheLevelDecidesWhatThePhoneOffers() {
        let view = WikiRights.of(.view)
        XCTAssertFalse(view.edit)
        XCTAssertFalse(view.tick) // unlike a canvas, a viewer cannot tick (§4.1)
        XCTAssertFalse(view.rename)
        XCTAssertFalse(view.createChild)
        for level in [WikiLevel.edit, .full] {
            let rights = WikiRights.of(level)
            XCTAssertTrue(rights.edit && rights.tick && rights.rename && rights.createChild, level.rawValue)
        }
        XCTAssertFalse(WikiRights.of(nil).edit)
        XCTAssertTrue(WikiRights.createsTopLevel(isGuest: false))
        XCTAssertFalse(WikiRights.createsTopLevel(isGuest: true))
        // An unknown level of a newer server offers nothing.
        XCTAssertEqual(WikiLevel(raw: "owner"), .view)
        XCTAssertEqual(WikiLevel(raw: nil), .view)
    }

    func testPageLinksAndPermalinks() {
        let base = URL(string: "https://chat.example.com/")!
        let id = "01a0f811-c836-755b-925c-0d71f4c5cd22"
        XCTAssertEqual(PageLink.pageId(base: base, url: "page:\(id)"), id)
        XCTAssertEqual(PageLink.pageId(base: nil, url: "PAGE:\(id.uppercased())"), id)
        XCTAssertEqual(PageLink.pageId(base: base, url: "https://chat.example.com/p/\(id)?x=1#h"), id)
        XCTAssertEqual(PageLink.pageId(base: base, url: "HTTPS://Chat.Example.com/p/\(id)"), id)
        XCTAssertNil(PageLink.pageId(base: base, url: "https://other.example.com/p/\(id)"))
        XCTAssertNil(PageLink.pageId(base: base, url: "https://chat.example.com/c/\(id)"))
        XCTAssertNil(PageLink.pageId(base: base, url: "page:not-a-uuid"))
        XCTAssertEqual(PageLink.url(base: base, pageId: id), "https://chat.example.com/p/\(id)")
        XCTAssertEqual(PageLink.ids(in: "[a](page:\(id)) と [b](page:\(id.uppercased())) と [c](https://x)"), [id])
        XCTAssertEqual(FileLink.attachmentId("attachment:\(id)"), id)
        XCTAssertNil(FileLink.attachmentId("attachment:x"))
    }

    func testPageAndFileLinksAreTokensWithTheirLabels() {
        let id = "01a0f811-c836-755b-925c-0d71f4c5cd22"
        XCTAssertEqual(BodyTokenizer.tokenizeInline("見る：[GPU の予約](page:\(id))"), [.text("見る："), .link("page:\(id)", label: "GPU の予約")])
        XCTAssertEqual(BodyTokenizer.tokenizeInline("[手順書.pdf](attachment:\(id))"), [.link("attachment:\(id)", label: "手順書.pdf")])
        // Other schemes stay text, as before.
        XCTAssertEqual(BodyTokenizer.tokenizeInline("[x](javascript:alert)"), [.text("[x](javascript:alert)")])
    }

    func testWhatAPageLinkShows() {
        XCTAssertEqual(MessageBodyView.pageLinkText(.page(title: "GPU の予約", icon: "🖥️"), label: "古い題名"), "🖥️ GPU の予約")
        XCTAssertEqual(MessageBodyView.pageLinkText(.page(title: "規則", icon: ":lab:"), label: nil), "📄 規則")
        XCTAssertEqual(MessageBodyView.pageLinkText(.unreadable, label: "秘密"), "📄 表示できないページ")
        XCTAssertEqual(MessageBodyView.pageLinkText(nil, label: "古い題名"), "📄 古い題名")
        XCTAssertEqual(MessageBodyView.pageLinkText(nil, label: nil), "📄 ページを開く")
    }

    func testPagesOpenOnTheStackAndABreadcrumbGoesBack() {
        var nav = MainNavigation()
        nav.paths[.home] = [.list(DocsView.selectionId)]
        nav.openPage("a", on: .home)
        nav.openPage("b", on: .home)
        nav.openPage("c", on: .home)
        XCTAssertEqual(nav.paths[.home], [.list(DocsView.selectionId), .page("a"), .page("b"), .page("c")])
        nav.openPage("a", on: .home) // a breadcrumb: back to it
        XCTAssertEqual(nav.paths[.home], [.list(DocsView.selectionId), .page("a")])
        nav.openPage("a", on: .home) // a link to itself: nothing moves
        XCTAssertEqual(nav.paths[.home], [.list(DocsView.selectionId), .page("a")])
        // A notification: over 「ドキュメント」 on the home tab.
        nav.tab = .activity
        nav.landPage("z", docsId: DocsView.selectionId)
        XCTAssertEqual(nav.tab, .home)
        XCTAssertEqual(nav.paths[.home], [.list(DocsView.selectionId), .page("z")])
        // The iPad's detail column.
        var split = MainNavigation()
        split.setLayout(.split, isDm: { _ in false })
        split.select(.list(DocsView.selectionId))
        split.openPage("a", on: .home)
        XCTAssertEqual(split.split, [.list(DocsView.selectionId), .page("a")])
        split.landPage("q", docsId: DocsView.selectionId)
        XCTAssertEqual(split.split, [.list(DocsView.selectionId), .page("q")])
        XCTAssertNil(split.frontChannelId) // a page is not a conversation
        // A page never goes with a conversation that left.
        var mixed = MainNavigation()
        mixed.paths[.home] = [.channel("gone"), .page("a")]
        mixed.dropChannels { $0 == "gone" }
        XCTAssertEqual(mixed.paths[.home], [])
    }

    func testAPageNotificationOpensThePage() {
        let payload = PushPayload(userInfo: ["kind": "page", "page_id": "p1", "workspace_id": "w"])
        XCTAssertTrue(payload.opensPage)
        XCTAssertEqual(payload.pageId, "p1")
        XCTAssertFalse(PushPayload(userInfo: ["kind": "page"]).opensPage)
        XCTAssertTrue(Workspaces.shouldPresent(payload, target: nil, active: nil, openChannelId: "c"))
    }

    func testTheDocsTileFollowsTheServerAndTheSharedCatalogue() {
        let threads = ThreadSummary(unreadCount: 0, mentionCount: 0)
        let without = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: nil)
        XCTAssertFalse(without.contains { $0.kind == .docs })
        let with = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: nil, docs: true)
        let kinds = with.map(\.kind)
        XCTAssertEqual(kinds.firstIndex(of: .docs), kinds.firstIndex(of: .canvases).map { $0 + 1 })
        let tile = with.first { $0.kind == .docs }!
        XCTAssertEqual(tile.title, "ドキュメント")
        XCTAssertNil(tile.count)
        XCTAssertEqual(tile.selectionId, DocsView.selectionId)
        XCTAssertEqual(tile.kind.navKey, "docs")
        // Hidden in my tiles: gone.
        let hidden = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: [NavItem(key: "docs", visible: false)], docs: true)
        XCTAssertFalse(hidden.contains { $0.kind == .docs })
    }

    func testPageActivityItemsDecodeAndRead() throws {
        let json = #"""
        {"items":[
          {"kind":"page_mention","at":"2026-10-07T01:00:00Z","page":{"item_id":"i1","page_id":"p1","title":"GPU の予約","icon":"🖥️","excerpt":"@me 確認して","rev_id":"r","level":null},"actor_ids":["u1"]},
          {"kind":"page_shared","at":"2026-10-07T00:00:00Z","page":{"item_id":"i2","page_id":"p2","title":"","icon":null,"excerpt":"","rev_id":null,"level":"edit"},"actor_ids":["u2"]},
          {"kind":"page_shared","at":"2026-10-07T00:00:00Z","actor_ids":["u2"]}
        ],"next_cursor":null,"read_at":"2026-10-06T00:00:00Z"}
        """#
        let list = try JSON.snakeDecoder.decode(ActivityListOut.self, from: Data(json.utf8))
        XCTAssertEqual(list.items.count, 2) // the one without its page is left out
        let mention = list.items[0]
        XCTAssertEqual(mention.page?.pageId, "p1")
        XCTAssertEqual(mention.id, "page_mention:i1")
        XCTAssertNil(mention.channelId)
        let names: (String) -> String = { ["u1": "山田", "u2": "佐藤"][$0] ?? "?" }
        XCTAssertEqual(ActivityRules.headlineText(mention, nameOf: names), "山田 が「🖥️ GPU の予約」であなたをメンションしました")
        XCTAssertEqual(ActivityRules.headlineText(list.items[1], nameOf: names), "佐藤 が「無題」を共有しました")
        XCTAssertEqual(ActivityRules.excerpt(mention, users: [:]), "@me 確認して")
        XCTAssertEqual(ActivityRules.whereText(mention, conversation: ""), "ドキュメント")
        XCTAssertEqual(ActivityRules.append([], list.items).count, 2)
        XCTAssertTrue(ApiClient.activityInclude.contains("page_mention"))
        XCTAssertTrue(ApiClient.activityInclude.contains("page_shared"))
    }

    func testANoticeSaysWhoAndWhat() {
        let notice = WikiNotice(pageId: "p", title: "規則", byUserId: "u1")
        XCTAssertEqual(notice.text(shared: false) { _ in "山田" }, "山田 が「規則」であなたをメンションしました")
        XCTAssertEqual(WikiNotice(pageId: "p", title: " ", byUserId: "x").text(shared: true) { _ in nil }, "メンバー が「ページ」を共有しました")
    }
}

// MARK: - the hub against a fake server

@MainActor
final class FakeWikiApi: WikiApi {
    var tree: [WikiPageItem] = []
    var cursor = 0
    var etag = "\"t1\""
    var changes: [WikiChangesOut] = []
    var pages: [String: WikiPageOut] = [:]
    var readable: Set<String>?
    var calls: [String] = []
    var treeEtags: [String?] = []
    var pageEtags: [String?] = []
    var saves: [(id: String, save: CanvasSaveIn)] = []
    var creates: [WikiPageCreate] = []
    var failNetwork = false

    func wikiTree(etag: String?) async throws -> WikiTreeFetch? {
        calls.append("tree")
        treeEtags.append(etag)
        if failNetwork { throw ApiError.network(URLError(.notConnectedToInternet)) }
        if etag == self.etag { return nil }
        return WikiTreeFetch(tree: WikiTreeOut(pages: tree, cursor: cursor), etag: self.etag)
    }

    func wikiChanges(since: Int) async throws -> WikiChangesOut {
        calls.append("changes:\(since)")
        if failNetwork { throw ApiError.network(URLError(.notConnectedToInternet)) }
        return changes.isEmpty ? WikiChangesOut(cursor: since) : changes.removeFirst()
    }

    func getPage(id: String, etag: String?) async throws -> WikiPageOut? {
        calls.append("page:\(id)")
        pageEtags.append(etag)
        if failNetwork { throw ApiError.network(URLError(.notConnectedToInternet)) }
        guard let page = pages[id], readable?.contains(id) ?? true else { throw ApiError.api(status: 404, code: "page_not_found", message: "") }
        if etag == "\"v\(page.item.version)-\(page.item.myLevel.rawValue)\"" { return nil }
        return page
    }

    func savePage(id: String, _ save: CanvasSaveIn) async throws -> WikiSaveOut {
        saves.append((id, save))
        if failNetwork { throw ApiError.network(URLError(.notConnectedToInternet)) }
        guard var page = pages[id] else { throw ApiError.api(status: 404, code: "page_not_found", message: "") }
        guard page.item.myLevel != .view else { throw ApiError.api(status: 403, code: "page_edit_restricted", message: "") }
        var item = page.item
        item.version += 1
        item.headRevId = "rev\(item.version)"
        page.content = WikiPageContent(item: item, body: save.body)
        pages[id] = page
        return WikiSaveOut(page: page.content, submittedRevId: item.headRevId, merged: false)
    }

    func createPage(_ create: WikiPageCreate) async throws -> WikiPageOut {
        creates.append(create)
        let id = "new-\(creates.count)"
        let made = out(WikiPageItem(id: id, parentId: create.parentId, position: "z", title: create.title ?? "無題", icon: create.icon,
                                    headRevId: "c1", myLevel: .full, isPrivate: create.parentId == nil && create.access == "private"))
        pages[id] = made
        return made
    }

    func updatePage(id: String, title: String?, icon: String?) async throws -> WikiPageOut {
        calls.append("patch:\(id):\(title ?? "-"):\(icon ?? "-")")
        guard var page = pages[id] else { throw ApiError.api(status: 404, code: "page_not_found", message: "") }
        var item = page.item
        if let title { item.title = title }
        if let icon { item.icon = icon.isEmpty ? nil : icon }
        item.version += 1
        page.content.item = item
        pages[id] = page
        return page
    }

    func pageBacklinks(id: String) async throws -> [WikiPageItem] { [] }

    func resolvePages(ids: [String]) async throws -> [WikiPageRef] {
        calls.append("resolve:\(ids.joined(separator: ","))")
        return ids.compactMap { id in pages[id].map { WikiPageRef(id: id, title: $0.item.title, icon: $0.item.icon, kind: "page") } }
    }
}

@MainActor
final class WikiHubTests: XCTestCase {
    private func hub(_ api: FakeWikiApi, store: Store? = nil, clock: CanvasClock? = nil) -> WikiHub {
        WikiHub(api: api, store: store ?? Store(), clock: clock, options: CanvasSaverOptions(debounce: 2, refreshDebounce: 0, retryDelays: [1]), feedDelay: 0)
    }

    func testBootstrapReadsTheTreeThenTheFeedAndAServerWithoutTheWikiReadsNothing() async {
        let api = FakeWikiApi()
        api.tree = [page("a"), page("b", parent: "a")]
        api.cursor = 7
        let hub = hub(api)
        await hub.bootstrap(nil)
        XCTAssertFalse(hub.available)
        XCTAssertEqual(api.calls, [])
        await hub.bootstrap(WikiBootstrap(changeSeq: 7))
        XCTAssertTrue(hub.available)
        XCTAssertEqual(hub.tree?.children(of: "a").map(\.id), ["b"])
        XCTAssertEqual(api.treeEtags, [nil])
        // The next bootstrap (a reconnect) reads the feed from the cursor.
        api.changes = [WikiChangesOut(pages: [page("c")], removed: ["b"], cursor: 9)]
        await hub.bootstrap(WikiBootstrap(changeSeq: 9))
        XCTAssertEqual(api.calls, ["tree", "changes:7"])
        XCTAssertEqual(Set(hub.tree?.pages.keys ?? [:].keys), ["a", "c"])
        XCTAssertEqual(hub.tree?.cursor, 9)
    }

    func testWikiChangedFoldsIntoOneReadAndAResetReadsTheTreeAgain() async {
        let api = FakeWikiApi()
        api.tree = [page("a")]
        api.cursor = 3
        let hub = hub(api)
        await hub.bootstrap(WikiBootstrap(changeSeq: 3))
        api.changes = [WikiChangesOut(pages: [page("a", title: "改名", version: 2)], cursor: 5)]
        hub.applyEvent("wiki.changed", .object(["seq": .number(4)]))
        hub.applyEvent("wiki.changed", .object(["seq": .number(5)]))
        await hub.settled()
        XCTAssertEqual(api.calls, ["tree", "changes:3"])
        XCTAssertEqual(hub.tree?.page("a")?.title, "改名")
        // A seq the tree has already: nothing to read.
        hub.applyEvent("wiki.changed", .object(["seq": .number(5)]))
        await hub.settled()
        XCTAssertEqual(api.calls.count, 2)
        // reset: the whole tree again, without the old ETag.
        api.changes = [WikiChangesOut(cursor: 99, reset: true)]
        api.tree = [page("x")]
        api.cursor = 99
        api.etag = "\"t2\""
        hub.applyEvent("wiki.changed", .object(["seq": .number(99)]))
        await hub.settled()
        XCTAssertEqual(api.calls.suffix(2), ["changes:5", "tree"])
        XCTAssertEqual(api.treeEtags.last, .some(nil))
        XCTAssertEqual(hub.tree?.pages.keys.sorted(), ["x"])
        XCTAssertEqual(hub.tree?.cursor, 99)
    }

    func testTheTreeIsKeptAndReadAgainWithItsETag() async {
        let store = Store()
        let api = FakeWikiApi()
        api.tree = [page("a"), page("m", isPrivate: true)]
        api.cursor = 2
        let first = hub(api, store: store)
        await first.bootstrap(WikiBootstrap(changeSeq: 2))
        first.stop()
        // A new start (the same store): the kept tree shows at once, offline too.
        api.failNetwork = true
        let second = hub(api, store: store)
        XCTAssertEqual(second.tree?.roots(private: true).map(\.id), ["m"])
        XCTAssertTrue(second.available)
        await second.loadTree()
        XCTAssertTrue(second.offline)
        XCTAssertNil(second.treeFailure)
        // Back online: If-None-Match with the kept ETag, 304 keeps the tree.
        api.failNetwork = false
        await second.loadTree()
        XCTAssertEqual(api.treeEtags.last, .some("\"t1\""))
        XCTAssertFalse(second.offline)
        XCTAssertEqual(second.tree?.pages.count, 2)
        // A group changed: the tree is read again (the ETag tells whether anything changed).
        api.tree = [page("a")]
        api.etag = "\"t3\""
        await second.loadTree()
        XCTAssertEqual(second.tree?.pages.keys.sorted(), ["a"])
    }

    func testAFailedFirstReadSaysWhy() async {
        let api = FakeWikiApi()
        api.failNetwork = true
        let hub = hub(api)
        await hub.bootstrap(WikiBootstrap(changeSeq: 1))
        XCTAssertNil(hub.tree)
        XCTAssertNotNil(hub.treeFailure)
    }

    func testAnOpenPageSavesThroughTheWikiAndKeepsACopy() async throws {
        let clock = ManualCanvasClock()
        let store = Store()
        let api = FakeWikiApi()
        let item = page("p", title: "手順", version: 3)
        api.tree = [item]
        api.pages["p"] = out(item, body: "# 手順\n- [ ] 準備", crumbs: [WikiCrumb(id: nil, title: nil, icon: nil, readable: false)])
        let hub = hub(api, store: store, clock: clock)
        await hub.bootstrap(WikiBootstrap(changeSeq: 1))
        let saver = try XCTUnwrap(hub.hold("p"))
        await saver.settled()
        XCTAssertEqual(saver.text, "# 手順\n- [ ] 準備")
        XCTAssertEqual(hub.pages["p"]?.breadcrumbs.first?.readable, false)
        XCTAssertEqual(api.pageEtags, [nil])
        // A tick (as the screen does): saved at once on the version read.
        saver.edit(CanvasText.toggleTaskLine(saver.text, line: 1, done: true)!, external: true)
        await saver.flush()
        XCTAssertEqual(api.saves.count, 1)
        XCTAssertEqual(api.saves[0].id, "p")
        XCTAssertEqual(api.saves[0].save.baseRevId, "r-p-3")
        XCTAssertEqual(api.saves[0].save.body, "# 手順\n- [x] 準備")
        XCTAssertEqual(api.saves[0].save.onConflict, .fail)
        XCTAssertEqual(saver.status, .saved)
        XCTAssertEqual(hub.item("p")?.version, 4)
        XCTAssertEqual(hub.keptPage("p")?.page.body, "# 手順\n- [x] 準備")
        // Typing: saved when it pauses (2 s), with a new key, on the version the last save made.
        saver.edit(saver.text + "\n本文")
        await clock.advance(1.9)
        XCTAssertEqual(api.saves.count, 1)
        await clock.advance(0.2)
        await saver.settled()
        XCTAssertEqual(api.saves.count, 2)
        XCTAssertEqual(api.saves[1].save.baseRevId, "rev4")
        XCTAssertNotEqual(api.saves[1].save.clientSaveId, api.saves[0].save.clientSaveId)
        // Read again (a pull): If-None-Match with the version and my level.
        await saver.refresh()
        XCTAssertEqual(api.pageEtags.last, .some("\"v5-edit\""))
        hub.release("p")
        clock.drain()
    }

    func testAPageReadOfflineComesFromTheKeptCopyAndTypingWaitsWithTheSameKey() async throws {
        let clock = ManualCanvasClock()
        let store = Store()
        let api = FakeWikiApi()
        let item = page("p", version: 2)
        api.tree = [item]
        api.pages["p"] = out(item, body: "前の本文")
        let first = hub(api, store: store, clock: clock)
        await first.bootstrap(WikiBootstrap(changeSeq: 1))
        let saver = try XCTUnwrap(first.hold("p"))
        await saver.settled()
        first.release("p")
        await saver.settled()
        first.stop()
        // Offline: a new start shows the kept copy at once and says so.
        api.failNetwork = true
        let second = hub(api, store: store, clock: clock)
        let offline = try XCTUnwrap(second.hold("p"))
        await offline.settled()
        XCTAssertEqual(offline.text, "前の本文")
        XCTAssertTrue(offline.offlineCopy)
        offline.edit("オフラインで書いた")
        await clock.advance(2.1)
        await offline.settled()
        XCTAssertEqual(offline.status, .offline)
        let key = api.saves.last?.save.clientSaveId
        XCTAssertNotNil(second.pending("p"))
        // Back online: the same save goes out (same key), and the pending state goes.
        api.failNetwork = false
        second.online()
        await offline.settled()
        XCTAssertEqual(api.saves.last?.save.clientSaveId, key)
        XCTAssertEqual(api.pages["p"]?.body, "オフラインで書いた")
        XCTAssertNil(second.pending("p"))
        second.release("p")
        clock.drain()
    }

    func testAViewersSaveIsRefusedAndAMissingPageIsGone() async throws {
        let clock = ManualCanvasClock()
        let api = FakeWikiApi()
        api.tree = [page("v", level: .view), page("x")]
        api.pages["v"] = out(page("v", level: .view), body: "読むだけ")
        let hub = hub(api, clock: clock)
        await hub.bootstrap(WikiBootstrap(changeSeq: 1))
        XCTAssertEqual(hub.level(of: "v"), .view)
        XCTAssertFalse(WikiRights.of(hub.level(of: "v")).edit)
        // 404 (not mine to read any more): gone, out of the tree, remembered as unreadable.
        let gone = try XCTUnwrap(hub.hold("x"))
        await gone.settled()
        XCTAssertEqual(gone.status, .gone)
        XCTAssertNil(hub.tree?.page("x"))
        XCTAssertEqual(hub.linkState("x"), .unreadable)
        hub.release("x")
        clock.drain()
    }

    func testPageUpdatedRetitlesAndReadsAnOpenPageAgain() async throws {
        let clock = ManualCanvasClock()
        let api = FakeWikiApi()
        let item = page("p", version: 1)
        api.tree = [item]
        api.pages["p"] = out(item, body: "一")
        let hub = hub(api, clock: clock)
        await hub.bootstrap(WikiBootstrap(changeSeq: 1))
        let saver = try XCTUnwrap(hub.hold("p"))
        await saver.settled()
        let newer = page("p", title: "新しい題名", version: 2)
        api.pages["p"] = out(newer, body: "二")
        let meta = try JSONValue.object([
            "page": JSON.plainDecoder.decode(JSONValue.self, from: JSON.snakeEncoder.encode(newer)),
            "change": .string("content"),
        ])
        hub.applyEvent("wiki.page.updated", meta)
        XCTAssertEqual(hub.tree?.page("p")?.title, "新しい題名")
        await clock.advance(0.1)
        await saver.settled()
        XCTAssertEqual(saver.text, "二")
        hub.release("p")
        clock.drain()
    }

    func testCreatingRenamingAndResolvingLinks() async throws {
        let api = FakeWikiApi()
        api.tree = [page("a")]
        api.pages["a"] = out(page("a"))
        api.pages["far"] = out(page("far", title: "遠いページ"))
        let hub = hub(api)
        await hub.bootstrap(WikiBootstrap(changeSeq: 1))
        // Top level, private: the access goes with it; a child: no access (it takes its parent's).
        let top = try await hub.create(parentId: nil, title: "メモ", icon: "📝", access: "private", clientSaveId: "k1")
        XCTAssertEqual(api.creates[0].json, .object(["client_save_id": .string("k1"), "kind": .string("page"), "access": .string("private"),
                                                       "title": .string("メモ"), "icon": .string("📝"), "tz": .string(TimeZone.current.identifier)]))
        XCTAssertEqual(hub.tree?.roots(private: true).map(\.id), [top.id])
        _ = try await hub.create(parentId: "a", title: nil, icon: nil, access: "workspace", clientSaveId: "k2")
        if case .object(let fields) = api.creates[1].json {
            XCTAssertEqual(fields["parent_id"], .string("a"))
            XCTAssertNil(fields["access"])
            XCTAssertNil(fields["title"])
        } else { XCTFail() }
        XCTAssertTrue(hub.expanded.contains("a"))
        XCTAssertEqual(hub.tree?.children(of: "a").count, 1)
        // Rename: the tree follows; an empty icon removes it.
        try await hub.rename("a", title: "改名", icon: "")
        XCTAssertEqual(api.calls.last, "patch:a:改名:")
        XCTAssertEqual(hub.tree?.page("a")?.title, "改名")
        // Links: the tree's titles, else resolve once; one not answered is unreadable.
        XCTAssertEqual(hub.linkState("a"), .page(title: "改名", icon: nil))
        XCTAssertNil(hub.linkState("far"))
        await hub.resolve(["far", "secret", "a"])
        XCTAssertEqual(api.calls.filter { $0.hasPrefix("resolve") }, ["resolve:far,secret"])
        XCTAssertEqual(hub.linkState("far"), .page(title: "遠いページ", icon: nil))
        XCTAssertEqual(hub.linkState("secret"), .unreadable)
        await hub.resolve(["far", "secret"])
        XCTAssertEqual(api.calls.filter { $0.hasPrefix("resolve") }.count, 1)
    }

    func testOnlyTheLatestPagesAreKept() async throws {
        let store = Store()
        let api = FakeWikiApi()
        let hub = hub(api, store: store)
        await hub.bootstrap(WikiBootstrap(changeSeq: 0))
        for n in 0..<(WikiHub.keptPageLimit + 3) {
            hub.received(out(page("p\(n)"), body: "本文 \(n)"))
        }
        XCTAssertEqual(store.wikiKeys(prefix: WikiHub.pagePrefix).count, WikiHub.keptPageLimit)
        XCTAssertNil(hub.keptPage("p0"))
        XCTAssertNotNil(hub.keptPage("p\(WikiHub.keptPageLimit + 2)"))
    }
}

@MainActor
final class WikiApiTests: XCTestCase {
    private func makeClient() -> ApiClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "a"
        return client
    }

    private let pageJSON = ##"{"id":"p1","parent_id":null,"position":"a0","kind":"page","title":"手順","icon":"📘","version":3,"head_rev_id":"r3","meta_seq":4,"inherit_access":true,"task_total":1,"task_done":0,"created_by":"u1","updated_by":"u2","created_at":"","updated_at":"","deleted_at":null,"my_level":"edit","private":true,"body":"# 手順"}"##

    private static func body(_ request: URLRequest) -> [String: JSONValue] {
        guard let stream = request.httpBodyStream else { return [:] }
        stream.open()
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
        stream.close()
        if case .object(let fields)? = try? JSONDecoder().decode(JSONValue.self, from: data) { return fields }
        return [:]
    }

    func testSavesGoToTheWikiAndConflictsComeBackAsTheCanvasLoopsFailures() async throws {
        var answer: (Int, String) = (200, "")
        var sent: [String: JSONValue] = [:]
        var paths: [String] = []
        StubProtocol.handler = { request in
            paths.append(request.httpMethod! + " " + request.url!.path)
            sent = Self.body(request)
            return (answer.0, Data(answer.1.utf8))
        }
        defer { StubProtocol.handler = nil }
        let client = makeClient()
        let save = CanvasSaveIn(baseRevId: "r1", body: "x", clientSaveId: "k1", onConflict: .ours)
        answer = (200, #"{"page":\#(pageJSON),"submitted_rev_id":"r4","merged":true}"#)
        let saved = try await client.savePage(id: "p1", save)
        XCTAssertEqual(paths.last, "PUT /api/v1/wiki/pages/p1/content")
        XCTAssertEqual(sent, ["base_rev_id": .string("r1"), "body": .string("x"), "client_save_id": .string("k1"), "on_conflict": .string("ours")])
        XCTAssertEqual(saved.page.item.myLevel, .edit)
        XCTAssertTrue(saved.page.item.isPrivate)
        XCTAssertEqual(saved.page.canvas.channelId, WikiPageContent.channel)
        XCTAssertEqual(saved.page.canvas.headRevId, "r3")
        answer = (409, #"{"error":{"code":"page_conflict","message":"m","details":{"head":\#(pageJSON),"conflicts":[{"base":"b","ours":"o","theirs":"t","ours_line":2,"theirs_line":3}],"timed_out":false}}}"#)
        do {
            _ = try await client.savePage(id: "p1", save)
            XCTFail("expected a conflict")
        } catch CanvasSaveFailure.conflict(let details) {
            XCTAssertEqual(details.head.id, "p1")
            XCTAssertEqual(details.head.body, "# 手順")
            XCTAssertEqual(details.conflicts?.first?.theirsLine, 3)
        }
        answer = (409, #"{"error":{"code":"page_base_expired","message":"m","details":{"head":\#(pageJSON),"conflicts":[]}}}"#)
        do {
            _ = try await client.savePage(id: "p1", save)
            XCTFail("expected expired")
        } catch CanvasSaveFailure.expired(let head) {
            XCTAssertEqual(head.version, 3)
        }
        answer = (403, #"{"error":{"code":"page_edit_restricted","message":"m","details":{}}}"#)
        do {
            _ = try await client.savePage(id: "p1", save)
            XCTFail("expected 403")
        } catch ApiError.api(let status, let code, _) {
            XCTAssertEqual(status, 403)
            XCTAssertEqual(code, "page_edit_restricted")
        }
    }

    func testReadsSendTheirETagsAnd304IsNil() async throws {
        var seen: [(String, String?)] = []
        StubProtocol.handler = { [pageJSON] request in
            let tag = request.value(forHTTPHeaderField: "If-None-Match")
            seen.append((request.url!.path + "?" + (request.url!.query ?? ""), tag))
            if request.url!.path == "/api/v1/wiki/tree" {
                return tag == "\"t\"" ? (304, Data()) : (200, Data(#"{"pages":[],"cursor":5}"#.utf8))
            }
            if request.url!.path == "/api/v1/wiki/changes" { return (200, Data(#"{"pages":[],"removed":["x"],"cursor":6,"reset":false}"#.utf8)) }
            let page = String(pageJSON.dropLast()) + #","breadcrumbs":[{"id":null,"title":null,"icon":null,"readable":false}],"children":[]}"#
            return tag == "\"v3-edit\"" ? (304, Data()) : (200, Data(page.utf8))
        }
        defer { StubProtocol.handler = nil }
        let client = makeClient()
        let tree = try await client.wikiTree(etag: nil)
        XCTAssertEqual(tree?.tree.cursor, 5)
        let same = try await client.wikiTree(etag: "\"t\"")
        XCTAssertNil(same)
        let changes = try await client.wikiChanges(since: 5)
        XCTAssertEqual(changes.removed, ["x"])
        let page = try await client.getPage(id: "p1", etag: nil)
        XCTAssertEqual(page?.breadcrumbs.first?.readable, false)
        let current = try await client.getPage(id: "p1", etag: WikiSaverApi.etag(version: 3, level: .edit))
        XCTAssertNil(current)
        XCTAssertEqual(seen.map(\.1), [nil, "\"t\"", nil, nil, "\"v3-edit\""])
        XCTAssertEqual(seen[2].0, "/api/v1/wiki/changes?since=5")
        XCTAssertNil(WikiSaverApi.etag(version: nil, level: .edit))
    }

    func testPageSearchSendsTheWordsPersonAndDatesButNoConversation() {
        var params = SearchParams(q: "in:手順 GPU", fromUserId: "u1", channelId: "c1")
        params.has = [.file]
        let names = SearchLogic.request(params).pageQueryItems(limit: 20, offset: 40).map(\.name)
        XCTAssertTrue(names.contains("q"))
        XCTAssertTrue(names.contains("from_user_id"))
        XCTAssertFalse(names.contains("channel_id"))
        XCTAssertFalse(names.contains("has"))
        XCTAssertTrue(SearchRequest.pageEmptyCheck(SearchLogic.request(SearchParams())))
    }
}

private extension SearchRequest {
    static func pageEmptyCheck(_ request: SearchRequest) -> Bool { request.pageIsEmpty }
}
