import PDFKit
import SwiftUI

/// M108 (docs/PREVIEWS.md §5): the box of a document's first page on its card: as wide as the card, the page's own
/// shape up to `maxHeight` (a portrait page shows its top, a slide whole). From the server's numbers, so the row has
/// its final height before the picture arrives.
enum DocumentFit {
    static let width: CGFloat = 260
    static let maxHeight: CGFloat = 200

    static func thumbHeight(_ preview: AttachmentPreviewOut?) -> CGFloat? {
        guard let preview, preview.isReady, let w = preview.width, let h = preview.height, w > 0, h > 0 else { return nil }
        return min(maxHeight, (width * CGFloat(h) / CGFloat(w)).rounded())
    }

    /// 「12 ページ」, or nil when the count is unknown.
    static func pagesLabel(_ pages: Int?) -> String? {
        guard let pages, pages > 0 else { return nil }
        return tr("\(pages) ページ")
    }

    /// The card's second line: 「プレビューを作成中…」 while the server works, else size and page count.
    static func detail(_ attachment: AttachmentOut) -> String {
        if attachment.preview?.isPending == true { return tr("プレビューを作成中…") }
        return [formatSize(attachment.sizeBytes), pagesLabel(attachment.preview?.pages)].compactMap { $0 }.joined(separator: " · ")
    }

    /// Shown as a document card (a preview being made or ready); a failed or missing preview keeps the plain row.
    static func showsCard(_ attachment: AttachmentOut) -> Bool {
        attachment.preview?.isPending == true || attachment.preview?.isReady == true
    }
}

/// A PDF or Office file with a preview: the first page (tap: every page in DocumentPDFViewer) over the name, size and
/// page count, and 「開く」 for the original file (Quick Look / share, as before).
struct DocumentPreviewCard: View {
    let attachment: AttachmentOut
    @Bindable var controller: AppController
    var present: ((URL) -> Void)? = nil
    @State private var loader = AttachmentImageLoader()
    @State private var viewing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let height = DocumentFit.thumbHeight(attachment.preview) {
                Button { viewing = true } label: {
                    ZStack {
                        Color.white
                        if let image = loader.image {
                            Image(uiImage: image).resizable().scaledToFill()
                                .frame(width: DocumentFit.width, height: height, alignment: .top)
                        } else if !loader.failed {
                            ProgressView()
                        }
                    }
                    .frame(width: DocumentFit.width, height: height, alignment: .top)
                    .clipped()
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(attachment.filename) のプレビュー")
                .task(id: attachment.id) {
                    await loader.load {
                        guard let api = controller.api else { throw URLError(.notConnectedToInternet) }
                        return try await api.fetchData("/api/v1/attachments/\(attachment.id)/preview/thumbnail")
                    }
                }
                Divider()
            }
            HStack(spacing: 8) {
                Image(systemName: "doc.richtext").foregroundStyle(.secondary)
                VStack(alignment: .leading) {
                    Text(attachment.filename).font(.subheadline).fileNameLine(attachment.filename)
                    Text(DocumentFit.detail(attachment)).font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 4)
                AttachmentFileButton(attachment: attachment, present: present) { await controller.downloadAttachment(attachment) }
            }
            .padding(8)
        }
        .frame(width: DocumentFit.width, alignment: .leading)
        .background(Color.secondary.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .fullScreenCover(isPresented: $viewing) {
            DocumentPDFViewer(attachment: attachment, controller: controller)
        }
    }
}

@MainActor @Observable
final class DocumentPDFLoader {
    /// What the pages area shows while there is no document (§27 / §29 for the drive's files).
    enum Status: Equatable {
        case loading
        /// A drive PDF's own bytes on their way (received, expected).
        case downloading(Int64, Int64?)
        /// An Office file's preview is being made (「プレビューを作成中…」): looked at again until it is ready.
        case making
        /// The file gets no preview (too large, no converter, not a kind the server previews).
        case unavailable
        /// The server could not make the preview.
        case previewFailed
        /// The pages could not be read (network, a PDF that is not one): 再試行.
        case failed
    }

    var document: PDFDocument?
    var file: URL?
    var status: Status = .loading
    var failed: Bool { status == .failed }
    /// A drive.changed for the file's folder (or a reconnect) while its preview is being made: look now.
    @ObservationIgnored private var poked = false
    /// How often a preview being made is looked at again (the desktop's 4 s).
    static var makingPoll: Duration = .seconds(4)

    func load(attachment: AttachmentOut, controller: AppController) async {
        status = .loading
        do {
            guard let api = controller.api else { throw URLError(.notConnectedToInternet) }
            try await loadPreview(attachmentId: attachment.id, filename: attachment.filename, api: api)
        } catch {
            guard !Task.isCancelled else { return }
            status = .failed
        }
    }

    private func loadPreview(attachmentId: String, filename: String, api: ApiClient) async throws {
        let data = try await api.fetchData("/api/v1/attachments/\(attachmentId)/preview/pdf")
        try Task.checkCancellation()
        guard let document = PDFDocument(data: data) else { status = .failed; return }
        // For the share button: a PDF named after the original (「議事録.pdf」), in the app's temporary folder.
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("previews", isDirectory: true)
            .appendingPathComponent(attachmentId.replacingOccurrences(of: "/", with: "_"), isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(Self.pdfName(filename))
        try data.write(to: url, options: .atomic)
        self.file = url
        self.document = document
    }

    func poke() { poked = true }

    /// A drive file (§27, §29, the desktop's DriveDocument): a PDF always shows, from its preview when ready, else from
    /// its own bytes (streamed to this device's caches, never whole in memory); an Office file without a preview asks
    /// the server to make it and waits (「プレビューを作成中…」) until the pages are there; one that gets none, or whose
    /// preview failed, says so (the viewer offers 「ダウンロード」).
    func load(drive item: DriveItemOut, controller: AppController) async {
        status = .loading
        guard let api = controller.api else { status = .failed; return }
        var live = item
        // A PDF opened from its own bytes stays on them (its preview becoming ready meanwhile would reload the pages).
        let original = DriveRules.documentSource(item) == .original
        do {
            // Never made (imported, §24): ask for it. A PDF asks too (its thumbnail later), but reads its own bytes.
            if live.file != nil, live.file?.preview == nil {
                do {
                    let preview = try await api.requestDrivePreview(item.id)
                    live.file?.preview = preview
                    if preview == nil, !original { status = .unavailable; return }
                } catch {
                    if !original { throw error }
                }
            }
            if original { return try await loadOriginal(item, api: api) }
            while true {
                try Task.checkCancellation()
                switch DriveRules.documentSource(live) {
                case .preview:
                    guard let file = live.file else { status = .failed; return }
                    return try await loadPreview(attachmentId: file.attachmentId, filename: live.name, api: api)
                case .original:
                    return try await loadOriginal(live, api: api)
                case .failed:
                    status = .previewFailed
                    return
                case .ask:
                    status = .unavailable
                    return
                case .making:
                    status = .making
                    try await waitForMaking()
                    if let detail = try? await api.driveItem(item.id) { live = detail.item }
                }
            }
        } catch {
            guard !Task.isCancelled, !(error is CancellationError) else { return }
            status = .failed
        }
    }

    private func waitForMaking() async throws {
        poked = false
        let step = Duration.milliseconds(100)
        var waited = Duration.zero
        while waited < Self.makingPoll, !poked {
            try await Task.sleep(for: step)
            waited += step
        }
    }

    /// The PDF itself (its preview is not ready): the download ticket's URL to the caches, kept per version.
    private func loadOriginal(_ item: DriveItemOut, api: ApiClient) async throws {
        guard let file = item.file else { status = .failed; return }
        let name = Self.pdfName(DriveRules.fileName(item.name))
        let destination = DriveFiles.directory("view").appendingPathComponent(file.versionId ?? file.attachmentId, isDirectory: true)
            .appendingPathComponent(name)
        if !FileManager.default.fileExists(atPath: destination.path) {
            let ticket = try await api.driveDownloadTicket(item.id)
            guard let url = DriveFiles.absolute(ticket.url, base: api.baseUrl) else { status = .failed; return }
            status = .downloading(0, item.sizeBytes)
            try await DriveFiles.download(url, to: destination) { [weak self] received, total in
                guard let self, case .downloading = self.status else { return }
                self.status = .downloading(received, total ?? item.sizeBytes)
            }
        }
        try Task.checkCancellation()
        guard let document = PDFDocument(url: destination) else {
            // Not a PDF after all (or damaged): not kept, so 再試行 fetches it again.
            try? FileManager.default.removeItem(at: destination)
            status = .failed
            return
        }
        self.file = destination
        self.document = document
    }

    static func pdfName(_ filename: String) -> String {
        let base = (filename as NSString).deletingPathExtension.replacingOccurrences(of: "/", with: "_")
        return (base.isEmpty ? "preview" : base) + ".pdf"
    }
}

/// Pull a document down to close it, as photos close (ViewerDismiss): from its header at any time, from the pages only
/// when they are scrolled to the top and not zoomed in (otherwise the drag scrolls or pans the pages).
enum DocumentDismiss {
    /// Whether a drag that has just moved this far closes the document: down more than sideways, from the top of the
    /// pages, not zoomed in. `atTop` is true for the header.
    static func begins(motion: CGPoint, atTop: Bool, zoomed: Bool) -> Bool {
        guard atTop, !zoomed, motion.y > 0 else { return false }
        return motion.y > abs(motion.x)
    }

    /// How far down the document goes for a drag: it follows the finger down, not above where it was.
    static func pull(_ translation: CGFloat) -> CGFloat { max(0, translation) }

    /// The pages are at their top (with the scroll view's inset; a point of slack for rounding).
    static func isAtTop(offsetY: CGFloat, insetTop: CGFloat) -> Bool { offsetY <= -insetTop + 1 }

    /// Zoomed in past the page width (PDFKit's fit scale), where a drag pans the page.
    static func isZoomed(scale: CGFloat, fit: CGFloat) -> Bool { fit > 0 && scale > fit * 1.01 }
}

/// Every page of the preview PDF in PDFKit (pinch to zoom, continuous scrolling), with 閉じる and share. Pulled down
/// from its header, or from the first page's top while not zoomed, it follows the finger and closes past a distance or
/// on a flick, else springs back (DocumentDismiss; as the photo viewer).
struct DocumentPDFViewer: View {
    let attachment: AttachmentOut
    @Bindable var controller: AppController
    /// A drive file (§29): its pages from the preview or the PDF itself, or why they are not there (with 「ダウンロード」).
    var driveItem: DriveItemOut? = nil
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var loader = DocumentPDFLoader()
    @State private var attempt = 0
    @State private var download: DriveDownloadRequest?
    /// How far the document is pulled down, and whether the header's drag is a pull (decided on its first move).
    @State private var pull: CGFloat = 0
    @State private var headerPull: Bool?
    @State private var closing = false
    @State private var faded = false

    var body: some View {
        GeometryReader { proxy in
            let extent = proxy.size.height + proxy.safeAreaInsets.top + proxy.safeAreaInsets.bottom
            let progress = ViewerDismiss.progress(offset: pull, extent: extent)
            ZStack {
                // The conversation shows through as the document is pulled away (the cover is otherwise opaque).
                Color.black.opacity(0.6 * (1 - progress)).ignoresSafeArea()
                VStack(spacing: 0) {
                    header(extent: extent)
                    pages(extent: extent)
                }
                .background(Color(.systemBackground).ignoresSafeArea())
                .offset(y: pull)
                .opacity(faded ? 0 : 1)
            }
        }
        .presentationBackground(.clear)
        // VoiceOver's escape (two-finger scrub) closes it like 閉じる.
        .accessibilityAction(.escape) { dismiss() }
        .task(id: attempt) {
            if let driveItem {
                await loader.load(drive: driveItem, controller: controller)
            } else {
                await loader.load(attachment: attachment, controller: controller)
            }
        }
        // The preview loop's drive.changed (or a reconnect) while its preview is being made: look now.
        .onChange(of: controller.drive?.signal(driveItem?.parentId ?? "") ?? 0) { _, _ in loader.poke() }
        .onChange(of: controller.drive?.reconnects ?? 0) { _, _ in loader.poke() }
        .sheet(item: $download) { DriveDownloadSheet(request: $0, controller: controller) }
    }

    private var title: String { driveItem?.name ?? attachment.filename }

    /// A drive file without pages to show: its own bytes to this device (share, “ファイル”に保存).
    @ViewBuilder
    private var downloadButton: some View {
        if let driveItem {
            Button { download = DriveDownloadRequest(item: driveItem) } label: { Label("ダウンロード", systemImage: "arrow.down.circle") }
                .buttonStyle(.bordered)
        }
    }

    private func header(extent: CGFloat) -> some View {
        HStack {
            Button("閉じる") { dismiss() }
            Spacer()
            if let file = loader.file {
                ShareLink(item: file) { Image(systemName: "square.and.arrow.up") }
                    .accessibilityLabel("共有")
            }
        }
        // The system title cuts a long name at its end; this one keeps the extension (FileNameEllipsis).
        .overlay {
            Text(title).font(.headline).fileNameLine(title)
                .padding(.horizontal, 72)
                .accessibilityAddTraits(.isHeader)
        }
        .padding(.horizontal, 16)
        .frame(height: 44)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
        .contentShape(Rectangle())
        .gesture(
            DragGesture(minimumDistance: 10, coordinateSpace: .global)
                .onChanged { value in
                    if headerPull == nil {
                        headerPull = DocumentDismiss.begins(motion: CGPoint(x: value.translation.width, y: value.translation.height),
                                                            atTop: true, zoomed: false)
                    }
                    if headerPull == true { pulled(value.translation.height) }
                }
                .onEnded { value in
                    if headerPull == true { released(value.translation.height, velocity: value.velocity.height, extent: extent) }
                    headerPull = nil
                }
        )
    }

    private func pages(extent: CGFloat) -> some View {
        Group {
            if let document = loader.document {
                PDFKitView(document: document, onPull: pulled,
                           onRelease: { released($0, velocity: $1, extent: extent) })
            } else {
                switch loader.status {
                case .failed:
                    VStack(spacing: 12) {
                        Label("プレビューを読み込めませんでした", systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
                        Button("再試行") { attempt += 1 }
                        downloadButton
                    }
                case .making:
                    VStack(spacing: 12) {
                        ProgressView()
                        Text("プレビューを作成中…")
                    }
                    .foregroundStyle(.secondary)
                    .accessibilityElement(children: .combine)
                case .unavailable:
                    VStack(spacing: 12) {
                        Label("このファイルはプレビューできません", systemImage: "doc").foregroundStyle(.secondary)
                        downloadButton
                    }
                case .previewFailed:
                    VStack(spacing: 12) {
                        Label("プレビューを作れませんでした", systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
                        downloadButton
                    }
                case .downloading(let received, let expected):
                    VStack(spacing: 8) {
                        if let expected, expected > 0 {
                            ProgressView(value: min(1, Double(received) / Double(expected)))
                            Text(verbatim: "\(driveSize(received)) / \(driveSize(expected))").font(.footnote).monospacedDigit()
                        } else {
                            ProgressView()
                        }
                    }
                    .frame(maxWidth: 260)
                    .foregroundStyle(.secondary)
                    .accessibilityLabel("プレビューを読み込み中")
                case .loading:
                    ProgressView().accessibilityLabel("プレビューを読み込み中")
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.secondarySystemBackground))
        .ignoresSafeArea(edges: .bottom)
    }

    private func pulled(_ translation: CGFloat) {
        guard !closing else { return }
        pull = DocumentDismiss.pull(translation)
    }

    private func released(_ translation: CGFloat, velocity: CGFloat, extent: CGFloat) {
        guard !closing else { return }
        let offset = DocumentDismiss.pull(translation)
        guard ViewerDismiss.shouldClose(offset: offset, velocity: velocity, extent: extent) else {
            withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(duration: 0.4, bounce: 0.15)) { pull = 0 }
            return
        }
        closing = true
        // The document carries on down and the background clears (with Reduce Motion it fades where it is); then the
        // cover goes without sliding down again.
        if reduceMotion {
            withAnimation(.easeOut(duration: 0.2)) { faded = true } completion: { closeNow() }
        } else {
            let duration = min(0.3, max(0.12, Double((extent - offset) / max(velocity, 1500))))
            withAnimation(.easeOut(duration: duration)) { pull = extent } completion: { closeNow() }
        }
    }

    private func closeNow() {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { dismiss() }
    }
}

struct PDFKitView: UIViewRepresentable {
    let document: PDFDocument
    var onPull: (CGFloat) -> Void = { _ in }
    var onRelease: (CGFloat, CGFloat) -> Void = { _, _ in }

    func makeCoordinator() -> DocumentPullController { DocumentPullController() }

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.autoScales = true
        view.backgroundColor = .secondarySystemBackground
        view.document = document
        context.coordinator.attach(to: view)
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        if view.document !== document { view.document = document }
        context.coordinator.onPull = onPull
        context.coordinator.onRelease = onRelease
        context.coordinator.linkScrollView()
    }
}

/// The pages' pull to close: a one-finger pan on the PDFView that PDFKit's scroll view waits for. It begins only for a
/// drag down from the top while not zoomed in (DocumentDismiss), so scrolling, panning a zoomed page and pinching
/// carry on as before; then the document follows the finger (in the window's coordinates, as the view moves with it).
final class DocumentPullController: NSObject, UIGestureRecognizerDelegate {
    let pan = UIPanGestureRecognizer()
    private(set) weak var view: PDFView?
    private weak var linked: UIScrollView?
    var onPull: (CGFloat) -> Void = { _ in }
    var onRelease: (CGFloat, CGFloat) -> Void = { _, _ in }

    func attach(to view: PDFView) {
        self.view = view
        pan.addTarget(self, action: #selector(panned(_:)))
        pan.delegate = self
        pan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(pan)
        linkScrollView()
    }

    /// PDFKit's own scroll view (inside the PDFView).
    var scrollView: UIScrollView? {
        guard let view else { return nil }
        var queue: [UIView] = view.subviews
        while !queue.isEmpty {
            let next = queue.removeFirst()
            if let scroll = next as? UIScrollView { return scroll }
            queue.append(contentsOf: next.subviews)
        }
        return nil
    }

    /// The scroll view waits for the pull to give the drag up (as the photo viewer's scroll views do).
    func linkScrollView() {
        guard let scroll = scrollView, scroll !== linked else { return }
        scroll.panGestureRecognizer.require(toFail: pan)
        linked = scroll
    }

    var isAtTop: Bool {
        guard let scroll = scrollView else { return true }
        return DocumentDismiss.isAtTop(offsetY: scroll.contentOffset.y, insetTop: scroll.adjustedContentInset.top)
    }

    var isZoomed: Bool {
        guard let view else { return false }
        return DocumentDismiss.isZoomed(scale: view.scaleFactor, fit: view.scaleFactorForSizeToFit)
    }

    /// Whether a drag that has moved this far is a pull to close; exposed for tests.
    func begins(motion: CGPoint) -> Bool { DocumentDismiss.begins(motion: motion, atTop: isAtTop, zoomed: isZoomed) }

    /// A pinch is under way or just ended (its finger left last may still move): no pull.
    var isPinching: Bool {
        guard let scroll = scrollView else { return false }
        if scroll.isZooming || scroll.isZoomBouncing { return true }
        switch scroll.pinchGestureRecognizer?.state {
        case .began?, .changed?: return true
        default: return false
        }
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === pan else { return true }
        linkScrollView()
        guard pan.numberOfTouches <= 1, !isPinching else { return false }
        var motion = pan.translation(in: nil)
        if motion == .zero { motion = pan.velocity(in: nil) }
        return begins(motion: motion)
    }

    @objc private func panned(_ pan: UIPanGestureRecognizer) {
        let translation = pan.translation(in: nil).y
        switch pan.state {
        case .began, .changed: onPull(translation)
        case .ended: onRelease(translation, pan.velocity(in: nil).y)
        default: onRelease(0, 0)
        }
    }
}
