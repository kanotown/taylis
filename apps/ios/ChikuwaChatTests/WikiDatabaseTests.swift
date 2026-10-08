import XCTest
@testable import ChikuwaChat

/// M124 (docs/WIKI.md §5.5, §18.2): databases on the phone — the cards' summary, the agenda (multi-day rows, time
/// zones), the cell values per type, the cell write's op id across retries, rows I cannot read, the level rules, the
/// open database's reads (debounced events, the offline copy, the calendar's month) and the request shapes.

private let tokyo = TimeZone(identifier: "Asia/Tokyo")!
private let utc = TimeZone(identifier: "UTC")!
private let newYork = TimeZone(identifier: "America/New_York")!
private let ja = Locale(identifier: "ja_JP")

private let status = DbProperty(id: "st", name: "段階", type: "select",
                                options: [DbOption(id: "o1", name: "実験中", color: "blue"), DbOption(id: "o2", name: "執筆中", color: "green")])
private let due = DbProperty(id: "due", name: "期限", type: "date")
private let owner = DbProperty(id: "own", name: "担当", type: "person")
private let papers = DbProperty(id: "rel_p", name: "論文", type: "relation", relation: DbRelationInfo(databaseId: "db2", databaseTitle: "論文リスト"))
private let note = DbProperty(id: "note", name: "メモ", type: "text")
private let count = DbProperty(id: "n", name: "数", type: "number", numberFormat: "integer")
private let done = DbProperty(id: "ok", name: "済", type: "checkbox")
private let titleProp = DbProperty(id: "title", name: "", type: "title")
private let created = DbProperty(id: "ct", name: "", type: "created_time")

private func database(level: WikiLevel = .edit, views: [DbView]? = nil) -> WikiDatabase {
    WikiDatabase(pageId: "db1", schemaVersion: 3, properties: [titleProp, status, due, owner, papers, note, count, done, created],
                 views: views ?? [DbView(id: "v1", name: "", type: "table"), DbView(id: "v2", name: "予定", type: "calendar", datePropId: "due")],
                 myLevel: level)
}

private func row(_ id: String, title: String = "", props: [String: JSONValue] = [:], relations: [String: [String]] = [:], hidden: [String] = []) -> DbRow {
    DbRow(id: id, databaseId: "db1", title: title.isEmpty ? id : title, props: props, relations: relations, hiddenRelations: hidden,
          createdAt: "2026-10-01T00:00:00Z", createdBy: "u1", updatedAt: "2026-10-02T00:00:00Z", updatedBy: "u2")
}

private func day(_ start: String, _ end: String? = nil, time: Bool = false) -> JSONValue { DbDateValue(start: start, end: end, time: time).json }

private let names: WikiDb.Names = { ["u1": "加納", "u2": "海老"][$0] ?? "?" }

final class WikiDbCardTests: XCTestCase {
    func testCardsShowTheFirstThreeVisibleColumnsOfTheView() {
        // The view orders note, title, owner first and hides status; the others follow in schema order.
        let view = DbView(id: "v", columns: [DbViewColumn(propId: "note"), DbViewColumn(propId: "title"), DbViewColumn(propId: "own"),
                                             DbViewColumn(propId: "st", hidden: true), DbViewColumn(propId: "gone")])
        let db = database()
        XCTAssertEqual(WikiDb.columns(db, view: view).map(\.id).prefix(4), ["title", "note", "own", "due"])
        XCTAssertEqual(WikiDb.cardProperties(db, view: view).map(\.id), ["note", "own", "due"])
        // No view: schema order without the title.
        XCTAssertEqual(WikiDb.cardProperties(db, view: nil).map(\.id), ["st", "due", "own"])
        // The title never hides.
        let hidingTitle = DbView(id: "h", columns: [DbViewColumn(propId: "title", hidden: true)])
        XCTAssertEqual(WikiDb.columns(db, view: hidingTitle).first?.id, "title")
    }

    func testACardSkipsEmptyValuesAndKeepsTheOptionsForChips() {
        let db = database()
        let props = WikiDb.cardProperties(db, view: nil) // st, due, own
        let r = row("r1", props: ["st": .string("o2"), "own": .array([.string("u1"), .string("u2")])])
        let fields = WikiDb.card(r, properties: props, refs: [:], names: names, zone: tokyo, locale: ja)
        XCTAssertEqual(fields.map(\.prop.id), ["st", "own"])
        XCTAssertEqual(fields[0].text, "執筆中")
        XCTAssertEqual(fields[0].options.map(\.id), ["o2"])
        XCTAssertEqual(fields[1].text, "加納, 海老")
        XCTAssertTrue(fields[1].options.isEmpty)
        // An unknown option id (deleted on the desktop) shows nothing.
        XCTAssertTrue(WikiDb.card(row("r2", props: ["st": .string("gone")]), properties: props, refs: [:], names: names).isEmpty)
    }

    func testCellTextPerType() {
        let r = row("r1", props: ["n": .number(1200.4), "ok": .bool(true), "due": day("2026-10-07", "2026-10-09"), "note": .string("メモ")],
                    relations: ["rel_p": ["a", "b"]])
        let refs = ["a": DbRowRef(id: "a", databaseId: "db2", title: "論文 A", icon: nil), "b": DbRowRef(id: "b", databaseId: "db2", title: "", icon: nil)]
        XCTAssertEqual(WikiDb.text(count, r, refs: refs, names: names, locale: ja), "1200")
        XCTAssertEqual(WikiDb.text(done, r, refs: refs, names: names), "✓")
        XCTAssertEqual(WikiDb.text(due, r, refs: refs, names: names, zone: tokyo, locale: ja), "2026/10/07 → 2026/10/09")
        XCTAssertEqual(WikiDb.text(papers, r, refs: refs, names: names), "論文 A, " + tr("無題"))
        XCTAssertEqual(WikiDb.text(DbProperty(id: "cb", name: "", type: "created_by"), r, refs: [:], names: names), "加納")
        XCTAssertEqual(WikiDb.text(created, r, refs: [:], names: names, zone: tokyo, locale: ja), "2026/10/01 9:00")
        XCTAssertEqual(WikiDb.formatNumber(0.5, format: "percent", locale: ja), "50%")
        XCTAssertEqual(WikiDb.formatNumber(1200, format: "yen", locale: ja), "¥1,200")
        XCTAssertEqual(created.displayName, tr("作成日時"))
        XCTAssertEqual(titleProp.displayName, tr("名前"))
        XCTAssertEqual(DbView(id: "x", type: "calendar").displayName, tr("カレンダー"))
    }
}

final class WikiDbAgendaTests: XCTestCase {
    func testMultiDayRowsShowOnEveryDayTheyCoverWithinTheMonth() {
        let rows = [
            row("a", props: ["due": day("2026-09-29", "2026-10-02")]), // from the month before
            row("b", props: ["due": day("2026-10-01")]),
            row("c", props: ["due": day("2026-10-31", "2026-11-03")]), // into the next month
            row("d"), // no date: not on the agenda
            row("e", props: ["due": day("2026-10-05", "2026-10-03")]), // an end before the start: the start only
        ]
        let days = WikiDb.agenda(rows: rows, prop: due, from: "2026-10-01", to: "2026-10-31", zone: tokyo)
        XCTAssertEqual(days.map(\.day), ["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-31"])
        // The server's order within a day is kept.
        XCTAssertEqual(days[0].entries.map(\.rowId), ["a", "b"])
        XCTAssertEqual(days[1].entries.map(\.rowId), ["a"])
        XCTAssertTrue(days[0].entries[0].multiDay)
        XCTAssertFalse(days[0].entries[1].multiDay)
        XCTAssertEqual(WikiDb.rangeLabel(days[0].entries[0]), "9/29 → 10/2")
        XCTAssertEqual(WikiDb.rangeLabel(days[3].entries[0]), "10/31 → 11/3")
        XCTAssertEqual(days[2].entries.map(\.rowId), ["e"])
        XCTAssertFalse(days[2].entries[0].multiDay)
    }

    func testTimedValuesFallOnTheDayOfTheDevicesZone() {
        // 23:30 UTC on the 7th is the 8th in Tokyo and still the 7th in New York.
        let r = row("t", props: ["due": day("2026-10-07T23:30:00+00:00", time: true)])
        XCTAssertEqual(WikiDb.span(due, r, zone: utc).map { [$0.first, $0.last] }, ["2026-10-07", "2026-10-07"])
        XCTAssertEqual(WikiDb.span(due, r, zone: tokyo).map { [$0.first, $0.last] }, ["2026-10-08", "2026-10-08"])
        XCTAssertEqual(WikiDb.span(due, r, zone: newYork).map { [$0.first, $0.last] }, ["2026-10-07", "2026-10-07"])
        // A timed range across midnight in Tokyo covers two days there, one in UTC.
        let night = row("n", props: ["due": day("2026-10-07T13:00:00+00:00", "2026-10-07T16:00:00+00:00", time: true)])
        XCTAssertEqual(WikiDb.agenda(rows: [night], prop: due, from: "2026-10-01", to: "2026-10-31", zone: tokyo).map(\.day), ["2026-10-07", "2026-10-08"])
        XCTAssertEqual(WikiDb.agenda(rows: [night], prop: due, from: "2026-10-01", to: "2026-10-31", zone: utc).map(\.day), ["2026-10-07"])
        // A date without a time is the same day everywhere.
        let plain = row("p", props: ["due": day("2026-10-07")])
        XCTAssertEqual(WikiDb.span(due, plain, zone: newYork)?.first, "2026-10-07")
        XCTAssertEqual(WikiDb.timeLabel("2026-10-07T00:30:00+00:00", zone: tokyo, locale: ja), "9:30")
        XCTAssertNil(WikiDb.timeLabel("2026-10-07", zone: tokyo))
        // created_time is a calendar's date too.
        XCTAssertEqual(WikiDb.span(created, row("c"), zone: tokyo)?.first, "2026-10-01")
    }

    func testMonths() {
        XCTAssertEqual(WikiDb.monthBounds("2026-02-14").start, "2026-02-01")
        XCTAssertEqual(WikiDb.monthBounds("2026-02-14").end, "2026-02-28")
        XCTAssertEqual(WikiDb.monthBounds("2028-02-01").end, "2028-02-29")
        XCTAssertEqual(WikiDb.addMonths("2026-12-01", 1), "2027-01-01")
        XCTAssertEqual(WikiDb.addMonths("2026-01-01", -1), "2025-12-01")
        XCTAssertEqual(WikiDb.addDays("2026-10-31", 1), "2026-11-01")
        XCTAssertEqual(WikiDb.dayHeading("2026-10-07", locale: ja), "10月7日(水)")
    }
}

final class WikiDbValueTests: XCTestCase {
    func testTextUrlAndTitle() {
        XCTAssertEqual(WikiDb.encodeText("  ", type: "text"), .null)
        XCTAssertEqual(WikiDb.encodeText("一行目\n二行目", type: "text"), .string("一行目\n二行目"))
        XCTAssertEqual(WikiDb.encodeText(" https://example.com ", type: "url"), .string("https://example.com"))
        // The title keeps "" (the server names it 「無題」), never null.
        XCTAssertEqual(WikiDb.encodeText("  ", type: "title"), .string(""))
    }

    func testNumbers() {
        XCTAssertEqual(WikiDb.encodeNumber("1,200", format: nil), .number(1200))
        XCTAssertEqual(WikiDb.encodeNumber("１２．５", format: nil), .number(12.5))
        XCTAssertEqual(WikiDb.encodeNumber("¥3,000", format: "yen"), .number(3000))
        XCTAssertEqual(WikiDb.encodeNumber("-2", format: "integer"), .number(-2))
        // A percent cell takes 50 as 50 % (0.5); "50%" anywhere is 0.5.
        XCTAssertEqual(WikiDb.encodeNumber("50", format: "percent"), .number(0.5))
        XCTAssertEqual(WikiDb.encodeNumber("50%", format: nil), .number(0.5))
        XCTAssertEqual(WikiDb.encodeNumber("", format: nil), .null)
        XCTAssertNil(WikiDb.encodeNumber("abc", format: nil))
        XCTAssertNil(WikiDb.encodeNumber("inf", format: nil))
        XCTAssertEqual(WikiDb.numberInput(.number(0.5), format: "percent"), "50")
        XCTAssertEqual(WikiDb.numberInput(.number(12.5), format: nil), "12.5")
        XCTAssertEqual(WikiDb.numberInput(nil, format: nil), "")
    }

    func testChoicesPeopleRelationsAndCheckboxes() {
        XCTAssertEqual(WikiDb.encodeSelect("o1"), .string("o1"))
        XCTAssertEqual(WikiDb.encodeSelect(nil), .null)
        XCTAssertEqual(WikiDb.encodeIds(["o1", "o2"]), .array([.string("o1"), .string("o2")]))
        XCTAssertEqual(WikiDb.encodeIds([]), .null)
        // A relation cell sends the readable rows chosen; none is [] (the server keeps the hidden links).
        XCTAssertEqual(WikiDb.encodeRelation([]), .array([]))
        XCTAssertEqual(WikiDb.encodeCheckbox(true), .bool(true))
        XCTAssertEqual(WikiDb.encodeCheckbox(false), .bool(false))
    }

    func testDatesAsDaysOrTimesWithTheZonesOffset() throws {
        // 2026-10-07 01:30 UTC.
        let moment = Date(timeIntervalSince1970: 1_791_336_600)
        XCTAssertEqual(WikiDb.encodeDate(start: moment, end: nil, time: false, zone: tokyo), day("2026-10-07"))
        XCTAssertEqual(WikiDb.encodeDate(start: moment, end: nil, time: false, zone: newYork), day("2026-10-06"))
        XCTAssertEqual(WikiDb.encodeDate(start: moment, end: nil, time: true, zone: tokyo), day("2026-10-07T10:30:00+09:00", time: true))
        // Daylight saving time in New York in October: -04:00.
        XCTAssertEqual(WikiDb.encodeDate(start: moment, end: nil, time: true, zone: newYork), day("2026-10-06T21:30:00-04:00", time: true))
        // A range; an end before the start becomes the start.
        let later = moment.addingTimeInterval(2 * 86400)
        XCTAssertEqual(WikiDb.encodeDate(start: moment, end: later, time: false, zone: tokyo), day("2026-10-07", "2026-10-09"))
        XCTAssertEqual(WikiDb.encodeDate(start: later, end: moment, time: false, zone: tokyo), day("2026-10-09", "2026-10-09"))
        // The pickers start from the stored value (a day at 9:00 in the zone).
        let picked = try XCTUnwrap(WikiDb.pickerDate("2026-10-07", zone: tokyo))
        XCTAssertEqual(WikiDb.withOffset(picked, zone: tokyo), "2026-10-07T09:00:00+09:00")
        XCTAssertEqual(WikiDb.pickerDate("2026-10-07T10:30:00+09:00"), moment)
        XCTAssertNil(WikiDb.pickerDate(nil))
        XCTAssertEqual(DbDateValue(day("2026-10-07T10:30:00+09:00", time: true))?.time, true)
        XCTAssertNil(DbDateValue(.string("2026-10-07")))
    }

    func testTheScreenShowsAWriteBeforeTheAnswer() {
        let r = row("r", props: ["ok": .bool(true), "st": .string("o1")], relations: ["rel_p": ["a"]])
        XCTAssertNil(WikiDb.applying(r, propId: "ok", value: .bool(false), type: "checkbox").props["ok"])
        XCTAssertNil(WikiDb.applying(r, propId: "st", value: .null, type: "select").props["st"])
        XCTAssertEqual(WikiDb.applying(r, propId: "rel_p", value: .array([.string("b")]), type: "relation").relations["rel_p"], ["b"])
        XCTAssertEqual(WikiDb.applying(r, propId: "title", value: .string("新"), type: "title").title, "新")
    }
}

final class WikiDbRulesTests: XCTestCase {
    func testLevels() {
        XCTAssertFalse(DbRights.of(.view).editCells)
        XCTAssertFalse(DbRights.of(.view).addRows)
        XCTAssertFalse(DbRights.of(nil).editCells)
        XCTAssertTrue(DbRights.of(.edit).editCells)
        XCTAssertTrue(DbRights.of(.full).addRows)
        // Schema and views are the desktop's, whatever the level (§9.2).
        XCTAssertFalse(DbRights.of(.full).editSchema)
        XCTAssertTrue(DbRights.isEditable(status))
        XCTAssertTrue(DbRights.isEditable(papers))
        XCTAssertFalse(DbRights.isEditable(created))
        XCTAssertFalse(DbRights.isEditable(DbProperty(id: "x", name: "", type: "formula")))
    }

    func testRowsICannotReadShowAsOneChipWithoutIds() throws {
        let json = #"""
        {"id":"r1","database_id":"db1","title":"実験","icon":null,"position":"a0","version":2,"head_rev_id":"h",
         "props":{"due_date":{"start":"2026-10-07","end":null,"time":false},"st":"o1"},
         "relations":{"rel_p":["a"]},"hidden_relations":["rel_p","rel_q"],
         "created_at":"2026-10-07T00:00:00Z","created_by":"u1","updated_at":"2026-10-07T00:00:00Z","updated_by":"u1"}
        """#
        let r = try JSON.snakeDecoder.decode(DbRow.self, from: Data(json.utf8))
        // Property ids keep their underscores (not camel-cased by the decoder).
        XCTAssertNotNil(r.props["due_date"])
        XCTAssertEqual(r.relations["rel_p"], ["a"])
        let refs = ["a": DbRowRef(id: "a", databaseId: "db2", title: "論文 A", icon: nil)]
        XCTAssertEqual(WikiDb.text(papers, r, refs: refs, names: names), "論文 A, " + tr("アクセスできないページ"))
        // Only hidden links: the one chip.
        let q = DbProperty(id: "rel_q", name: "", type: "relation")
        XCTAssertEqual(WikiDb.text(q, r, refs: refs, names: names), tr("アクセスできないページ"))
        XCTAssertNil(WikiDb.value(q, r))
        // The related database I cannot read: no id, no title.
        let prop = try JSON.snakeDecoder.decode(DbProperty.self, from: Data(#"{"id":"rel_q","name":"x","type":"relation","options":[],"number_format":null,"relation":{"database_id":null,"database_title":null,"pair_id":null,"primary":true}}"#.utf8))
        XCTAssertNil(prop.relation?.databaseId)
        XCTAssertNil(prop.relation?.databaseTitle)
    }
}

// MARK: - the models against a fake server

@MainActor
final class FakeWikiDbApi: WikiDbApi {
    var database = WikiDatabase(pageId: "db1", schemaVersion: 3, properties: [titleProp, status, due, papers],
                                views: [DbView(id: "v1"), DbView(id: "v2", type: "calendar", datePropId: "due")])
    var rows: [DbRow] = [row("r1", props: ["st": .string("o1")]), row("r2")]
    var queries: [DbQuery] = []
    var writes: [(rowId: String, set: [String: JSONValue], opId: String)] = []
    var creates: [String] = []
    var failNetwork = false
    /// Failures to answer the next writes with, in order.
    var writeFailures: [Error] = []
    var rowReads = 0

    func wikiDatabase(id: String) async throws -> WikiDatabase {
        if failNetwork { throw ApiError.network(URLError(.notConnectedToInternet)) }
        return database
    }

    /// M148: a grouped answer (when the query asks for one): the groups and the rows by group, as the server makes them.
    var grouping: ((DbRow) -> [String])?
    var groupOrder: [String] = []
    var hiddenGroups: Set<String> = []
    var moves: [(rowId: String, move: DbRowMove)] = []
    var moveFailures: [Error] = []
    var appliedOps: Set<String> = []

    func queryRows(databaseId: String, _ query: DbQuery) async throws -> DbQueryOut {
        queries.append(query)
        if failNetwork { throw ApiError.network(URLError(.notConnectedToInternet)) }
        let refs = [DbRowRef(id: "a", databaseId: "db2", title: "論文 A", icon: nil)]
        if query.grouped == true, let grouping {
            var outRows: [DbRow] = []
            var keys: [String] = []
            var counts: [String: Int] = [:]
            for key in groupOrder {
                for r in rows where grouping(r).contains(key) {
                    counts[key, default: 0] += 1
                    if hiddenGroups.contains(key) { continue }
                    outRows.append(r)
                    keys.append(key)
                }
            }
            return DbQueryOut(rows: outRows, refs: refs, total: outRows.count, nextCursor: nil, schemaVersion: database.schemaVersion,
                              groups: groupOrder.map { DbRowGroup(key: $0, count: counts[$0] ?? 0, hidden: hiddenGroups.contains($0)) },
                              rowGroups: keys)
        }
        return DbQueryOut(rows: rows, refs: refs, total: rows.count, nextCursor: nil, schemaVersion: database.schemaVersion)
    }

    func moveRow(rowId: String, _ move: DbRowMove) async throws -> DbRowWithRefs {
        moves.append((rowId, move))
        if !moveFailures.isEmpty { throw moveFailures.removeFirst() }
        guard let index = rows.firstIndex(where: { $0.id == rowId }) else { throw ApiError.api(status: 404, code: "page_not_found", message: "") }
        // The same op id again changes nothing (the server's client_op_id).
        guard appliedOps.insert(move.clientOpId).inserted else { return DbRowWithRefs(row: rows[index]) }
        for (key, value) in move.set {
            rows[index] = WikiDb.applying(rows[index], propId: key, value: value, type: database.property(key)?.type)
        }
        rows[index].version += 1
        return DbRowWithRefs(row: rows[index])
    }

    var createBodies: [DbRowCreate] = []

    func createRow(databaseId: String, _ create: DbRowCreate) async throws -> DbRowWithRefs {
        creates.append(create.clientSaveId)
        createBodies.append(create)
        let made = row("new-\(create.clientSaveId)", title: create.title, props: create.props)
        if !rows.contains(where: { $0.id == made.id }) { rows.append(made) }
        return DbRowWithRefs(row: made)
    }

    func wikiRow(id: String) async throws -> DbRowDetail {
        rowReads += 1
        if failNetwork { throw ApiError.network(URLError(.notConnectedToInternet)) }
        guard let r = rows.first(where: { $0.id == id }) else { throw ApiError.api(status: 404, code: "page_not_found", message: "") }
        return DbRowDetail(row: r, database: database, databaseTitle: "研究", refs: [], referencedBy: [])
    }

    func setRowCells(rowId: String, set: [String: JSONValue], clientOpId: String) async throws -> DbRowWithRefs {
        writes.append((rowId, set, clientOpId))
        if !writeFailures.isEmpty { throw writeFailures.removeFirst() }
        guard let index = rows.firstIndex(where: { $0.id == rowId }) else { throw ApiError.api(status: 404, code: "page_not_found", message: "") }
        for (key, value) in set {
            rows[index] = WikiDb.applying(rows[index], propId: key, value: value, type: database.property(key)?.type)
        }
        rows[index].version += 1
        return DbRowWithRefs(row: rows[index])
    }

    func relationCandidates(databaseId: String, propId: String, q: String) async throws -> [DbRowRef] {
        [DbRowRef(id: "a", databaseId: "db2", title: "論文 A", icon: nil)].filter { q.isEmpty || $0.title.contains(q) }
    }
}

@MainActor
final class WikiDbModelTests: XCTestCase {
    func testTheOpIdStaysTheSameAcrossRetriesAndARefusalIsNotRetried() async throws {
        let api = FakeWikiDbApi()
        api.writeFailures = [ApiError.network(URLError(.timedOut)), ApiError.api(status: 503, code: "unavailable", message: "")]
        let out = try await DbCellWriter.write(api: api, rowId: "r1", set: ["st": .string("o2")], delays: [0, 0, 0])
        XCTAssertEqual(out.row.props["st"], .string("o2"))
        XCTAssertEqual(api.writes.count, 3)
        XCTAssertEqual(Set(api.writes.map(\.opId)).count, 1)
        // A refusal (422) goes back at once.
        api.writes = []
        api.writeFailures = [ApiError.api(status: 422, code: "wiki_invalid_property_value", message: "")]
        do {
            _ = try await DbCellWriter.write(api: api, rowId: "r1", set: ["st": .string("x")], delays: [0, 0])
            XCTFail("expected the refusal")
        } catch ApiError.api(let status, _, _) {
            XCTAssertEqual(status, 422)
        }
        XCTAssertEqual(api.writes.count, 1)
        // Out of retries: the last error comes back; every try had the same id.
        api.writes = []
        api.writeFailures = Array(repeating: ApiError.network(URLError(.notConnectedToInternet)), count: 5)
        do {
            _ = try await DbCellWriter.write(api: api, rowId: "r1", set: ["st": .string("o1")], delays: [0, 0])
            XCTFail("expected the network error")
        } catch {}
        XCTAssertEqual(api.writes.count, 3)
        XCTAssertEqual(Set(api.writes.map(\.opId)).count, 1)
        // Each edit has its own id.
        api.writeFailures = []
        _ = try await DbCellWriter.write(api: api, rowId: "r1", set: ["st": .string("o1")], delays: [])
        XCTAssertNotEqual(api.writes.last?.opId, api.writes.first?.opId)
    }

    func testARowsCellIsShownAtOnceThenTheServersAndARefusalReadsTheRowAgain() async throws {
        let api = FakeWikiDbApi()
        let model = WikiRowModel(rowId: "r1", api: api, store: Store())
        await model.load()
        XCTAssertTrue(model.rights.editCells)
        try await model.set("st", .string("o2"))
        XCTAssertEqual(model.detail?.row.props["st"], .string("o2"))
        XCTAssertEqual(model.detail?.row.version, 2)
        XCTAssertEqual(api.writes.last?.set, ["st": .string("o2")])
        api.writeFailures = [ApiError.api(status: 422, code: "wiki_invalid_property_value", message: "")]
        let reads = api.rowReads
        do {
            try await model.set("st", .string("bad"))
            XCTFail("expected the refusal")
        } catch {}
        XCTAssertEqual(api.rowReads, reads + 1)
        XCTAssertEqual(model.detail?.row.props["st"], .string("o2"))
        // A viewer's form is read only.
        api.database.myLevel = .view
        await model.load()
        XCTAssertFalse(model.rights.editCells)
    }

    func testTheDatabaseReadsItsViewAndFoldsEventsIntoOneRead() async {
        let api = FakeWikiDbApi()
        let model = WikiDatabaseModel(databaseId: "db1", api: api, store: Store(), zone: tokyo, today: Date(timeIntervalSince1970: 1_791_336_600),
                                      reloadDelay: 0.05)
        await model.load()
        XCTAssertEqual(model.view?.id, "v1")
        XCTAssertEqual(model.rows.map(\.id), ["r1", "r2"])
        XCTAssertEqual(api.queries.last?.viewId, "v1")
        XCTAssertNil(api.queries.last?.range)
        // Three events: one read.
        let before = api.queries.count
        model.changed()
        model.changed()
        model.changed()
        await model.settled()
        XCTAssertEqual(api.queries.count, before + 1)
        // The calendar asks for its month (and up to 1,000 rows).
        await model.select(view: "v2")
        XCTAssertEqual(api.queries.last?.viewId, "v2")
        XCTAssertEqual(api.queries.last?.range?.start, "2026-10-01")
        XCTAssertEqual(api.queries.last?.range?.end, "2026-10-31")
        XCTAssertEqual(api.queries.last?.limit, 1000)
        await model.shiftMonth(1)
        XCTAssertEqual(api.queries.last?.range?.start, "2026-11-01")
        XCTAssertEqual(api.queries.last?.range?.end, "2026-11-30")
        // A new row on the calendar starts on the shown month's first day (today is in October).
        XCTAssertEqual(model.newRowProps(today: Date(timeIntervalSince1970: 1_791_336_600)), ["due": day("2026-11-01")])
        await model.shiftMonth(-1)
        XCTAssertEqual(model.newRowProps(today: Date(timeIntervalSince1970: 1_791_336_600)), ["due": day("2026-10-07")])
    }

    func testANewRowsKeyIsKeptAcrossRetries() async throws {
        let api = FakeWikiDbApi()
        let model = WikiDatabaseModel(databaseId: "db1", api: api, store: Store(), reloadDelay: 0)
        await model.load()
        let first = try await model.createRow(title: "新しい実験", clientSaveId: "k1")
        let again = try await model.createRow(title: "新しい実験", clientSaveId: "k1")
        XCTAssertEqual(first.id, again.id)
        XCTAssertEqual(api.creates, ["k1", "k1"])
        XCTAssertEqual(model.rows.filter { $0.id == first.id }.count, 1)
    }

    func testTheLastDatabaseOpenedIsReadOffline() async {
        let store = Store()
        let api = FakeWikiDbApi()
        let online = WikiDatabaseModel(databaseId: "db1", api: api, store: store, reloadDelay: 0)
        await online.load()
        XCTAssertNil(online.offlineSince)
        // Offline: the kept rows, marked as such; the row page reads its cells from them, read only.
        api.failNetwork = true
        let offline = WikiDatabaseModel(databaseId: "db1", api: api, store: store, reloadDelay: 0)
        XCTAssertEqual(offline.rows.map(\.id), ["r1", "r2"])
        await offline.load()
        XCTAssertNotNil(offline.offlineSince)
        XCTAssertEqual(offline.rows.map(\.id), ["r1", "r2"])
        XCTAssertEqual(offline.refs["a"]?.title, "論文 A")
        XCTAssertNil(offline.failure)
        let rowModel = WikiRowModel(rowId: "r1", api: api, store: store)
        await rowModel.load()
        XCTAssertEqual(rowModel.detail?.row.props["st"], .string("o1"))
        XCTAssertFalse(rowModel.rights.editCells)
        // Another database is not kept: it says why.
        let other = WikiDatabaseModel(databaseId: "db9", api: api, store: store, reloadDelay: 0)
        await other.load()
        XCTAssertTrue(other.rows.isEmpty)
        XCTAssertNotNil(other.offlineSince ?? other.failure.map { _ in Date() })
    }

    func testEventsReachTheOpenScreens() {
        let hub = WikiHub(api: FakeWikiApi(), store: Store(), feedDelay: 0)
        hub.applyEvent("wiki.rows.changed", .object(["database_id": .string("DB1"), "seq": .number(5), "schema_version": .number(4)]))
        hub.applyEvent("wiki.rows.changed", .object(["database_id": .string("db1"), "seq": .number(6), "schema_version": .number(4)]))
        XCTAssertEqual(hub.rowsSignal["db1"], 2)
        XCTAssertEqual(hub.rowsSchema["db1"], 4)
        let meta: JSONValue = .object(["id": .string("r1"), "version": .number(3), "head_rev_id": .string("h"), "kind": .string("row"), "title": .string("x")])
        hub.applyEvent("wiki.page.updated", .object(["page": meta, "change": .string("props")]))
        hub.applyEvent("wiki.page.updated", .object(["page": meta, "change": .string("body")]))
        XCTAssertEqual(hub.propsSignal["r1"], 1)
    }
}

@MainActor
final class WikiDbApiTests: XCTestCase {
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

    func testRequestShapes() async throws {
        let rowJSON = #"{"id":"r1","database_id":"db1","title":"t","icon":null,"position":"a0","version":2,"head_rev_id":"h","props":{"st":"o1"},"relations":{},"hidden_relations":[],"created_at":"","created_by":"u","updated_at":"","updated_by":"u"}"#
        var seen: [(String, JSONValue?)] = []
        StubProtocol.handler = { request in
            let url = request.url!
            seen.append((request.httpMethod! + " " + url.path + (url.query.map { "?" + $0 } ?? ""), Self.body(request)))
            switch url.path {
            case "/api/v1/wiki/rows/r1/props": return (200, Data(#"{"row":\#(rowJSON),"refs":[]}"#.utf8))
            case "/api/v1/wiki/databases/db1/query": return (200, Data(#"{"rows":[\#(rowJSON)],"refs":[],"total":1,"next_cursor":null,"schema_version":3}"#.utf8))
            default: return (200, Data(#"[{"id":"a","database_id":"db2","title":"論文 A","icon":null}]"#.utf8))
            }
        }
        defer { StubProtocol.handler = nil }
        let client = makeClient()
        let written = try await client.setRowCells(rowId: "r1", set: ["st": .string("o1"), "due": .null], clientOpId: "op-1")
        XCTAssertEqual(written.row.props["st"], .string("o1"))
        XCTAssertEqual(seen.last?.0, "PATCH /api/v1/wiki/rows/r1/props")
        XCTAssertEqual(seen.last?.1, .object(["set": .object(["st": .string("o1"), "due": .null]), "client_op_id": .string("op-1")]))
        let out = try await client.queryRows(databaseId: "db1", DbQuery(viewId: "v2", range: ("due", "2026-10-01", "2026-10-31"), limit: 1000))
        XCTAssertEqual(out.total, 1)
        XCTAssertEqual(seen.last?.1, .object(["view_id": .string("v2"), "limit": .number(1000),
                                              "range": .object(["prop_id": .string("due"), "start": .string("2026-10-01"), "end": .string("2026-10-31")])]))
        let found = try await client.relationCandidates(databaseId: "db1", propId: "rel_p", q: "論文")
        XCTAssertEqual(found.first?.title, "論文 A")
        XCTAssertTrue(seen.last?.0.hasPrefix("GET /api/v1/wiki/databases/db1/properties/rel_p/candidates?q=") ?? false)
    }
}
