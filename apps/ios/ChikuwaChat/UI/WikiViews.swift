import SwiftUI

/// M122 (docs/WIKI.md §9.2): 「ドキュメント」 on the phone — the tree (共有 / プライベート, rows that open and close),
/// a page (breadcrumbs, the canvas's renderer, child pages, backlinks), light editing with the canvas's editor and save
/// loop, new pages, the title and icon, and the history to read. Sharing, moving and the trash are the desktop's.

/// Words and small rules of the wiki's screens (pure, for the tests).
enum WikiText {
    /// Where a page is, as a hit's or a row's second line: its readable ancestors (「研究室マニュアル › 計算機」), else
    /// 「ドキュメント」 for a top-level page.
    static func place(_ page: WikiPageItem, tree: WikiTree?) -> String {
        let chain = tree?.ancestors(of: page.id) ?? []
        guard !chain.isEmpty else { return tr("ドキュメント") }
        return chain.map(\.displayTitle).joined(separator: " › ")
    }

    /// What the icon field keeps: one emoji (the first character typed), or a custom emoji's `:name:`; nil for none.
    static func icon(_ input: String) -> String? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return nil }
        if trimmed.hasPrefix(":") { return String(trimmed.prefix(64)) }
        return String(first)
    }

    /// A title as the server takes it: spaces folded, at most 200 characters; nil when empty (the server's 「無題」).
    static func title(_ input: String) -> String? {
        let folded = input.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return folded.isEmpty ? nil : String(folded.prefix(200))
    }

    /// The rows of the tree list: each root, and under an open row its children, one level further in.
    struct Row: Identifiable, Equatable {
        let page: WikiPageItem
        let depth: Int
        let hasChildren: Bool
        let open: Bool
        var id: String { page.id }
    }

    static func rows(_ tree: WikiTree, roots: [WikiPageItem], expanded: Set<String>) -> [Row] {
        var out: [Row] = []
        var seen: Set<String> = []
        func add(_ page: WikiPageItem, depth: Int) {
            guard seen.insert(page.id).inserted else { return }
            let children = tree.children(of: page.id)
            let open = expanded.contains(page.id) && !children.isEmpty
            out.append(Row(page: page, depth: depth, hasChildren: !children.isEmpty, open: open))
            if open { for child in children { add(child, depth: depth + 1) } }
        }
        for root in roots { add(root, depth: 0) }
        return out
    }

    /// The pages whose title holds the filter (NFKC, any case), in the tree's order of titles.
    static func filtered(_ tree: WikiTree, query: String) -> [WikiPageItem] {
        let words = fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        guard !words.isEmpty else { return [] }
        return tree.pages.values.filter { fold($0.title).contains(words) }
            .sorted { $0.displayTitle != $1.displayTitle ? $0.displayTitle < $1.displayTitle : $0.id < $1.id }
    }

    /// NFKC and any case (the canvases' filter's rule).
    static func fold(_ text: String) -> String { text.precomposedStringWithCompatibilityMapping.lowercased() }

    /// M146: the line over a template (§22.3): a page template changes the pages made from it later, a row template
    /// the rows of its database; nil for an ordinary page.
    static func templateBanner(_ item: WikiPageItem?) -> String? {
        guard let item, item.isTemplate else { return nil }
        if item.kind == "row" {
            return tr("データベースの行のテンプレートです。ここで変えると、これから作る行に反映されます。日付の「今日」と人の「自分」は行を作るときに決まります。")
        }
        return tr("ページのテンプレートです。ここで変えると、これから作るページに反映されます（作ったページは変わりません）。")
    }

    /// M146: 「複製」 is offered for a page or a row (a database cannot be duplicated yet), not to guests (the server
    /// refuses them); a row's copy goes into its database, so it needs edit there.
    static func canDuplicate(_ item: WikiPageItem?, isGuest: Bool) -> Bool {
        guard let item, !isGuest else { return false }
        switch item.kind {
        case "page": return true
        case "row": return item.myLevel >= .edit
        default: return false
        }
    }

    /// What VoiceOver says for a tree row.
    static func spoken(_ row: Row) -> String {
        var parts = [row.page.displayTitle]
        if row.page.myLevel == .view { parts.append(tr("閲覧のみ")) }
        if row.hasChildren { parts.append(row.open ? tr("サブページを表示中") : tr("サブページあり")) }
        return parts.joined(separator: tr("、"))
    }
}

/// A page's icon: its emoji, a custom emoji (`:name:`), or the document symbol.
struct WikiIconView: View {
    let icon: String?
    @Bindable var controller: AppController
    var size: CGFloat = 17
    /// M124: a database without an icon shows the table symbol.
    var kind: String = "page"

    var body: some View {
        if let icon, !icon.isEmpty {
            let store = controller.store
            CustomEmoji.text(Emoji.replaceShortcodes(icon), custom: store.customEmoji, images: store.emojiImages,
                             onNeed: { controller.loadEmojiImage($0) }, height: size * 1.1)
                .font(.system(size: size))
                .accessibilityHidden(true)
        } else {
            Image(systemName: kind == "database" ? "tablecells" : "doc.text")
                .font(.system(size: size * 0.9)).foregroundStyle(.secondary).accessibilityHidden(true)
        }
    }
}

// MARK: the tree

/// A new page to make: under a page (its access), or at the top level of 共有 (everyone edits) / プライベート (me only).
struct WikiNewPageTarget: Identifiable, Equatable {
    var parentId: String?
    var access: String = "workspace"
    /// M146: the template chosen first (「このテンプレートでページを作成」).
    var template: WikiTemplateChoice? = nil
    var id: String { (parentId ?? "top") + ":" + access + ":" + (template.map { "\($0)" } ?? "") }
}

/// The home's 「ドキュメント」: the tree I can read, under 共有 and プライベート (§3.1), each row opening its children; a tap
/// opens the page on this stack. The filter narrows by title; submitting it searches the bodies (the search's tab).
struct DocsView: View {
    static let selectionId = "docs"

    @Bindable var controller: AppController
    let onOpen: (String) -> Void
    let onSearch: (SearchParams) -> Void
    @State private var query = ""
    @State private var newPage: WikiNewPageTarget?

    var body: some View {
        Group {
            if let hub = controller.wiki, hub.available || hub.tree != nil {
                content(hub)
            } else {
                ContentUnavailableView("ドキュメントを使えません", systemImage: "book.closed",
                                       description: Text("このサーバはまだドキュメントに対応していません。"))
            }
        }
        .navigationTitle("ドキュメント")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "題名で絞り込む")
        .onSubmit(of: .search) { if let params = CanvasesModel.bodySearch(query) { onSearch(params) } }
        .toolbar {
            if controller.wiki?.available == true, WikiRights.createsTopLevel(isGuest: controller.isGuest) {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("共有に新しいページ", systemImage: "person.2") { newPage = WikiNewPageTarget(parentId: nil, access: "workspace") }
                        Button("プライベートに新しいページ", systemImage: "lock") { newPage = WikiNewPageTarget(parentId: nil, access: "private") }
                    } label: {
                        Image(systemName: "plus")
                    }
                    .accessibilityLabel("新しいページ")
                }
            }
        }
        .sheet(item: $newPage) { target in
            WikiNewPageSheet(controller: controller, target: target) { page in onOpen(page.id) }
        }
    }

    @ViewBuilder
    private func content(_ hub: WikiHub) -> some View {
        if let tree = hub.tree {
            let filtering = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            List {
                if hub.offline {
                    Label("オフライン — この端末に保存した一覧です", systemImage: "wifi.slash")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .listRowSeparator(.hidden)
                }
                if filtering {
                    let found = WikiText.filtered(tree, query: query)
                    ForEach(found) { page in
                        Button { onOpen(page.id) } label: {
                            HStack(spacing: 10) {
                                WikiIconView(icon: page.icon, controller: controller, kind: page.kind)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(page.displayTitle).lineLimit(1)
                                    Text(WikiText.place(page, tree: tree)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                                }
                                Spacer(minLength: 0)
                            }
                            .frame(minHeight: 44)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    if let params = CanvasesModel.bodySearch(query) {
                        Button("「\(params.q)」をドキュメントの本文からも検索") { onSearch(params) }
                            .font(.footnote)
                            .frame(maxWidth: .infinity)
                            .listRowSeparator(.hidden)
                    }
                } else {
                    section(tr("共有"), hub: hub, tree: tree, roots: tree.roots(private: false), empty: tr("まだページはありません。"))
                    section(tr("プライベート"), hub: hub, tree: tree, roots: tree.roots(private: true), empty: tr("自分だけが読めるページはここに入ります。"))
                }
            }
            .listStyle(.insetGrouped)
            .refreshable { await hub.refresh() }
        } else if let failure = hub.treeFailure {
            ContentUnavailableView {
                Label("ドキュメントを読み込めませんでした", systemImage: "exclamationmark.triangle")
            } description: {
                Text(failure)
            } actions: {
                Button("再読み込み") { Task { await hub.loadTree() } }.buttonStyle(.bordered)
            }
        } else {
            ProgressView("読み込み中…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .task { if hub.tree == nil, !hub.loadingTree { await hub.loadTree() } }
        }
    }

    private func section(_ title: String, hub: WikiHub, tree: WikiTree, roots: [WikiPageItem], empty: String) -> some View {
        Section(title) {
            let rows = WikiText.rows(tree, roots: roots, expanded: hub.expanded)
            if rows.isEmpty {
                Text(empty).font(.subheadline).foregroundStyle(.secondary)
            }
            ForEach(rows) { row in
                WikiTreeRow(controller: controller, row: row, onOpen: { onOpen(row.page.id) }, onToggle: {
                    if hub.expanded.contains(row.page.id) { hub.expanded.remove(row.page.id) } else { hub.expanded.insert(row.page.id) }
                }, onNewChild: WikiRights.of(row.page.myLevel).createChild ? { newPage = WikiNewPageTarget(parentId: row.page.id) } : nil)
            }
        }
    }
}

/// One row of the tree: the chevron (when it has child pages), the icon and the title, indented by its depth.
struct WikiTreeRow: View {
    @Bindable var controller: AppController
    let row: WikiText.Row
    let onOpen: () -> Void
    let onToggle: () -> Void
    let onNewChild: (() -> Void)?

    var body: some View {
        HStack(spacing: 6) {
            Group {
                if row.hasChildren {
                    Button(action: onToggle) {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .rotationEffect(.degrees(row.open ? 90 : 0))
                            .frame(width: 28, height: 36)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel(row.open ? "サブページを閉じる" : "サブページを開く")
                } else {
                    Color.clear.frame(width: 28, height: 36)
                }
            }
            .padding(.leading, CGFloat(row.depth) * 16)
            Button(action: onOpen) {
                HStack(spacing: 8) {
                    WikiIconView(icon: row.page.icon, controller: controller, kind: row.page.kind)
                    Text(row.page.displayTitle).lineLimit(1)
                    Spacer(minLength: 0)
                    if row.page.myLevel == .view {
                        Image(systemName: "eye").font(.caption2).foregroundStyle(.tertiary).accessibilityHidden(true)
                    }
                }
                .frame(minHeight: 40)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(WikiText.spoken(row))
            .accessibilityHint("ページを開きます")
        }
        .contextMenu {
            if let onNewChild { Button("子ページを作成", systemImage: "plus", action: onNewChild) }
            Button("リンクをコピー", systemImage: "link") { controller.copyPageLink(row.page.id) }
        }
    }
}

/// A new page: its title and an icon (one emoji), under a parent or at the top level (共有 / プライベート, §4.2).
struct WikiNewPageSheet: View {
    @Bindable var controller: AppController
    let target: WikiNewPageTarget
    let onCreated: (WikiPageOut) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var icon = ""
    @State private var busy = false
    /// One key for this sheet: a retry after a failure on the way returns the page made by the first try.
    @State private var key = UUID().uuidString.lowercased()
    /// M146: nil is 「白紙のページ」.
    @State private var template: WikiTemplateChoice?
    @State private var started = false

    var body: some View {
        let parent = target.parentId.flatMap { controller.wiki?.item($0) }
        NavigationStack {
            Form {
                Section {
                    TextField(template == nil ? "題名（空欄なら「無題」）" : "題名（空欄ならテンプレートの題名）", text: $title)
                    TextField(template == nil ? "アイコン（絵文字 1 つ、なくても可）" : "アイコン（空欄ならテンプレートのもの）", text: $icon)
                } footer: {
                    if let parent {
                        Text("「\(parent.displayTitle)」の下に作ります。見える人は親のページと同じです。")
                    } else if target.access == "private" {
                        Text("自分だけが読めるページです。共有はパソコンから設定できます。")
                    } else {
                        Text("ワークスペースの全員が読み書きできるページです（ゲストを除く）。")
                    }
                }
                WikiTemplateChoices(controller: controller, blank: true, selection: template) { template = $0 }
            }
            .onAppear {
                guard !started else { return }
                started = true
                template = target.template
            }
            .onChange(of: template) { _, _ in key = UUID().uuidString.lowercased() }
            .navigationTitle(target.parentId == nil ? "新しいページ" : "子ページを作成")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("作成") { Task { await create() } }.disabled(busy)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func create() async {
        guard let hub = controller.wiki else { return }
        busy = true
        defer { busy = false }
        do {
            let page = try await hub.create(parentId: target.parentId, title: WikiText.title(title), icon: WikiText.icon(icon), access: target.access,
                                            clientSaveId: key, template: template)
            dismiss()
            onCreated(page)
        } catch {
            controller.error = controller.describe(error)
        }
    }
}

/// M146 (§22.3 / §24.3): the templates to start from — 「白紙のページ」 (when `blank`), 「組み込み」 (the canvases'
/// templates) and 「みんなのテンプレート」 (page templates I can read), read from GET /wiki/templates when shown.
struct WikiTemplateChoices: View {
    @Bindable var controller: AppController
    let blank: Bool
    let selection: WikiTemplateChoice?
    let onSelect: (WikiTemplateChoice?) -> Void
    @State private var templates: WikiTemplatesOut?
    @State private var failure: String?

    var body: some View {
        Group {
            if blank {
                Section("テンプレート") {
                    row(title: tr("白紙のページ"), subtitle: nil, icon: nil, choice: nil)
                }
            }
            if let templates {
                if !templates.builtins.isEmpty {
                    Section("組み込み") {
                        ForEach(templates.builtins) { builtin in
                            row(title: builtin.name, subtitle: builtin.description, icon: nil, choice: .builtin(key: builtin.key))
                        }
                    }
                }
                Section {
                    ForEach(templates.pages) { page in
                        row(title: page.displayTitle, subtitle: nil, icon: page.icon, choice: .page(id: page.id))
                    }
                    if templates.pages.isEmpty {
                        Text("まだありません。パソコンのページの ⋯ から「テンプレートとして保存」で作れます。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                } header: {
                    Text("みんなのテンプレート")
                }
            } else if let failure {
                Section {
                    Text(failure).font(.footnote).foregroundStyle(.secondary)
                    Button("再読み込み") { Task { await load() } }
                }
            } else {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .task { if templates == nil { await load() } }
    }

    private func load() async {
        guard let hub = controller.wiki else { return }
        do {
            templates = try await hub.templates()
            failure = nil
        } catch {
            failure = tr("テンプレートを読み込めませんでした：") + controller.describe(error)
        }
    }

    private func row(title: String, subtitle: String?, icon: String?, choice: WikiTemplateChoice?) -> some View {
        Button { onSelect(choice) } label: {
            HStack(spacing: 10) {
                Group {
                    switch choice {
                    case nil: Image(systemName: "doc").foregroundStyle(.secondary)
                    case .builtin?: Image(systemName: "doc.text.image").foregroundStyle(.secondary)
                    case .page?: WikiIconView(icon: icon, controller: controller)
                    }
                }
                .frame(width: 22)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: title).foregroundStyle(.primary).lineLimit(1)
                    if let subtitle, !subtitle.isEmpty { Text(verbatim: subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                }
                Spacer(minLength: 0)
                if selection == choice { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
            }
            .frame(minHeight: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selection == choice ? .isSelected : [])
    }
}

/// M146: 「テンプレートから始める」 on an empty page (POST …/apply-template): the template's body, and its title and icon
/// when the page has none.
struct WikiApplyTemplateSheet: View {
    @Bindable var controller: AppController
    let hub: WikiHub
    let pageId: String
    @Environment(\.dismiss) private var dismiss
    @State private var template: WikiTemplateChoice?
    @State private var busy = false
    /// One key per choice: a retry after a failure on the way changes nothing again.
    @State private var key = UUID().uuidString.lowercased()

    var body: some View {
        NavigationStack {
            Form {
                WikiTemplateChoices(controller: controller, blank: false, selection: template) { template = $0 }
            }
            .onChange(of: template) { _, _ in key = UUID().uuidString.lowercased() }
            .navigationTitle("テンプレートから始める")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("使う") { Task { await apply() } }.disabled(busy || template == nil)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func apply() async {
        guard let template else { return }
        busy = true
        defer { busy = false }
        do {
            try await hub.applyTemplate(pageId, template: template, clientSaveId: key)
            dismiss()
        } catch {
            controller.error = controller.describe(error)
        }
    }
}

// MARK: a page

/// A wiki page on screen (its own, or pushed from the tree, a link, a search hit): holds the page's save loop while
/// shown; letting go saves what is typed.
struct WikiPageScreen: View {
    @Bindable var controller: AppController
    let pageId: String
    /// A page link, a breadcrumb or a child page tapped here.
    let onOpenPage: (String) -> Void
    @State private var saver: CanvasSaver?

    var body: some View {
        Group {
            if saver != nil, let hub = controller.wiki, hub.item(pageId)?.kind == "database" {
                // M124: a database page is its rows (cards / an agenda), not a body.
                WikiDatabaseScreen(controller: controller, hub: hub, databaseId: pageId, onOpenPage: onOpenPage)
            } else if let saver, let hub = controller.wiki {
                WikiPageDocument(controller: controller, hub: hub, saver: saver, pageId: pageId, onOpenPage: onOpenPage)
            } else if controller.wiki == nil {
                ContentUnavailableView("ドキュメントを使えません", systemImage: "book.closed")
            } else {
                ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear {
            if saver == nil { saver = controller.wiki?.hold(pageId) }
        }
        .onDisappear {
            if saver != nil {
                controller.wiki?.release(pageId)
                saver = nil
            }
        }
    }
}

private enum WikiPageMode: Hashable { case view, edit }

private struct WikiSectionTarget: Identifiable {
    let line: Int
    var id: Int { line }
}

struct WikiPageDocument: View {
    @Bindable var controller: AppController
    let hub: WikiHub
    let saver: CanvasSaver
    let pageId: String
    let onOpenPage: (String) -> Void
    /// The phone reads first (§7.4).
    @State private var mode: WikiPageMode = .view
    @State private var section: WikiSectionTarget?
    @State private var choiceOpen = true
    @State private var renaming = false
    @State private var newChild: WikiNewPageTarget?
    @State private var history = false
    @State private var backlinks: [WikiPageItem]?
    /// M124: pull to refresh reads a row's cells again too.
    @State private var rowRefresh = 0
    /// M146: 「テンプレートから始める」 and 「複製」 (one key per duplicate, kept for its move to the top level).
    @State private var applyingTemplate = false
    @State private var duplicating = false
    @State private var duplicateKey: String?
    @State private var offerTopLevel = false
    /// M153a (docs/WIKI.md §30.4): the bundled 見たまま editor behind the per-device switch (自分 → 表示, off by default),
    /// warmed up while the page is read (the WebView made and its page loaded; 編集 only sends the body); the form last
    /// chosen (見たまま / Markdown) is kept on the device; the caret's line crosses the switch both ways.
    @AppStorage(MobileEditorSettings.enabledKey) private var wysiwygEnabled = false
    @AppStorage(MobileEditorSettings.modeKey) private var editorModeRaw = MobileEditorMode.wysiwyg.rawValue
    @State private var editorSession: MobileEditorSession?
    @State private var switchLine: Int?
    @State private var markdownCaret: Int?
    @State private var leaving = false

    private var item: WikiPageItem? { hub.item(pageId) }
    private var editorMode: MobileEditorMode { MobileEditorMode(rawValue: editorModeRaw) ?? .wysiwyg }
    private var wysiwygOffered: Bool { wysiwygEnabled && MobileEditorBundle.isAvailable }
    private var wysiwygActive: Bool { wysiwygOffered && editorMode == .wysiwyg && editorSession != nil }
    private var page: WikiPageOut? { hub.pages[pageId] ?? hub.keptPage(pageId)?.page }
    private var rights: WikiRights { WikiRights.of(hub.level(of: pageId)) }

    var body: some View {
        let rights = rights
        let status = saver.status
        let editing = rights.edit && mode == .edit && status != .loading && status != .gone
        VStack(spacing: 0) {
            if let notice = notice(rights: rights) {
                HStack(spacing: 8) {
                    Text(notice.text).font(.caption).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 4)
                    if notice.copy {
                        Button { controller.copyCanvasText(saver.text) } label: { Label("本文をコピー", systemImage: "doc.on.doc").font(.caption) }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(notice.warn ? Color.orange.opacity(0.14) : Color.secondary.opacity(0.08))
                Divider()
            }
            if let banner = WikiText.templateBanner(item) {
                templateBanner(banner)
                Divider()
            }
            if status == .loading {
                ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if status == .gone && saver.canvas == nil {
                ContentUnavailableView("ページが見つかりません", systemImage: "doc.questionmark",
                                       description: Text("ゴミ箱に移されたか、共有が外れました。"))
            } else if saver.loadFailed {
                CanvasLoadFailed(detail: saver.error.map { controller.describe($0) }) { await saver.reload() }
            } else if editing {
                editorArea
            } else {
                reader(rights: rights, status: status)
            }
        }
        .navigationTitle(item?.displayTitle ?? tr("ページ"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                CanvasSaveStateLabel(saver: saver) { choiceOpen = true }.fixedSize()
            }
            ToolbarItemGroup(placement: .primaryAction) {
                if rights.edit && status != .gone && status != .loading {
                    Button { toggleEditing() } label: {
                        Text(mode == .edit ? "完了" : "編集")
                    }
                    .disabled(leaving)
                    .accessibilityIdentifier("wiki-edit-toggle")
                }
                if status != .gone { menu(rights: rights) }
            }
        }
        .onChange(of: status) { _, next in
            guard next == .conflict || next == .expired else { return }
            choiceOpen = true
            KeyboardBehavior.dismiss()
        }
        .onAppear { warmUpEditor() }
        .onChange(of: wysiwygEnabled) { _, _ in warmUpEditor() }
        .onDisappear { editorSession = nil }
        .sheet(item: $section) { target in
            CanvasSectionSheet(controller: controller, saver: saver, line: target.line, isPage: true)
        }
        .sheet(isPresented: Binding(get: { choiceOpen && status == .conflict && saver.conflict != nil }, set: { if !$0 { choiceOpen = false } })) {
            if let conflict = saver.conflict {
                CanvasConflictSheet(controller: controller, saver: saver, conflict: conflict, tickOnly: false)
            }
        }
        .sheet(isPresented: Binding(get: { choiceOpen && status == .expired && saver.expired != nil }, set: { if !$0 { choiceOpen = false } })) {
            if let head = saver.expired {
                CanvasExpiredSheet(controller: controller, saver: saver, head: head, canOverwrite: rights.edit)
            }
        }
        .sheet(isPresented: $renaming) {
            if let item { WikiRenameSheet(controller: controller, hub: hub, item: item) }
        }
        .sheet(item: $newChild) { target in
            WikiNewPageSheet(controller: controller, target: target) { page in onOpenPage(page.id) }
        }
        .sheet(isPresented: $history) {
            WikiHistorySheet(controller: controller, pageId: pageId, headId: item?.headRevId)
        }
        .sheet(isPresented: $applyingTemplate) {
            WikiApplyTemplateSheet(controller: controller, hub: hub, pageId: pageId)
        }
        .alert("最上位に複製しますか？", isPresented: $offerTopLevel) {
            Button("キャンセル", role: .cancel) { duplicateKey = nil }
            Button("最上位に複製") { Task { await duplicate(topLevel: true) } }
        } message: {
            Text("親のページを編集できないため、隣には置けません。写しをドキュメントの最上位に作ります。")
        }
        .task(id: pageId) { await loadBacklinks() }
    }

    // MARK: editing (M153a: 見たまま / Markdown)

    /// The editor in the form chosen: the bundled 見たまま editor (MobileEditorView) or the Markdown editor, with the
    /// switch above them while the prototype is on.
    @ViewBuilder
    private var editorArea: some View {
        if wysiwygOffered {
            Picker("編集の形", selection: Binding(get: { editorMode }, set: { switchEditor(to: $0) })) {
                ForEach(MobileEditorMode.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .disabled(leaving)
            .accessibilityIdentifier("wiki-editor-mode")
            Divider()
        }
        if wysiwygActive, let session = editorSession {
            MobileEditorView(controller: controller, saver: saver, session: session, caretLine: switchLine, onOpenPage: onOpenPage)
        } else {
            CanvasEditor(controller: controller, saver: saver, isPage: true, initialLine: wysiwygOffered ? switchLine : nil,
                         onCaretLine: wysiwygOffered ? { markdownCaret = $0 } : nil)
        }
    }

    /// The WebView made and its page read while the page is still being read (§30.3 温め), when the prototype is on.
    private func warmUpEditor() {
        guard wysiwygOffered else {
            editorSession = nil
            return
        }
        guard editorSession == nil else { return }
        let web = MobileEditorController()
        web.schemeHandler.assets = controller
        web.onError = { message in print("mobile editor: \(message)") }
        let session = MobileEditorSession(transport: web, host: controller)
        session.onLog = { line in print("mobile editor: \(line)") }
        web.start()
        editorSession = session
    }

    /// 編集 / 完了. Leaving the 見たまま editor first takes the body as it holds it (`requestBody`), so the reading view
    /// shows the last words typed.
    private func toggleEditing() {
        guard mode == .edit else {
            switchLine = nil
            markdownCaret = nil
            mode = .edit
            return
        }
        guard wysiwygActive, let session = editorSession else {
            mode = .view
            return
        }
        leaving = true
        Task {
            await session.commit()
            leaving = false
            mode = .view
        }
    }

    /// 見たまま ⇄ Markdown: the body goes through the saver (the same text both read), the caret's line goes along.
    private func switchEditor(to next: MobileEditorMode) {
        guard next != editorMode, !leaving else { return }
        if next == .markdown, wysiwygActive, let session = editorSession {
            leaving = true
            Task {
                switchLine = await session.commit()
                leaving = false
                editorModeRaw = next.rawValue
            }
            return
        }
        switchLine = markdownCaret
        editorModeRaw = next.rawValue
    }

    /// 「セクションを編集」 from the reading view: the Markdown section sheet, or (見たまま) the whole page at that heading.
    private func editSection(_ line: Int) {
        if wysiwygActive {
            switchLine = line
            mode = .edit
        } else {
            section = WikiSectionTarget(line: line)
        }
    }

    /// M146: the template's line, with 「このテンプレートでページを作成」 for a page template.
    private func templateBanner(_ text: String) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "doc.on.doc").font(.caption).foregroundStyle(Color.accentColor).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(text).font(.caption).fixedSize(horizontal: false, vertical: true)
                if item?.kind == "page", WikiRights.createsTopLevel(isGuest: controller.isGuest) {
                    Button("このテンプレートでページを作成") {
                        newChild = WikiNewPageTarget(parentId: nil, access: "workspace", template: .page(id: pageId))
                    }
                    .font(.caption.weight(.semibold))
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Color.accentColor.opacity(0.10))
        .accessibilityElement(children: .combine)
    }

    /// 「複製」 (POST …/duplicate): the copy opens. 403 page_edit_restricted on the parent offers the top level, with
    /// the same key.
    private func duplicate(topLevel: Bool = false) async {
        let key = duplicateKey ?? UUID().uuidString.lowercased()
        duplicateKey = key
        duplicating = true
        defer { duplicating = false }
        do {
            switch try await hub.duplicate(pageId, clientSaveId: key, topLevel: topLevel) {
            case .made(let copy):
                duplicateKey = nil
                controller.notice = tr("複製しました")
                onOpenPage(copy.id)
            case .parentRestricted:
                offerTopLevel = true
            }
        } catch {
            controller.error = controller.describe(error)
        }
    }

    private func loadBacklinks() async {
        backlinks = try? await hub.backlinks(pageId)
    }

    /// A tick is saved at once (only for those who may edit: a viewer's boxes do not move, §4.1).
    private func toggle(_ line: Int, _ done: Bool) {
        guard let next = CanvasText.toggleTaskLine(saver.text, line: line, done: done) else { return }
        saver.edit(next, external: true)
        Task { await saver.flush() }
    }

    private func menu(rights: WikiRights) -> some View {
        Menu {
            if rights.rename, item != nil {
                Button("題名とアイコンを変更…", systemImage: "pencil") { renaming = true }
            }
            if rights.createChild, item?.kind != "row", item?.isTemplate != true {
                Button("子ページを作成", systemImage: "plus") { newChild = WikiNewPageTarget(parentId: pageId) }
            }
            if WikiText.canDuplicate(item, isGuest: controller.isGuest) {
                Button("複製", systemImage: "plus.square.on.square") { Task { await duplicate() } }
                    .disabled(duplicating)
            }
            Button("履歴", systemImage: "clock.arrow.circlepath") { history = true }
            Button("本文をコピー", systemImage: "doc.on.doc") { controller.copyCanvasText(saver.text) }
            Button("リンクをコピー", systemImage: "link") { controller.copyPageLink(pageId) }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("ページの操作")
    }

    /// A line over the page: why it cannot be changed here, or what happened to it.
    private func notice(rights: WikiRights) -> (text: String, warn: Bool, copy: Bool)? {
        if saver.loadFailed { return nil }
        switch saver.status {
        case .gone where saver.canvas != nil:
            return (tr("このページはゴミ箱に移されたか、見られなくなりました。手元の本文はコピーできます。"), true, true)
        case .blocked: return (tr("保存できませんでした：") + (saver.error.map { controller.describe($0) } ?? ErrorMessages.unknown), true, true)
        default: break
        }
        if saver.offlineCopy, let savedAt = saver.cachedAt { return (CanvasOffline.notice(savedAt: savedAt), true, false) }
        if saver.status == .loading || saver.status == .gone || item == nil { return nil }
        if !rights.edit { return (tr("閲覧のみです。"), false, false) }
        return nil
    }

    // MARK: reading

    private func reader(rights: WikiRights, status: CanvasSaveStatus) -> some View {
        let headings = CanvasText.outline(saver.text)
        return ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    breadcrumbs
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let icon = item?.icon, !icon.isEmpty { WikiIconView(icon: icon, controller: controller, size: 26) }
                        Text(item?.displayTitle ?? tr("ページ")).font(.title2.bold()).fixedSize(horizontal: false, vertical: true)
                    }
                    if let item { byline(item) }
                    if item?.kind == "row" {
                        WikiRowPropertiesView(controller: controller, hub: hub, rowId: pageId, refresh: rowRefresh, onOpenPage: onOpenPage)
                            .padding(.top, 8)
                    }
                    if saver.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        HStack(spacing: 4) {
                            Text("まだ何も書かれていません。").foregroundStyle(.secondary)
                            if rights.edit && status != .gone { Button("書き始める") { mode = .edit } }
                        }
                        .font(.subheadline)
                        .padding(.top, 16)
                        // M146: an empty page may start from a template (not a template itself, not a row).
                        if rights.edit, status != .gone, item?.kind == "page", item?.isTemplate != true, !saver.unsaved {
                            Button { applyingTemplate = true } label: {
                                Label("テンプレートから始める", systemImage: "doc.on.doc")
                            }
                            .font(.subheadline)
                            .accessibilityIdentifier("wiki-apply-template")
                        }
                    } else {
                        CanvasBodyView(body: saver.text, controller: controller, onToggleTask: rights.tick && status != .gone ? toggle : nil,
                                       onEditSection: rights.edit && status != .gone ? editSection : nil,
                                       onOpenPage: onOpenPage)
                            .padding(.top, 10)
                    }
                    children(rights: rights, status: status)
                    backlinkList
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .padding(.bottom, headings.count >= 3 ? 56 : 0)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable {
                rowRefresh += 1
                await saver.refresh()
                await loadBacklinks()
            }
            .overlay(alignment: .bottomTrailing) {
                if headings.count >= 3 {
                    Menu {
                        ForEach(headings) { entry in
                            Button(String(repeating: "  ", count: entry.level - 1) + entry.text) {
                                withAnimation { proxy.scrollTo(CanvasBodyView.anchor(CanvasBodyView.anchorLine(saver.text, line: entry.line)), anchor: .top) }
                            }
                        }
                    } label: {
                        Label("目次", systemImage: "list.bullet.indent")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 10)
                            .background(.regularMaterial, in: Capsule())
                            .shadow(color: .black.opacity(0.12), radius: 4, y: 1)
                    }
                    .padding(16)
                }
            }
        }
    }

    /// The ancestors, root first (§4.6: one I cannot read is 「…」); a tap goes back to it.
    @ViewBuilder
    private var breadcrumbs: some View {
        let crumbs = page?.breadcrumbs ?? hub.tree?.ancestors(of: pageId).map { WikiCrumb(id: $0.id, title: $0.title, icon: $0.icon, readable: true) } ?? []
        if !crumbs.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(Array(crumbs.enumerated()), id: \.offset) { index, crumb in
                        if index > 0 { Image(systemName: "chevron.right").font(.caption2).foregroundStyle(.tertiary) }
                        if crumb.readable, let id = crumb.id {
                            Button { onOpenPage(id) } label: {
                                HStack(spacing: 3) {
                                    if let icon = crumb.icon, !icon.isEmpty { WikiIconView(icon: icon, controller: controller, size: 12) }
                                    Text(WikiPageItem(id: id, title: crumb.title ?? "").displayTitle).lineLimit(1)
                                }
                                .frame(minHeight: 30)
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(.secondary)
                        } else {
                            Text("…").foregroundStyle(.tertiary).accessibilityLabel("表示できないページ")
                        }
                    }
                }
                .font(.caption)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("パンくず")
        }
    }

    /// 「最終更新：名前 · 10:23」 and the task progress.
    private func byline(_ item: WikiPageItem) -> some View {
        let store = controller.store
        let who = store.users[item.updatedBy]?.displayName ?? (store.me?.id == item.updatedBy ? store.me?.displayName : nil) ?? tr("メンバー")
        return HStack(spacing: 10) {
            Text("最終更新：\(who) · \(DMList.timeLabel(item.updatedAt) ?? "")")
            if let progress = CanvasText.taskProgress(total: item.taskTotal, done: item.taskDone) {
                Label(progress, systemImage: "checkmark.square")
            }
            if item.isPrivate { Label("プライベート", systemImage: "lock").labelStyle(.titleAndIcon) }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }

    /// The child pages (§3.2: listed under the page, never written into its body), in the tree's order.
    @ViewBuilder
    private func children(rights: WikiRights, status: CanvasSaveStatus) -> some View {
        let listed = hub.tree?.page(pageId) != nil ? hub.tree?.children(of: pageId) ?? [] : page?.children ?? []
        // M124: a row has no child pages (its database is its parent).
        if item?.kind != "row", item?.isTemplate != true, !listed.isEmpty || (rights.createChild && status != .gone) {
            VStack(alignment: .leading, spacing: 4) {
                Divider().padding(.vertical, 8)
                Text("サブページ").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(listed) { child in
                    Button { onOpenPage(child.id) } label: {
                        HStack(spacing: 8) {
                            WikiIconView(icon: child.icon, controller: controller, kind: child.kind)
                            Text(child.displayTitle).lineLimit(1)
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").font(.caption).foregroundStyle(.tertiary)
                        }
                        .frame(minHeight: 40)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                if rights.createChild && status != .gone {
                    Button { newChild = WikiNewPageTarget(parentId: pageId) } label: {
                        Label("子ページを作成", systemImage: "plus").font(.subheadline)
                    }
                    .frame(minHeight: 40)
                }
            }
        }
    }

    /// 「このページへのリンク」: pages I can read that link here (§3.3).
    @ViewBuilder
    private var backlinkList: some View {
        if let backlinks, !backlinks.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                Divider().padding(.vertical, 8)
                Text("このページへのリンク").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(backlinks) { source in
                    Button { onOpenPage(source.id) } label: {
                        HStack(spacing: 8) {
                            WikiIconView(icon: source.icon, controller: controller, kind: source.kind)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(source.displayTitle).lineLimit(1)
                                Text(WikiText.place(source, tree: hub.tree)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                        }
                        .frame(minHeight: 40)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

/// 題名とアイコン (PATCH /wiki/pages/{id}): an empty icon removes it.
struct WikiRenameSheet: View {
    @Bindable var controller: AppController
    let hub: WikiHub
    let item: WikiPageItem
    @Environment(\.dismiss) private var dismiss
    @State private var title = ""
    @State private var icon = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("題名", text: $title)
                TextField("アイコン（絵文字 1 つ、空欄で外す）", text: $icon)
            }
            .navigationTitle("題名とアイコン")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }.disabled(busy)
                }
            }
        }
        .presentationDetents([.medium])
        .onAppear {
            title = item.title
            icon = item.icon ?? ""
        }
    }

    private func save() async {
        let newTitle = WikiText.title(title)
        let newIcon = WikiText.icon(icon)
        let titleChange = newTitle != nil && newTitle != item.title ? newTitle : nil
        let iconChange = newIcon != item.icon ? (newIcon ?? "") : nil
        guard titleChange != nil || iconChange != nil else {
            dismiss()
            return
        }
        busy = true
        defer { busy = false }
        do {
            try await hub.rename(item.id, title: titleChange, icon: iconChange)
            dismiss()
        } catch {
            controller.error = controller.describe(error)
        }
    }
}

/// The page's history, read only on the phone (the canvas's list and comparisons; restoring and naming versions are
/// the desktop's).
struct WikiHistorySheet: View {
    @Bindable var controller: AppController
    let pageId: String
    let headId: String?
    @State private var model: CanvasHistoryModel
    @Environment(\.dismiss) private var dismiss

    init(controller: AppController, pageId: String, headId: String?) {
        self.controller = controller
        self.pageId = pageId
        self.headId = headId
        _model = State(initialValue: CanvasHistoryModel(canvasId: pageId, isPage: true))
    }

    var body: some View {
        NavigationStack {
            List {
                if let rows = model.rows {
                    ForEach(rows) { revision in
                        NavigationLink(value: revision.id) {
                            CanvasRevisionRow(controller: controller, revision: revision, head: revision.id == headId)
                        }
                    }
                    if model.next != nil {
                        Button("さらに読み込む") { Task { await model.load(controller, more: true) } }
                    }
                } else if model.failed {
                    Text("履歴を読み込めませんでした。").foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("履歴")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
            .navigationDestination(for: String.self) { id in
                CanvasRevisionDetail(controller: controller, model: model, revisionId: id, headId: headId, rights: .none)
            }
            .safeAreaInset(edge: .bottom) {
                Text("版を選ぶと、前の版や現在の版との違いを見られます。版に戻すのはパソコンから行えます。")
                    .font(.footnote).foregroundStyle(.secondary).padding(8)
            }
            .task(id: headId) { await model.load(controller, more: false) }
        }
    }
}

/// M122: a page link tapped outside the wiki (a message, a canvas, a notice): the page in its own stack, its links
/// pushed on it.
struct PageLinkSheet: View {
    @Bindable var controller: AppController
    let pageId: String
    @Environment(\.dismiss) private var dismiss
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            WikiPageScreen(controller: controller, pageId: pageId, onOpenPage: { open($0) })
                .navigationDestination(for: String.self) { id in
                    WikiPageScreen(controller: controller, pageId: id, onOpenPage: { open($0) })
                }
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
        }
    }

    /// Back to a page on the stack (a breadcrumb), else over the one in front.
    private func open(_ id: String) {
        if id == pageId {
            path = []
        } else if let index = path.lastIndex(of: id) {
            path = Array(path[...index])
        } else {
            path.append(id)
        }
    }
}
