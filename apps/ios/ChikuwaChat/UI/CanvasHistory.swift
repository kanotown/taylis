import SwiftUI

/// M58 (CANVAS.md §4.9, the desktop's M44 `ui/CanvasHistory.tsx`): a canvas's history on the phone. The versions newest
/// first (who, when, lines added / removed, the name given to one, 「現在の版」); a version opens on its comparison with
/// the version before it, with the current one, or as it was. Who may change the body may make a version the current one
/// again (a new version: nothing is lost) and name it (「提出版」). Everyone who reads the canvas reads its history.
/// M74: owners and administrators (in a DM the canvas's creator) may erase an older version's body (a secret pasted by
/// mistake; not undoable, audited by the server).
@MainActor
@Observable
final class CanvasHistoryModel {
    let canvasId: String
    private(set) var rows: [CanvasRevisionMeta]?
    private(set) var next: String?
    private(set) var failed = false
    /// Version bodies read so far (the comparisons ask for two at a time).
    private(set) var bodies: [String: String] = [:]
    @ObservationIgnored private var asking: Set<String> = []

    init(canvasId: String) { self.canvasId = canvasId }

    /// Known up front (snapshot tests).
    init(canvasId: String, rows: [CanvasRevisionMeta], bodies: [String: String]) {
        self.canvasId = canvasId
        self.rows = rows
        self.bodies = bodies
    }

    func load(_ controller: AppController, more: Bool) async {
        guard let api = controller.api else { return }
        do {
            let page = try await api.canvasRevisions(id: canvasId, cursor: more ? next : nil)
            rows = (more ? rows ?? [] : []) + page.items
            next = page.nextCursor
            failed = false
        } catch {
            failed = rows == nil
            controller.error = controller.describe(error)
        }
    }

    func revision(_ id: String) -> CanvasRevisionMeta? { rows?.first { $0.id == id } }

    /// 「前の版」: the next older one listed; its parent for the oldest loaded one; none for the first version.
    func previousId(of id: String) -> String? {
        guard let rows, let index = rows.firstIndex(where: { $0.id == id }) else { return nil }
        if index + 1 < rows.count { return rows[index + 1].id }
        return rows[index].kind == "create" ? nil : rows[index].parentRevId
    }

    func body(_ id: String, _ controller: AppController) async {
        guard bodies[id] == nil, !asking.contains(id), let api = controller.api else { return }
        asking.insert(id)
        defer { asking.remove(id) }
        do { bodies[id] = try await api.canvasRevision(id: canvasId, revisionId: id).body } catch {
            controller.error = controller.describe(error)
        }
    }

    /// M74: a version whose body was erased, as the server answered it: the row says so and its body is not kept.
    func erased(_ meta: CanvasRevisionMeta) {
        replace(meta)
        bodies[meta.id] = nil
    }

    /// M74 (§4.7, the desktop's CanvasHistory): 「本文を消去」 on a version — for who may erase, never on the current
    /// version (the server refuses it: canvas_revision_is_head) nor on one already erased.
    static func offersErase(_ revision: CanvasRevisionMeta, headId: String?, rights: CanvasRights) -> Bool {
        rights.erase && revision.kind != "erased" && revision.id != headId
    }

    /// A version's new name, as the server answered it.
    func replace(_ meta: CanvasRevisionMeta) {
        rows = rows?.map { $0.id == meta.id ? meta : $0 }
    }

    static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "create": tr("作成")
        case "merge": tr("同時編集をまとめた版")
        case "side": tr("送信した版")
        case "restore": tr("復元")
        case "erased": tr("本文を消去")
        case "task": tr("タスクと連動") // M83: the server's marker or tick for a linked task (CANVAS.md §22)
        default: tr("編集")
        }
    }
}

extension CanvasSaver {
    /// The canvas's metadata as shown: the conversation's list (kept current by events) unless the loop has a newer one.
    func meta(in store: Store) -> CanvasMeta? {
        let listed = store.canvasMeta(id)
        if let listed, canvas.map({ listed.version >= $0.version }) ?? true { return listed }
        return canvas?.meta ?? listed
    }
}

/// The history sheet: the versions, each opening its comparison (a two-screen flow, as the desktop's narrow width).
struct CanvasHistorySheet: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    let saver: CanvasSaver?
    @State private var model: CanvasHistoryModel
    @State private var path: [String] = []
    @Environment(\.dismiss) private var dismiss

    init(controller: AppController, channel: ChannelState, saver: CanvasSaver?, model: CanvasHistoryModel, open: String? = nil) {
        self.controller = controller
        self.channel = channel
        self.saver = saver
        _model = State(initialValue: model)
        _path = State(initialValue: open.map { [$0] } ?? []) // the version opened first (snapshot tests)
    }

    private var meta: CanvasMeta? { saver?.meta(in: controller.store) ?? controller.store.canvasMeta(model.canvasId) }

    var body: some View {
        let headId = meta?.headRevId
        NavigationStack(path: $path) {
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
                CanvasRevisionDetail(controller: controller, model: model, revisionId: id, headId: headId,
                                     rights: meta.map { CanvasRights.of(channel, actor: controller.canvasActor, meta: $0) } ?? .none)
            }
            .safeAreaInset(edge: .bottom) {
                Text("版を選ぶと、前の版や現在の版との違いを見られます。").font(.footnote).foregroundStyle(.secondary).padding(8)
            }
            // Read again when the canvas gets a new version (a restore here, someone's save meanwhile).
            .task(id: headId) { await model.load(controller, more: false) }
        }
    }
}

/// One version in the list: who, 「現在の版」, when and what kind, +n −m, its name.
struct CanvasRevisionRow: View {
    @Bindable var controller: AppController
    let revision: CanvasRevisionMeta
    let head: Bool

    var body: some View {
        let author = controller.store.users[revision.authorId]?.displayName
            ?? (controller.store.me?.id == revision.authorId ? controller.store.me?.displayName : nil) ?? tr("メンバー")
        HStack(alignment: .top, spacing: 10) {
            AvatarView(id: revision.authorId, name: author, size: 28)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(author).fontWeight(.medium).lineLimit(1)
                    if head { CanvasBadge(text: tr("現在の版"), tint: .accentColor) }
                }
                Text("\(Timeline.fullLabel(revision.createdAt)) · \(CanvasHistoryModel.kindLabel(revision.kind))")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if (revision.kind != "erased" && (revision.linesAdded > 0 || revision.linesRemoved > 0)) || revision.label?.isEmpty == false {
                    HStack(spacing: 8) {
                        if revision.kind != "erased" && (revision.linesAdded > 0 || revision.linesRemoved > 0) {
                            HStack(spacing: 4) {
                                Text("+\(revision.linesAdded)").foregroundStyle(.green)
                                Text("−\(revision.linesRemoved)").foregroundStyle(.red)
                            }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("\(revision.linesAdded) 行追加、\(revision.linesRemoved) 行削除")
                        }
                        if let label = revision.label, !label.isEmpty {
                            Label(label, systemImage: "tag").labelStyle(.titleAndIcon)
                                .font(.caption2.weight(.semibold))
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Color.orange.opacity(0.2), in: Capsule())
                        }
                    }
                    .font(.caption.monospacedDigit())
                }
            }
        }
        .padding(.vertical, 2)
    }
}

struct CanvasBadge: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text).font(.caption2.weight(.semibold)).foregroundStyle(tint)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(tint.opacity(0.14), in: Capsule())
            .fixedSize()
    }
}

/// One version: compared with the one before it (the default), with the current one, or shown as it was; 名前を付ける
/// and この版に戻す for who may change the body.
struct CanvasRevisionDetail: View {
    enum Mode: String, CaseIterable, Identifiable {
        case previous, current, body
        var id: String { rawValue }
        var label: String {
            switch self {
            case .previous: tr("前の版と比較")
            case .current: tr("現在の版と比較")
            case .body: tr("この版の本文")
            }
        }
    }

    @Bindable var controller: AppController
    let model: CanvasHistoryModel
    let revisionId: String
    let headId: String?
    let rights: CanvasRights
    @State private var mode: Mode
    @State private var diff: [CanvasDiff.Row]?
    @State private var confirmRestore = false
    @State private var confirmErase = false
    @State private var labelling = false
    @State private var labelText = ""
    @State private var busy = false
    @Environment(\.dismiss) private var dismiss

    init(controller: AppController, model: CanvasHistoryModel, revisionId: String, headId: String?, rights: CanvasRights, mode: Mode = .previous) {
        self.controller = controller
        self.model = model
        self.revisionId = revisionId
        self.headId = headId
        self.rights = rights
        _mode = State(initialValue: mode)
    }

    private var revision: CanvasRevisionMeta? { model.revision(revisionId) }
    private var otherId: String? {
        switch mode {
        case .previous: model.previousId(of: revisionId)
        case .current: headId
        case .body: nil
        }
    }

    var body: some View {
        let revision = revision
        let erased = revision?.kind == "erased"
        let isHead = revisionId == headId
        VStack(spacing: 0) {
            Picker("表示", selection: $mode) {
                ForEach(Mode.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.vertical, 8)
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if let revision { header(revision, head: isHead) }
                    content(erased: erased, isHead: isHead)
                }
                .padding(16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .navigationTitle(revision.map { CanvasHistoryModel.kindLabel($0.kind) } ?? tr("版"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let revision, CanvasHistoryModel.offersErase(revision, headId: headId, rights: rights) {
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button("本文を消去", systemImage: "eraser", role: .destructive) { confirmErase = true }
                    } label: {
                        Image(systemName: "ellipsis.circle")
                    }
                    .disabled(busy)
                    .accessibilityLabel("この版の操作")
                }
            }
            if let revision, !erased, rights.edit {
                ToolbarItemGroup(placement: .bottomBar) {
                    Button {
                        labelText = revision.label ?? ""
                        labelling = true
                    } label: {
                        Text(revision.label == nil ? "名前を付ける" : "名前を変更") // words: the bar shows a Label as its icon alone
                    }
                    Spacer()
                    if !isHead {
                        Button { confirmRestore = true } label: {
                            Text("この版に戻す")
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(busy)
                    }
                }
            }
        }
        .task(id: "\(mode.rawValue)|\(otherId ?? "")") {
            guard !erased else { return }
            await model.body(revisionId, controller)
            if let otherId { await model.body(otherId, controller) }
        }
        .task(id: diffKey) { await makeDiff() }
        .confirmationDialog("この版の本文を消去しますか？", isPresented: $confirmErase, titleVisibility: .visible) {
            Button("消去する", role: .destructive) { Task { await erase() } }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("誤って書いた秘密などを履歴から消します。消した本文は戻せません。消去したことは監査ログに残ります。")
        }
        .confirmationDialog("この版に戻しますか？", isPresented: $confirmRestore, titleVisibility: .visible) {
            Button("この版に戻す") { Task { await restore() } }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("\(revision.map { Timeline.fullLabel($0.createdAt) } ?? "") の版の本文を、新しい版として保存します。今の本文も履歴に残ります。")
        }
        .alert("版に名前を付ける", isPresented: $labelling) {
            TextField("提出版", text: $labelText)
            Button("保存") { Task { await saveLabel(labelText) } }
                .disabled(labelText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if revision?.label != nil {
                Button("名前を外す", role: .destructive) { Task { await saveLabel(nil) } }
            }
            Button("キャンセル", role: .cancel) {}
        } message: {
            Text("「提出版」「ゼミ発表前」のように名前を付けた版は、古くなっても整理されずに残ります。")
        }
    }

    private func header(_ revision: CanvasRevisionMeta, head: Bool) -> some View {
        let author = controller.store.users[revision.authorId]?.displayName
            ?? (controller.store.me?.id == revision.authorId ? controller.store.me?.displayName : nil) ?? tr("メンバー")
        return VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(revision.title).font(.headline).lineLimit(2)
                if head { CanvasBadge(text: tr("現在の版"), tint: .accentColor) }
                if let label = revision.label, !label.isEmpty {
                    Label(label, systemImage: "tag").font(.caption2.weight(.semibold))
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Color.orange.opacity(0.2), in: Capsule())
                        .fixedSize()
                }
            }
            Text("\(author) · \(Timeline.fullLabel(revision.createdAt)) · \(CanvasHistoryModel.kindLabel(revision.kind))")
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func content(erased: Bool, isHead: Bool) -> some View {
        if erased {
            note(tr("この版の本文は消去されています。"))
        } else if mode == .current && isHead {
            note(tr("これが現在の版です。"))
        } else if mode == .body {
            if let text = model.bodies[revisionId] {
                CanvasBodyView(body: text, controller: controller, onToggleTask: nil)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        } else if let diff {
            CanvasDiffView(rows: diff)
        } else if let otherId, model.revision(otherId)?.kind == "erased" {
            note(tr("比べる版の本文は消去されています。"))
        } else {
            ProgressView().frame(maxWidth: .infinity)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.subheadline).foregroundStyle(.secondary)
    }

    /// What the comparison is made of: both bodies, once read (the first version compares with nothing: all added).
    private var diffKey: String {
        guard mode != .body, revision?.kind != "erased", let mine = model.bodies[revisionId] else { return "" }
        let other: String? = otherId.flatMap { model.bodies[$0] } ?? (mode == .previous && otherId == nil ? "" : nil)
        guard let other else { return "" }
        return "\(mode.rawValue)|\(otherId ?? "-")|\(mine.count)|\(other.count)"
    }

    private func makeDiff() async {
        guard !diffKey.isEmpty, let mine = model.bodies[revisionId] else {
            diff = nil
            return
        }
        let other = otherId.flatMap { model.bodies[$0] } ?? ""
        let names = { (text: String) in Mentions.toNames(CanvasMarkers.strip(text), users: controller.store.users, groups: controller.store.groups) }
        // Previous → this version; this version → the current one.
        let (from, to) = mode == .previous ? (names(other), names(mine)) : (names(mine), names(other))
        diff = await Task.detached(priority: .userInitiated) { CanvasDiff.rows(CanvasDiff.lines(from, to)) }.value
    }

    private func restore() async {
        busy = true
        let restored = await controller.restoreCanvasRevision(model.canvasId, revisionId: revisionId)
        busy = false
        guard restored != nil else { return }
        controller.notice = tr("この版を復元しました")
        dismiss() // back to the list, read again with the new current version on top
    }

    private func erase() async {
        busy = true
        let erased = await controller.eraseCanvasRevision(model.canvasId, revisionId: revisionId)
        busy = false
        guard let erased else { return }
        model.erased(erased)
        diff = nil
        controller.notice = tr("この版の本文を消去しました")
    }

    private func saveLabel(_ label: String?) async {
        busy = true
        let named = await controller.labelCanvasRevision(model.canvasId, revisionId: revisionId, label: label)
        busy = false
        if let named { model.replace(named) }
    }
}

/// The comparison: removed lines red, added green, the changed words of a touched-up line marked; kept stretches folded.
struct CanvasDiffView: View {
    let rows: [CanvasDiff.Row]

    var body: some View {
        let counts = CanvasDiff.counts(rows)
        if counts.added == 0 && counts.removed == 0 {
            Text("違いはありません。").font(.subheadline).foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 4) {
                    Text("+\(counts.added) 行").foregroundStyle(.green)
                    Text("·").foregroundStyle(.secondary)
                    Text("−\(counts.removed) 行").foregroundStyle(.red)
                }
                .font(.caption.monospacedDigit())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(counts.added) 行追加、\(counts.removed) 行削除")
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in rowView(row) }
                }
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator)))
            }
        }
    }

    @ViewBuilder
    private func rowView(_ row: CanvasDiff.Row) -> some View {
        switch row {
        case .skip(let count):
            Text("… \(count) 行 …")
                .font(.caption2).foregroundStyle(.secondary)
                .padding(.horizontal, 10).padding(.vertical, 2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground))
        case .line(let line):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(line.kind == .add ? "+" : line.kind == .del ? "−" : " ")
                    .foregroundStyle(line.kind == .add ? Color.green : line.kind == .del ? Color.red : Color.secondary)
                    .frame(width: 10)
                    .accessibilityHidden(true)
                Text(Self.text(line))
                    .foregroundStyle(line.kind == .del && line.words == nil ? Color.secondary : Color.primary)
                    .strikethrough(line.kind == .del && line.words == nil, color: .red.opacity(0.5))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .font(.callout)
            .padding(.horizontal, 8)
            .padding(.vertical, 1)
            .background(line.kind == .add ? Color.green.opacity(0.12) : line.kind == .del ? Color.red.opacity(0.10) : Color.clear)
            .accessibilityElement(children: .combine)
            .accessibilityLabel((line.kind == .add ? tr("追加：") : line.kind == .del ? tr("削除：") : "") + (line.text.isEmpty ? tr("空行") : line.text))
        }
    }

    /// A line's text; a touched-up line's changed words marked (struck through on the removed side).
    static func text(_ line: CanvasDiff.Line) -> AttributedString {
        guard let words = line.words else { return AttributedString(line.text.isEmpty ? " " : line.text) }
        var out = AttributedString()
        for piece in words {
            var part = AttributedString(piece.text)
            if piece.changed {
                part.backgroundColor = line.kind == .add ? Color.green.opacity(0.35) : Color.red.opacity(0.3)
                if line.kind == .del { part.strikethroughStyle = .single }
            }
            out += part
        }
        return out
    }
}
