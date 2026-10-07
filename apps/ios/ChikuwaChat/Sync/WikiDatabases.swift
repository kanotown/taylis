import Foundation
import Observation

/// M124 (docs/WIKI.md §5, §18.2): the database calls the phone makes (ApiClient and the test fakes).
@MainActor
protocol WikiDbApi: AnyObject {
    func wikiDatabase(id: String) async throws -> WikiDatabase
    func queryRows(databaseId: String, _ query: DbQuery) async throws -> DbQueryOut
    func createRow(databaseId: String, title: String, props: [String: JSONValue], clientSaveId: String) async throws -> DbRowWithRefs
    func wikiRow(id: String) async throws -> DbRowDetail
    func setRowCells(rowId: String, set: [String: JSONValue], clientOpId: String) async throws -> DbRowWithRefs
    func relationCandidates(databaseId: String, propId: String, q: String) async throws -> [DbRowRef]
}

extension ApiClient: WikiDbApi {
    func wikiDatabase(id: String) async throws -> WikiDatabase { try await requestJSON("GET", "/api/v1/wiki/databases/\(id)") }

    func queryRows(databaseId: String, _ query: DbQuery) async throws -> DbQueryOut {
        try await requestJSON("POST", "/api/v1/wiki/databases/\(databaseId)/query", body: query.json)
    }

    func createRow(databaseId: String, title: String, props: [String: JSONValue], clientSaveId: String) async throws -> DbRowWithRefs {
        try await requestJSON("POST", "/api/v1/wiki/databases/\(databaseId)/rows",
                              body: .object(["title": .string(title), "props": .object(props), "client_save_id": .string(clientSaveId)]))
    }

    func wikiRow(id: String) async throws -> DbRowDetail { try await requestJSON("GET", "/api/v1/wiki/rows/\(id)") }

    func setRowCells(rowId: String, set: [String: JSONValue], clientOpId: String) async throws -> DbRowWithRefs {
        try await requestJSON("PATCH", "/api/v1/wiki/rows/\(rowId)/props", body: .object(["set": .object(set), "client_op_id": .string(clientOpId)]))
    }

    func relationCandidates(databaseId: String, propId: String, q: String) async throws -> [DbRowRef] {
        try await requestJSON("GET", Self.pathWithQuery("/api/v1/wiki/databases/\(databaseId)/properties/\(propId)/candidates",
                                                         [URLQueryItem(name: "q", value: q), URLQueryItem(name: "limit", value: "30")]))
    }
}

/// A cell write (PATCH /wiki/rows/{id}/props, §5.3): one `client_op_id` for the edit, sent again with the same id after a
/// failure on the way (the server applies it once) — up to `delays.count` more times; a refusal (403, 422) is not retried.
/// The last writer wins per cell.
@MainActor
enum DbCellWriter {
    static var delays: [TimeInterval] = [0.5, 1.5, 4]

    static func write(api: WikiDbApi, rowId: String, set: [String: JSONValue], opId: String = UUID().uuidString.lowercased(),
                      delays: [TimeInterval]? = nil) async throws -> DbRowWithRefs {
        let waits = delays ?? Self.delays
        var attempt = 0
        while true {
            do {
                return try await api.setRowCells(rowId: rowId, set: set, clientOpId: opId)
            } catch {
                guard CanvasSaver.retryable(error), attempt < waits.count else { throw error }
                let wait = waits[attempt]
                attempt += 1
                if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            }
        }
    }
}

/// The last database page opened, kept to read offline (§10: its rows as the last view showed them).
struct WikiDbKept: Codable, Equatable {
    static let key = "wiki:db:last"

    var databaseId: String
    var viewId: String?
    var month: String?
    var database: WikiDatabase
    var rows: [DbRow]
    var refs: [DbRowRef]
    var total: Int
    var savedAt: Date

    @MainActor static func load(_ store: Store) -> WikiDbKept? {
        guard let raw = store.wikiValue(key) else { return nil }
        return try? JSON.plainDecoder.decode(WikiDbKept.self, from: Data(raw.utf8))
    }

    @MainActor func save(_ store: Store) {
        store.setWikiValue(Self.key, (try? JSON.plainEncoder.encode(self)).flatMap { String(data: $0, encoding: .utf8) })
    }
}

/// An open database page (§5.5): its schema and views, the rows of the chosen view (cards, or a calendar's month as an
/// agenda), new rows, cell writes, and reading again after `wiki.rows.changed` (debounced) or a reconnect.
@MainActor
@Observable
final class WikiDatabaseModel {
    let databaseId: String
    private(set) var database: WikiDatabase?
    private(set) var viewId: String?
    private(set) var rows: [DbRow] = []
    private(set) var refs: [String: DbRowRef] = [:]
    private(set) var total = 0
    private(set) var nextCursor: String?
    private(set) var loading = false
    private(set) var failure: String?
    /// The rows on screen are the kept copy (the server could not be reached).
    private(set) var offlineSince: Date?
    /// The calendar's month: its first day ("2026-10-01").
    private(set) var month: String

    @ObservationIgnored private let api: WikiDbApi?
    @ObservationIgnored private let store: Store
    @ObservationIgnored private let zone: TimeZone
    @ObservationIgnored private let reloadDelay: TimeInterval
    @ObservationIgnored private var reloadTask: Task<Void, Never>?
    @ObservationIgnored private var generation = 0

    init(databaseId: String, api: WikiDbApi?, store: Store, zone: TimeZone = .current, today: Date = Date(), reloadDelay: TimeInterval = 0.3) {
        self.databaseId = databaseId
        self.api = api
        self.store = store
        self.zone = zone
        self.reloadDelay = reloadDelay
        month = String(WikiDb.iso(today, zone: zone).prefix(7)) + "-01"
        if let kept = WikiDbKept.load(store), kept.databaseId == databaseId {
            database = kept.database
            viewId = kept.viewId
            if let month = kept.month { self.month = month }
            rows = kept.rows
            refs = Dictionary(kept.refs.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
            total = kept.total
        }
    }

    var view: DbView? { database?.view(viewId) ?? database?.views.first }
    var rights: DbRights { DbRights.of(database?.myLevel) }
    var datePropOfView: DbProperty? {
        guard let view, view.isCalendar else { return nil }
        return view.datePropId.flatMap { database?.property($0) }
    }

    /// The schema (always) and the rows of the view.
    func load() async {
        guard let api else { return }
        loading = true
        defer { loading = false }
        do {
            let next = try await api.wikiDatabase(id: databaseId)
            database = next
            if viewId == nil || next.view(viewId) == nil { viewId = next.views.first?.id }
            try await queryFirstPage()
            failure = nil
        } catch {
            if CanvasSaver.retryable(error), let kept = WikiDbKept.load(store), kept.databaseId == databaseId {
                offlineSince = kept.savedAt
                if database == nil { database = kept.database }
                return
            }
            if CanvasSaver.retryable(error), database != nil {
                offlineSince = offlineSince ?? Date()
                return
            }
            failure = ErrorMessages.text(for: error)
        }
    }

    private func query(cursor: String?) -> DbQuery {
        var q = DbQuery(viewId: view?.id, cursor: cursor, limit: 100)
        if let prop = datePropOfView {
            let bounds = WikiDb.monthBounds(month)
            q.range = (prop.id, bounds.start, bounds.end)
            q.limit = 1000
        }
        return q
    }

    private func queryFirstPage() async throws {
        guard let api else { return }
        generation += 1
        let mine = generation
        let out = try await api.queryRows(databaseId: databaseId, query(cursor: nil))
        guard mine == generation else { return }
        rows = out.rows
        refs = Dictionary(out.refs.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
        total = out.total
        nextCursor = out.nextCursor
        offlineSince = nil
        if let database, out.schemaVersion > database.schemaVersion {
            self.database = try await api.wikiDatabase(id: databaseId)
        }
        keep()
    }

    private func keep() {
        guard let database else { return }
        WikiDbKept(databaseId: databaseId, viewId: viewId, month: month, database: database, rows: rows, refs: Array(refs.values),
                   total: total, savedAt: Date()).save(store)
    }

    /// The next page of the view (cards: 100 at a time).
    func loadMore() async {
        guard let api, let cursor = nextCursor, !loading else { return }
        loading = true
        defer { loading = false }
        let mine = generation
        do {
            let out = try await api.queryRows(databaseId: databaseId, query(cursor: cursor))
            guard mine == generation else { return }
            let known = Set(rows.map(\.id))
            rows += out.rows.filter { !known.contains($0.id) }
            for ref in out.refs { refs[ref.id] = ref }
            total = out.total
            nextCursor = out.nextCursor
        } catch {
            failure = ErrorMessages.text(for: error)
        }
    }

    func select(view id: String) async {
        guard id != viewId else { return }
        viewId = id
        rows = []
        nextCursor = nil
        await reloadRows()
    }

    func shiftMonth(_ n: Int) async {
        month = WikiDb.addMonths(month, n)
        await reloadRows()
    }

    func reloadRows() async {
        loading = true
        defer { loading = false }
        do {
            try await queryFirstPage()
            failure = nil
        } catch {
            if CanvasSaver.retryable(error) { offlineSince = offlineSince ?? Date() } else { failure = ErrorMessages.text(for: error) }
        }
    }

    /// wiki.rows.changed / a reconnect: read again after a short pause (several events fold into one read); the schema
    /// too when it moved.
    func changed(schemaVersion: Int? = nil) {
        reloadTask?.cancel()
        let delay = reloadDelay
        reloadTask = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
            guard let self, !Task.isCancelled else { return }
            if let schemaVersion, let known = self.database?.schemaVersion, schemaVersion > known {
                await self.load()
            } else {
                await self.reloadRows()
            }
        }
    }

    /// Resolves once a scheduled read has finished (tests).
    func settled() async { await reloadTask?.value }

    func stop() {
        reloadTask?.cancel()
        reloadTask = nil
    }

    /// A new row: its title (and, on a calendar, the day shown) — `clientSaveId` is the sheet's, kept across retries.
    func createRow(title: String, props: [String: JSONValue] = [:], clientSaveId: String) async throws -> DbRow {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        let out = try await api.createRow(databaseId: databaseId, title: title, props: props, clientSaveId: clientSaveId)
        for ref in out.refs { refs[ref.id] = ref }
        if !rows.contains(where: { $0.id == out.row.id }) {
            rows.append(out.row)
            total += 1
        }
        changed()
        return out.row
    }

    /// The props a new row starts with on a calendar: the shown day on the view's date property (today in this month,
    /// else the month's first day).
    func newRowProps(today: Date = Date()) -> [String: JSONValue] {
        guard let prop = datePropOfView, prop.type == "date" else { return [:] }
        let todayIso = WikiDb.iso(today, zone: zone)
        let day = todayIso.hasPrefix(String(month.prefix(7))) ? todayIso : month
        return [prop.id: DbDateValue(start: day).json]
    }
}

/// A row page's properties (§5.5: the form over the body): its cells with the database's schema, the rows linking here,
/// cell writes, and reading again on `wiki.page.updated` (change "props").
@MainActor
@Observable
final class WikiRowModel {
    let rowId: String
    private(set) var detail: DbRowDetail?
    private(set) var failure: String?
    private(set) var offline = false
    /// Cells being written (a spinner next to them).
    private(set) var writing: Set<String> = []

    @ObservationIgnored private let api: WikiDbApi?
    @ObservationIgnored private let store: Store

    init(rowId: String, api: WikiDbApi?, store: Store) {
        self.rowId = rowId
        self.api = api
        self.store = store
        // Offline: the row as the last database page opened showed it.
        if let kept = WikiDbKept.load(store), let row = kept.rows.first(where: { $0.id == rowId }) {
            detail = DbRowDetail(row: row, database: kept.database, databaseTitle: "", refs: kept.refs, referencedBy: [])
            offline = true
        }
    }

    var refs: [String: DbRowRef] { Dictionary((detail?.refs ?? []).map { ($0.id, $0) }, uniquingKeysWith: { _, b in b }) }
    var rights: DbRights { offline ? DbRights(editCells: false) : DbRights.of(detail?.database.myLevel) }

    func load() async {
        guard let api else { return }
        do {
            detail = try await api.wikiRow(id: rowId)
            failure = nil
            offline = false
        } catch {
            if CanvasSaver.retryable(error), detail != nil {
                offline = true
            } else if detail == nil || !CanvasSaver.retryable(error) {
                failure = ErrorMessages.text(for: error)
            }
        }
    }

    /// One cell: shown at once, written with one op id (retried with it), then the server's row; a refusal reads the
    /// row again and throws (the screen shows the error).
    func set(_ propId: String, _ value: JSONValue) async throws {
        guard let api, var current = detail else { return }
        let type = current.database.property(propId)?.type
        current.row = WikiDb.applying(current.row, propId: propId, value: value, type: type)
        detail = current
        writing.insert(propId)
        defer { writing.remove(propId) }
        do {
            let out = try await DbCellWriter.write(api: api, rowId: rowId, set: [propId: value])
            guard var next = detail else { return }
            next.row = out.row
            var known = refs
            for ref in out.refs { known[ref.id] = ref }
            next.refs = Array(known.values)
            detail = next
        } catch {
            await load()
            throw error
        }
    }

    /// The rows a relation cell may link to (`…/candidates`: the related database's rows I can read).
    func candidates(_ prop: DbProperty, q: String) async -> [DbRowRef] {
        guard let api, let databaseId = detail?.row.databaseId else { return [] }
        return (try? await api.relationCandidates(databaseId: databaseId, propId: prop.id, q: q)) ?? []
    }

    /// A row the picker found: its title for the chip until the server's answer names it.
    func remember(_ ref: DbRowRef) {
        guard var next = detail, !next.refs.contains(where: { $0.id == ref.id }) else { return }
        next.refs.append(ref)
        detail = next
    }
}
