import XCTest
@testable import ChikuwaChat

/// M148 (docs/WIKI.md §22.4, §25): database views on the phone — the view settings and grouped answers decoded, the
/// groups' names, the sections, a board card's value when it moves and the move's request and op id, the query a view
/// sends (grouped, tz, covers), the names of unnamed views and who may move cards.

private let ja = Locale(identifier: "ja_JP")
private let tokyo = TimeZone(identifier: "Asia/Tokyo")!

private let titleProp = DbProperty(id: "title", name: "", type: "title")
private let stage = DbProperty(id: "st", name: "段階", type: "select",
                               options: [DbOption(id: "o1", name: "未着手", color: "gray"), DbOption(id: "o2", name: "進行中", color: "blue"),
                                         DbOption(id: "o3", name: "完了", color: "green")])
private let owner = DbProperty(id: "own", name: "担当", type: "person")
private let done = DbProperty(id: "ok", name: "済", type: "checkbox")
private let tags = DbProperty(id: "tg", name: "タグ", type: "multi_select", options: [DbOption(id: "t1", name: "実験"), DbOption(id: "t2", name: "執筆")])
private let due = DbProperty(id: "due", name: "期限", type: "date")

private let names: WikiDb.Names = { ["u1": "加納", "u2": "海老"][$0] ?? tr("メンバー") }

private func row(_ id: String, _ props: [String: JSONValue] = [:]) -> DbRow {
    DbRow(id: id, databaseId: "db1", title: id, props: props, createdAt: "2026-10-01T00:00:00Z", createdBy: "u1",
          updatedAt: "2026-10-02T00:00:00Z", updatedBy: "u1")
}

private let boardView = DbView(id: "vb", type: "board", groupBy: DbGroupBy(propId: "st"))
private let galleryView = DbView(id: "vg", type: "gallery")
private let listView = DbView(id: "vl", type: "list", groupBy: DbGroupBy(propId: "tg"))

private func database(level: WikiLevel = .edit, views: [DbView]) -> WikiDatabase {
    WikiDatabase(pageId: "db1", schemaVersion: 3, properties: [titleProp, stage, owner, done, tags, due], views: views, myLevel: level)
}

final class WikiDbViewDecodingTests: XCTestCase {
    func testViewSettingsGroupedAnswersAndCoversDecode() throws {
        let views = #"""
        [{"id":"vb","name":"","type":"board","columns":[],"sort":[],"filter":null,"date_prop_id":null,
          "group_by":{"prop_id":"st","date_unit":null,"hidden":["o3"],"hide_empty":true},"cover":"body","card_size":"large"},
         {"id":"vt","name":"","type":"table","columns":[{"prop_id":"title","width":280,"hidden":false}]}]
        """#
        let decoded = try JSON.snakeDecoder.decode([DbView].self, from: Data(views.utf8))
        XCTAssertEqual(decoded[0].groupBy, DbGroupBy(propId: "st", hidden: ["o3"], hideEmpty: true))
        XCTAssertTrue(decoded[0].isBoard)
        XCTAssertEqual(decoded[0].cardSize, "large")
        // A view of a server before M147: no groups, the defaults.
        XCTAssertNil(decoded[1].groupBy)
        XCTAssertEqual(decoded[1].cover, "body")
        XCTAssertEqual(decoded[1].cardSize, "medium")
        XCTAssertFalse(decoded[1].showsCovers)

        let answer = #"""
        {"rows":[{"id":"r1","database_id":"db1","title":"a","icon":null,"position":"a0","version":1,"head_rev_id":"h","props":{"st":"o1"},
                  "relations":{},"hidden_relations":[],"created_at":"","created_by":"u","updated_at":"","updated_by":"u",
                  "cover":{"attachment_id":"9a7c0d4e-0000-4000-8000-000000000001","thumbnail":true,"width":640,"height":480}},
                 {"id":"r2","database_id":"db1","title":"b","icon":null,"position":"a1","version":1,"head_rev_id":"h","props":{},
                  "relations":{},"hidden_relations":[],"created_at":"","created_by":"u","updated_at":"","updated_by":"u","cover":null}],
         "refs":[],"total":2,"next_cursor":null,"schema_version":3,
         "groups":[{"key":"o1","count":1,"hidden":false},{"key":"o3","count":4,"hidden":true},{"key":"","count":1,"hidden":false}],
         "row_groups":["o1",""]}
        """#
        let out = try JSON.snakeDecoder.decode(DbQueryOut.self, from: Data(answer.utf8))
        XCTAssertEqual(out.groups?.map(\.key), ["o1", "o3", ""])
        XCTAssertEqual(out.groups?[1], DbRowGroup(key: "o3", count: 4, hidden: true))
        XCTAssertEqual(out.rowGroups, ["o1", ""])
        XCTAssertEqual(out.rows[0].cover, DbRowCover(attachmentId: "9a7c0d4e-0000-4000-8000-000000000001", thumbnail: true, width: 640, height: 480))
        XCTAssertEqual(out.rows[0].cover?.path, "/api/v1/attachments/9a7c0d4e-0000-4000-8000-000000000001/thumbnail")
        XCTAssertEqual(DbRowCover(attachmentId: "x", thumbnail: false).path, "/api/v1/attachments/x/content?inline=1")
        XCTAssertNil(out.rows[1].cover)
        // Before M147: no groups.
        let old = try JSON.snakeDecoder.decode(DbQueryOut.self, from: Data(#"{"rows":[],"refs":[],"total":0,"next_cursor":null,"schema_version":1}"#.utf8))
        XCTAssertNil(old.groups)
        XCTAssertNil(old.rowGroups)
    }

    func testUnnamedViewsAreNamedByTheirType() {
        XCTAssertEqual(DbView(id: "a", type: "board").displayName, tr("ボード"))
        XCTAssertEqual(DbView(id: "b", type: "list").displayName, tr("リスト"))
        XCTAssertEqual(DbView(id: "c", type: "gallery").displayName, tr("ギャラリー"))
        XCTAssertEqual(DbView(id: "d", type: "calendar").displayName, tr("カレンダー"))
        XCTAssertEqual(DbView(id: "e", type: "table").displayName, tr("表"))
        XCTAssertEqual(DbView(id: "f", type: "timeline").displayName, tr("表"))
        XCTAssertEqual(DbView(id: "g", name: "  進み具合 ", type: "board").displayName, "進み具合")
        XCTAssertNotEqual(DbView(id: "a", type: "board").displayName, tr("表"))
        XCTAssertNotEqual(DbView(id: "a", type: "board").symbol, DbView(id: "b", type: "gallery").symbol)
    }
}

final class WikiDbGroupTests: XCTestCase {
    func testGroupNames() {
        XCTAssertEqual(WikiDb.groupName(stage, key: "o2", unit: nil, names: names), "進行中")
        XCTAssertEqual(WikiDb.groupName(stage, key: "", unit: nil, names: names), tr("なし"))
        XCTAssertEqual(WikiDb.groupName(stage, key: "gone", unit: nil, names: names), tr("なし"))
        XCTAssertEqual(WikiDb.groupOption(stage, key: "o2")?.name, "進行中")
        XCTAssertNil(WikiDb.groupOption(stage, key: ""))
        XCTAssertEqual(WikiDb.groupName(tags, key: "t1", unit: nil, names: names), "実験")
        XCTAssertEqual(WikiDb.groupName(owner, key: "u2", unit: nil, names: names), "海老")
        XCTAssertEqual(WikiDb.groupName(owner, key: "", unit: nil, names: names), tr("なし"))
        XCTAssertEqual(WikiDb.groupName(DbProperty(id: "cb", name: "", type: "created_by"), key: "u1", unit: nil, names: names), "加納")
        // A checkbox's groups are its two states ("" never comes for one).
        XCTAssertEqual(WikiDb.groupName(done, key: "true", unit: nil, names: names), tr("オン"))
        XCTAssertEqual(WikiDb.groupName(done, key: "false", unit: nil, names: names), tr("オフ"))
        // Dates: a day, a week by its Monday, a month.
        XCTAssertEqual(WikiDb.groupName(due, key: "2026-10-07", unit: nil, names: names, locale: ja), "2026/10/07")
        XCTAssertEqual(WikiDb.groupName(due, key: "2026-10-05", unit: "week", names: names, locale: ja), tr("\("2026/10/05") の週"))
        XCTAssertEqual(WikiDb.groupName(due, key: "2026-10", unit: "month", names: names, locale: ja), "2026年10月")
        XCTAssertEqual(WikiDb.groupName(due, key: "", unit: "month", names: names, locale: ja), tr("なし"))
    }

    func testSectionsFollowTheServersGroupsWithoutTheHiddenOnes() {
        let a = row("a", ["tg": .array([.string("t1"), .string("t2")])])
        let b = row("b", ["tg": .array([.string("t2")])])
        let c = row("c")
        let groups = [DbRowGroup(key: "t1", count: 1), DbRowGroup(key: "t2", count: 2), DbRowGroup(key: "x", count: 3, hidden: true),
                      DbRowGroup(key: "", count: 1)]
        let sections = WikiDb.sections(groups: groups, rows: [a, a, b, c], rowGroups: ["t1", "t2", "t2", ""])
        XCTAssertEqual(sections.map(\.key), ["t1", "t2", ""])
        XCTAssertEqual(sections.map { $0.rows.map(\.id) }, [["a"], ["a", "b"], ["c"]])
        XCTAssertEqual(sections.map(\.count), [1, 2, 1])
        // An empty group (no rows) still shows with its count.
        let empty = WikiDb.sections(groups: [DbRowGroup(key: "o1", count: 0), DbRowGroup(key: "o2", count: 1)], rows: [c], rowGroups: ["o2"])
        XCTAssertEqual(empty.map { $0.rows.count }, [0, 1])
        XCTAssertEqual(WikiDb.moveTargets(sections, from: "t2").map(\.key), ["t1", ""])
    }

    func testTheGroupPropertyOfAView() {
        let db = database(views: [boardView])
        XCTAssertEqual(WikiDb.groupProperty(db, view: boardView)?.id, "st")
        XCTAssertEqual(WikiDb.groupProperty(db, view: listView)?.id, "tg")
        XCTAssertNil(WikiDb.groupProperty(db, view: galleryView))
        // A board may not group by a multi-select; a deleted property or a calendar groups nothing.
        XCTAssertNil(WikiDb.groupProperty(db, view: DbView(id: "x", type: "board", groupBy: DbGroupBy(propId: "tg"))))
        XCTAssertNil(WikiDb.groupProperty(db, view: DbView(id: "y", type: "table", groupBy: DbGroupBy(propId: "gone"))))
        XCTAssertNil(WikiDb.groupProperty(db, view: DbView(id: "z", type: "calendar", datePropId: "due", groupBy: DbGroupBy(propId: "st"))))
    }

    func testABoardCardsValueWhenItMoves() {
        // A select takes the column's option; 「なし」 clears it.
        XCTAssertEqual(WikiDb.boardValue(stage, row("r", ["st": .string("o1")]), from: "o1", to: "o2"), .string("o2"))
        XCTAssertEqual(WikiDb.boardValue(stage, row("r", ["st": .string("o1")]), from: "o1", to: ""), .null)
        XCTAssertEqual(WikiDb.boardValue(stage, row("r"), from: "", to: "o3"), .string("o3"))
        // A checkbox takes the column's state.
        XCTAssertEqual(WikiDb.boardValue(done, row("r"), from: "false", to: "true"), .bool(true))
        XCTAssertEqual(WikiDb.boardValue(done, row("r", ["ok": .bool(true)]), from: "true", to: "false"), .bool(false))
        // A person: the column's person out, the new one in (the others stay); 「なし」 clears it.
        let both = row("r", ["own": .array([.string("u1"), .string("u2")])])
        XCTAssertEqual(WikiDb.boardValue(owner, both, from: "u1", to: "u3"), .array([.string("u2"), .string("u3")]))
        XCTAssertEqual(WikiDb.boardValue(owner, both, from: "u1", to: "u2"), .array([.string("u2")]))
        XCTAssertEqual(WikiDb.boardValue(owner, both, from: "u1", to: ""), .null)
        XCTAssertEqual(WikiDb.boardValue(owner, row("r"), from: "", to: "u1"), .array([.string("u1")]))
    }
}

@MainActor
final class WikiDbViewModelTests: XCTestCase {
    private func api(_ views: [DbView], level: WikiLevel = .edit) -> FakeWikiDbApi {
        let api = FakeWikiDbApi()
        api.database = database(level: level, views: views)
        api.rows = [row("r1", ["st": .string("o1")]), row("r2", ["st": .string("o2")]), row("r3")]
        api.grouping = { [$0.props["st"]?.stringValue ?? ""] }
        api.groupOrder = ["o1", "o2", "o3", ""]
        return api
    }

    func testEachViewSendsItsQuery() async {
        let api = api([boardView, galleryView, DbView(id: "vt"), DbView(id: "vn", type: "gallery", cover: "none"), listView])
        let model = WikiDatabaseModel(databaseId: "db1", api: api, store: Store(), zone: tokyo, reloadDelay: 0)
        await model.load()
        // A grouped view: grouped, the device's zone, 1,000 rows.
        XCTAssertEqual(api.queries.last?.grouped, true)
        XCTAssertEqual(api.queries.last?.tz, "Asia/Tokyo")
        XCTAssertEqual(api.queries.last?.limit, 1000)
        XCTAssertFalse(api.queries.last?.covers ?? true)
        XCTAssertEqual(api.queries.last?.json["grouped"], .bool(true))
        XCTAssertEqual(api.queries.last?.json["tz"], .string("Asia/Tokyo"))
        XCTAssertEqual(model.sections?.map(\.key), ["o1", "o2", "o3", ""])
        XCTAssertEqual(model.sections?.map { $0.rows.map(\.id) }, [["r1"], ["r2"], [], ["r3"]])
        // A gallery asks for the pictures, not for groups.
        await model.select(view: "vg")
        XCTAssertEqual(api.queries.last?.covers, true)
        XCTAssertEqual(api.queries.last?.json["covers"], .bool(true))
        XCTAssertNil(api.queries.last?.grouped)
        XCTAssertNil(model.sections)
        // A table without groups: the query as before M147.
        await model.select(view: "vt")
        XCTAssertEqual(api.queries.last?.json, .object(["view_id": .string("vt"), "limit": .number(100)]))
        // A gallery without pictures.
        await model.select(view: "vn")
        XCTAssertFalse(api.queries.last?.covers ?? true)
    }

    func testABoardCardMovesAtOnceWithOneOpIdAcrossRetries() async throws {
        let api = api([boardView])
        let model = WikiDatabaseModel(databaseId: "db1", api: api, store: Store(), zone: tokyo, reloadDelay: 0)
        await model.load()
        XCTAssertTrue(model.canMoveCards)
        api.moveFailures = [ApiError.network(URLError(.timedOut)), ApiError.api(status: 503, code: "unavailable", message: "")]
        let r1 = try XCTUnwrap(model.rows.first { $0.id == "r1" })
        try await model.move(r1, from: "o1", to: "o3", opId: "op-1", delays: [0, 0, 0])
        XCTAssertEqual(api.moves.count, 3)
        XCTAssertEqual(Set(api.moves.map(\.move.clientOpId)), ["op-1"])
        XCTAssertEqual(api.moves.last?.rowId, "r1")
        XCTAssertEqual(api.moves.last?.move.json, .object(["set": .object(["st": .string("o3")]), "client_op_id": .string("op-1")]))
        // On screen at once (then read again: the server's groups).
        XCTAssertEqual(model.sections?.first { $0.key == "o3" }?.rows.map(\.id), ["r1"])
        await model.settled()
        XCTAssertEqual(api.rows.first { $0.id == "r1" }?.props["st"], .string("o3"))
        XCTAssertEqual(model.sections?.map { $0.rows.map(\.id) }, [[], ["r2"], ["r1"], ["r3"]])
        XCTAssertEqual(model.sections?.map(\.count), [0, 1, 1, 1])
        // To 「なし」: the value is cleared.
        let r2 = try XCTUnwrap(model.rows.first { $0.id == "r2" })
        try await model.move(r2, from: "o2", to: "", opId: "op-2", delays: [])
        XCTAssertEqual(api.moves.last?.move.set, ["st": .null])
        // A refusal is not retried and reads the view again.
        api.moveFailures = [ApiError.api(status: 403, code: "page_edit_restricted", message: "")]
        let before = api.queries.count
        let r3 = try XCTUnwrap(model.rows.first { $0.id == "r3" })
        do {
            try await model.move(r3, from: "", to: "o1", opId: "op-3", delays: [0, 0])
            XCTFail("expected the refusal")
        } catch {}
        XCTAssertEqual(api.moves.filter { $0.move.clientOpId == "op-3" }.count, 1)
        XCTAssertGreaterThan(api.queries.count, before)
    }

    func testAPersonCardLeavesItsColumnForTheNewOne() async throws {
        let personBoard = DbView(id: "vp", type: "board", groupBy: DbGroupBy(propId: "own"))
        let api = api([personBoard])
        api.rows = [row("r1", ["own": .array([.string("u1"), .string("u2")])])]
        api.grouping = { WikiDb.strings($0.props["own"]).isEmpty ? [""] : WikiDb.strings($0.props["own"]) }
        api.groupOrder = ["u1", "u2", ""]
        let model = WikiDatabaseModel(databaseId: "db1", api: api, store: Store(), reloadDelay: 0)
        await model.load()
        XCTAssertEqual(model.sections?.map { $0.rows.map(\.id) }, [["r1"], ["r1"], []])
        let card = try XCTUnwrap(model.rows.first)
        // u1 → u2, where the row already is: one card left, in u2.
        try await model.move(card, from: "u1", to: "u2", opId: "op-p", delays: [])
        XCTAssertEqual(api.moves.last?.move.set, ["own": .array([.string("u2")])])
        await model.settled()
        XCTAssertEqual(model.sections?.map { $0.rows.map(\.id) }, [[], ["r1"], []])
    }

    func testOnlyEditorsMoveCardsAndOnlyOnABoard() async throws {
        let viewer = api([boardView], level: .view)
        let model = WikiDatabaseModel(databaseId: "db1", api: viewer, store: Store(), reloadDelay: 0)
        await model.load()
        XCTAssertNotNil(model.sections)
        XCTAssertFalse(model.canMoveCards)
        try await model.move(model.rows[0], from: "o1", to: "o2", opId: "x", delays: [])
        XCTAssertTrue(viewer.moves.isEmpty)
        // A grouped list is not a board: no moves even for an editor.
        let editor = api([listView])
        editor.grouping = { WikiDb.strings($0.props["tg"]).isEmpty ? [""] : WikiDb.strings($0.props["tg"]) }
        editor.groupOrder = ["t1", "t2", ""]
        let list = WikiDatabaseModel(databaseId: "db1", api: editor, store: Store(), reloadDelay: 0)
        await list.load()
        XCTAssertNotNil(list.sections)
        XCTAssertFalse(list.canMoveCards)
    }

    func testTheGroupsAreKeptForOffline() async {
        let store = Store()
        let api = api([boardView])
        let online = WikiDatabaseModel(databaseId: "db1", api: api, store: store, reloadDelay: 0)
        await online.load()
        api.failNetwork = true
        let offline = WikiDatabaseModel(databaseId: "db1", api: api, store: store, reloadDelay: 0)
        await offline.load()
        XCTAssertNotNil(offline.offlineSince)
        XCTAssertEqual(offline.sections?.map { $0.rows.map(\.id) }, [["r1"], ["r2"], [], ["r3"]])
        XCTAssertFalse(offline.canMoveCards)
    }
}

@MainActor
final class WikiDbMoveApiTests: XCTestCase {
    private static func body(_ request: URLRequest) -> JSONValue? {
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
        stream.close()
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    func testTheMoveRequest() async throws {
        let rowJSON = #"{"id":"r1","database_id":"db1","title":"t","icon":null,"position":"a0","version":2,"head_rev_id":"h","props":{"st":"o2"},"relations":{},"hidden_relations":[],"created_at":"","created_by":"u","updated_at":"","updated_by":"u"}"#
        var seen: [(String, JSONValue?)] = []
        StubProtocol.handler = { request in
            seen.append((request.httpMethod! + " " + request.url!.path, Self.body(request)))
            return (200, Data(#"{"row":\#(rowJSON),"refs":[]}"#.utf8))
        }
        defer { StubProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "a"
        let out = try await client.moveRow(rowId: "r1", DbRowMove(set: ["st": .string("o2")], clientOpId: "op-9"))
        XCTAssertEqual(out.row.props["st"], .string("o2"))
        XCTAssertEqual(seen.last?.0, "POST /api/v1/wiki/rows/r1/move")
        XCTAssertEqual(seen.last?.1, .object(["set": .object(["st": .string("o2")]), "client_op_id": .string("op-9")]))
        // A move to 「なし」 sends null for the cell.
        _ = try await client.moveRow(rowId: "r1", DbRowMove(set: ["st": .null], clientOpId: "op-10"))
        XCTAssertEqual(seen.last?.1, .object(["set": .object(["st": .null]), "client_op_id": .string("op-10")]))
    }
}
