import SwiftUI

/// M45: a canvas rendered (CANVAS.md §4.2): the message renderer's blocks plus tasks with boxes that tick (§4.4
/// 「チェックの切り替え」), the canvas's images (the authenticated loader) and rules. Headings carry ids for the outline and,
/// for those who may edit, 「このセクションを編集」 (§5).
struct CanvasBodyView: View {
    let body_: String
    @Bindable var controller: AppController
    /// nil: the boxes only show (read only).
    var onToggleTask: ((Int, Bool) -> Void)?
    /// nil: no section editing.
    var onEditSection: ((Int) -> Void)?
    /// M73 (CANVAS.md §18.3): 「タスクにする」 on an open checklist item's long press (its line); nil: not offered.
    var onMakeTask: ((Int) -> Void)?
    /// M122: a page link tapped in this body (a wiki page pushes it on its own stack); nil: over everything.
    var onOpenPage: ((String) -> Void)?
    /// M122: a page's file link, downloaded and shown.
    @State private var openedFile: URL?

    init(body: String, controller: AppController, onToggleTask: ((Int, Bool) -> Void)?, onEditSection: ((Int) -> Void)? = nil,
         onMakeTask: ((Int) -> Void)? = nil, onOpenPage: ((String) -> Void)? = nil) {
        self.body_ = body
        self.controller = controller
        self.onToggleTask = onToggleTask
        self.onEditSection = onEditSection
        self.onMakeTask = onMakeTask
        self.onOpenPage = onOpenPage
    }

    static func anchor(_ line: Int) -> String { "canvas-h-\(line)" }

    /// M149: where the outline scrolls for a heading on `line` — the callout or toggle around it (a closed toggle does
    /// not draw it), else the heading itself.
    static func anchorLine(_ body: String, line: Int) -> Int {
        guard let entry = BodyTokenizer.parseLinedBlocks(body, canvas: true).last(where: { $0.line <= line }) else { return line }
        switch entry.block {
        case .callout, .toggle: return entry.line
        default: return line
        }
    }

    var body: some View {
        CanvasBlocksView(entries: BodyTokenizer.parseLinedBlocks(body_, canvas: true).map { BodyLinedBlock(block: $0.block, line: $0.line) },
                         controller: controller, onToggleTask: onToggleTask, onEditSection: onEditSection, onMakeTask: onMakeTask,
                         onOpenPage: onOpenPage)
        .environment(\.openURL, OpenURLAction { url in
            if url.scheme == CanvasLink.scheme, let id = url.host {
                controller.canvasLink = CanvasLinkTarget(id: id)
                return .handled
            }
            if url.scheme == Permalink.scheme, let id = url.host {
                Task { await controller.openPermalink(id) }
                return .handled
            }
            // M122: a wiki page (`page:` or `/p/`): the screen that shows this body may open it itself (a page's own
            // links stay on its stack), else over everything.
            if url.scheme == PageLink.scheme, let id = url.host {
                if let onOpenPage { onOpenPage(id) } else { controller.pageLink = PageLinkTarget(id: id) }
                return .handled
            }
            if url.scheme == FileLink.scheme, let id = url.host {
                Task { if let file = await controller.downloadPageFile(id) { openedFile = file } }
                return .handled
            }
            return .systemAction
        })
        .sheet(item: $openedFile) { url in
            if AttachmentPreview.canPreview(url) { FilePreviewSheet(url: url, onDismiss: { openedFile = nil }) } else { ShareSheet(items: [url]) }
        }
        // M122: the titles of the pages this body links to that are not known here yet.
        .task(id: body_) {
            guard body_.contains("](page:"), let wiki = controller.wiki else { return }
            await wiki.resolveLinks(in: body_)
        }
    }
}

/// The blocks of a body, or of a container's inside (M149): the same renderer all the way down, with the lines of the
/// whole body (a task in a callout ticks its own line). Inside a container a heading has no section editing (its
/// section would run past the container's close).
struct CanvasBlocksView: View {
    let entries: [BodyLinedBlock]
    @Bindable var controller: AppController
    var onToggleTask: ((Int, Bool) -> Void)?
    var onEditSection: ((Int) -> Void)?
    var onMakeTask: ((Int) -> Void)?
    var onOpenPage: ((String) -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in
                block(entry.block, line: entry.line)
            }
        }
    }

    private func inner(_ blocks: [BodyLinedBlock]) -> CanvasBlocksView {
        CanvasBlocksView(entries: blocks, controller: controller, onToggleTask: onToggleTask, onEditSection: nil, onMakeTask: onMakeTask,
                         onOpenPage: onOpenPage)
    }

    /// M149: a callout's tint, faint enough for the text in light and dark mode.
    static func tint(_ tone: CalloutTone) -> Color {
        switch tone {
        case .gray: Color.secondary.opacity(0.12)
        case .yellow: Color.yellow.opacity(0.18)
        case .red: Color.red.opacity(0.13)
        case .green: Color.green.opacity(0.14)
        case .blue: Color.blue.opacity(0.12)
        }
    }

    @ViewBuilder
    private func block(_ block: BodyBlock, line: Int) -> some View {
        switch block {
        case .callout(let icon, let tone, let blocks):
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                if let icon {
                    CustomEmoji.text(Emoji.replaceShortcodes(icon), custom: controller.store.customEmoji, images: controller.store.emojiImages,
                                     onNeed: { controller.loadEmojiImage($0) })
                        .font(.title3)
                        .fixedSize()
                        .accessibilityHidden(true)
                }
                inner(blocks).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Self.tint(tone), in: RoundedRectangle(cornerRadius: 10))
            .accessibilityElement(children: .contain)
            .accessibilityLabel(Text("コールアウト"))
            .id(CanvasBodyView.anchor(line))
        case .toggle(let title, let blocks):
            CanvasToggle(label: title.map(BodyTokenizer.inlineText).joined(),
                         title: { message([.paragraph([title])]) },
                         content: { inner(blocks) })
                .id(CanvasBodyView.anchor(line))
        case .embed(_, let pageId, let viewId, _):
            // The label is never shown (§22.5): the title is the database's own, or nothing I may not read.
            CanvasEmbedView(pageId: pageId, viewId: viewId, controller: controller, onOpenPage: onOpenPage)
        case .task(let items):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(items, id: \.line) { item in taskRow(item) }
            }
        case .image(let alt, let attachmentId, _):
            CanvasImageView(attachmentId: attachmentId, alt: alt, controller: controller)
        case .rule:
            Divider().padding(.vertical, 6)
        case .heading:
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                message([block])
                if let onEditSection {
                    Button { onEditSection(line) } label: {
                        Image(systemName: "square.and.pencil").font(.subheadline).foregroundStyle(.secondary)
                            .frame(width: 32, height: 32).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("このセクションを編集")
                }
            }
            .padding(.top, 6)
            .id(CanvasBodyView.anchor(line))
        default:
            message([block])
        }
    }

    private func taskRow(_ item: BodyTaskItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Button { onToggleTask?(item.line, !item.done) } label: {
                Image(systemName: item.done ? "checkmark.square.fill" : "square")
                    .font(.title3)
                    .foregroundStyle(item.done ? Color.accentColor : Color.secondary)
                    .frame(minWidth: 32, minHeight: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(onToggleTask == nil)
            .accessibilityLabel(item.done ? "完了を取り消す" : "完了にする")
            .accessibilityValue(item.done ? "完了" : "未完了")
            message([.paragraph([item.tokens])])
                .strikethrough(item.done)
                .foregroundStyle(item.done ? .secondary : .primary)
        }
        .padding(.leading, CGFloat(item.level) * 24)
        .modifier(MakeTaskMenu(action: item.done ? nil : onMakeTask.map { make in { make(item.line) } }))
    }

    private func message(_ blocks: [BodyBlock]) -> some View {
        let store = controller.store
        let wiki = controller.wiki
        return MessageBodyView(text: "", users: store.users, groups: store.groups, internalBase: controller.api?.baseUrl,
                               customEmoji: store.customEmoji, emojiImages: store.emojiImages,
                               onNeedEmojiImage: { controller.loadEmojiImage($0) }, preparsed: blocks,
                               pageLabel: { id in wiki?.linkState(id) })
    }
}

/// M73: the long press of an open checklist item offers 「タスクにする」; nothing is attached without one (a done item,
/// a read-only body), so the row scrolls and ticks as before.
private struct MakeTaskMenu: ViewModifier {
    let action: (() -> Void)?

    func body(content: Content) -> some View {
        if let action {
            content
                .contentShape(.contextMenuPreview, Rectangle())
                .contextMenu { Button("タスクにする", systemImage: "checklist", action: action) }
        } else {
            content
        }
    }
}

/// M149: a toggle — a chevron and its title, closed at first; a tap opens and closes it. The state is this screen's
/// (never written into the body) and may reset when the screen is built again.
private struct CanvasToggle<Title: View, Content: View>: View {
    /// What VoiceOver reads for the title.
    let label: String
    @ViewBuilder let title: () -> Title
    @ViewBuilder let content: () -> Content
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { open.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "chevron.right")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .frame(width: 20)
                    title()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label.trimmingCharacters(in: .whitespaces).isEmpty ? tr("トグル") : label)
            .accessibilityValue(open ? tr("展開中") : tr("折りたたみ中"))
            if open {
                content().padding(.leading, 26)
            }
        }
    }
}

/// M149 (WIKI.md §22.5 / §26): a database embedded in a body — on the phone its title, the view's name and its first rows
/// as small cards, and 「開く」 (its page; a row opens the row's page). The label written in the body is never shown: a
/// database I may not read (a 4xx other than 401 / 429, or a page the tree says I cannot see) is 「アクセスできないページ」
/// with no name at all; a network failure keeps what was shown, else 「データベースを読み込めませんでした」 and 「開く」.
struct CanvasEmbedView: View {
    let pageId: String
    let viewId: String?
    @Bindable var controller: AppController
    var onOpenPage: ((String) -> Void)?
    @State private var phase: Phase

    static let rowLimit = 5
    /// The loading placeholder is about this high, so the body moves little when the rows come.
    static let minHeight: CGFloat = 132

    init(pageId: String, viewId: String?, controller: AppController, onOpenPage: ((String) -> Void)? = nil, phase: Phase = .loading) {
        self.pageId = pageId
        self.viewId = viewId
        self.controller = controller
        self.onOpenPage = onOpenPage
        _phase = State(initialValue: phase)
    }

    struct RowLine: Equatable, Identifiable {
        let id: String
        let title: String
        let detail: String?
    }

    enum Phase: Equatable {
        case loading
        case shown(viewName: String, rows: [RowLine])
        case unreadable
        case offline
    }

    /// The phase after a failed load: refused for good is unreadable, anything else keeps the rows shown (or is offline).
    static func failed(_ error: Error, was phase: Phase) -> Phase {
        if let api = error as? ApiError, api.isRefused { return .unreadable }
        if case .shown = phase { return phase }
        return .offline
    }

    var body: some View {
        Group {
            if case .unreadable? = controller.wiki?.linkState(pageId) {
                hidden
            } else {
                switch phase {
                case .loading:
                    RoundedRectangle(cornerRadius: 10).fill(Color.secondary.opacity(0.08))
                        .overlay(ProgressView())
                        .frame(maxWidth: .infinity, minHeight: Self.minHeight)
                        .accessibilityLabel(Text("読み込み中"))
                case .shown(let viewName, let rows):
                    card(viewName: viewName, rows: rows)
                case .unreadable:
                    hidden
                case .offline:
                    header(viewName: nil, note: tr("データベースを読み込めませんでした"))
                        .padding(10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.35), lineWidth: 1))
                }
            }
        }
        .task(id: pageId + "#" + (viewId ?? "")) { await load() }
    }

    /// 「アクセスできないページ」 and nothing else (not the label, not a name).
    private var hidden: some View {
        Label("アクセスできないページ", systemImage: "lock")
            .font(.subheadline).foregroundStyle(.secondary)
            .padding(.horizontal, 12).padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.35), lineWidth: 1))
    }

    /// The database's own title with its emoji, when the tree knows it (never the body's label).
    private var title: String? {
        guard case .page(let title, let icon)? = controller.wiki?.linkState(pageId) else { return nil }
        let mark = icon.flatMap { $0.isEmpty || $0.hasPrefix(":") ? nil : $0 }
        return (mark.map { $0 + " " } ?? "") + title
    }

    private func open(_ id: String) {
        if let onOpenPage { onOpenPage(id) } else { controller.pageLink = PageLinkTarget(id: id) }
    }

    private func header(viewName: String?, note: String? = nil) -> some View {
        HStack(alignment: .center, spacing: 8) {
            Image(systemName: "tablecells").foregroundStyle(.secondary).accessibilityLabel(Text("データベース"))
            VStack(alignment: .leading, spacing: 1) {
                if let title { Text(verbatim: title).font(.subheadline.bold()).lineLimit(1).accessibilityAddTraits(.isHeader) }
                if let viewName, !viewName.isEmpty { Text(verbatim: viewName).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                if let note { Text(verbatim: note).font(.caption).foregroundStyle(.secondary) }
            }
            Spacer(minLength: 8)
            Button("開く") { open(pageId) }
                .buttonStyle(.bordered)
                .controlSize(.small)
        }
    }

    private func card(viewName: String, rows: [RowLine]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            header(viewName: viewName)
            if rows.isEmpty {
                Text("行がありません").font(.footnote).foregroundStyle(.secondary).padding(.vertical, 4)
            }
            ForEach(rows) { row in
                Button { open(row.id) } label: {
                    HStack(spacing: 8) {
                        Text(verbatim: row.title).font(.subheadline.weight(.medium)).lineLimit(1)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        if let detail = row.detail {
                            Text(verbatim: detail).font(.caption).foregroundStyle(.secondary).lineLimit(1).frame(maxWidth: 140, alignment: .trailing)
                        }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Color.secondary.opacity(0.10), in: RoundedRectangle(cornerRadius: 6))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.secondary.opacity(0.35), lineWidth: 1))
        .accessibilityElement(children: .contain)
    }

    private func names(_ id: String) -> String {
        let store = controller.store
        return store.users[id]?.displayName ?? (store.me?.id == id ? store.me?.displayName : nil) ?? tr("メンバー")
    }

    /// The tree's title, the schema (for the view and its card property), then the view's first rows.
    private func load() async {
        await controller.wiki?.resolve([pageId])
        guard let api = controller.api else {
            if phase == .loading { phase = .offline }
            return
        }
        do {
            let database = try await api.wikiDatabase(id: pageId)
            let view = database.view(viewId) ?? database.views.first
            let out = try await api.queryRows(databaseId: pageId, DbQuery(viewId: view?.id, limit: Self.rowLimit))
            let properties = WikiDb.cardProperties(database, view: view)
            let refs = Dictionary(out.refs.map { ($0.id, $0) }, uniquingKeysWith: { _, b in b })
            let rows = out.rows.prefix(Self.rowLimit).map { row in
                let icon = row.icon.flatMap { $0.isEmpty || $0.hasPrefix(":") ? nil : $0 }
                let detail = WikiDb.card(row, properties: properties, refs: refs, names: names, locale: UILanguage.shared.locale).first?.text
                return RowLine(id: row.id, title: (icon.map { $0 + " " } ?? "") + row.displayTitle, detail: detail)
            }
            phase = .shown(viewName: view?.displayName ?? "", rows: rows)
        } catch is CancellationError {
            return
        } catch {
            phase = Self.failed(error, was: phase)
        }
    }
}

/// An image of the canvas (`![alt](attachment:<uuid>)`): its thumbnail, else the file itself (images only, §4.10), with
/// authentication; 「表示できない画像」 when neither loads (another canvas's file, or one I may not see).
struct CanvasImageView: View {
    let attachmentId: String
    let alt: String
    @Bindable var controller: AppController
    @State private var loader = AttachmentImageLoader()
    @State private var attempt = 0

    var body: some View {
        Group {
            if let image = loader.image {
                Image(uiImage: image).resizable().scaledToFit()
                    .frame(maxWidth: .infinity, maxHeight: 320, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .accessibilityLabel(alt.isEmpty ? tr("画像") : alt)
            } else if loader.failed {
                Button { attempt += 1 } label: {
                    Label(alt.isEmpty ? "表示できない画像" : "表示できない画像：\(alt)", systemImage: "photo")
                        .font(.footnote).foregroundStyle(.secondary)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4])).foregroundStyle(.secondary))
                }
                .buttonStyle(.plain)
            } else {
                ZStack {
                    Color.secondary.opacity(0.12)
                    ProgressView()
                }
                .frame(width: 200, height: 140)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
        .task(id: "\(attachmentId):\(attempt)") {
            await loader.load {
                guard let api = controller.api else { throw URLError(.notConnectedToInternet) }
                do {
                    return try await api.fetchData("/api/v1/attachments/\(attachmentId)/thumbnail")
                } catch ApiError.api(_, let code, _) where code == "thumbnail_not_found" {
                    // A small image the server made no thumbnail of: the file itself (an image is checked by UIImage).
                    return try await api.fetchData("/api/v1/attachments/\(attachmentId)/content?inline=1")
                }
            }
        }
    }
}
