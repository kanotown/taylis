import SwiftUI

/// M124 (docs/WIKI.md §5.5, §9.2): databases on the phone — a database page shows its rows as cards (the title and the
/// first properties of the view) or, for a calendar view, as an agenda by day; a row page shows its properties as a form
/// over the body. The schema and the views are set on the desktop (read only here).

extension DbOption {
    /// The option's chip colour (the server's names).
    var tint: Color {
        switch color {
        case "brown": .brown
        case "orange": .orange
        case "yellow": .yellow
        case "green": .green
        case "blue": .blue
        case "purple": .purple
        case "pink": .pink
        case "red": .red
        default: .gray
        }
    }
}

/// Words of the database screens (pure, for the tests).
enum WikiDbText {
    /// M146: the new row's alert, by what it starts from (a title left empty takes the template's).
    static func newRowMessage(_ start: DbRowStart, database: WikiDatabase?) -> String {
        let opens = tr("作ると行のページが開きます。")
        switch start {
        case .template(let id):
            let name = database?.templates.first { $0.id == id }?.displayTitle ?? tr("テンプレート")
            return tr("「\(name)」から行を作ります。名前を空欄にするとテンプレートの名前になります。") + opens
        case .standard:
            if let fallback = database?.defaultTemplate {
                return tr("既定のテンプレート「\(fallback.displayTitle)」から行を作ります。名前を空欄にするとテンプレートの名前になります。") + opens
            }
            return tr("名前を付けて行を作ります。") + opens
        case .blank:
            return tr("名前を付けて行を作ります。") + opens
        }
    }
}

struct DbOptionChip: View {
    let option: DbOption

    var body: some View {
        Text(verbatim: option.name)
            .font(.caption)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(option.tint.opacity(0.22), in: Capsule())
    }
}

/// 「アクセスできないページ」: links to rows I cannot read (no ids, titles or count, §5.7).
struct DbHiddenRowsChip: View {
    var body: some View {
        Label("アクセスできないページ", systemImage: "lock")
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(Color.secondary.opacity(0.12), in: Capsule())
            .accessibilityHint("あなたが読めない行へのリンクがあります（変更しても残ります）")
    }
}

// MARK: the database page

/// A database page: the view switcher, its rows (cards, or a calendar's month as an agenda), pull to refresh, ＋ for a
/// new row (its title, then the row page). `wiki.rows.changed` and a reconnect read it again (debounced).
struct WikiDatabaseScreen: View {
    @Bindable var controller: AppController
    let hub: WikiHub
    let databaseId: String
    let onOpenPage: (String) -> Void
    @State private var model: WikiDatabaseModel?
    @State private var newRow = false
    @State private var newTitle = ""
    @State private var newKey = UUID().uuidString.lowercased()
    @State private var newStart: DbRowStart = .standard
    @State private var creating = false

    private var item: WikiPageItem? { hub.item(databaseId) }

    var body: some View {
        Group {
            if let model {
                content(model)
            } else {
                ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .navigationTitle(item?.displayTitle ?? tr("データベース"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if let model, model.rights.addRows, model.offlineSince == nil {
                    let templates = model.database?.templates ?? []
                    if templates.isEmpty {
                        Button { startRow(.standard) } label: {
                            Image(systemName: "plus")
                        }
                        .disabled(creating)
                        .accessibilityLabel("新しい行")
                        .accessibilityIdentifier("wiki-db-new-row")
                    } else {
                        // M146 (§24.3): the row templates — 「新規」 from the default (the server picks it), one of
                        // them, or blank; and opening a template to change it.
                        Menu {
                            let fallback = model.database?.defaultTemplate
                            Button(fallback.map { tr("新規（\($0.displayTitle)）") } ?? tr("新規"), systemImage: "plus") { startRow(.standard) }
                            Section("テンプレートから") {
                                ForEach(templates) { template in
                                    Button {
                                        startRow(.template(template.id))
                                    } label: {
                                        Label(template.displayTitle, systemImage: template.id == fallback?.id ? "star.fill" : "doc.on.doc")
                                    }
                                }
                            }
                            Button("白紙の行", systemImage: "doc") { startRow(.blank) }
                            Menu("テンプレートを開く", systemImage: "pencil") {
                                ForEach(templates) { template in
                                    Button(template.displayTitle) { onOpenPage(template.id) }
                                }
                            }
                        } label: {
                            Image(systemName: "plus")
                        }
                        .disabled(creating)
                        .accessibilityLabel("新しい行")
                        .accessibilityIdentifier("wiki-db-new-row")
                    }
                }
                Menu {
                    Button("リンクをコピー", systemImage: "link") { controller.copyPageLink(databaseId) }
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("データベースの操作")
            }
        }
        .alert("新しい行", isPresented: $newRow) {
            TextField("名前", text: $newTitle)
            Button("キャンセル", role: .cancel) {}
            Button("作成") { Task { await create() } }
        } message: {
            Text(WikiDbText.newRowMessage(newStart, database: model?.database))
        }
        .onAppear {
            if model == nil {
                let next = WikiDatabaseModel(databaseId: databaseId, api: controller.api, store: controller.store)
                model = next
                Task { await next.load() }
            }
        }
        .onDisappear { model?.stop() }
        .onChange(of: hub.rowsSignal[databaseId.lowercased()]) { _, _ in
            model?.changed(schemaVersion: hub.rowsSchema[databaseId.lowercased()])
        }
        .onChange(of: hub.reconnects) { _, _ in model?.changed() }
    }

    /// The title alert for a new row started from `start` (one key per row).
    private func startRow(_ start: DbRowStart) {
        newStart = start
        newTitle = ""
        newKey = UUID().uuidString.lowercased()
        newRow = true
    }

    private func create() async {
        guard let model else { return }
        creating = true
        defer { creating = false }
        do {
            let title = WikiText.title(newTitle) ?? ""
            let row = try await model.createRow(title: title, props: model.newRowProps(), start: newStart, clientSaveId: newKey)
            onOpenPage(row.id)
        } catch {
            controller.error = controller.describe(error)
        }
    }

    @ViewBuilder
    private func content(_ model: WikiDatabaseModel) -> some View {
        if let database = model.database {
            let view = model.view
            List {
                if let since = model.offlineSince {
                    Label(CanvasOffline.notice(savedAt: since), systemImage: "wifi.slash")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .listRowSeparator(.hidden)
                }
                if !model.rights.editCells {
                    Text("閲覧のみです。").font(.footnote).foregroundStyle(.secondary).listRowSeparator(.hidden)
                }
                if database.views.count > 1 {
                    viewSwitcher(model, database: database)
                        .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                        .listRowSeparator(.hidden)
                }
                if view?.isCalendar == true {
                    agenda(model, database: database)
                } else {
                    cards(model, database: database, view: view)
                }
            }
            .listStyle(.plain)
            .refreshable { await model.load() }
        } else if let failure = model.failure {
            ContentUnavailableView {
                Label("データベースを読み込めませんでした", systemImage: "exclamationmark.triangle")
            } description: {
                Text(failure)
            } actions: {
                Button("再読み込み") { Task { await model.load() } }.buttonStyle(.bordered)
            }
        } else if model.offlineSince != nil {
            ContentUnavailableView("オフラインです", systemImage: "wifi.slash", description: Text("このデータベースはこの端末に保存されていません。"))
        } else {
            ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// The saved views as chips (a table's cards, a calendar's agenda).
    private func viewSwitcher(_ model: WikiDatabaseModel, database: WikiDatabase) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(database.views) { view in
                    let selected = view.id == model.view?.id
                    Button {
                        Task { await model.select(view: view.id) }
                    } label: {
                        Label(view.displayName, systemImage: view.isCalendar ? "calendar" : "rectangle.grid.1x2")
                            .font(.subheadline)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(selected ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.1), in: Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("ビュー")
    }

    private func names(_ id: String) -> String {
        let store = controller.store
        return store.users[id]?.displayName ?? (store.me?.id == id ? store.me?.displayName : nil) ?? tr("メンバー")
    }

    @ViewBuilder
    private func cards(_ model: WikiDatabaseModel, database: WikiDatabase, view: DbView?) -> some View {
        let properties = WikiDb.cardProperties(database, view: view)
        if model.rows.isEmpty && !model.loading {
            Text(model.rights.addRows ? "行はまだありません。＋で追加できます。" : "行はまだありません。")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .listRowSeparator(.hidden)
        }
        ForEach(model.rows) { row in
            Button { onOpenPage(row.id) } label: {
                WikiDbCard(controller: controller, row: row,
                           fields: WikiDb.card(row, properties: properties, refs: model.refs, names: names, locale: UILanguage.shared.locale))
            }
            .buttonStyle(.plain)
            .onAppear {
                if row.id == model.rows.last?.id, model.nextCursor != nil { Task { await model.loadMore() } }
            }
        }
        if model.nextCursor != nil {
            Button("さらに読み込む") { Task { await model.loadMore() } }
                .frame(maxWidth: .infinity)
                .listRowSeparator(.hidden)
        }
        if model.total > 0 {
            Text("\(model.total) 行").font(.caption).foregroundStyle(.secondary).frame(maxWidth: .infinity).listRowSeparator(.hidden)
        }
    }

    @ViewBuilder
    private func agenda(_ model: WikiDatabaseModel, database: WikiDatabase) -> some View {
        HStack {
            Button { Task { await model.shiftMonth(-1) } } label: { Image(systemName: "chevron.left").frame(width: 44, height: 36) }
                .accessibilityLabel("前の月")
            Spacer()
            Text(verbatim: WikiDb.monthHeading(model.month, locale: UILanguage.shared.locale)).font(.headline)
            Spacer()
            Button { Task { await model.shiftMonth(1) } } label: { Image(systemName: "chevron.right").frame(width: 44, height: 36) }
                .accessibilityLabel("次の月")
        }
        .buttonStyle(.borderless)
        .listRowSeparator(.hidden)
        if let prop = model.datePropOfView {
            let bounds = WikiDb.monthBounds(model.month)
            let days = WikiDb.agenda(rows: model.rows, prop: prop, from: bounds.start, to: bounds.end, zone: .current)
            let byId = Dictionary(model.rows.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
            if days.isEmpty && !model.loading {
                Text("この月の行はありません").font(.subheadline).foregroundStyle(.secondary).listRowSeparator(.hidden)
            }
            ForEach(days) { day in
                Section {
                    ForEach(day.entries) { entry in
                        if let row = byId[entry.rowId] {
                            Button { onOpenPage(row.id) } label: {
                                HStack(spacing: 8) {
                                    if let icon = row.icon, !icon.isEmpty { WikiIconView(icon: icon, controller: controller, size: 15) }
                                    Text(verbatim: row.displayTitle).lineLimit(1)
                                    Spacer(minLength: 4)
                                    if entry.multiDay {
                                        Text(verbatim: WikiDb.rangeLabel(entry)).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                                    } else if let value = DbDateValue(WikiDb.value(prop, row)), value.time,
                                              let time = WikiDb.timeLabel(value.start, locale: UILanguage.shared.locale) {
                                        Text(verbatim: time).font(.caption).foregroundStyle(.secondary).monospacedDigit()
                                    }
                                }
                                .frame(minHeight: 40)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                } header: {
                    Text(verbatim: WikiDb.dayHeading(day.day, locale: UILanguage.shared.locale))
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(day.day == WikiDb.iso(Date(), zone: .current) ? Color.accentColor : Color.secondary)
                }
            }
        } else {
            Text("このカレンダーの日付のプロパティがありません。パソコンでビューを設定してください。")
                .font(.subheadline).foregroundStyle(.secondary).listRowSeparator(.hidden)
        }
    }
}

/// A row as a card: its icon and title, then up to three properties of the view (§5.5).
struct WikiDbCard: View {
    @Bindable var controller: AppController
    let row: DbRow
    let fields: [WikiDb.CardField]

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 8) {
                if let icon = row.icon, !icon.isEmpty { WikiIconView(icon: icon, controller: controller, size: 16) }
                Text(verbatim: row.displayTitle).font(.body.weight(.semibold)).lineLimit(2)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
            }
            ForEach(fields) { field in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: field.prop.displayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .frame(width: 88, alignment: .leading)
                    if !field.options.isEmpty {
                        HStack(spacing: 4) { ForEach(field.options) { DbOptionChip(option: $0) } }
                    } else {
                        Text(verbatim: field.text).font(.subheadline).lineLimit(2)
                    }
                }
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

// MARK: a row's properties

/// A cell being edited (one sheet at a time).
private struct DbEditTarget: Identifiable {
    let prop: DbProperty
    var id: String { prop.id }
}

/// The row page's form (§5.5): each property with its value, a tap opens its editor (read only for viewers and for
/// the computed ones); the rows linking here (`referenced_by`). `wiki.page.updated` (props) reads it again.
struct WikiRowPropertiesView: View {
    @Bindable var controller: AppController
    let hub: WikiHub
    let rowId: String
    let refresh: Int
    let onOpenPage: (String) -> Void
    @State private var model: WikiRowModel?
    @State private var editing: DbEditTarget?

    var body: some View {
        Group {
            if let model, let detail = model.detail {
                form(model, detail: detail)
            } else if let failure = model?.failure {
                Text(failure).font(.footnote).foregroundStyle(.secondary)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .onAppear {
            if model == nil {
                let next = WikiRowModel(rowId: rowId, api: controller.api, store: controller.store)
                model = next
                Task { await next.load() }
            }
        }
        .onChange(of: refresh) { _, _ in Task { await model?.load() } }
        .onChange(of: hub.propsSignal[rowId.lowercased()]) { _, _ in Task { await model?.load() } }
        .onChange(of: hub.reconnects) { _, _ in Task { await model?.load() } }
        .sheet(item: $editing) { target in
            if let model {
                WikiCellEditor(controller: controller, model: model, prop: target.prop, isTemplate: hub.item(rowId)?.isTemplate == true)
            }
        }
    }

    private func names(_ id: String) -> String {
        let store = controller.store
        return store.users[id]?.displayName ?? (store.me?.id == id ? store.me?.displayName : nil) ?? tr("メンバー")
    }

    private func form(_ model: WikiRowModel, detail: DbRowDetail) -> some View {
        let rights = model.rights
        let refs = model.refs
        let props = detail.database.properties.filter { $0.type != "title" }
        return VStack(alignment: .leading, spacing: 0) {
            if props.isEmpty {
                Text("プロパティはまだありません").font(.footnote).foregroundStyle(.secondary)
            }
            ForEach(props) { prop in
                propertyRow(model, prop: prop, row: detail.row, refs: refs, rights: rights)
                Divider()
            }
            ForEach(Array(detail.referencedBy.enumerated()), id: \.offset) { _, group in
                VStack(alignment: .leading, spacing: 4) {
                    Text("\(group.databaseTitle.isEmpty ? tr("無題") : group.databaseTitle) の \(group.propName.isEmpty ? tr("リレーション") : group.propName)")
                        .font(.caption).foregroundStyle(.secondary)
                    WrapChips(refs: group.rows, hidden: false, controller: controller, onOpen: onOpenPage)
                }
                .padding(.vertical, 8)
                Divider()
            }
        }
    }

    @ViewBuilder
    private func propertyRow(_ model: WikiRowModel, prop: DbProperty, row: DbRow, refs: [String: DbRowRef], rights: DbRights) -> some View {
        let editable = rights.editCells && DbRights.isEditable(prop)
        let name = Label(prop.displayName, systemImage: Self.symbol(prop.type))
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .frame(width: 120, alignment: .leading)
        if prop.type == "checkbox" {
            HStack(spacing: 10) {
                name
                Toggle(isOn: Binding(get: { WikiDb.isChecked(prop, row) }, set: { on in write(model, prop, WikiDb.encodeCheckbox(on)) })) {
                    Text(verbatim: prop.displayName)
                }
                .labelsHidden()
                .fixedSize()
                .disabled(!editable)
                Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
        } else {
            // The whole line opens the editor (chips of linked rows inside open those rows).
            Button { if editable { editing = DbEditTarget(prop: prop) } } label: {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    name
                    valueView(prop, row: row, refs: refs)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if model.writing.contains(prop.id) { ProgressView().controlSize(.mini) }
                }
                .frame(minHeight: 30)
                .padding(.vertical, 6)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!editable && prop.type != "url" && prop.type != "relation")
            .accessibilityLabel(Text(verbatim: prop.displayName + tr("、") + WikiDb.text(prop, row, refs: refs, names: names)))
            .accessibilityHint(editable ? tr("値を編集") : "")
        }
    }

    @ViewBuilder
    private func valueView(_ prop: DbProperty, row: DbRow, refs: [String: DbRowRef]) -> some View {
        let text = WikiDb.text(prop, row, refs: refs, names: names, locale: UILanguage.shared.locale)
        switch prop.type {
        case "select", "multi_select":
            let options = WikiDb.options(prop, row)
            if options.isEmpty { empty } else { HStack(spacing: 4) { ForEach(options) { DbOptionChip(option: $0) } } }
        case "relation":
            let ids = WikiDb.strings(WikiDb.value(prop, row))
            if ids.isEmpty && !row.hiddenRelations.contains(prop.id) {
                empty
            } else {
                WrapChips(refs: ids.map { refs[$0] ?? DbRowRef(id: $0, databaseId: "", title: "", icon: nil) },
                          hidden: row.hiddenRelations.contains(prop.id), controller: controller, onOpen: onOpenPage)
            }
        case "url":
            if let url = URL(string: text), !text.isEmpty, ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                Link(destination: url) { Text(verbatim: text).lineLimit(1) }
            } else if text.isEmpty { empty } else { Text(verbatim: text) }
        default:
            if text.isEmpty { empty } else { Text(verbatim: text).font(.subheadline).fixedSize(horizontal: false, vertical: true) }
        }
    }

    private var empty: some View { Text("空").font(.subheadline).foregroundStyle(.tertiary) }

    private func write(_ model: WikiRowModel, _ prop: DbProperty, _ value: JSONValue) {
        Task {
            do { try await model.set(prop.id, value) } catch { controller.error = controller.describe(error) }
        }
    }

    static func symbol(_ type: String) -> String {
        switch type {
        case "text": "text.alignleft"
        case "number": "number"
        case "select": "chevron.down.circle"
        case "multi_select": "list.bullet"
        case "date": "calendar"
        case "person", "created_by", "updated_by": "person"
        case "checkbox": "checkmark.square"
        case "url": "link"
        case "relation": "arrow.up.right"
        case "created_time", "updated_time": "clock"
        default: "textformat"
        }
    }
}

/// Linked rows as chips (a tap opens the row), and the one 「アクセスできないページ」 when some are not mine to read.
struct WrapChips: View {
    let refs: [DbRowRef]
    let hidden: Bool
    @Bindable var controller: AppController
    let onOpen: (String) -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 4) { chips }
            VStack(alignment: .leading, spacing: 4) { chips }
        }
    }

    @ViewBuilder
    private var chips: some View {
        ForEach(refs) { ref in
            Button { onOpen(ref.id) } label: {
                HStack(spacing: 3) {
                    WikiIconView(icon: ref.icon, controller: controller, size: 12, kind: "row")
                    Text(verbatim: ref.displayTitle).lineLimit(1)
                }
                .font(.caption)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(Color.accentColor.opacity(0.12), in: Capsule())
            }
            .buttonStyle(.plain)
        }
        if hidden { DbHiddenRowsChip() }
    }
}

// MARK: the editors (one per type)

/// The editor of one cell, in a sheet: text, number, select / multi-select, date (with an end and a time), person,
/// URL, relation (the candidates of the related database I can read). Saving writes the cell (one op id, retried).
struct WikiCellEditor: View {
    @Bindable var controller: AppController
    let model: WikiRowModel
    let prop: DbProperty
    /// M146: a row template's date may be 「今日」 and its people 「自分」 (put in when a row is made from it).
    var isTemplate = false
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var invalid = false
    @State private var chosen: [String] = []
    @State private var start = Date()
    @State private var end = Date()
    @State private var hasEnd = false
    @State private var timed = false
    @State private var query = ""
    @State private var found: [DbRowRef]?
    @State private var started = false

    private var row: DbRow? { model.detail?.row }

    var body: some View {
        NavigationStack {
            Form { editor }
                .navigationTitle(Text(verbatim: prop.displayName))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                    if prop.type != "select" {
                        ToolbarItem(placement: .confirmationAction) { Button("保存") { save() }.accessibilityIdentifier("wiki-cell-save") }
                    }
                }
        }
        .presentationDetents(prop.type == "text" || prop.type == "url" || prop.type == "number" ? [.medium, .large] : [.large])
        .onAppear(perform: prepare)
    }

    private func prepare() {
        guard !started, let row else { return }
        started = true
        let value = WikiDb.value(prop, row)
        switch prop.type {
        case "number": text = WikiDb.numberInput(value, format: prop.numberFormat)
        case "multi_select", "person", "relation": chosen = WikiDb.strings(value)
        case "select": chosen = [value?.stringValue].compactMap { $0 }
        case "date":
            let date = DbDateValue(value)
            start = WikiDb.pickerDate(date?.start) ?? Calendar.current.startOfDay(for: Date()).addingTimeInterval(9 * 3600)
            end = WikiDb.pickerDate(date?.end) ?? start
            hasEnd = date?.end != nil
            timed = date?.time ?? false
        default: text = value?.stringValue ?? ""
        }
    }

    @ViewBuilder
    private var editor: some View {
        switch prop.type {
        case "text":
            TextField("値", text: $text, axis: .vertical).lineLimit(3...10)
        case "url":
            TextField("https://", text: $text).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
        case "number":
            Section {
                TextField("数", text: $text).keyboardType(.numbersAndPunctuation)
            } footer: {
                if invalid { Text("数を入力してください").foregroundStyle(.red) }
                else if prop.numberFormat == "percent" { Text("パーセントの値を入力します（50 は 50 パーセント）") }
            }
        case "select": selectEditor
        case "multi_select": multiEditor
        case "date": dateEditor
        case "person": personEditor
        case "relation": relationEditor
        default:
            Text("この値は自動で決まります").foregroundStyle(.secondary)
        }
    }

    private var selectEditor: some View {
        Section {
            Button { write(WikiDb.encodeSelect(nil)) } label: {
                HStack { Text("なし").foregroundStyle(.secondary); Spacer(); if chosen.isEmpty { Image(systemName: "checkmark") } }
            }
            ForEach(prop.options) { option in
                Button { write(WikiDb.encodeSelect(option.id)) } label: {
                    HStack { DbOptionChip(option: option); Spacer(); if chosen.contains(option.id) { Image(systemName: "checkmark") } }
                }
                .foregroundStyle(.primary)
            }
        } footer: {
            if prop.options.isEmpty { Text("選択肢がありません（パソコンでフルアクセスの人が作れます）") }
        }
    }

    private var multiEditor: some View {
        Section {
            ForEach(prop.options) { option in
                Button { toggle(option.id) } label: {
                    HStack { DbOptionChip(option: option); Spacer(); if chosen.contains(option.id) { Image(systemName: "checkmark") } }
                }
                .foregroundStyle(.primary)
            }
        } footer: {
            if prop.options.isEmpty { Text("選択肢がありません（パソコンでフルアクセスの人が作れます）") }
        }
    }

    @ViewBuilder
    private var dateEditor: some View {
        Section {
            DatePicker(hasEnd ? "開始日" : "日付", selection: $start, displayedComponents: timed ? [.date, .hourAndMinute] : [.date])
            if hasEnd {
                DatePicker("終了日", selection: $end, in: start..., displayedComponents: timed ? [.date, .hourAndMinute] : [.date])
            }
            Toggle("終了日", isOn: $hasEnd)
            Toggle("時刻を含める", isOn: $timed)
        }
        Section {
            Button("今日") { start = Calendar.current.startOfDay(for: Date()).addingTimeInterval(9 * 3600) }
            if isTemplate {
                Button("今日（行を作る日）") { write(WikiDb.todayValue) }
            }
            Button("消す", role: .destructive) { write(.null) }
        } footer: {
            if isTemplate, let row, WikiDb.isToday(WikiDb.value(prop, row)) {
                Text("今は「今日（行を作る日）」です。")
            }
        }
    }

    private var people: [UserPublic] {
        let store = controller.store
        let needle = WikiText.fold(query.trimmingCharacters(in: .whitespaces))
        return store.users.values
            .filter { $0.role != "bot" && $0.deactivatedAt == nil }
            .filter { needle.isEmpty || WikiText.fold($0.displayName).contains(needle) || WikiText.fold($0.username).contains(needle) }
            .sorted { $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending }
    }

    @ViewBuilder
    private var personEditor: some View {
        Section {
            TextField("人を探す", text: $query).autocorrectionDisabled().textInputAutocapitalization(.never)
        }
        if isTemplate {
            Section {
                Button { toggle(WikiDb.meToken) } label: {
                    HStack { Text("自分（行を作る人）"); Spacer(); if chosen.contains(WikiDb.meToken) { Image(systemName: "checkmark") } }
                }
                .foregroundStyle(.primary)
            }
        }
        Section {
            ForEach(people.prefix(80)) { user in
                Button { toggle(user.id) } label: {
                    HStack(spacing: 10) {
                        AvatarView(id: user.id, name: user.displayName, size: 26)
                        Text(verbatim: user.displayName)
                        Spacer()
                        if chosen.contains(user.id) { Image(systemName: "checkmark") }
                    }
                }
                .foregroundStyle(.primary)
            }
            // A chosen person no longer listed (deactivated): still shown, so they can be removed.
            ForEach(chosen.filter { id in id != WikiDb.meToken && !people.contains { $0.id == id } }, id: \.self) { id in
                Button { toggle(id) } label: {
                    HStack { Text(verbatim: controller.store.users[id]?.displayName ?? tr("メンバー")); Spacer(); Image(systemName: "checkmark") }
                }
                .foregroundStyle(.primary)
            }
        }
    }

    @ViewBuilder
    private var relationEditor: some View {
        let refs = model.refs
        if prop.relation?.databaseId == nil {
            Text("相手のデータベースを読めません").foregroundStyle(.secondary)
        } else {
            Section {
                ForEach(chosen, id: \.self) { id in
                    HStack {
                        Text(verbatim: refs[id]?.displayTitle ?? tr("無題"))
                        Spacer()
                        Button { toggle(id) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                            .buttonStyle(.borderless)
                            .accessibilityLabel("外す")
                    }
                }
                if let row, row.hiddenRelations.contains(prop.id) { DbHiddenRowsChip() }
                if chosen.isEmpty && !(row?.hiddenRelations.contains(prop.id) ?? false) {
                    Text("つながっている行はありません").foregroundStyle(.secondary)
                }
            } header: {
                Text(verbatim: prop.relation?.databaseTitle ?? "")
            }
            Section {
                TextField("行を探す", text: $query).autocorrectionDisabled().textInputAutocapitalization(.never)
                if let found {
                    if found.isEmpty { Text("読める行が見つかりません").foregroundStyle(.secondary) }
                    ForEach(found) { ref in
                        Button {
                            model.remember(ref)
                            toggle(ref.id)
                        } label: {
                            HStack(spacing: 8) {
                                WikiIconView(icon: ref.icon, controller: controller, size: 14, kind: "row")
                                Text(verbatim: ref.displayTitle)
                                Spacer()
                                if chosen.contains(ref.id) { Image(systemName: "checkmark") }
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                } else {
                    ProgressView()
                }
            }
            .task(id: query) {
                try? await Task.sleep(nanoseconds: 200_000_000)
                guard !Task.isCancelled else { return }
                found = await model.candidates(prop, q: query)
            }
        }
    }

    private func toggle(_ id: String) {
        if let index = chosen.firstIndex(of: id) { chosen.remove(at: index) } else { chosen.append(id) }
    }

    private func save() {
        switch prop.type {
        case "text", "url", "title": write(WikiDb.encodeText(text, type: prop.type))
        case "number":
            guard let value = WikiDb.encodeNumber(text, format: prop.numberFormat) else {
                invalid = true
                return
            }
            write(value)
        case "multi_select", "person": write(WikiDb.encodeIds(chosen))
        case "relation": write(WikiDb.encodeRelation(chosen))
        case "date": write(WikiDb.encodeDate(start: start, end: hasEnd ? end : nil, time: timed))
        default: dismiss()
        }
    }

    private func write(_ value: JSONValue) {
        let model = model
        let controller = controller
        let id = prop.id
        dismiss()
        Task {
            do { try await model.set(id, value) } catch { controller.error = controller.describe(error) }
        }
    }
}
