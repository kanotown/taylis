import SwiftUI

/// M45: a conversation's 「キャンバス」 tab (CANVAS.md §4.1 / §5, the desktop's CanvasPane): the conversation's tab canvas
/// (else the most recently updated one) open, its list (title, task progress, 新しいキャンバス, ゴミ箱), a new one from a
/// template and the trash.
struct CanvasPane: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    @State private var selectedId: String?
    @State private var dialog: CanvasDialog?

    enum CanvasDialog: String, Identifiable {
        case list, new, trash
        var id: String { rawValue }
    }

    /// The canvas the tab opens on: the conversation's tab canvas, else the most recently updated one.
    static func defaultId(_ list: [CanvasMeta]) -> String? { (list.first { $0.isChannelTab } ?? list.first)?.id }

    var body: some View {
        let list = controller.store.canvasesOf(channel.id)
        let hub = controller.engine?.canvases
        let rights = CanvasRights.of(channel, actor: controller.canvasActor, meta: nil)
        Group {
            if hub?.available != true {
                ContentUnavailableView("キャンバスを使えません", systemImage: "exclamationmark.circle", description: Text("サーバがキャンバスに対応していません。"))
            } else if let selectedId {
                CanvasScreen(controller: controller, channel: channel, canvasId: selectedId,
                             onOpenList: { dialog = .list }, onTrashed: { self.selectedId = nil })
                    .id(selectedId)
            } else if list == nil, let failure = controller.store.canvasListFailure(channel.id) {
                switch failure {
                case .unsupported:
                    ContentUnavailableView("このサーバはまだキャンバスに対応していません", systemImage: "doc.text",
                                           description: Text("サーバの更新後に使えるようになります。"))
                case .failed:
                    CanvasLoadFailed { await hub?.loadList(channel.id) }
                }
            } else if list == nil {
                ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: 12) {
                    Image(systemName: "doc.text").font(.system(size: 34)).foregroundStyle(.tint)
                    Text("この会話にはまだキャンバスがありません").font(.headline)
                    Text("議事録・週報・チェックリストなど、会話のメンバーで一緒に書く文書です。")
                        .font(.subheadline).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    HStack {
                        if rights.create {
                            Button { dialog = .new } label: { Label("キャンバスを作成", systemImage: "plus") }.buttonStyle(.borderedProminent)
                        }
                        Button { dialog = .trash } label: { Label("ゴミ箱", systemImage: "trash") }.buttonStyle(.bordered)
                    }
                    .padding(.top, 4)
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        // The first canvas shown stays until another is chosen (the list's order moves as others save).
        .onChange(of: list.flatMap(Self.defaultId), initial: true) { _, id in
            if selectedId == nil, let id { selectedId = id }
        }
        .task(id: channel.id) {
            if controller.store.canvasesOf(channel.id) == nil { await hub?.loadList(channel.id) }
        }
        .sheet(item: $dialog) { which in
            switch which {
            case .list:
                CanvasListSheet(controller: controller, channel: channel, currentId: selectedId,
                                onSelect: { selectedId = $0; dialog = nil },
                                onNew: rights.create ? { dialog = .new } : nil,
                                onTrash: { dialog = .trash })
            case .new:
                NewCanvasSheet(controller: controller, channel: channel) { canvas in
                    selectedId = canvas.id
                    dialog = nil
                }
            case .trash:
                CanvasTrashSheet(controller: controller, channel: channel) { canvas in
                    selectedId = canvas.id
                    dialog = nil
                }
            }
        }
    }
}

/// A list or a canvas that could not be read: 再読み込み (the failure is cleared while it asks: the spinner shows).
private struct CanvasLoadFailed: View {
    var detail: String?
    let retry: () async -> Void

    var body: some View {
        ContentUnavailableView {
            Label("キャンバスを読み込めませんでした", systemImage: "exclamationmark.triangle")
        } description: {
            if let detail { Text(detail) }
        } actions: {
            Button("再読み込み") { Task { await retry() } }.buttonStyle(.bordered)
        }
    }
}

/// One canvas on screen: its bar (the canvas's name → the list, the save state, 閲覧 / 編集, ⋯), the document or the
/// editor, and the choices a save may ask for. Holds the canvas's save loop while shown; letting go saves what is typed
/// (§4.4 「画面を閉じるとき」).
struct CanvasScreen: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    let canvasId: String
    /// nil: no list to go to (a canvas opened from a link).
    var onOpenList: (() -> Void)?
    var onTrashed: () -> Void = {}
    @State private var saver: CanvasSaver?

    var body: some View {
        Group {
            if let saver {
                CanvasDocument(controller: controller, channel: channel, saver: saver, onOpenList: onOpenList, onTrashed: onTrashed)
            } else {
                ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onAppear {
            if saver == nil { saver = controller.engine?.canvases.hold(canvasId, channelId: channel.id) }
        }
        .onDisappear {
            if saver != nil {
                controller.engine?.canvases.release(canvasId)
                saver = nil
            }
        }
    }
}

private enum CanvasMode: Hashable { case view, edit }

private struct SectionTarget: Identifiable {
    let line: Int
    var id: Int { line }
}

private struct CanvasDocument: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    let saver: CanvasSaver
    var onOpenList: (() -> Void)?
    var onTrashed: () -> Void
    /// The phone's default is reading (§1: reading, ticking and short edits).
    @State private var mode: CanvasMode = .view
    @State private var section: SectionTarget?
    @State private var choiceOpen = true
    @State private var renaming = false
    @State private var newTitle = ""
    @State private var history = false
    @State private var confirmTrash = false

    private var meta: CanvasMeta? {
        let listed = controller.store.canvasMeta(saver.id)
        if let listed, saver.canvas.map({ listed.version >= $0.version }) ?? true { return listed }
        return saver.canvas?.meta ?? listed
    }

    private var rights: CanvasRights {
        guard let meta else { return .none }
        return CanvasRights.of(channel, actor: controller.canvasActor, meta: meta)
    }

    var body: some View {
        let rights = rights
        let status = saver.status
        let editing = rights.edit && mode == .edit && status != .loading && status != .gone
        VStack(spacing: 0) {
            bar(rights: rights)
            Divider()
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
            if status == .loading {
                ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if saver.loadFailed {
                CanvasLoadFailed(detail: saver.error.map { controller.describe($0) }) { await saver.reload() }
            } else if editing {
                CanvasEditor(controller: controller, saver: saver)
            } else {
                CanvasReader(controller: controller, saver: saver, title: meta?.title ?? "キャンバス", meta: meta,
                             onToggleTask: rights.tick && status != .gone ? toggle : nil,
                             onEditSection: rights.edit && status != .gone ? { section = SectionTarget(line: $0) } : nil,
                             onStartWriting: rights.edit ? { mode = .edit } : nil)
            }
        }
        .onChange(of: status) { _, next in
            guard next == .conflict || next == .expired else { return }
            choiceOpen = true
            KeyboardBehavior.dismiss() // the choice takes the screen; typing goes on after it
        }
        .sheet(item: $section) { target in
            CanvasSectionSheet(controller: controller, saver: saver, line: target.line)
        }
        .sheet(isPresented: Binding(get: { choiceOpen && status == .conflict && saver.conflict != nil }, set: { if !$0 { choiceOpen = false } })) {
            if let conflict = saver.conflict {
                CanvasConflictSheet(controller: controller, saver: saver, conflict: conflict, tickOnly: !rights.edit)
            }
        }
        .sheet(isPresented: Binding(get: { choiceOpen && status == .expired && saver.expired != nil }, set: { if !$0 { choiceOpen = false } })) {
            if let head = saver.expired {
                CanvasExpiredSheet(controller: controller, saver: saver, head: head, canOverwrite: rights.edit)
            }
        }
        .sheet(isPresented: $history) {
            CanvasHistorySheet(controller: controller, canvasId: saver.id)
        }
        .alert("題名を変更", isPresented: $renaming) {
            TextField("題名", text: $newTitle)
            Button("キャンセル", role: .cancel) {}
            Button("変更") {
                let trimmed = newTitle.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !trimmed.isEmpty, trimmed != meta?.title else { return }
                Task { await controller.updateCanvas(saver.id, title: String(trimmed.prefix(200))) }
            }
        }
        .confirmationDialog("このキャンバスをゴミ箱に移しますか？", isPresented: $confirmTrash, titleVisibility: .visible) {
            Button("ゴミ箱に移す", role: .destructive) {
                Task { if await controller.trashCanvas(saver.id, channelId: channel.id) { onTrashed() } }
            }
        } message: {
            Text("30 日間はゴミ箱から戻せます。")
        }
    }

    /// A tick is saved at once (§4.4); only the box changes, so a member who may only tick sends what the server takes.
    private func toggle(_ line: Int, _ done: Bool) {
        guard let next = CanvasText.toggleTaskLine(saver.text, line: line, done: done) else { return }
        saver.edit(next, external: true)
        Task { await saver.flush() }
    }

    private func bar(rights: CanvasRights) -> some View {
        HStack(spacing: 6) {
            Button { onOpenList?() } label: {
                HStack(spacing: 4) {
                    Image(systemName: "doc.text").foregroundStyle(.tint)
                    Text(meta?.title ?? "キャンバス").font(.subheadline.weight(.semibold)).lineLimit(1)
                    if onOpenList != nil { Image(systemName: "chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(.secondary) }
                }
                .frame(minHeight: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(onOpenList == nil)
            .accessibilityLabel("キャンバスの一覧")
            .accessibilityValue(meta?.title ?? "")
            Spacer(minLength: 4)
            CanvasSaveStateLabel(saver: saver) { choiceOpen = true }
            if rights.edit && saver.status != .gone {
                Picker("表示", selection: $mode) {
                    Text("閲覧").tag(CanvasMode.view)
                    Text("編集").tag(CanvasMode.edit)
                }
                .pickerStyle(.segmented)
                .fixedSize()
            }
            if saver.status != .gone { menu(rights: rights) }
        }
        .padding(.horizontal, 12)
    }

    /// ⋯: title, who edits (not in a DM), the conversation's tab, history, copy, the trash (CANVAS.md §4.7).
    private func menu(rights: CanvasRights) -> some View {
        let dm = channel.channel.isDm
        let tabTaken = (controller.store.canvasesOf(channel.id) ?? []).contains { $0.isChannelTab && $0.id != saver.id }
        return Menu {
            if let meta {
                if rights.manage {
                    Button("題名を変更…", systemImage: "pencil") {
                        newTitle = meta.title
                        renaming = true
                    }
                    if !tabTaken {
                        Button(meta.isChannelTab ? "会話のキャンバスから外す" : "会話のキャンバスにする", systemImage: "rectangle.stack") {
                            Task { await controller.updateCanvas(meta.id, isChannelTab: !meta.isChannelTab) }
                        }
                    }
                    if !dm {
                        Picker(selection: Binding(get: { meta.editPolicy }, set: { value in
                            Task { await controller.updateCanvas(meta.id, editPolicy: value) }
                        })) {
                            Text("投稿できるメンバー全員").tag("members")
                            Text("作成者・オーナー・管理者 (チェックは全員)").tag("owners")
                        } label: {
                            Label("編集できる人", systemImage: "person.2")
                        }
                        .pickerStyle(.menu)
                    }
                }
                Button("履歴", systemImage: "clock.arrow.circlepath") { history = true }
                Button("本文をコピー", systemImage: "doc.on.doc") { controller.copyCanvasText(saver.text) }
                Button("リンクをコピー", systemImage: "link") { controller.copyCanvasLink(meta.id) }
                if rights.trash {
                    Divider()
                    Button("ゴミ箱に移す", systemImage: "trash", role: .destructive) { confirmTrash = true }
                }
            }
        } label: {
            Image(systemName: "ellipsis.circle").font(.title3).frame(width: 36, height: 44).contentShape(Rectangle())
        }
        .accessibilityLabel("キャンバスの操作")
    }

    /// A line under the bar: why this canvas cannot be changed here, or what happened to it.
    private func notice(rights: CanvasRights) -> (text: String, warn: Bool, copy: Bool)? {
        if saver.loadFailed { return nil } // the screen says it
        switch saver.status {
        case .gone: return ("このキャンバスはゴミ箱に移されたか、見られなくなりました。手元の本文はコピーできます。", true, true)
        case .blocked: return ("保存できませんでした: " + (saver.error.map { controller.describe($0) } ?? ErrorMessages.unknown), true, true)
        default: break
        }
        if channel.channel.archived { return ("アーカイブされた会話のキャンバスは閲覧だけです。", false, false) }
        if saver.status == .loading || meta == nil { return nil }
        if !rights.edit && rights.tick { return ("チェックだけ付けられます。本文を変更できるのは作成者・オーナー・管理者です。", false, false) }
        if !rights.tick { return ("閲覧のみです。", false, false) }
        return nil
    }
}

/// The save state beside the canvas's name; 「競合」 opens its choice again.
struct CanvasSaveStateLabel: View {
    let saver: CanvasSaver
    let onOpenChoice: () -> Void

    static func label(_ status: CanvasSaveStatus) -> String {
        switch status {
        case .loading: "読み込み中…"
        case .saved: "保存済み"
        case .editing: "編集中"
        case .saving: "保存中…"
        case .offline: "オフライン"
        case .retrying: "再試行中…"
        case .conflict, .expired: "競合"
        case .blocked: "保存できません"
        case .gone: "ゴミ箱"
        }
    }

    private var icon: String {
        switch saver.status {
        case .loading, .saving, .retrying: "arrow.triangle.2.circlepath"
        case .saved: "checkmark.icloud"
        case .editing: "pencil"
        case .offline: "icloud.slash"
        case .conflict, .expired, .blocked: "exclamationmark.triangle.fill"
        case .gone: "trash"
        }
    }

    private var tint: Color {
        switch saver.status {
        case .offline, .retrying: .orange
        case .conflict, .expired, .blocked: .red
        default: .secondary
        }
    }

    var body: some View {
        let content = HStack(spacing: 3) {
            Image(systemName: icon).imageScale(.small)
            Text(Self.label(saver.status)).lineLimit(1)
        }
        .font(.caption)
        .foregroundStyle(tint)
        if saver.status == .conflict || saver.status == .expired {
            Button(action: onOpenChoice) { content.frame(minHeight: 44).contentShape(Rectangle()) }
                .buttonStyle(.plain)
                .accessibilityIdentifier("canvas-save-state")
        } else {
            content
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("canvas-save-state")
        }
    }
}

/// The reading view: the title, who changed it last, the rendered body with boxes to tick, pull to refresh and, for a
/// long canvas, an outline to jump to a heading.
private struct CanvasReader: View {
    @Bindable var controller: AppController
    let saver: CanvasSaver
    let title: String
    let meta: CanvasMeta?
    let onToggleTask: ((Int, Bool) -> Void)?
    let onEditSection: ((Int) -> Void)?
    let onStartWriting: (() -> Void)?

    var body: some View {
        let headings = CanvasText.outline(saver.text)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(.title2.bold()).fixedSize(horizontal: false, vertical: true)
                    if let meta { byline(meta) }
                    if saver.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        HStack(spacing: 4) {
                            Text("まだ何も書かれていません。").foregroundStyle(.secondary)
                            if let onStartWriting { Button("書き始める", action: onStartWriting) }
                        }
                        .font(.subheadline)
                        .padding(.top, 16)
                    } else {
                        CanvasBodyView(body: saver.text, controller: controller, onToggleTask: onToggleTask, onEditSection: onEditSection)
                            .padding(.top, 10)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 14)
                .padding(.bottom, headings.count >= 3 ? 56 : 0)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .refreshable { await saver.refresh() }
            .overlay(alignment: .bottomTrailing) {
                if headings.count >= 3 {
                    Menu {
                        ForEach(headings) { entry in
                            Button(String(repeating: "  ", count: entry.level - 1) + entry.text) {
                                withAnimation { proxy.scrollTo(CanvasBodyView.anchor(entry.line), anchor: .top) }
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

    /// 「最終更新: 名前 · 10:23」, the task progress, the tab mark, who edits.
    private func byline(_ meta: CanvasMeta) -> some View {
        let who = controller.store.users[meta.updatedBy]?.displayName ?? (controller.store.me?.id == meta.updatedBy ? controller.store.me?.displayName : nil) ?? "メンバー"
        return HStack(spacing: 10) {
            Text("最終更新: \(who) · \(DMList.timeLabel(meta.updatedAt) ?? "")")
            if let progress = CanvasText.taskProgress(total: meta.taskTotal, done: meta.taskDone) {
                Label(progress, systemImage: "checkmark.square")
            }
            if meta.isChannelTab { Text("会話のキャンバス").foregroundStyle(.tint) }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
    }
}

/// §5 「このセクションを編集」: one heading's section in the editor; the whole body (with the section replaced) is saved,
/// so the server merges what others changed elsewhere meanwhile.
private struct CanvasSectionSheet: View {
    @Bindable var controller: AppController
    let saver: CanvasSaver
    let line: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            CanvasEditor(controller: controller, saver: saver, sectionLine: line, autoFocus: true)
                .navigationTitle("セクションを編集")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) { CanvasSaveStateLabel(saver: saver) {}.fixedSize() }
                    ToolbarItem(placement: .confirmationAction) { Button("完了") { dismiss() } }
                }
        }
        .interactiveDismissDisabled(saver.status == .saving)
    }
}

/// The conversation's canvases: title, who changed it and when, the task progress, the tab mark; 新しいキャンバス, ゴミ箱.
private struct CanvasListSheet: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    let currentId: String?
    let onSelect: (String) -> Void
    let onNew: (() -> Void)?
    let onTrash: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section("この会話のキャンバス") {
                    ForEach(controller.store.canvasesOf(channel.id) ?? []) { canvas in
                        Button { onSelect(canvas.id) } label: { row(canvas) }
                            .buttonStyle(.plain)
                    }
                }
                Section {
                    if let onNew { Button { onNew() } label: { Label("新しいキャンバス", systemImage: "plus") } }
                    Button { onTrash() } label: { Label("ゴミ箱", systemImage: "trash") }
                }
            }
            .navigationTitle("キャンバス")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
            .refreshable { await controller.engine?.canvases.loadList(channel.id) }
        }
        .presentationDetents([.medium, .large])
    }

    private func row(_ canvas: CanvasMeta) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "doc.text").foregroundStyle(canvas.id == currentId ? Color.accentColor : Color.secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(canvas.title).lineLimit(1).fontWeight(canvas.id == currentId ? .semibold : .regular)
                Text("\(controller.store.users[canvas.updatedBy]?.displayName ?? "メンバー") · \(DMList.timeLabel(canvas.updatedAt) ?? "")")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 4)
            if canvas.isChannelTab {
                Text("タブ").font(.caption2.weight(.semibold)).foregroundStyle(.tint)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Color.accentColor.opacity(0.12), in: Capsule())
            }
            if let progress = CanvasText.taskProgress(total: canvas.taskTotal, done: canvas.taskDone) {
                Text(progress).font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
        }
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}

/// A new canvas: empty or from a template (§4.12); the conversation's tab when it has none.
private struct NewCanvasSheet: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    let onCreated: (CanvasOut) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var templates: [CanvasTemplateOut]?
    @State private var choice = ""
    @State private var title = ""
    @State private var asTab = true
    @State private var busy = false

    var body: some View {
        let hasTab = (controller.store.canvasesOf(channel.id) ?? []).contains { $0.isChannelTab }
        NavigationStack {
            Form {
                Section {
                    option("", "空白のキャンバス", nil)
                    if let templates {
                        ForEach(templates) { option($0.key, $0.name, $0.description) }
                    } else {
                        HStack { ProgressView(); Text("テンプレートを読み込んでいます…").foregroundStyle(.secondary) }
                    }
                } header: {
                    Text("テンプレート")
                } footer: {
                    Text("日付や名前はテンプレートに入ります。")
                }
                Section {
                    TextField(choice.isEmpty ? "題名 (空欄なら「無題のキャンバス」)" : "題名 (空欄ならテンプレートの題名)", text: $title)
                    if !hasTab {
                        Toggle("会話のキャンバスにする", isOn: $asTab)
                    }
                } footer: {
                    if !hasTab { Text("「キャンバス」タブで最初に開きます。") }
                }
            }
            .navigationTitle("新しいキャンバス")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("作成") {
                        busy = true
                        Task {
                            let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
                            let canvas = await controller.createCanvas(channelId: channel.id, templateKey: choice.isEmpty ? nil : choice,
                                                                       title: trimmed.isEmpty ? nil : String(trimmed.prefix(200)), asTab: asTab && !hasTab)
                            busy = false
                            if let canvas { onCreated(canvas) }
                        }
                    }
                    .disabled(busy)
                }
            }
            .task { templates = await controller.canvasTemplates() ?? [] }
        }
    }

    private func option(_ key: String, _ name: String, _ description: String?) -> some View {
        Button { choice = key } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: choice == key ? "largecircle.fill.circle" : "circle")
                    .foregroundStyle(choice == key ? Color.accentColor : Color.secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                    if let description, !description.isEmpty { Text(description).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(choice == key ? [.isSelected] : [])
    }
}

/// The conversation's trash: canvases moved there (restorable; the server purges them after 30 days).
private struct CanvasTrashSheet: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    let onRestored: (CanvasOut) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var rows: [CanvasMeta]?

    var body: some View {
        NavigationStack {
            List {
                if let rows {
                    if rows.isEmpty {
                        Text("ゴミ箱は空です。").foregroundStyle(.secondary)
                    }
                    ForEach(rows) { canvas in
                        HStack(spacing: 10) {
                            Image(systemName: "doc.text").foregroundStyle(.secondary)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(canvas.title).lineLimit(1)
                                Text("削除: " + (DMList.timeLabel(canvas.deletedAt) ?? "")).font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 4)
                            if CanvasRights.of(channel, actor: controller.canvasActor, meta: canvas).trash {
                                Button("戻す") {
                                    Task { if let restored = await controller.restoreCanvas(canvas.id) { onRestored(restored) } }
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("キャンバスのゴミ箱")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
            .safeAreaInset(edge: .bottom) {
                Text("ゴミ箱のキャンバスは 30 日後に完全に削除されます。").font(.footnote).foregroundStyle(.secondary).padding(8)
            }
            .task { rows = await controller.trashedCanvases(channelId: channel.id) ?? [] }
        }
        .presentationDetents([.medium, .large])
    }
}

/// §4.4 409 canvas_conflict: where both changed the same words, and the choices (a member who may only tick: 相手の版).
private struct CanvasConflictSheet: View {
    @Bindable var controller: AppController
    let saver: CanvasSaver
    let conflict: CanvasSaver.ConflictState
    let tickOnly: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let conflicts = conflict.details.conflicts ?? []
        let shown = Array(conflicts.prefix(5))
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text(tickOnly ? "相手の版を残して、チェックを付け直してください。" : "重なった箇所だけ、どちらを残すか選んでください。ほかの変更はどちらも残ります。")
                        .font(.subheadline).foregroundStyle(.secondary)
                    if conflict.details.timedOut == true {
                        Text("文書が大きく、細かく比べられませんでした。文書全体をひとつの箇所として扱います。").font(.footnote).foregroundStyle(.secondary)
                    }
                    ForEach(Array(shown.enumerated()), id: \.offset) { _, region in
                        VStack(alignment: .leading, spacing: 6) {
                            side("自分の版", region.ours, mine: true)
                            side("相手の版", region.theirs, mine: false)
                            if !region.base.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                Text("元の文: " + String(names(region.base).prefix(200))).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        .padding(10)
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.3)))
                    }
                    if conflicts.count > shown.count { Text("ほか \(conflicts.count - shown.count) 箇所").font(.caption).foregroundStyle(.secondary) }
                }
                .padding(16)
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    if !tickOnly {
                        Button { choose(.ours) } label: { Text("自分の版").frame(maxWidth: .infinity) }.buttonStyle(.borderedProminent)
                    }
                    Button { choose(.theirs) } label: { Text("相手の版").frame(maxWidth: .infinity) }.buttonStyle(.bordered)
                    if !tickOnly {
                        Button { choose(.both) } label: { Text("両方残す").frame(maxWidth: .infinity) }.buttonStyle(.bordered)
                    }
                    Button("あとで") { dismiss() }.padding(.top, 2)
                }
                .controlSize(.large)
                .padding(16)
                .background(.bar)
            }
            .navigationTitle("同じ箇所がほかの人にも変更されました")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private func choose(_ choice: CanvasOnConflict) {
        dismiss()
        Task { await saver.resolveConflict(choice) }
    }

    private func names(_ text: String) -> String { Mentions.toNames(text, users: controller.store.users, groups: controller.store.groups) }

    private func side(_ label: String, _ text: String, mine: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(text.isEmpty ? "(削除)" : names(text)).font(.callout).foregroundStyle(text.isEmpty ? .secondary : .primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(8)
        .background(mine ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// §4.4 409 canvas_base_expired: mine and the current body one above the other.
private struct CanvasExpiredSheet: View {
    @Bindable var controller: AppController
    let saver: CanvasSaver
    let head: CanvasOut
    let canOverwrite: Bool
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("長くオフラインだった間に版が整理されました。自分の本文と今の本文を見比べて選んでください。")
                        .font(.subheadline).foregroundStyle(.secondary)
                    side("自分の本文", saver.text, mine: true)
                    side("今の本文", head.body, mine: false)
                }
                .padding(16)
            }
            .safeAreaInset(edge: .bottom) {
                VStack(spacing: 8) {
                    if canOverwrite {
                        Button { dismiss(); Task { await saver.resolveExpired(keepMine: true) } } label: {
                            Text("自分の本文で上書き").frame(maxWidth: .infinity)
                        }.buttonStyle(.borderedProminent)
                    }
                    Button { dismiss(); Task { await saver.resolveExpired(keepMine: false) } } label: {
                        Text("今の本文にする").frame(maxWidth: .infinity)
                    }.buttonStyle(.bordered)
                    Button { controller.copyCanvasText(saver.text) } label: { Label("自分の本文をコピー", systemImage: "doc.on.doc") }
                }
                .controlSize(.large)
                .padding(16)
                .background(.bar)
            }
            .navigationTitle("編集の元にした版がなくなりました")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("あとで") { dismiss() } } }
        }
    }

    private func side(_ label: String, _ text: String, mine: Bool) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            Text(Mentions.toNames(text, users: controller.store.users, groups: controller.store.groups))
                .font(.callout).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(mine ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
    }
}

/// The history, read only on the phone (CANVAS.md §5: 「履歴 (MVP は閲覧 …)」): who saved what when; a version opens
/// rendered. Restoring, labels and erasing are the desktop's (M44).
private struct CanvasHistorySheet: View {
    @Bindable var controller: AppController
    let canvasId: String
    @Environment(\.dismiss) private var dismiss
    @State private var rows: [CanvasRevisionMeta]?
    @State private var next: String?
    @State private var failed = false

    var body: some View {
        NavigationStack {
            List {
                if let rows {
                    ForEach(rows) { revision in
                        NavigationLink {
                            CanvasRevisionView(controller: controller, canvasId: canvasId, revision: revision)
                        } label: { row(revision) }
                        .disabled(revision.kind == "erased")
                    }
                    if let next {
                        Button("さらに読み込む") { Task { await load(cursor: next) } }
                    }
                } else if failed {
                    Text("履歴を読み込めませんでした。").foregroundStyle(.secondary)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("履歴")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
            .task { await load(cursor: nil) }
        }
    }

    private func load(cursor: String?) async {
        guard let api = controller.api else { return }
        do {
            let page = try await api.canvasRevisions(id: canvasId, cursor: cursor)
            rows = (cursor == nil ? [] : rows ?? []) + page.items
            next = page.nextCursor
        } catch {
            failed = rows == nil
            controller.error = controller.describe(error)
        }
    }

    static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "create": "作成"
        case "merge": "保存 (マージ)"
        case "restore": "復元"
        case "erased": "消去済み"
        default: "保存"
        }
    }

    private func row(_ revision: CanvasRevisionMeta) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(controller.store.users[revision.authorId]?.displayName ?? "メンバー").fontWeight(.medium)
                Text(Self.kindLabel(revision.kind)).font(.caption).foregroundStyle(.secondary)
                if let label = revision.label, !label.isEmpty {
                    Text(label).font(.caption2.weight(.semibold)).padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Color.accentColor.opacity(0.14), in: Capsule())
                }
            }
            HStack(spacing: 8) {
                Text(Timeline.fullLabel(revision.createdAt))
                if revision.linesAdded > 0 { Text("+\(revision.linesAdded)").foregroundStyle(.green) }
                if revision.linesRemoved > 0 { Text("−\(revision.linesRemoved)").foregroundStyle(.red) }
            }
            .font(.caption).foregroundStyle(.secondary)
        }
    }
}

private struct CanvasRevisionView: View {
    @Bindable var controller: AppController
    let canvasId: String
    let revision: CanvasRevisionMeta
    @State private var body_: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(revision.title).font(.title3.bold())
                Text("\(controller.store.users[revision.authorId]?.displayName ?? "メンバー") · \(Timeline.fullLabel(revision.createdAt))")
                    .font(.caption).foregroundStyle(.secondary)
                if let body_ {
                    CanvasBodyView(body: body_, controller: controller, onToggleTask: nil).padding(.top, 8)
                } else {
                    ProgressView().padding(.top, 24)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(CanvasHistorySheet.kindLabel(revision.kind))
        .navigationBarTitleDisplayMode(.inline)
        .task {
            guard let api = controller.api else { return }
            do { body_ = try await api.canvasRevision(id: canvasId, revisionId: revision.id).body } catch { controller.error = controller.describe(error) }
        }
    }
}

/// M45: a canvas link tapped in a message (`<server>/c/<id>`, §4.13): the canvas's screen for members of its
/// conversation; 「メンバーではありません」 for others (403), 「見つかりません」 when it is gone (404).
struct CanvasLinkSheet: View {
    @Bindable var controller: AppController
    let canvasId: String
    @Environment(\.dismiss) private var dismiss
    @State private var state: LoadState = .loading

    private enum LoadState {
        case loading
        case open(channelId: String)
        case notMember
        case missing
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            Group {
                switch state {
                case .loading:
                    ProgressView("読み込み中…").frame(maxWidth: .infinity, maxHeight: .infinity)
                case .open(let channelId):
                    if let channel = controller.store.channel(channelId), channel.isMember {
                        CanvasScreen(controller: controller, channel: channel, canvasId: canvasId, onOpenList: nil, onTrashed: { dismiss() })
                    } else {
                        notMember
                    }
                case .notMember:
                    notMember
                case .missing:
                    ContentUnavailableView("キャンバスが見つかりません", systemImage: "doc.questionmark",
                                           description: Text("ゴミ箱に移されたか、削除されました。"))
                case .failed(let message):
                    ContentUnavailableView {
                        Label("キャンバスを開けませんでした", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(message)
                    } actions: {
                        Button("再試行") { Task { await load() } }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                if case .open(let channelId) = state, let channel = controller.store.channel(channelId) {
                    ToolbarItem(placement: .primaryAction) {
                        Button("会話へ") {
                            dismiss()
                            NotificationCenter.default.post(name: .chikuwaOpenChannel, object: nil, userInfo: ["id": channel.id])
                        }
                    }
                }
            }
        }
        .task { await load() }
    }

    private var title: String {
        if case .open(let channelId) = state, let channel = controller.store.channel(channelId) { return channelTitle(channel, store: controller.store) }
        return "キャンバス"
    }

    private var notMember: some View {
        ContentUnavailableView("メンバーではありません", systemImage: "lock",
                               description: Text("このキャンバスは、会話のメンバーだけが見られます。"))
    }

    private func load() async {
        guard let api = controller.api else { return }
        state = .loading
        do {
            if let canvas = try await api.getCanvas(id: canvasId, knownVersion: nil) {
                state = controller.store.channel(canvas.channelId)?.isMember == true ? .open(channelId: canvas.channelId) : .notMember
            }
        } catch ApiError.api(let status, let code, _) where status == 403 || code == "not_a_member" {
            state = .notMember
        } catch ApiError.api(let status, _, _) where status == 404 {
            state = .missing
        } catch {
            state = .failed(controller.describe(error))
        }
    }
}
