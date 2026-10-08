import Foundation

/// M124 (docs/WIKI.md §5, §18.2): wiki databases on the phone. A database is a page of kind `database`; its rows are
/// pages of kind `row` (title, cells, a body). The server sorts and filters (§5.4); the phone shows what it answers.
/// Cells stay as JSON (`props: {prop_id: value}`) and are read and written through `WikiDb`'s rules.

/// One option of a select / multi-select property.
struct DbOption: Codable, Equatable, Identifiable {
    let id: String
    var name: String
    var color: String = "gray"
}

/// Where a relation points. A database I cannot read has no id or title (its rows are 「アクセスできないページ」, §5.7).
struct DbRelationInfo: Codable, Equatable {
    var databaseId: String?
    var databaseTitle: String?
    var pairId: String?
    var primary: Bool = true
}

/// A property of the schema (`PropertyOut`), in display order (the title first).
struct DbProperty: Codable, Equatable, Identifiable {
    let id: String
    /// "" for a new database's title property: shown as 「名前」.
    var name: String
    /// title | text | number | select | multi_select | date | person | checkbox | url | relation | created_time |
    /// updated_time | created_by | updated_by (an unknown type of a newer server shows as text, read only).
    var type: String
    var options: [DbOption] = []
    var numberFormat: String?
    var relation: DbRelationInfo?

    init(id: String, name: String, type: String, options: [DbOption] = [], numberFormat: String? = nil, relation: DbRelationInfo? = nil) {
        self.id = id
        self.name = name
        self.type = type
        self.options = options
        self.numberFormat = numberFormat
        self.relation = relation
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        type = try c.decode(String.self, forKey: .type)
        options = try c.decodeIfPresent([DbOption].self, forKey: .options) ?? []
        numberFormat = try c.decodeIfPresent(String.self, forKey: .numberFormat)
        relation = try c.decodeIfPresent(DbRelationInfo.self, forKey: .relation)
    }

    /// The name as shown: an unnamed title is 「名前」, another unnamed property its type's word.
    var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        return type == "title" ? tr("名前") : WikiDb.typeName(type)
    }
}

struct DbViewColumn: Codable, Equatable {
    let propId: String
    var width: Int?
    var hidden: Bool = false

    init(propId: String, width: Int? = nil, hidden: Bool = false) {
        self.propId = propId
        self.width = width
        self.hidden = hidden
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        propId = try c.decode(String.self, forKey: .propId)
        width = try c.decodeIfPresent(Int.self, forKey: .width)
        hidden = try c.decodeIfPresent(Bool.self, forKey: .hidden) ?? false
    }
}

/// M147 (§25.1): a view's groups — a board's columns, a table's / list's / gallery's sections. The phone reads it and
/// never changes it (the hidden groups and the order are in the server's answer).
struct DbGroupBy: Codable, Equatable {
    let propId: String
    /// day | week | month for a date (nil: day).
    var dateUnit: String?
    var hidden: [String] = []
    var hideEmpty: Bool = false

    init(propId: String, dateUnit: String? = nil, hidden: [String] = [], hideEmpty: Bool = false) {
        self.propId = propId
        self.dateUnit = dateUnit
        self.hidden = hidden
        self.hideEmpty = hideEmpty
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        propId = try c.decode(String.self, forKey: .propId)
        dateUnit = try c.decodeIfPresent(String.self, forKey: .dateUnit)
        hidden = try c.decodeIfPresent([String].self, forKey: .hidden) ?? []
        hideEmpty = try c.decodeIfPresent(Bool.self, forKey: .hideEmpty) ?? false
    }
}

/// A saved view (`ViewOut`): a table or a list (cards on the phone), a board (sections of cards, M148), a gallery (a
/// two-column grid, M148) or a calendar (an agenda). The server applies its sort, filter and groups when the query
/// names it; the phone never edits views (§5.5).
struct DbView: Codable, Equatable, Identifiable {
    let id: String
    var name: String
    /// table | calendar | board | list | gallery (an unknown one of a newer server shows as cards).
    var type: String
    var columns: [DbViewColumn] = []
    var datePropId: String?
    /// M147: the groups (nil: none; a board without one shows its cards in one list).
    var groupBy: DbGroupBy?
    /// M147, gallery: the card's picture, body (the body's first image) | none.
    var cover: String = "body"
    /// M147, gallery: small | medium | large (the phone's grid has two columns whatever it is).
    var cardSize: String = "medium"

    init(id: String, name: String = "", type: String = "table", columns: [DbViewColumn] = [], datePropId: String? = nil,
         groupBy: DbGroupBy? = nil, cover: String = "body", cardSize: String = "medium") {
        self.id = id
        self.name = name
        self.type = type
        self.columns = columns
        self.datePropId = datePropId
        self.groupBy = groupBy
        self.cover = cover
        self.cardSize = cardSize
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "table"
        columns = try c.decodeIfPresent([DbViewColumn].self, forKey: .columns) ?? []
        datePropId = try c.decodeIfPresent(String.self, forKey: .datePropId)
        groupBy = try c.decodeIfPresent(DbGroupBy.self, forKey: .groupBy)
        cover = try c.decodeIfPresent(String.self, forKey: .cover) ?? "body"
        cardSize = try c.decodeIfPresent(String.self, forKey: .cardSize) ?? "medium"
    }

    var isCalendar: Bool { type == "calendar" }
    var isBoard: Bool { type == "board" }
    var isGallery: Bool { type == "gallery" }
    /// The gallery asks for each row's picture (`covers: true`).
    var showsCovers: Bool { isGallery && cover != "none" }

    /// An unnamed view: its type's word (「表」 for a table and an unknown type).
    var displayName: String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty { return trimmed }
        switch type {
        case "calendar": return tr("カレンダー")
        case "board": return tr("ボード")
        case "list": return tr("リスト")
        case "gallery": return tr("ギャラリー")
        default: return tr("表")
        }
    }

    /// The switcher's symbol of the type.
    var symbol: String {
        switch type {
        case "calendar": "calendar"
        case "board": "rectangle.split.3x1"
        case "list": "list.bullet"
        case "gallery": "square.grid.2x2"
        default: "tablecells"
        }
    }
}

/// GET /wiki/databases/{id}.
struct WikiDatabase: Codable, Equatable {
    let pageId: String
    var schemaVersion: Int
    var properties: [DbProperty]
    var views: [DbView]
    var myLevel: WikiLevel
    var rowCount: Int
    /// M146: the row templates (「＋」's list, oldest first) and the one a new row starts from when none is named.
    var templates: [DbTemplateRef]
    var defaultTemplateId: String?

    init(pageId: String, schemaVersion: Int = 1, properties: [DbProperty], views: [DbView], myLevel: WikiLevel = .edit, rowCount: Int = 0,
         templates: [DbTemplateRef] = [], defaultTemplateId: String? = nil) {
        self.pageId = pageId
        self.schemaVersion = schemaVersion
        self.properties = properties
        self.views = views
        self.myLevel = myLevel
        self.rowCount = rowCount
        self.templates = templates
        self.defaultTemplateId = defaultTemplateId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pageId = try c.decode(String.self, forKey: .pageId)
        schemaVersion = try c.decodeIfPresent(Int.self, forKey: .schemaVersion) ?? 0
        properties = try c.decodeIfPresent([DbProperty].self, forKey: .properties) ?? []
        views = try c.decodeIfPresent([DbView].self, forKey: .views) ?? []
        myLevel = WikiLevel(raw: try c.decodeIfPresent(String.self, forKey: .myLevel))
        rowCount = try c.decodeIfPresent(Int.self, forKey: .rowCount) ?? 0
        templates = try c.decodeIfPresent([DbTemplateRef].self, forKey: .templates) ?? []
        defaultTemplateId = try c.decodeIfPresent(String.self, forKey: .defaultTemplateId)
    }

    func property(_ id: String) -> DbProperty? { properties.first { $0.id == id } }
    func view(_ id: String?) -> DbView? { id.flatMap { id in views.first { $0.id == id } } }

    /// The template 「＋」 starts from when nothing is named (a trashed default comes as null).
    var defaultTemplate: DbTemplateRef? { defaultTemplateId.flatMap { id in templates.first { $0.id == id } } }
}

/// A row template of a database (M146, §22.3): open it as a page to change it.
struct DbTemplateRef: Codable, Equatable, Identifiable {
    let id: String
    var title: String
    var icon: String?

    var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? tr("無題") : trimmed
    }
}

/// What a new row starts from (POST …/rows): nothing named → the database's default template (the server picks it), a
/// named template, or blank even when there is a default.
enum DbRowStart: Equatable {
    case standard
    case template(String)
    case blank
}

/// POST /wiki/databases/{id}/rows.
struct DbRowCreate: Equatable {
    var title: String
    var props: [String: JSONValue] = [:]
    var start: DbRowStart = .standard
    var clientSaveId: String
    var tz: String? = TimeZone.current.identifier

    var json: JSONValue {
        var fields: [String: JSONValue] = ["title": .string(title), "props": .object(props), "client_save_id": .string(clientSaveId)]
        switch start {
        case .standard: break
        case .template(let id): fields["template_id"] = .string(id)
        case .blank: fields["blank"] = .bool(true)
        }
        if let tz { fields["tz"] = .string(tz) }
        return .object(fields)
    }
}

/// A date cell: `start` "YYYY-MM-DD" (time false) or ISO 8601 with its offset (time true); `end` a range's last.
struct DbDateValue: Codable, Equatable {
    var start: String
    var end: String?
    var time: Bool = false

    var json: JSONValue {
        .object(["start": .string(start), "end": end.map { .string($0) } ?? .null, "time": .bool(time)])
    }

    init(start: String, end: String? = nil, time: Bool = false) {
        self.start = start
        self.end = end
        self.time = time
    }

    init?(_ value: JSONValue?) {
        guard let value, case .string(let start)? = value["start"] else { return nil }
        self.start = start
        end = value["end"]?.stringValue
        if case .bool(let timed)? = value["time"] { time = timed } else { time = start.count > 10 }
    }
}

/// A row without its body (`RowOut`).
struct DbRow: Codable, Equatable, Identifiable {
    let id: String
    var databaseId: String
    var title: String
    var icon: String?
    var position: String = ""
    var version: Int = 1
    var headRevId: String = ""
    /// Stored values by property id (no relations; empty cells are left out).
    var props: [String: JSONValue] = [:]
    /// Relation cells: the linked rows I can read, in order (titles in the refs).
    var relations: [String: [String]] = [:]
    /// Relation properties that also link to rows I cannot read (one 「アクセスできないページ」, never ids).
    var hiddenRelations: [String] = []
    var createdAt: String = ""
    var createdBy: String = ""
    var updatedAt: String = ""
    var updatedBy: String = ""
    /// M147: the gallery's picture (only when the query asked for `covers`).
    var cover: DbRowCover?

    init(id: String, databaseId: String, title: String, icon: String? = nil, version: Int = 1, props: [String: JSONValue] = [:],
         relations: [String: [String]] = [:], hiddenRelations: [String] = [], createdAt: String = "", createdBy: String = "",
         updatedAt: String = "", updatedBy: String = "", cover: DbRowCover? = nil) {
        self.id = id
        self.databaseId = databaseId
        self.title = title
        self.icon = icon
        self.version = version
        self.props = props
        self.relations = relations
        self.hiddenRelations = hiddenRelations
        self.createdAt = createdAt
        self.createdBy = createdBy
        self.updatedAt = updatedAt
        self.updatedBy = updatedBy
        self.cover = cover
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        databaseId = try c.decodeIfPresent(String.self, forKey: .databaseId) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        icon = try c.decodeIfPresent(String.self, forKey: .icon)
        position = try c.decodeIfPresent(String.self, forKey: .position) ?? ""
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        headRevId = try c.decodeIfPresent(String.self, forKey: .headRevId) ?? ""
        props = try c.decodeIfPresent([String: JSONValue].self, forKey: .props) ?? [:]
        relations = try c.decodeIfPresent([String: [String]].self, forKey: .relations) ?? [:]
        hiddenRelations = try c.decodeIfPresent([String].self, forKey: .hiddenRelations) ?? []
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        createdBy = try c.decodeIfPresent(String.self, forKey: .createdBy) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
        updatedBy = try c.decodeIfPresent(String.self, forKey: .updatedBy) ?? ""
        cover = try c.decodeIfPresent(DbRowCover.self, forKey: .cover)
    }

    var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? tr("無題") : trimmed
    }
}

/// M147 (§25.2): a gallery card's picture, the first image of the row's body (an image attached to the row): its
/// thumbnail when the server made one, else the file itself.
struct DbRowCover: Codable, Equatable {
    let attachmentId: String
    var thumbnail: Bool = true
    var width: Int?
    var height: Int?

    /// The authenticated path the card loads.
    var path: String {
        thumbnail ? "/api/v1/attachments/\(attachmentId)/thumbnail" : "/api/v1/attachments/\(attachmentId)/content?inline=1"
    }
}

/// A linked row I can read.
struct DbRowRef: Codable, Equatable, Identifiable {
    let id: String
    var databaseId: String
    var title: String
    var icon: String?

    var displayTitle: String {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? tr("無題") : trimmed
    }
}

/// POST /wiki/databases/{id}/query.
struct DbQueryOut: Codable, Equatable {
    var rows: [DbRow]
    var refs: [DbRowRef] = []
    var total: Int = 0
    var nextCursor: String?
    var schemaVersion: Int = 0
    /// M147, a grouped answer only: every group in order (hidden ones too, with their counts) and the group of each of
    /// `rows` (a row with several values comes once in each of its groups).
    var groups: [DbRowGroup]?
    var rowGroups: [String]?
}

/// A group of a grouped answer (`RowGroup`): the phone names it (the option, the person, 「なし」 for "").
struct DbRowGroup: Codable, Equatable {
    let key: String
    var count: Int = 0
    var hidden: Bool = false
}

/// A row with the titles of its linked rows (a create's or a cell write's answer).
struct DbRowWithRefs: Codable, Equatable {
    var row: DbRow
    var refs: [DbRowRef] = []
}

/// Rows I can read that link to this row through a one-way relation (「（データベース）の（プロパティ）」, §5.7).
struct DbReferencedBy: Codable, Equatable {
    var databaseId: String
    var databaseTitle: String
    var propId: String
    var propName: String
    var rows: [DbRowRef]
}

/// GET /wiki/rows/{id}: the row's cells with its database's schema (the row page shows them over the body).
struct DbRowDetail: Codable, Equatable {
    var row: DbRow
    var database: WikiDatabase
    var databaseTitle: String
    var refs: [DbRowRef] = []
    var referencedBy: [DbReferencedBy] = []
}

/// The query of a view: the saved view's sort and filter (the server's), a calendar's month window.
struct DbQuery: Equatable {
    var viewId: String?
    var range: (propId: String, start: String, end: String)?
    var cursor: String?
    var limit: Int = 100
    /// M148: true answers in the view's groups (`groups`, `row_groups`); nil (left out) as before M147.
    var grouped: Bool?
    /// M148: each row's gallery picture.
    var covers = false
    /// The device's IANA zone: the day of a time when grouping by a date.
    var tz: String?

    static func == (a: DbQuery, b: DbQuery) -> Bool {
        a.viewId == b.viewId && a.cursor == b.cursor && a.limit == b.limit && a.range?.propId == b.range?.propId
            && a.range?.start == b.range?.start && a.range?.end == b.range?.end && a.grouped == b.grouped && a.covers == b.covers
            && a.tz == b.tz
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = ["limit": .number(Double(limit))]
        if let viewId { fields["view_id"] = .string(viewId) }
        if let range { fields["range"] = .object(["prop_id": .string(range.propId), "start": .string(range.start), "end": .string(range.end)]) }
        if let cursor { fields["cursor"] = .string(cursor) }
        if let grouped { fields["grouped"] = .bool(grouped) }
        if covers { fields["covers"] = .bool(true) }
        if let tz { fields["tz"] = .string(tz) }
        return .object(fields)
    }
}

/// POST /wiki/rows/{id}/move (M147, §25.2): a board card's 「◯◯へ移動」 on the phone — the column's value only (no
/// place: the row keeps its place in the rows' order). One `client_op_id` per move, the same on every retry (the
/// server sets the cells once).
struct DbRowMove: Equatable {
    var set: [String: JSONValue]
    var clientOpId: String

    var json: JSONValue { .object(["set": .object(set), "client_op_id": .string(clientOpId)]) }
}

/// What the phone may do with a database and its rows (§5.5, §18.1): edit adds rows and changes cells, full changes the
/// schema and views — on the desktop only. View reads (read-only forms).
struct DbRights: Equatable {
    let editCells: Bool

    var addRows: Bool { editCells }
    /// Never on the phone (§9.2 / §13): properties and views are set on the desktop.
    var editSchema: Bool { false }

    static func of(_ level: WikiLevel?) -> DbRights { DbRights(editCells: (level ?? .view) >= .edit) }

    /// A property a person sets (the created / updated ones are the server's, unknown types are read only).
    static func isEditable(_ prop: DbProperty) -> Bool { WikiDb.editableTypes.contains(prop.type) }
}

/// The rules of the database screens, without SwiftUI (the tests' subject).
enum WikiDb {
    static let titleId = "title"
    static let editableTypes: Set<String> = ["title", "text", "number", "select", "multi_select", "date", "person", "checkbox", "url", "relation"]
    static let dateTypes: Set<String> = ["date", "created_time", "updated_time"]
    static let personTypes: Set<String> = ["person", "created_by", "updated_by"]
    /// How many properties a card shows under its title (§5.5).
    static let cardFieldLimit = 3

    static func typeName(_ type: String) -> String {
        switch type {
        case "title": tr("タイトル")
        case "text": tr("テキスト")
        case "number": tr("数値")
        case "select": tr("セレクト")
        case "multi_select": tr("マルチセレクト")
        case "date": tr("日付")
        case "person": tr("ユーザー")
        case "checkbox": tr("チェックボックス")
        case "url": "URL"
        case "relation": tr("リレーション")
        case "created_time": tr("作成日時")
        case "updated_time": tr("最終更新日時")
        case "created_by": tr("作成者")
        case "updated_by": tr("最終更新者")
        default: type
        }
    }

    // MARK: reading a cell

    /// A cell as the server has it (computed ones from the row; relations: the readable row ids). nil: empty.
    static func value(_ prop: DbProperty, _ row: DbRow) -> JSONValue? {
        switch prop.type {
        case "title": return row.title.isEmpty ? nil : .string(row.title)
        case "created_time": return DbDateValue(start: row.createdAt, time: true).json
        case "updated_time": return DbDateValue(start: row.updatedAt, time: true).json
        case "created_by": return row.createdBy.isEmpty ? nil : .array([.string(row.createdBy)])
        case "updated_by": return row.updatedBy.isEmpty ? nil : .array([.string(row.updatedBy)])
        case "relation":
            let ids = row.relations[prop.id] ?? []
            return ids.isEmpty ? nil : .array(ids.map { .string($0) })
        default:
            let value = row.props[prop.id]
            return value == .null ? nil : value
        }
    }

    static func strings(_ value: JSONValue?) -> [String] { value?.arrayValue?.compactMap(\.stringValue) ?? [] }

    static func number(_ value: JSONValue?) -> Double? {
        if case .number(let n)? = value { return n }
        return nil
    }

    static func isChecked(_ prop: DbProperty, _ row: DbRow) -> Bool {
        if case .bool(true)? = row.props[prop.id] { return true }
        return false
    }

    /// The options a select / multi-select cell names, in the cell's order (unknown ids are dropped).
    static func options(_ prop: DbProperty, _ row: DbRow) -> [DbOption] {
        let value = row.props[prop.id]
        let ids = prop.type == "select" ? [value?.stringValue].compactMap { $0 } : strings(value)
        return ids.compactMap { id in prop.options.first { $0.id == id } }
    }

    /// The number as its format shows it: 50 %, ¥1,200, an integer, or as written.
    static func formatNumber(_ value: Double, format: String?, locale: Locale = .current) -> String {
        let formatter = NumberFormatter()
        formatter.locale = locale
        switch format {
        case "percent":
            formatter.numberStyle = .decimal
            formatter.maximumFractionDigits = 2
            formatter.usesGroupingSeparator = false
            return (formatter.string(from: NSNumber(value: value * 100)) ?? "\(value * 100)") + "%"
        case "yen":
            formatter.numberStyle = .currency
            formatter.currencyCode = "JPY"
            formatter.maximumFractionDigits = 0
            return formatter.string(from: NSNumber(value: value)) ?? "¥\(Int(value))"
        case "integer":
            formatter.numberStyle = .decimal
            formatter.maximumFractionDigits = 0
            formatter.usesGroupingSeparator = false
            return formatter.string(from: NSNumber(value: value)) ?? "\(Int(value.rounded()))"
        default:
            formatter.numberStyle = .decimal
            formatter.maximumFractionDigits = 10
            formatter.usesGroupingSeparator = false
            return formatter.string(from: NSNumber(value: value)) ?? "\(value)"
        }
    }

    /// "2026/10/07", "2026/10/07 9:30", a range with " → ". Times show in `zone`.
    static func formatDate(_ value: DbDateValue, zone: TimeZone = .current, locale: Locale = .current) -> String {
        func one(_ text: String) -> String {
            if !value.time || text.count <= 10 {
                guard let date = day(text).flatMap({ dayDate($0, zone: zone) }) else { return text }
                return dateFormatter(time: false, zone: zone, locale: locale).string(from: date)
            }
            guard let date = parseIsoDate(text) else { return text }
            return dateFormatter(time: true, zone: zone, locale: locale).string(from: date)
        }
        guard let end = value.end, !end.isEmpty else { return one(value.start) }
        return one(value.start) + " → " + one(end)
    }

    private static func dateFormatter(time: Bool, zone: TimeZone, locale: Locale) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = zone
        formatter.setLocalizedDateFormatFromTemplate(time ? "yyyyMMddjmm" : "yyyyMMdd")
        return formatter
    }

    /// Who a user id is (a deactivated person keeps their name, §5.2).
    typealias Names = (String) -> String

    // MARK: a row template's dynamic values (M146, §22.3)

    /// A date cell of a row template that becomes the day the row is made: `{"start": "@today"}` (or `"@today"`).
    static let todayToken = "@today"
    /// A person cell's entry of a row template that becomes the person making the row.
    static let meToken = "@me"

    static func isToday(_ value: JSONValue?) -> Bool {
        if value?.stringValue == todayToken { return true }
        return value?["start"]?.stringValue == todayToken
    }

    /// The date cell 「今日（行を作る日）」 of a row template.
    static var todayValue: JSONValue { .object(["start": .string(todayToken)]) }

    /// A cell as plain text (a card's line, the agenda, VoiceOver).
    static func text(_ prop: DbProperty, _ row: DbRow, refs: [String: DbRowRef], names: Names, zone: TimeZone = .current,
                     locale: Locale = .current) -> String {
        guard let value = value(prop, row) else {
            return prop.type == "relation" && row.hiddenRelations.contains(prop.id) ? tr("アクセスできないページ") : ""
        }
        switch prop.type {
        case "title", "text", "url": return value.stringValue ?? ""
        case "number": return number(value).map { formatNumber($0, format: prop.numberFormat, locale: locale) } ?? ""
        case "checkbox": return isChecked(prop, row) ? "✓" : ""
        case "select", "multi_select": return options(prop, row).map(\.name).joined(separator: ", ")
        case "date", "created_time", "updated_time":
            if isToday(value) { return tr("今日") }
            return DbDateValue(value).map { $0.start.isEmpty ? "" : formatDate($0, zone: zone, locale: locale) } ?? ""
        case "person", "created_by", "updated_by":
            return strings(value).map { $0 == meToken ? tr("自分") : names($0) }.joined(separator: ", ")
        case "relation":
            var titles = strings(value).map { refs[$0]?.displayTitle ?? tr("無題") }
            if row.hiddenRelations.contains(prop.id) { titles.append(tr("アクセスできないページ")) }
            return titles.joined(separator: ", ")
        default:
            return value.stringValue ?? ""
        }
    }

    // MARK: cards (§5.5)

    /// The view's visible properties in its order, then the ones it does not list (schema order); the title first.
    static func columns(_ database: WikiDatabase, view: DbView?) -> [DbProperty] {
        var out: [DbProperty] = []
        var listed: Set<String> = []
        for column in view?.columns ?? [] {
            guard let prop = database.property(column.propId), listed.insert(prop.id).inserted else { continue }
            if column.hidden && prop.type != "title" { continue }
            out.append(prop)
        }
        for prop in database.properties where !listed.contains(prop.id) { out.append(prop) }
        if let title = out.firstIndex(where: { $0.type == "title" }), title != 0 { out.insert(out.remove(at: title), at: 0) }
        return out
    }

    /// The properties a card shows under its title: the first three the view shows (not the title).
    static func cardProperties(_ database: WikiDatabase, view: DbView?) -> [DbProperty] {
        Array(columns(database, view: view).filter { $0.type != "title" }.prefix(cardFieldLimit))
    }

    /// One line of a card: the property and its value as text; a select keeps its options for the chips.
    struct CardField: Equatable, Identifiable {
        let prop: DbProperty
        let text: String
        var options: [DbOption] = []
        var id: String { prop.id }
    }

    /// A card's lines: the card properties that have a value (an empty one leaves no blank line).
    static func card(_ row: DbRow, properties: [DbProperty], refs: [String: DbRowRef], names: Names, zone: TimeZone = .current,
                     locale: Locale = .current) -> [CardField] {
        properties.compactMap { prop in
            let text = text(prop, row, refs: refs, names: names, zone: zone, locale: locale)
            guard !text.isEmpty else { return nil }
            let options = prop.type == "select" || prop.type == "multi_select" ? options(prop, row) : []
            return CardField(prop: prop, text: text, options: options)
        }
    }

    // MARK: groups and boards (M148, §25)

    /// The group of rows with no value (「なし」).
    static let noneGroup = ""
    /// The types a board's columns may be (a card moves by setting the value).
    static let boardGroupTypes: Set<String> = ["select", "person", "checkbox"]

    /// The property a view groups by (nil: no groups, a calendar, or one deleted since).
    static func groupProperty(_ database: WikiDatabase, view: DbView?) -> DbProperty? {
        guard let view, !view.isCalendar, let groupBy = view.groupBy, let prop = database.property(groupBy.propId) else { return nil }
        if view.isBoard && !boardGroupTypes.contains(prop.type) { return nil }
        return prop
    }

    /// A group's name: the option, the person, オン / オフ, the day / week / month, 「なし」 for "".
    static func groupName(_ prop: DbProperty, key: String, unit: String?, names: Names, locale: Locale = .current) -> String {
        if prop.type == "checkbox" { return key == "true" ? tr("オン") : tr("オフ") }
        if key == noneGroup { return tr("なし") }
        switch prop.type {
        case "select", "multi_select":
            return prop.options.first { $0.id == key }?.name ?? tr("なし")
        case "person", "created_by", "updated_by":
            return names(key)
        default:
            if unit == "month" { return monthHeading(key, locale: locale) }
            let day = formatDate(DbDateValue(start: key), zone: TimeZone(identifier: "UTC")!, locale: locale)
            return unit == "week" ? tr("\(day) の週") : day
        }
    }

    /// The option a select / multi-select group shows as its chip (nil: 「なし」, or an option deleted since).
    static func groupOption(_ prop: DbProperty, key: String) -> DbOption? {
        guard prop.type == "select" || prop.type == "multi_select", key != noneGroup else { return nil }
        return prop.options.first { $0.id == key }
    }

    /// One section of a grouped view: its group and its rows (a row with several values is in each of its groups).
    struct GroupSection: Equatable, Identifiable {
        let key: String
        var count: Int
        var hidden: Bool
        var rows: [DbRow]
        var id: String { key }
    }

    /// The sections of an answer in the server's order (`rowGroups[i]` is the group of `rows[i]`). Hidden groups are left
    /// out (the server sends none of their rows; their settings are the desktop's).
    static func sections(groups: [DbRowGroup], rows: [DbRow], rowGroups: [String]) -> [GroupSection] {
        var out = groups.filter { !$0.hidden }.map { GroupSection(key: $0.key, count: $0.count, hidden: false, rows: []) }
        var index: [String: Int] = [:]
        for (i, section) in out.enumerated() where index[section.key] == nil { index[section.key] = i }
        for (i, row) in rows.enumerated() {
            let key = i < rowGroups.count ? rowGroups[i] : noneGroup
            guard let at = index[key], !out[at].rows.contains(where: { $0.id == row.id }) else { continue }
            out[at].rows.append(row)
        }
        return out
    }

    /// The value a board card gets when it moves from the column `from` to `to` (§25.2): a select takes the option
    /// (「なし」 clears it), a checkbox the column's state, a person loses `from` and gains `to` (「なし」 clears it).
    static func boardValue(_ prop: DbProperty, _ row: DbRow, from: String, to: String) -> JSONValue {
        if prop.type == "checkbox" { return .bool(to == "true") }
        if to == noneGroup { return .null }
        if prop.type == "person" {
            var people = strings(row.props[prop.id]).filter { $0 != from }
            if !people.contains(to) { people.append(to) }
            return encodeIds(people)
        }
        return .string(to)
    }

    /// The columns a board card in `from` may move to: the other shown groups, in order.
    static func moveTargets(_ sections: [GroupSection], from: String) -> [GroupSection] {
        sections.filter { $0.key != from && !$0.hidden }
    }

    // MARK: days and the agenda (§5.8)

    private static func calendar(_ zone: TimeZone) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        calendar.firstWeekday = 2
        return calendar
    }

    /// The time of a timed value in `zone` (「9:30」), nil for a day.
    static func timeLabel(_ text: String, zone: TimeZone = .current, locale: Locale = .current) -> String? {
        guard text.count > 10, let date = parseIsoDate(text) else { return nil }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = zone
        formatter.setLocalizedDateFormatFromTemplate("jmm")
        return formatter.string(from: date)
    }

    /// "YYYY-MM-DD" of a stored date ("2026-10-07…"), nil when it is not one.
    static func day(_ text: String) -> String? {
        let head = String(text.prefix(10))
        guard head.count == 10, head.dropFirst(4).first == "-", head.dropFirst(7).first == "-" else { return nil }
        return head
    }

    /// Midnight of a day in `zone`.
    static func dayDate(_ day: String, zone: TimeZone) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar(zone).date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    static func iso(_ date: Date, zone: TimeZone) -> String {
        let c = calendar(zone).dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    static func addDays(_ day: String, _ n: Int) -> String {
        let utc = TimeZone(identifier: "UTC")!
        guard let date = dayDate(day, zone: utc), let next = calendar(utc).date(byAdding: .day, value: n, to: date) else { return day }
        return iso(next, zone: utc)
    }

    /// The calendar day of a stored value in `zone`: a date as written, a time on that zone's day.
    static func dayOfValue(_ text: String, zone: TimeZone) -> String? {
        if text.count <= 10 { return day(text) }
        guard let date = parseIsoDate(text) else { return day(text) }
        return iso(date, zone: zone)
    }

    /// [first day, last day] of a row on a date property in `zone` (nil: no date).
    static func span(_ prop: DbProperty, _ row: DbRow, zone: TimeZone) -> (first: String, last: String)? {
        guard let value = DbDateValue(value(prop, row)), let first = dayOfValue(value.start, zone: zone) else { return nil }
        let last = value.end.flatMap { dayOfValue($0, zone: zone) } ?? first
        return last < first ? (first, first) : (first, last)
    }

    /// The first and last day of the month holding `day`.
    static func monthBounds(_ day: String) -> (start: String, end: String) {
        let start = String(day.prefix(7)) + "-01"
        let utc = TimeZone(identifier: "UTC")!
        let cal = calendar(utc)
        guard let first = dayDate(start, zone: utc), let next = cal.date(byAdding: .month, value: 1, to: first),
              let last = cal.date(byAdding: .day, value: -1, to: next) else { return (start, start) }
        return (start, iso(last, zone: utc))
    }

    /// The first day of the month `n` months from the one holding `day`.
    static func addMonths(_ day: String, _ n: Int) -> String {
        let utc = TimeZone(identifier: "UTC")!
        guard let first = dayDate(String(day.prefix(7)) + "-01", zone: utc),
              let next = calendar(utc).date(byAdding: .month, value: n, to: first) else { return day }
        return iso(next, zone: utc)
    }

    /// One row on one day of the agenda: `range` is set for a row of several days (「10/5 → 10/9」 next to it).
    struct AgendaEntry: Equatable, Identifiable {
        let rowId: String
        let first: String
        let last: String
        var multiDay: Bool { first != last }
        var id: String { rowId }
    }

    struct AgendaDay: Equatable, Identifiable {
        let day: String
        var entries: [AgendaEntry]
        var id: String { day }
    }

    /// The agenda of [from, to] (§5.8, a phone's calendar): each day that has rows, a row on every day it covers, in
    /// the order given (the server's sort).
    static func agenda(_ spans: [(rowId: String, first: String, last: String)], from: String, to: String) -> [AgendaDay] {
        var days: [String: [AgendaEntry]] = [:]
        for span in spans {
            var day = max(span.first, from)
            let last = min(span.last, to)
            var guardCount = 0
            while day <= last && guardCount < 400 {
                days[day, default: []].append(AgendaEntry(rowId: span.rowId, first: span.first, last: span.last))
                day = addDays(day, 1)
                guardCount += 1
            }
        }
        return days.keys.sorted().map { AgendaDay(day: $0, entries: days[$0] ?? []) }
    }

    /// The agenda of rows on a view's date property in `zone`.
    static func agenda(rows: [DbRow], prop: DbProperty, from: String, to: String, zone: TimeZone) -> [AgendaDay] {
        agenda(rows.compactMap { row in span(prop, row, zone: zone).map { (row.id, $0.first, $0.last) } }, from: from, to: to)
    }

    /// 「10/5 → 10/9」: a multi-day row's range next to it in the agenda.
    static func rangeLabel(_ entry: AgendaEntry) -> String {
        func short(_ day: String) -> String {
            let parts = day.split(separator: "-").compactMap { Int($0) }
            return parts.count == 3 ? "\(parts[1])/\(parts[2])" : day
        }
        return short(entry.first) + " → " + short(entry.last)
    }

    /// The agenda's heading of a day: 「10月7日（水）」 in the app's language.
    static func dayHeading(_ day: String, locale: Locale = .current) -> String {
        let utc = TimeZone(identifier: "UTC")!
        guard let date = dayDate(day, zone: utc) else { return day }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = utc
        formatter.setLocalizedDateFormatFromTemplate("MMMdEEE")
        return formatter.string(from: date)
    }

    static func monthHeading(_ day: String, locale: Locale = .current) -> String {
        let utc = TimeZone(identifier: "UTC")!
        guard let date = dayDate(String(day.prefix(7)) + "-01", zone: utc) else { return day }
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = utc
        formatter.setLocalizedDateFormatFromTemplate("yyyyMMMM")
        return formatter.string(from: date)
    }

    // MARK: writing a cell (§18.2: the value shapes)

    /// Text / URL: trimmed; empty clears the cell. The title keeps "" (the server's 「無題」).
    static func encodeText(_ text: String, type: String) -> JSONValue {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if type == "title" { return .string(trimmed) }
        return trimmed.isEmpty ? .null : .string(type == "url" ? trimmed : text)
    }

    /// A number as typed ("1,200", "１２．５", "50%" for a percent cell → 0.5); nil: not a number. Empty clears (.null).
    static func encodeNumber(_ text: String, format: String?) -> JSONValue? {
        var folded = text.precomposedStringWithCompatibilityMapping.trimmingCharacters(in: .whitespacesAndNewlines)
        if folded.isEmpty { return .null }
        folded = folded.replacingOccurrences(of: ",", with: "").replacingOccurrences(of: "¥", with: "").replacingOccurrences(of: "￥", with: "")
        let percent = folded.hasSuffix("%")
        if percent { folded = String(folded.dropLast()).trimmingCharacters(in: .whitespaces) }
        guard let number = Double(folded), number.isFinite else { return nil }
        return .number(percent || format == "percent" ? number / 100 : number)
    }

    /// The text a number editor starts with (a percent cell shows 50 for 0.5).
    static func numberInput(_ value: JSONValue?, format: String?) -> String {
        guard let n = number(value) else { return "" }
        let shown = format == "percent" ? n * 100 : n
        return shown == shown.rounded() && abs(shown) < 1e15 ? String(Int64(shown)) : String(shown)
    }

    static func encodeSelect(_ optionId: String?) -> JSONValue { optionId.map { .string($0) } ?? .null }

    /// Multi-select, person: the ids; none clears the cell.
    static func encodeIds(_ ids: [String]) -> JSONValue { ids.isEmpty ? .null : .array(ids.map { .string($0) }) }

    /// Relation: the readable rows chosen (the server keeps the links to rows I cannot read, §5.7); none is [].
    static func encodeRelation(_ ids: [String]) -> JSONValue { .array(ids.map { .string($0) }) }

    static func encodeCheckbox(_ on: Bool) -> JSONValue { .bool(on) }

    /// A date cell from the pickers: a day ("2026-10-07") in `zone`, or with `time` the moment with `zone`'s offset
    /// ("2026-10-07T09:30:00+09:00"); an end before the start becomes the start.
    static func encodeDate(start: Date, end: Date?, time: Bool, zone: TimeZone = .current) -> JSONValue {
        func one(_ date: Date) -> String { time ? withOffset(date, zone: zone) : iso(date, zone: zone) }
        let first = one(start)
        var last = end.map(one)
        if let end, end < start { last = first }
        if !time, let lastDay = last, lastDay < first { last = first }
        return DbDateValue(start: first, end: last, time: time).json
    }

    /// A moment as ISO 8601 with `zone`'s offset at that moment ("2026-10-07T09:30:00+09:00").
    static func withOffset(_ date: Date, zone: TimeZone) -> String {
        let cal = calendar(zone)
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let offset = zone.secondsFromGMT(for: date) / 60
        let sign = offset >= 0 ? "+" : "-"
        return String(format: "%04d-%02d-%02dT%02d:%02d:00%@%02d:%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0, c.hour ?? 0, c.minute ?? 0,
                      sign, abs(offset) / 60, abs(offset) % 60)
    }

    /// The pickers' dates of a stored value: a day at 9:00 in `zone` (what a new time starts at), a time as it is.
    static func pickerDate(_ text: String?, zone: TimeZone = .current) -> Date? {
        guard let text, !text.isEmpty else { return nil }
        if text.count <= 10 {
            return day(text).flatMap { dayDate($0, zone: zone) }.map { $0.addingTimeInterval(9 * 3600) }
        }
        return parseIsoDate(text)
    }

    /// The cell after a write, as the screen shows it before the server answers (the server's answer replaces it).
    static func applying(_ row: DbRow, propId: String, value: JSONValue, type: String?) -> DbRow {
        var next = row
        if propId == titleId || type == "title" {
            next.title = value.stringValue ?? ""
        } else if type == "relation" {
            next.relations[propId] = strings(value)
        } else if value == .null || value == .bool(false) {
            next.props[propId] = nil
        } else {
            next.props[propId] = value
        }
        return next
    }
}
