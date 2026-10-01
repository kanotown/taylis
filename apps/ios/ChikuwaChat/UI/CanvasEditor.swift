import SwiftUI
import UIKit

/// M45: the canvas's Markdown editor (CANVAS.md §5 「編集」): a text view with a small toolbar (heading, list, checklist,
/// bold, link, mention, rule) and `@` completion, for the whole body or one heading's section. Mentions show as
/// `@username` and are stored as `<@uuid>` (§4.2). Every change goes to the save loop (CanvasSaver); a body the loop
/// replaces (someone else's merged edits) comes back here with the caret kept — never under an IME composition.
struct CanvasEditor: View {
    @Bindable var controller: AppController
    let saver: CanvasSaver
    /// nil: the whole body; else the heading line of the section being edited.
    var sectionLine: Int? = nil
    var autoFocus = false
    @State private var model = CanvasEditorModel()

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                CanvasTextView(model: model, autoFocus: autoFocus)
                if model.shown.isEmpty {
                    Text(sectionLine == nil ? "# 見出し\n本文を書きます。\n- [ ] チェックリスト\n@名前 でメンション" : "## 見出し\n本文を書きます。")
                        .foregroundStyle(.tertiary)
                        .padding(.horizontal, CanvasTextView.inset.left + 5)
                        .padding(.top, CanvasTextView.inset.top)
                        .allowsHitTesting(false)
                }
            }
            if !model.candidates.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        ForEach(model.candidates) { candidate in
                            Button { model.pick(candidate) } label: {
                                HStack(spacing: 4) {
                                    Text("@" + candidate.username).fontWeight(.semibold)
                                    Text(candidate.label).foregroundStyle(.secondary).lineLimit(1)
                                }
                                .font(.subheadline)
                                .padding(.horizontal, 10)
                                .frame(minHeight: 36)
                                .background(Color.secondary.opacity(0.12), in: Capsule())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                }
                .accessibilityLabel("メンションの候補")
            }
            Divider()
            toolbar
        }
        .onAppear { model.attach(saver: saver, store: controller.store, sectionLine: sectionLine) }
        .onDisappear { model.detach() }
        .onChange(of: saver.textRevision) { _, _ in model.external() }
        .fullScreenCover(item: $model.table) { target in
            CanvasTableEditor(target: target, onDone: { model.finishTable($0) }, onCancel: { model.cancelTable() })
        }
    }

    private var toolbar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                Menu {
                    Button("見出し 1") { model.apply { CanvasText.setHeading($0, level: 1) } }
                    Button("見出し 2") { model.apply { CanvasText.setHeading($0, level: 2) } }
                    Button("見出し 3") { model.apply { CanvasText.setHeading($0, level: 3) } }
                } label: { toolIcon("textformat.size") }
                .accessibilityLabel("見出し")
                tool("list.bullet", "箇条書き") { CanvasText.toggleLinePrefix($0, marker: "- ") }
                tool("checklist", "チェックリスト") { CanvasText.toggleTasks($0) }
                tool("bold", "太字") { CanvasText.toggleWrap($0, "**") }
                tool("link", "リンク") { CanvasText.insertLink($0) }
                tool("at", "メンション") { CanvasText.insertMentionMark($0) }
                tool("minus", "区切り線") { CanvasText.insertRule($0) }
                Button { model.openTable() } label: { toolIcon("tablecells") }
                    .accessibilityLabel("表")
                Spacer(minLength: 8)
                Button { KeyboardBehavior.dismiss() } label: { toolIcon("keyboard.chevron.compact.down") }
                    .accessibilityLabel("キーボードを閉じる")
            }
            .padding(.horizontal, 6)
        }
        .frame(height: 44)
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("書式")
    }

    private func tool(_ icon: String, _ label: String, _ transform: @escaping (CanvasText.EditState) -> CanvasText.EditState?) -> some View {
        Button { model.apply(transform) } label: { toolIcon(icon) }
            .accessibilityLabel(label)
    }

    private func toolIcon(_ name: String) -> some View {
        Image(systemName: name)
            .font(.body)
            .frame(width: 40, height: 40)
            .contentShape(Rectangle())
    }
}

/// The editor's state between the text view and the save loop: the shown text (`@name`), the stored text it stands
/// for, the section (a range of the stored body) when only one is edited, and the mention being typed.
@MainActor
@Observable
final class CanvasEditorModel {
    /// What the text view shows.
    private(set) var shown = ""
    private(set) var candidates: [Mentions.Candidate] = []
    /// M57: the table open in the table editor (CANVAS.md §17).
    var table: CanvasTable.Target?
    @ObservationIgnored weak var textView: UITextView?
    @ObservationIgnored private var saver: CanvasSaver?
    @ObservationIgnored private var store: Store?
    /// The stored body the shown text stands for: a change of the loop's text that is not this one is taken in.
    @ObservationIgnored private var wire = ""
    /// The section being edited, in `wire` (nil: the whole body).
    @ObservationIgnored private(set) var section: NSRange?

    func attach(saver: CanvasSaver, store: Store, sectionLine: Int?) {
        self.saver = saver
        self.store = store
        wire = saver.text
        if let sectionLine { section = CanvasText.section(wire, headingLine: sectionLine) ?? NSRange(location: 0, length: 0) }
        shown = decode(section.map { CanvasText.slice(wire, $0) } ?? wire)
        textView?.text = shown
        // An IME composition must not have its text replaced under it: the loop keeps a merged body for later meanwhile.
        saver.canReplace = { [weak self] in self?.textView?.markedTextRange == nil }
    }

    func detach() {
        saver?.canReplace = { true }
        if let saver { Task { await saver.flush() } }
    }

    private func decode(_ stored: String) -> String {
        guard let store else { return stored }
        return Mentions.decode(stored, users: store.users, groups: store.groups)
    }

    private func encode(_ text: String) -> String {
        guard let store else { return text }
        return Mentions.encode(text, users: store.users.values, groups: Array(store.groups.values))
    }

    /// The reader typed (or the toolbar changed the text): the stored body goes to the save loop.
    func userChanged(_ text: String) {
        shown = text
        let stored = encode(text)
        if let range = section {
            wire = CanvasText.replacing(wire, range, with: stored)
            section = NSRange(location: range.location, length: (stored as NSString).length)
        } else {
            wire = stored
        }
        saver?.edit(wire)
        updateCandidates()
    }

    /// The loop replaced the body (a merge, someone else's version): shown with the caret kept.
    func external() {
        guard let saver, saver.text != wire else { return }
        if let tv = textView, tv.markedTextRange != nil { return } // the loop does not replace under a composition
        let before = shown
        if let range = section {
            section = CanvasText.relocateSection(wire, saver.text, range)
        }
        wire = saver.text
        let next = decode(section.map { CanvasText.slice(wire, $0) } ?? wire)
        guard next != before else { return }
        shown = next
        guard let tv = textView else { return }
        let selected = tv.selectedRange
        let start = CanvasText.preserveCaret(before, next, selected.location)
        let end = CanvasText.preserveCaret(before, next, selected.location + selected.length)
        tv.text = next
        tv.selectedRange = NSRange(location: start, length: max(0, end - start))
    }

    /// A toolbar edit on the current selection.
    func apply(_ transform: (CanvasText.EditState) -> CanvasText.EditState?) {
        guard let tv = textView, tv.markedTextRange == nil else { return }
        let selected = tv.selectedRange
        guard let next = transform(CanvasText.EditState(text: tv.text, start: selected.location, end: selected.location + selected.length)) else { return }
        tv.text = next.text
        tv.selectedRange = NSRange(location: next.start, length: max(0, next.end - next.start))
        if !tv.isFirstResponder { tv.becomeFirstResponder() }
        userChanged(next.text)
    }

    // MARK: the table editor (M57, CANVAS.md §17)

    /// 「表」: the table holding the caret's line, else a new 3 × 2 table to go after it (written only at 完了).
    func openTable() {
        if let tv = textView, tv.markedTextRange != nil { return }
        external() // what the loop has merged meanwhile
        let text = textView?.text ?? shown
        let caret = textView?.selectedRange.location ?? (text as NSString).length
        KeyboardBehavior.dismiss()
        table = CanvasTable.open(text, caretLine: CanvasTable.line(of: caret, in: text))
    }

    /// 完了: the edited table into the text as it is now (see `CanvasTable.writeBack`), as one edit through the same path
    /// as typing, so the save loop, its merge and undo take it.
    @discardableResult
    func finishTable(_ edited: CanvasTable.Table) -> CanvasTable.WriteBack? {
        guard let target = table else { return nil }
        table = nil
        external()
        let current = textView?.text ?? shown
        guard let out = CanvasTable.writeBack(target, table: edited, into: current) else { return nil }
        let range: ClosedRange<Int>
        switch out.result {
        case .replaced(let r), .inserted(let r): range = r
        }
        replaceText(with: out.text, caret: CanvasTable.offset(ofLine: range.lowerBound, in: out.text))
        return out.result
    }

    /// キャンセル: nothing changes (a new table was never put in).
    func cancelTable() { table = nil }

    /// The text replaced by `next`, through the text view's input (one undo step) when there is one.
    private func replaceText(with next: String, caret: Int) {
        guard let tv = textView else {
            userChanged(next)
            return
        }
        let before = (tv.text ?? "") as NSString
        let after = next as NSString
        let common = min(before.length, after.length)
        var prefix = 0
        while prefix < common && before.character(at: prefix) == after.character(at: prefix) { prefix += 1 }
        var suffix = 0
        while suffix < common - prefix && before.character(at: before.length - 1 - suffix) == after.character(at: after.length - 1 - suffix) { suffix += 1 }
        let replacement = after.substring(with: NSRange(location: prefix, length: after.length - prefix - suffix))
        if let start = tv.position(from: tv.beginningOfDocument, offset: prefix),
           let end = tv.position(from: tv.beginningOfDocument, offset: before.length - suffix),
           let range = tv.textRange(from: start, to: end) {
            tv.replace(range, withText: replacement)
        }
        if tv.text != next { tv.text = next }
        tv.selectedRange = NSRange(location: min(caret, after.length), length: 0)
        if shown != next { userChanged(next) } // the replace above may already have told the delegate
    }

    /// Return inside a task, list or quote goes on with the next item (the composer's rule, §5).
    func returnPressed(in tv: UITextView, range: NSRange) -> Bool {
        guard tv.markedTextRange == nil, range.length == 0,
              let next = CanvasText.continueStructure(CanvasText.EditState(text: tv.text, start: range.location, end: range.location)) else { return false }
        tv.text = next.text
        tv.selectedRange = NSRange(location: next.start, length: 0)
        userChanged(next.text)
        return true
    }

    func selectionChanged() { updateCandidates() }

    /// `@prefix` before the caret: the people and groups it may name (not @channel: a canvas notifies nobody).
    private func updateCandidates() {
        guard let tv = textView, let store, tv.selectedRange.length == 0 else {
            if !candidates.isEmpty { candidates = [] }
            return
        }
        let before = (tv.text as NSString).substring(to: min(tv.selectedRange.location, (tv.text as NSString).length))
        guard let query = Mentions.query(before) else {
            if !candidates.isEmpty { candidates = [] }
            return
        }
        let found = Mentions.candidates(query, users: store.users.values, groups: Array(store.groups.values), limit: 8).filter { $0.kind != "all" }
        if found != candidates { candidates = found }
    }

    func pick(_ candidate: Mentions.Candidate) {
        guard let tv = textView else { return }
        let ns = tv.text as NSString
        let caret = min(tv.selectedRange.location, ns.length)
        let completed = Mentions.complete(ns.substring(to: caret), username: candidate.username)
        let text = completed + ns.substring(from: caret)
        tv.text = text
        tv.selectedRange = NSRange(location: (completed as NSString).length, length: 0)
        userChanged(text)
    }
}

/// UITextView under SwiftUI: the selection, the IME's marked text and Return are needed here (a TextEditor shows none).
struct CanvasTextView: UIViewRepresentable {
    let model: CanvasEditorModel
    var autoFocus = false
    static let inset = UIEdgeInsets(top: 12, left: 12, bottom: 24, right: 12)

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.delegate = context.coordinator
        view.font = .preferredFont(forTextStyle: .body)
        view.adjustsFontForContentSizeCategory = true
        view.textColor = .label
        view.backgroundColor = .systemBackground
        view.textContainerInset = Self.inset
        view.alwaysBounceVertical = true
        view.keyboardDismissMode = .interactive
        // Markdown as typed: 「---」 must not become a dash, nor quotes curl.
        view.smartDashesType = .no
        view.smartQuotesType = .no
        view.smartInsertDeleteType = .no
        view.accessibilityLabel = "キャンバスの本文 (Markdown)"
        view.accessibilityIdentifier = "canvas-editor"
        view.text = model.shown
        model.textView = view
        if autoFocus { DispatchQueue.main.async { view.becomeFirstResponder() } }
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if model.textView !== view { model.textView = view }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        let model: CanvasEditorModel
        init(model: CanvasEditorModel) { self.model = model }

        func textViewDidChange(_ textView: UITextView) {
            MainActor.assumeIsolated { model.userChanged(textView.text) }
        }

        func textViewDidChangeSelection(_ textView: UITextView) {
            MainActor.assumeIsolated { model.selectionChanged() }
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            guard text == "\n" else { return true }
            return MainActor.assumeIsolated { !model.returnPressed(in: textView, range: range) }
        }
    }
}
