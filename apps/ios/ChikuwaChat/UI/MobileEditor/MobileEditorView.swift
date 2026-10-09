import PhotosUI
import SwiftUI
import UIKit
import WebKit

/// M153a (docs/WIKI.md §30.4): a Docs page's body in the bundled 見たまま editor (the WebView) with the app's own
/// formatting row under it, above the keyboard. The WebView is resized above the keyboard by SwiftUI's keyboard safe
/// area (the editor is told `keyboardHeight: 0`), so the caret is always in the visible part and the row stands right
/// on the keyboard. Pictures come from the photo library through the app's upload; links open in the app.
struct MobileEditorView: View {
    @Bindable var controller: AppController
    let saver: CanvasSaver
    let session: MobileEditorSession
    /// The body line to put the caret on (from the Markdown editor); nil: the start.
    var caretLine: Int? = nil
    let onOpenPage: (String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.scenePhase) private var scenePhase
    @State private var showPhotoPicker = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var uploading = 0
    @State private var openedFile: URL?

    private var theme: EditorTheme { colorScheme == .dark ? .dark : .light }

    var body: some View {
        VStack(spacing: 0) {
            MobileEditorWebView(session: session)
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
            MobileEditorToolbar(session: session) { showPhotoPicker = true }
        }
        .onAppear {
            session.onOpenPage = onOpenPage
            session.attach(saver: saver, caretLine: caretLine, theme: theme)
        }
        .onDisappear {
            let session = session
            Task { await session.detach() }
        }
        .onChange(of: colorScheme) { _, next in session.setTheme(next == .dark ? .dark : .light) }
        // The app is leaving the front: the body as the editor holds it goes into the saver now (didEnterBackground
        // then flushes every page). Asked at .inactive, while the web process still answers.
        .onChange(of: scenePhase) { _, phase in
            if phase == .inactive { Task { await session.commit() } }
        }
        .onChange(of: session.imageRequested) { _, wanted in
            guard wanted else { return }
            session.imageRequested = false
            showPhotoPicker = true
        }
        .onChange(of: session.openedLink) { _, link in
            guard let link else { return }
            session.openedLink = nil
            open(link)
        }
        // The picker is presented from the editor itself (a PhotosPicker inside a Menu never opens, M58).
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
        .sheet(item: $openedFile) { url in
            if AttachmentPreview.canPreview(url) { FilePreviewSheet(url: url, onDismiss: { openedFile = nil }) } else { ShareSheet(items: [url]) }
        }
        .background {
            // ⌘S on a hardware keyboard: the body into the saver and saved now (the Markdown editor saves on the pause).
            Button("") { Task { await session.commit(); await saver.flush() } }
                .keyboardShortcut("s", modifiers: .command)
                .opacity(0)
                .accessibilityHidden(true)
        }
    }

    /// The server takes at most 100 attachments per page: past that nothing is sent (the Markdown editor's rule).
    private func roomFor(_ count: Int) -> Bool {
        guard CanvasText.attachmentRefs(saver.text).count + count <= CanvasText.maxImages else {
            controller.error = ErrorMessages.byCode["too_many_canvas_images"] ?? ErrorMessages.unknown
            return false
        }
        return true
    }

    /// One picture to the server (pending), then its block at the caret; the save that carries it binds it (§4.10).
    private func upload(_ data: Data, filename: String, contentType: String) async {
        defer { uploading -= 1 }
        guard let uploaded = await controller.uploadAttachment(data: data, filename: filename, contentType: contentType) else { return }
        session.insertImage(uploaded.id)
    }

    /// `attachment:<id>` (a file chip, a picture): the app's preview; `https://…`: the browser. Pages went to `onOpenPage`.
    private func open(_ link: String) {
        if let id = FileLink.attachmentId(link) {
            Task { if let file = await controller.downloadPageFile(id) { openedFile = file } }
            return
        }
        guard let url = URL(string: link), let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http" else { return }
        UIApplication.shared.open(url)
    }
}

/// The WebView the session owns, in SwiftUI (made once at the warm-up; the same instance whatever the view's identity).
struct MobileEditorWebView: UIViewRepresentable {
    let session: MobileEditorSession

    func makeUIView(context: Context) -> UIView {
        guard let controller = session.transport as? MobileEditorController else { return UIView() }
        return controller.webView
    }

    func updateUIView(_ view: UIView, context: Context) {}
}

/// The formatting row above the keyboard: the editor's own actions (`command`), undo / redo, and the keyboard away. A
/// SwiftUI row rather than WebKit's bar: WebKit's own one (‹ › 完了) is hidden (NoAccessoryWebView), and this one stays
/// when the keyboard is down, follows the app's look and reads its labels in the app's language.
struct MobileEditorToolbar: View {
    let session: MobileEditorSession
    let onPickImage: () -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 2) {
                tool("arrow.uturn.backward", tr("操作を取り消す"), .undo)
                tool("arrow.uturn.forward", tr("やり直す"), .redo)
                Menu {
                    Button("見出し 1") { session.command(.h1) }
                    Button("見出し 2") { session.command(.h2) }
                    Button("見出し 3") { session.command(.h3) }
                } label: { toolIcon("textformat.size") }
                .accessibilityLabel("見出し")
                tool("bold", tr("太字"), .bold)
                tool("italic", tr("斜体"), .italic)
                tool("strikethrough", tr("取り消し線"), .strike)
                tool("chevron.left.forwardslash.chevron.right", tr("コード"), .code)
                tool("list.bullet", tr("箇条書き"), .bullet)
                tool("list.number", tr("番号付きリスト"), .ordered)
                tool("checklist", tr("チェックリスト"), .task)
                tool("text.quote", tr("引用"), .quote)
                tool("curlybraces", tr("コードブロック"), .codeBlock)
                tool("minus", tr("区切り線"), .divider)
                tool("link", tr("リンク"), .link)
                tool("at", tr("メンション"), .mention)
                Button { onPickImage() } label: { toolIcon("photo") }
                    .accessibilityLabel("画像")
                tool("tablecells", tr("表"), .table)
                tool("increase.indent", tr("インデント"), .indent)
                tool("decrease.indent", tr("インデント解除"), .outdent)
                tool("slash.circle", tr("ブロックを挿入"), .slash)
                Spacer(minLength: 8)
                Button { KeyboardBehavior.dismiss(); session.blur() } label: { toolIcon("keyboard.chevron.compact.down") }
                    .accessibilityLabel("キーボードを閉じる")
            }
            .padding(.horizontal, 6)
        }
        .frame(height: 44)
        .background(.bar)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("書式")
        .accessibilityIdentifier("mobile-editor-toolbar")
    }

    private func tool(_ icon: String, _ label: String, _ command: EditorCommand) -> some View {
        Button { session.command(command) } label: { toolIcon(icon) }
            .accessibilityLabel(label)
            .accessibilityIdentifier("editor-tool-\(command.rawValue)")
    }

    private func toolIcon(_ name: String) -> some View {
        Image(systemName: name)
            .font(.body)
            .frame(width: 40, height: 40)
            .contentShape(Rectangle())
    }
}
