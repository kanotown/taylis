import PhotosUI
import SwiftUI
import UIKit
import UniformTypeIdentifiers

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
    /// M122 (docs/WIKI.md §7.1): a wiki page's body — the same editor and save loop, without the canvas's 「編集中」 frames
    /// (canvas_presence, M126 for pages) and 「タスクにする」 (a task's source is a canvas).
    var isPage = false
    /// M153a (WIKI.md §30.4): the body line to put the caret on when the editor opens (coming from the 見たまま editor).
    var initialLine: Int? = nil
    /// M153a: the body line the caret is on, whenever it moves (handed to the 見たまま editor on the switch).
    var onCaretLine: ((Int) -> Void)? = nil
    @State private var model = CanvasEditorModel()
    /// M58: 「画像」 (§4.10): the photo library or the camera; pictures are uploaded and put in at the caret.
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var uploading = 0
    /// M73: 「タスクにする」 from the edit menu of an open checklist item (CANVAS.md §18.3).
    @State private var taskForm: TaskFormTarget?
    @Environment(\.scenePhase) private var scenePhase
    private static let hasCamera = UIImagePickerController.isSourceTypeAvailable(.camera)

    var body: some View {
        VStack(spacing: 0) {
            ZStack(alignment: .topLeading) {
                CanvasTextView(model: model, autoFocus: autoFocus, initialLine: initialLine)
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
            if uploading > 0 {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("画像をアップロード中…（\(uploading)）").font(.caption).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
                .accessibilityElement(children: .combine)
            }
            Divider()
            toolbar
        }
        .onAppear {
            model.attach(saver: saver, store: controller.store, sectionLine: sectionLine)
            model.onCaretLine = onCaretLine
            if isPage { return }
            // M73 (§18.2): 「編集中」 for the others while the text view has the focus.
            let canvasId = saver.id
            model.onPresence = { [weak app = controller] editing, section in
                app?.engine?.setCanvasEditing(canvasId, editing: editing, section: section)
            }
            let channelId = saver.channelId
            model.onMakeTask = controller.serverHasTasks ? { [weak app = controller] body, line in
                guard let app, let draft = app.canvasTaskDraft(canvasId: canvasId, channelId: channelId, body: body, line: line) else { return }
                KeyboardBehavior.dismiss()
                taskForm = .new(draft)
            } : nil
        }
        .onDisappear { model.detach() }
        .onChange(of: scenePhase) { _, phase in model.sceneActive(phase == .active) }
        .task {
            // The refresh every 20 s (the sender holds back repeats until then): ticks of 5 s keep it within the 45 s.
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(5))
                model.refreshPresence()
            }
        }
        // A sheet, not a full-screen cover: a cover ends the canvas screen under it (onDisappear lets go of the canvas).
        .sheet(item: $taskForm) { target in
            TaskForm(controller: controller, hub: controller.taskHub, target: target)
        }
        .onChange(of: saver.textRevision) { _, _ in model.external() }
        .fullScreenCover(item: $model.table) { target in
            CanvasTableEditor(target: target, onDone: { model.finishTable($0) }, onCancel: { model.cancelTable() })
        }
        // M58: the picker is presented from the editor itself; a PhotosPicker inside a Menu never opens.
        .photosPicker(isPresented: $showPhotoPicker, selection: $photoItems, maxSelectionCount: 10, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            guard roomFor(items.count) else { return }
            uploading += items.count
            Task {
                for item in items {
                    // Library photos are mostly HEIC: re-encoded as JPEG as the composer does (the server keeps a thumbnail).
                    guard let data = try? await item.loadTransferable(type: Data.self), let photo = ImageUpload.prepare(data) else {
                        uploading -= 1
                        controller.error = tr("写真を読み込めませんでした")
                        continue
                    }
                    await upload(photo.data, filename: "photo." + photo.ext, contentType: photo.mime)
                }
            }
        }
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                guard let data = image.normalizedUp().jpegData(compressionQuality: 0.85), roomFor(1) else { return }
                uploading += 1
                Task { await upload(data, filename: "photo-\(Int(Date().timeIntervalSince1970)).jpg", contentType: "image/jpeg") }
            }
            .ignoresSafeArea()
        }
    }

    /// The server takes at most 100 attachments per canvas: past that nothing is sent (the desktop's rule).
    private func roomFor(_ count: Int) -> Bool {
        guard CanvasText.attachmentRefs(saver.text).count + count <= CanvasText.maxImages else {
            controller.error = ErrorMessages.byCode["too_many_canvas_images"] ?? ErrorMessages.unknown
            return false
        }
        return true
    }

    /// One picture to the server (pending), then its line at the caret; the save that carries it binds it (§4.10).
    private func upload(_ data: Data, filename: String, contentType: String) async {
        defer { uploading -= 1 }
        guard let uploaded = await controller.uploadAttachment(data: data, filename: filename, contentType: contentType) else { return }
        model.insertImage(uploaded.id)
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
                tool("list.bullet", tr("箇条書き")) { CanvasText.toggleLinePrefix($0, marker: "- ") }
                tool("checklist", tr("チェックリスト")) { CanvasText.toggleTasks($0) }
                // M149 (WIKI.md §22.7): the containers of the dialect.
                tool("lightbulb", tr("コールアウト")) { CanvasText.insertCallout($0) }
                tool("chevron.right.square", tr("トグル")) { CanvasText.insertToggle($0) }
                tool("bold", tr("太字")) { CanvasText.toggleWrap($0, "**") }
                tool("link", tr("リンク")) { CanvasText.insertLink($0) }
                tool("at", tr("メンション")) { CanvasText.insertMentionMark($0) }
                tool("minus", tr("区切り線")) { CanvasText.insertRule($0) }
                Button { model.openTable() } label: { toolIcon("tablecells") }
                    .accessibilityLabel("表")
                Menu {
                    Button("写真を選ぶ", systemImage: "photo.on.rectangle") { showPhotoPicker = true }
                    if Self.hasCamera { Button("写真を撮る", systemImage: "camera") { showCamera = true } }
                } label: { toolIcon("photo") }
                .accessibilityLabel("画像")
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

/// The editor's state between the text view and the save loop: the shown text (`@name`, task markers as invisible
/// stand-ins), the stored text it stands for, the section (a range of the stored body) when only one is edited, and the
/// mention being typed.
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
    /// M73 (CANVAS.md §18.2): tells the others I edit (true, with the caret's heading) or stopped (false).
    @ObservationIgnored var onPresence: ((Bool, String?) -> Void)?
    /// M73 (§18.3): 「タスクにする」 on an open checklist item: the stored body and the item's line in it.
    @ObservationIgnored var onMakeTask: ((String, Int) -> Void)?
    /// M153a: the body line the caret is on, as it moves (the whole-body editor; a section's lines start at its heading).
    @ObservationIgnored var onCaretLine: ((Int) -> Void)?
    /// The text view has the focus (and the app is in front).
    @ObservationIgnored private(set) var focused = false
    @ObservationIgnored private var inFront = true
    @ObservationIgnored private var lastAnnounced: Date?
    /// M83 (CANVAS.md §22.8): the task markers shown as stand-ins, which go back to the end of their line when stored.
    @ObservationIgnored let markers = CanvasMarkers.Table()
    /// Set while the editor makes its own deletion beside a stand-in (the text view may ask the delegate again).
    @ObservationIgnored private var replacing = false

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
        focused = false
        announce(false)
        saver?.canReplace = { true }
        if let saver { Task { await saver.flush() } }
    }

    private func decode(_ stored: String) -> String {
        let hidden = markers.hide(stored)
        guard let store else { return hidden }
        return Mentions.decode(hidden, users: store.users, groups: store.groups)
    }

    private func encode(_ text: String) -> String {
        let stored = markers.show(text)
        guard let store else { return stored }
        return Mentions.encode(stored, users: store.users.values, groups: Array(store.groups.values))
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
        if focused { announce(true, soon: true) }
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

    // MARK: images (M58, CANVAS.md §4.10)

    /// Whether the reader has put the caret anywhere yet (else a picture goes at the end, as the desktop's).
    @ObservationIgnored private var caretPlaced = false

    /// An uploaded picture's `![](attachment:<id>)` on a line of its own at the caret, through the same path as typing
    /// (the save loop, its merge and undo). The caret is the text view's: kept through merges while the picker was up.
    func insertImage(_ attachmentId: String) {
        external() // what the loop has merged meanwhile
        let text = textView?.text ?? shown
        let length = (text as NSString).length
        let selected = caretPlaced ? (textView?.selectedRange ?? NSRange(location: length, length: 0)) : NSRange(location: length, length: 0)
        let next = CanvasText.insertImageLine(CanvasText.EditState(text: text, start: selected.location, end: selected.location + selected.length),
                                              attachmentId: attachmentId)
        replaceText(with: next.text, caret: next.start)
        caretPlaced = true
    }

    /// The text replaced by `next`, through the text view's input (one undo step) when there is one.
    func replaceText(with next: String, caret: Int) {
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

    /// M83 (§22.8): Backspace / Delete beside a stand-in with nothing selected takes the visible character and keeps
    /// the stand-ins (UIKit would take the grapheme — the character together with its stand-ins — or the stand-in
    /// alone). True: done here, through the text view's input (undo takes it back).
    func deletePressed(in tv: UITextView, range: NSRange) -> Bool {
        guard !replacing, tv.markedTextRange == nil, range.length > 0 else { return false }
        let selected = tv.selectedRange
        guard selected.length == 0 else { return false }
        let caret = selected.location
        let backward = NSMaxRange(range) == caret
        guard backward || range.location == caret else { return false }
        let text = tv.text ?? ""
        let ns = text as NSString
        guard NSMaxRange(range) <= ns.length else { return false }
        // One character (a word deleted at once is left to the text view, its stand-ins with it).
        guard CanvasMarkers.stripStandIns(ns.substring(with: range)).count <= 1,
              let out = CanvasMarkers.deleteBeside(text, caret: caret, backward: backward) else { return false }
        if out.text == text {
            tv.selectedRange = NSRange(location: out.caret, length: 0)
            return true
        }
        replacing = true
        replaceText(with: out.text, caret: out.caret)
        replacing = false
        return true
    }

    /// The selection as stored, for a cut that keeps its markers (pasted back into a canvas editor, they return).
    func markedForm(_ shownText: String) -> String { markers.show(shownText) }

    /// A cut's stored form as this editor shows it.
    func hidden(_ wireText: String) -> String { markers.hide(wireText) }

    func selectionChanged() {
        if textView?.isFirstResponder == true { caretPlaced = true }
        updateCandidates()
        if focused { announce(true, soon: true) }
        if let onCaretLine, let tv = textView {
            let offset = section.map { CanvasText.lineIndex(wire, at: $0.location) } ?? 0
            onCaretLine(offset + CanvasText.lineIndex(tv.text, at: tv.selectedRange.location))
        }
    }

    // MARK: 「編集中」 (M73, CANVAS.md §18.2)

    /// `soon`: from typing or the caret moving — looked at every 2 s at most (the heading is found by a scan).
    func announce(_ editing: Bool, soon: Bool = false, now: Date = Date()) {
        if editing && soon, let lastAnnounced, now.timeIntervalSince(lastAnnounced) < CanvasPresence.throttle { return }
        lastAnnounced = now
        onPresence?(editing, editing ? caretSection() : nil)
    }

    /// The heading over the caret, in the text shown (a section's text starts with its heading).
    func caretSection() -> String? {
        guard let tv = textView else { return nil }
        return CanvasText.sectionAt(tv.text, caret: tv.selectedRange.location)
    }

    func focusChanged(_ on: Bool) {
        focused = on
        announce(on && inFront)
    }

    /// The app went to the background (false) or came back: editing stops and starts again with it.
    func sceneActive(_ active: Bool) {
        inFront = active
        if focused { announce(active) }
    }

    /// The 20-second refresh while editing (the sender sends nothing new before then).
    func refreshPresence() {
        if focused && inFront { announce(true) }
    }

    // MARK: 「タスクにする」 (M73, §18.3)

    /// The line of the stored body that UTF-16 offset `location` of the shown text is on, when it is an open checklist
    /// item. Mentions shown as names keep the lines; a section's lines start where it does in the body.
    func checklistLine(at location: Int) -> Int? {
        let local = CanvasText.lineIndex(shown, at: location)
        let offset = section.map { CanvasText.lineIndex(wire, at: $0.location) } ?? 0
        let line = offset + local
        guard let item = TaskRules.checklistItem(wire, line: line), !item.done else { return nil }
        return line
    }

    /// The edit menu's 「タスクにする」 for the item at the selection, or nil.
    func makeTaskAction(at location: Int) -> UIAction? {
        guard onMakeTask != nil, textView?.markedTextRange == nil, let line = checklistLine(at: location) else { return nil }
        return UIAction(title: tr("タスクにする"), image: UIImage(systemName: "checklist")) { [weak self] _ in
            guard let self else { return }
            self.onMakeTask?(self.wire, line)
        }
    }

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
        // The people and the AI bots by their `bot_kind` (AI.md §2.1; the model holds no AI status).
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
    /// M153a: the caret on this line of the shown text (and the keyboard up) when the view is made.
    var initialLine: Int? = nil
    static let inset = UIEdgeInsets(top: 12, left: 12, bottom: 24, right: 12)

    func makeCoordinator() -> Coordinator { Coordinator(model: model) }

    func makeUIView(context: Context) -> UITextView {
        let view = CanvasUITextView()
        view.model = model
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
        view.accessibilityLabel = tr("キャンバスの本文（Markdown）")
        view.accessibilityIdentifier = "canvas-editor"
        view.text = model.shown
        model.textView = view
        if let initialLine {
            // After the model is attached (onAppear sets the text, which puts the caret at the end): the line of the
            // text as shown then.
            DispatchQueue.main.async {
                let offset = CanvasTable.offset(ofLine: initialLine, in: view.text)
                view.selectedRange = NSRange(location: offset, length: 0)
                view.becomeFirstResponder()
                view.scrollRangeToVisible(NSRange(location: offset, length: 0))
            }
        } else if autoFocus {
            DispatchQueue.main.async { view.becomeFirstResponder() }
        }
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

        func textViewDidBeginEditing(_ textView: UITextView) {
            MainActor.assumeIsolated { model.focusChanged(true) }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            MainActor.assumeIsolated { model.focusChanged(false) }
        }

        /// M73: the long press's menu on an open checklist item adds 「タスクにする」.
        func textView(_ textView: UITextView, editMenuForTextIn range: NSRange, suggestedActions: [UIMenuElement]) -> UIMenu? {
            MainActor.assumeIsolated {
                guard let action = model.makeTaskAction(at: range.location) else { return nil }
                return UIMenu(children: suggestedActions + [action])
            }
        }

        func textView(_ textView: UITextView, shouldChangeTextIn range: NSRange, replacementText text: String) -> Bool {
            if text.isEmpty { return MainActor.assumeIsolated { !model.deletePressed(in: textView, range: range) } }
            guard text == "\n" else { return true }
            return MainActor.assumeIsolated { !model.returnPressed(in: textView, range: range) }
        }
    }
}

/// M83 (CANVAS.md §22.8): the editor's text view. A copy leaves the task markers' stand-ins out; a cut also keeps the
/// stored form (markers at the end of their lines) under the app's own type, so pasting it back into a canvas editor
/// brings the markers back (a line cut and pasted elsewhere keeps its task). A copy pasted gets no markers (one task's
/// line would be there twice).
final class CanvasUITextView: UITextView {
    static let pasteboardType = "jp.chikuwachat.canvas-text"
    weak var model: CanvasEditorModel?

    private var selectedShown: String? {
        guard let range = selectedTextRange, !range.isEmpty else { return nil }
        return text(in: range)
    }

    override func copy(_ sender: Any?) {
        guard let shown = selectedShown, CanvasMarkers.hasStandIns(shown) else { return super.copy(sender) }
        UIPasteboard.general.string = CanvasMarkers.stripStandIns(shown)
    }

    override func cut(_ sender: Any?) {
        guard let shown = selectedShown, CanvasMarkers.hasStandIns(shown), let model, let range = selectedTextRange else { return super.cut(sender) }
        let stored = model.markedForm(shown)
        UIPasteboard.general.setItems([[UTType.utf8PlainText.identifier: CanvasMarkers.stripStandIns(shown), Self.pasteboardType: Data(stored.utf8)]])
        replace(range, withText: "") // through the input: undo takes it back, the delegate hears of it
        if model.shown != text { model.userChanged(text) }
    }

    override func paste(_ sender: Any?) {
        let board = UIPasteboard.general
        guard let model, let range = selectedTextRange, board.contains(pasteboardTypes: [Self.pasteboardType]),
              let data = board.data(forPasteboardType: Self.pasteboardType), let stored = String(data: data, encoding: .utf8),
              CanvasMarkers.strip(stored) == board.string else { return super.paste(sender) }
        let shown = model.hidden(stored)
        replace(range, withText: shown)
        if model.shown != text { model.userChanged(text) }
    }
}
