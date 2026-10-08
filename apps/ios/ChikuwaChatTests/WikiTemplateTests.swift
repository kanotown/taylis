import XCTest
@testable import ChikuwaChat

/// M146 (docs/WIKI.md §22.3 / §24.3): templates and duplicates on the phone — decoding GET /wiki/templates and a
/// database's row templates, the request bodies (create from a template, apply-template, duplicate, a new row), one
/// client_save_id per intent (a retry and the move to the top level reuse it), the template banner and the rules of what
/// is offered, 「今日」 / 「自分」 in a row template's cells, and templates kept out of the tree.

private func item(_ id: String, kind: String = "page", parent: String? = nil, level: WikiLevel = .edit, template: Bool = false,
                  version: Int = 1) -> WikiPageItem {
    WikiPageItem(id: id, parentId: parent, kind: kind, title: id, version: version, headRevId: "r-\(id)-\(version)", myLevel: level,
                 isTemplate: template)
}

private func out(_ item: WikiPageItem, body: String = "") -> WikiPageOut {
    WikiPageOut(content: WikiPageContent(item: item, body: body))
}

final class WikiTemplateModelTests: XCTestCase {
    func testTemplatesDecodeWithTheirKindAndHiddenBuiltinsAreLeftOut() throws {
        let json = ##"""
        {"pages":[{"id":"t1","parent_id":null,"position":"a0","kind":"page","title":"週報","icon":"📝","version":2,"head_rev_id":"h",
          "meta_seq":3,"inherit_access":false,"task_total":0,"task_done":0,"created_by":"u1","updated_by":"u1","created_at":"",
          "updated_at":"","deleted_at":null,"is_template":true,"my_level":"full","private":false}],
         "builtins":[{"id":"b1","key":"weekly","name":"週報","description":"毎週の報告","title":"週報 {{week}}","body":"# 今週",
          "position":1,"builtin":true,"hidden":false,"updated_at":"2026-10-08T00:00:00Z"},
          {"id":"b2","key":"old","name":"古い","description":null,"title":"","body":"","position":2,"builtin":true,"hidden":true,
          "updated_at":"2026-10-08T00:00:00Z"}]}
        """##
        let out = try JSON.snakeDecoder.decode(WikiTemplatesOut.self, from: Data(json.utf8))
        XCTAssertEqual(out.pages.map(\.id), ["t1"])
        XCTAssertTrue(out.pages[0].isTemplate)
        XCTAssertEqual(out.builtins.map(\.key), ["weekly"])
        // An older server: no `is_template` on a page, no `builtins`.
        let older = try JSON.snakeDecoder.decode(WikiTemplatesOut.self, from: Data(#"{"pages":[]}"#.utf8))
        XCTAssertEqual(older, WikiTemplatesOut())
        let page = try JSON.snakeDecoder.decode(WikiPageItem.self, from: Data(
            #"{"id":"p","kind":"page","title":"x","version":1,"head_rev_id":"h","my_level":"edit","private":false}"#.utf8))
        XCTAssertFalse(page.isTemplate)
        // Kept on the device and read back (the plain coder of the offline copy).
        let kept = try JSON.plainDecoder.decode(WikiPageItem.self, from: JSON.plainEncoder.encode(out.pages[0]))
        XCTAssertTrue(kept.isTemplate)
    }

    func testADatabaseNamesItsRowTemplatesAndItsDefault() throws {
        let json = #"{"page_id":"db1","schema_version":2,"properties":[],"views":[],"my_level":"edit","row_count":3,"limits":{},"templates":[{"id":"t1","title":"実験ノート","icon":"🧪"},{"id":"t2","title":"","icon":null}],"default_template_id":"t1"}"#
        let db = try JSON.snakeDecoder.decode(WikiDatabase.self, from: Data(json.utf8))
        XCTAssertEqual(db.templates.map(\.id), ["t1", "t2"])
        XCTAssertEqual(db.defaultTemplate?.title, "実験ノート")
        XCTAssertEqual(db.templates[1].displayTitle, "無題")
        // A default that is gone (in the trash: the server sends null; an unknown id reads the same).
        var other = db
        other.defaultTemplateId = "gone"
        XCTAssertNil(other.defaultTemplate)
        // An older server: none.
        let older = try JSON.snakeDecoder.decode(WikiDatabase.self, from: Data(#"{"page_id":"db1","properties":[],"views":[],"my_level":"view"}"#.utf8))
        XCTAssertEqual(older.templates, [])
        XCTAssertNil(older.defaultTemplateId)
    }

    func testRequestBodies() {
        // A page from a page template / a built-in, with the zone; blank sends neither.
        let fromPage = WikiPageCreate(parentId: "p", title: nil, icon: nil, clientSaveId: "k1", tz: "Asia/Tokyo", template: .page(id: "t1"))
        XCTAssertEqual(fromPage.json, .object(["client_save_id": .string("k1"), "kind": .string("page"), "parent_id": .string("p"),
                                               "tz": .string("Asia/Tokyo"), "template_page_id": .string("t1")]))
        let fromBuiltin = WikiPageCreate(parentId: nil, title: "議事録", icon: nil, access: "private", clientSaveId: "k2", tz: "Asia/Tokyo",
                                         template: .builtin(key: "minutes"))
        XCTAssertEqual(fromBuiltin.json, .object(["client_save_id": .string("k2"), "kind": .string("page"), "access": .string("private"),
                                                  "title": .string("議事録"), "tz": .string("Asia/Tokyo"), "template_key": .string("minutes")]))
        let blank = WikiPageCreate(parentId: "p", title: nil, icon: nil, clientSaveId: "k3", tz: nil)
        XCTAssertEqual(blank.json, .object(["client_save_id": .string("k3"), "kind": .string("page"), "parent_id": .string("p")]))
        // apply-template.
        XCTAssertEqual(WikiTemplateApply(template: .builtin(key: "weekly"), clientSaveId: "k4", tz: "Asia/Tokyo").json,
                       .object(["template_key": .string("weekly"), "client_save_id": .string("k4"), "tz": .string("Asia/Tokyo")]))
        // Duplicate: beside the original (only the key), or the top level (parent_id null).
        XCTAssertEqual(WikiDuplicate(clientSaveId: "k5").json, .object(["client_save_id": .string("k5")]))
        XCTAssertEqual(WikiDuplicate(clientSaveId: "k5", topLevel: true).json, .object(["client_save_id": .string("k5"), "parent_id": .null]))
        // A new row: nothing named (the server's default), a template, or blank.
        let props: [String: JSONValue] = ["due": .object(["start": .string("2026-10-08")])]
        XCTAssertEqual(DbRowCreate(title: "", props: props, clientSaveId: "k6", tz: "Asia/Tokyo").json,
                       .object(["title": .string(""), "props": .object(props), "client_save_id": .string("k6"), "tz": .string("Asia/Tokyo")]))
        XCTAssertEqual(DbRowCreate(title: "a", start: .template("t1"), clientSaveId: "k7", tz: nil).json,
                       .object(["title": .string("a"), "props": .object([:]), "client_save_id": .string("k7"), "template_id": .string("t1")]))
        XCTAssertEqual(DbRowCreate(title: "a", start: .blank, clientSaveId: "k8", tz: nil).json,
                       .object(["title": .string("a"), "props": .object([:]), "client_save_id": .string("k8"), "blank": .bool(true)]))
    }

    func testTheBannerAndWhatIsOffered() {
        XCTAssertNil(WikiText.templateBanner(nil))
        XCTAssertNil(WikiText.templateBanner(item("p")))
        XCTAssertTrue(WikiText.templateBanner(item("t", template: true))?.hasPrefix("ページのテンプレート") ?? false)
        let rowBanner = WikiText.templateBanner(item("r", kind: "row", template: true)) ?? ""
        XCTAssertTrue(rowBanner.hasPrefix("データベースの行のテンプレート"))
        XCTAssertTrue(rowBanner.contains("「今日」"))
        // 「複製」: a page (even read only: the copy goes where I can write), a row I can edit, never a database or a guest.
        XCTAssertTrue(WikiText.canDuplicate(item("p", level: .view), isGuest: false))
        XCTAssertFalse(WikiText.canDuplicate(item("p"), isGuest: true))
        XCTAssertTrue(WikiText.canDuplicate(item("r", kind: "row"), isGuest: false))
        XCTAssertFalse(WikiText.canDuplicate(item("r", kind: "row", level: .view), isGuest: false))
        XCTAssertFalse(WikiText.canDuplicate(item("d", kind: "database", level: .full), isGuest: false))
        XCTAssertFalse(WikiText.canDuplicate(nil, isGuest: false))
    }

    func testARowTemplatesDynamicValuesReadAsTodayAndMe() {
        let due = DbProperty(id: "due", name: "期限", type: "date")
        let owner = DbProperty(id: "own", name: "担当", type: "person")
        let names: WikiDb.Names = { ["u1": "加納"][$0] ?? "?" }
        let row = DbRow(id: "t", databaseId: "db1", title: "テンプレ", props: ["due": WikiDb.todayValue, "own": .array([.string("@me"), .string("u1")])])
        XCTAssertEqual(WikiDb.text(due, row, refs: [:], names: names), "今日")
        XCTAssertEqual(WikiDb.text(owner, row, refs: [:], names: names), "自分, 加納")
        // The plain "@today" the server also takes.
        let plain = DbRow(id: "t2", databaseId: "db1", title: "", props: ["due": .string("@today")])
        XCTAssertEqual(WikiDb.text(due, plain, refs: [:], names: names), "今日")
        XCTAssertTrue(WikiDb.isToday(.object(["start": .string("@today"), "end": .null])))
        XCTAssertFalse(WikiDb.isToday(.object(["start": .string("2026-10-08")])))
        XCTAssertFalse(WikiDb.isToday(nil))
    }

    func testTheNewRowsWordsFollowWhatItStartsFrom() {
        let db = WikiDatabase(pageId: "db1", properties: [], views: [],
                              templates: [DbTemplateRef(id: "t1", title: "実験ノート"), DbTemplateRef(id: "t2", title: "会議")], defaultTemplateId: "t1")
        XCTAssertTrue(WikiDbText.newRowMessage(.standard, database: db).contains("既定のテンプレート「実験ノート」"))
        XCTAssertTrue(WikiDbText.newRowMessage(.template("t2"), database: db).hasPrefix("「会議」から"))
        XCTAssertEqual(WikiDbText.newRowMessage(.blank, database: db), "名前を付けて行を作ります。作ると行のページが開きます。")
        XCTAssertEqual(WikiDbText.newRowMessage(.standard, database: nil), "名前を付けて行を作ります。作ると行のページが開きます。")
    }

    func testTemplatesStayOutOfTheTree() {
        var tree = WikiTree(pages: [item("a"), item("t", template: true)], cursor: 1)
        XCTAssertEqual(tree.pages.keys.sorted(), ["a"])
        // A template opened (a link, the create sheet) is not upserted; a page that became one leaves.
        tree.upsert(item("t2", template: true))
        XCTAssertNil(tree.page("t2"))
        tree.upsert(item("a", template: true, version: 2))
        XCTAssertNil(tree.page("a"))
        _ = tree.apply(WikiChangesOut(pages: [item("b"), item("t3", template: true)], cursor: 2))
        XCTAssertEqual(tree.pages.keys.sorted(), ["b"])
    }
}

@MainActor
final class WikiTemplateHubTests: XCTestCase {
    private func hub(_ api: FakeWikiApi) -> WikiHub {
        WikiHub(api: api, store: Store(), options: CanvasSaverOptions(debounce: 2, refreshDebounce: 0, retryDelays: [1]), feedDelay: 0)
    }

    func testCreatingFromATemplateSendsItOnce() async throws {
        let api = FakeWikiApi()
        api.templates = WikiTemplatesOut(pages: [item("t1", template: true)])
        let hub = hub(api)
        await hub.bootstrap(WikiBootstrap(changeSeq: 0))
        let listed = try await hub.templates()
        XCTAssertEqual(listed.pages.map(\.id), ["t1"])
        _ = try await hub.create(parentId: nil, title: nil, icon: nil, access: "workspace", clientSaveId: "k1", template: .page(id: "t1"))
        XCTAssertEqual(api.creates.first?.template, .page(id: "t1"))
        XCTAssertEqual(api.creates.first?.json["template_page_id"], .string("t1"))
        XCTAssertNotNil(api.creates.first?.json["tz"])
    }

    func testDuplicateBesideThenAtTheTopLevelWithTheSameKey() async throws {
        let api = FakeWikiApi()
        let original = item("p", parent: "parent")
        api.tree = [item("parent", level: .view), original]
        api.pages["p"] = out(original, body: "# 本文")
        api.parentRestricted = ["p"]
        let hub = hub(api)
        await hub.bootstrap(WikiBootstrap(changeSeq: 0))
        // The parent is read only: the copy cannot go beside the original; the screen offers the top level.
        let first = try await hub.duplicate("p", clientSaveId: "dup-1")
        XCTAssertEqual(first, .parentRestricted)
        guard case .made(let copy) = try await hub.duplicate("p", clientSaveId: "dup-1", topLevel: true) else { return XCTFail("no copy") }
        XCTAssertNil(copy.item.parentId)
        XCTAssertEqual(copy.item.title, "p（コピー）")
        XCTAssertEqual(api.duplicates.map(\.duplicate.clientSaveId), ["dup-1", "dup-1"])
        XCTAssertEqual(api.duplicates.map(\.duplicate.topLevel), [false, true])
        XCTAssertNotNil(hub.tree?.page(copy.id))
        // A retry of the same duplicate (the answer was lost) answers the first copy: no second one.
        guard case .made(let again) = try await hub.duplicate("p", clientSaveId: "dup-1", topLevel: true) else { return XCTFail("no copy") }
        XCTAssertEqual(again.id, copy.id)
        XCTAssertEqual(api.copies.count, 1)
    }

    func testARowsRefusedDuplicateIsAnErrorAndNotAMoveToTheTopLevel() async throws {
        let api = FakeWikiApi()
        let row = item("r", kind: "row", parent: "db")
        api.pages["r"] = out(row)
        api.parentRestricted = ["r"]
        let hub = hub(api)
        hub.received(out(row))
        do {
            _ = try await hub.duplicate("r", clientSaveId: "k")
            XCTFail("a row's copy stays in its database")
        } catch ApiError.api(let status, let code, _) {
            XCTAssertEqual(status, 403)
            XCTAssertEqual(code, "page_edit_restricted")
        }
    }

    func testStartingAnEmptyPageFromATemplateReadsTheNewBody() async throws {
        let api = FakeWikiApi()
        let empty = item("p", version: 1)
        api.tree = [empty]
        api.pages["p"] = out(empty)
        let hub = hub(api)
        await hub.bootstrap(WikiBootstrap(changeSeq: 0))
        let saver = try XCTUnwrap(hub.hold("p"))
        await saver.settled()
        XCTAssertEqual(saver.text, "")
        try await hub.applyTemplate("p", template: .builtin(key: "weekly"), clientSaveId: "a1")
        XCTAssertEqual(api.applies.first?.apply.json["template_key"], .string("weekly"))
        XCTAssertEqual(api.applies.first?.apply.clientSaveId, "a1")
        XCTAssertEqual(saver.text, "# テンプレートから")
        XCTAssertEqual(hub.item("p")?.version, 2)
        // Not empty any more: 409 wiki_page_not_empty comes back as the error.
        do {
            try await hub.applyTemplate("p", template: .builtin(key: "weekly"), clientSaveId: "a2")
            XCTFail("only an empty page")
        } catch ApiError.api(let status, let code, _) {
            XCTAssertEqual(status, 409)
            XCTAssertEqual(code, "wiki_page_not_empty")
            XCTAssertEqual(ErrorMessages.text(for: ApiError.api(status: status, code: code, message: "")).isEmpty, false)
        }
        hub.release("p")
    }

    func testANewRowNamesItsTemplateWithOneKey() async throws {
        let api = FakeWikiDbApi()
        let model = WikiDatabaseModel(databaseId: "db1", api: api, store: Store(), reloadDelay: 0)
        await model.load()
        _ = try await model.createRow(title: "", start: .template("t1"), clientSaveId: "k1")
        _ = try await model.createRow(title: "", start: .template("t1"), clientSaveId: "k1")
        _ = try await model.createRow(title: "白紙", start: .blank, clientSaveId: "k2")
        _ = try await model.createRow(title: "既定", clientSaveId: "k3")
        XCTAssertEqual(api.createBodies.map(\.clientSaveId), ["k1", "k1", "k2", "k3"])
        XCTAssertEqual(api.createBodies.map(\.start), [.template("t1"), .template("t1"), .blank, .standard])
        XCTAssertEqual(model.rows.filter { $0.id == "new-k1" }.count, 1)
        model.stop()
    }
}

@MainActor
final class WikiTemplateApiTests: XCTestCase {
    private func makeClient() -> ApiClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "a"
        return client
    }

    private static func body(_ request: URLRequest) -> JSONValue? {
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
        stream.close()
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    func testTheCallsGoToTheTemplateEndpoints() async throws {
        let page = ##"{"id":"c1","parent_id":null,"position":"a0","kind":"page","title":"手順（コピー）","icon":null,"version":1,"head_rev_id":"r1","meta_seq":4,"inherit_access":true,"task_total":0,"task_done":0,"created_by":"u1","updated_by":"u1","created_at":"","updated_at":"","deleted_at":null,"is_template":false,"my_level":"full","private":false,"body":"# 手順","breadcrumbs":[],"children":[]}"##
        let rowJSON = #"{"id":"r9","database_id":"db1","title":"t","icon":null,"position":"a0","version":1,"head_rev_id":"h","props":{},"relations":{},"hidden_relations":[],"created_at":"","created_by":"u","updated_at":"","updated_by":"u"}"#
        var seen: [(String, JSONValue?)] = []
        StubProtocol.handler = { request in
            let url = request.url!
            seen.append((request.httpMethod! + " " + url.path, Self.body(request)))
            switch url.path {
            case "/api/v1/wiki/templates": return (200, Data(#"{"pages":[],"builtins":[]}"#.utf8))
            case "/api/v1/wiki/pages/p1/duplicate": return (201, Data(#"{"page":\#(page),"row":null}"#.utf8))
            case "/api/v1/wiki/databases/db1/rows": return (201, Data(#"{"row":\#(rowJSON),"refs":[]}"#.utf8))
            default: return (200, Data(page.utf8))
            }
        }
        defer { StubProtocol.handler = nil }
        let client = makeClient()
        let templates = try await client.wikiTemplates()
        XCTAssertEqual(templates, WikiTemplatesOut())
        XCTAssertEqual(seen.last?.0, "GET /api/v1/wiki/templates")
        let applied = try await client.applyTemplate(pageId: "p1", WikiTemplateApply(template: .page(id: "t1"), clientSaveId: "k1", tz: "UTC"))
        XCTAssertEqual(applied.id, "c1")
        XCTAssertEqual(seen.last?.0, "POST /api/v1/wiki/pages/p1/apply-template")
        XCTAssertEqual(seen.last?.1, .object(["template_page_id": .string("t1"), "client_save_id": .string("k1"), "tz": .string("UTC")]))
        let copy = try await client.duplicatePage(id: "p1", WikiDuplicate(clientSaveId: "k2", topLevel: true))
        XCTAssertEqual(copy.page.item.title, "手順（コピー）")
        XCTAssertNil(copy.row)
        XCTAssertEqual(seen.last?.0, "POST /api/v1/wiki/pages/p1/duplicate")
        XCTAssertEqual(seen.last?.1, .object(["client_save_id": .string("k2"), "parent_id": .null]))
        let made = try await client.createRow(databaseId: "db1", DbRowCreate(title: "", start: .blank, clientSaveId: "k3", tz: "UTC"))
        XCTAssertEqual(made.row.id, "r9")
        XCTAssertEqual(seen.last?.1, .object(["title": .string(""), "props": .object([:]), "client_save_id": .string("k3"), "blank": .bool(true),
                                              "tz": .string("UTC")]))
    }
}
