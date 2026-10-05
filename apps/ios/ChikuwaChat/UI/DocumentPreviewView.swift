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
                    Text(attachment.filename).font(.subheadline).lineLimit(2)
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
    var document: PDFDocument?
    var file: URL?
    var failed = false

    func load(attachment: AttachmentOut, controller: AppController) async {
        failed = false
        do {
            guard let api = controller.api else { throw URLError(.notConnectedToInternet) }
            let data = try await api.fetchData("/api/v1/attachments/\(attachment.id)/preview/pdf")
            try Task.checkCancellation()
            guard let document = PDFDocument(data: data) else { failed = true; return }
            // For the share button: a PDF named after the original (「議事録.pdf」), in the app's temporary folder.
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("previews", isDirectory: true)
                .appendingPathComponent(attachment.id.replacingOccurrences(of: "/", with: "_"), isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(Self.pdfName(attachment.filename))
            try data.write(to: url, options: .atomic)
            self.file = url
            self.document = document
        } catch {
            guard !Task.isCancelled else { return }
            failed = true
        }
    }

    static func pdfName(_ filename: String) -> String {
        let base = (filename as NSString).deletingPathExtension.replacingOccurrences(of: "/", with: "_")
        return (base.isEmpty ? "preview" : base) + ".pdf"
    }
}

/// Every page of the preview PDF in PDFKit (pinch to zoom, continuous scrolling), with 閉じる and share.
struct DocumentPDFViewer: View {
    let attachment: AttachmentOut
    @Bindable var controller: AppController
    @Environment(\.dismiss) private var dismiss
    @State private var loader = DocumentPDFLoader()
    @State private var attempt = 0

    var body: some View {
        NavigationStack {
            Group {
                if let document = loader.document {
                    PDFKitView(document: document).ignoresSafeArea(edges: .bottom)
                } else if loader.failed {
                    VStack(spacing: 12) {
                        Label("プレビューを読み込めませんでした", systemImage: "exclamationmark.triangle")
                        Button("再試行") { attempt += 1 }
                    }
                    .foregroundStyle(.secondary)
                } else {
                    ProgressView().accessibilityLabel("プレビューを読み込み中")
                }
            }
            .navigationTitle(attachment.filename)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                if let file = loader.file {
                    ToolbarItem(placement: .primaryAction) {
                        ShareLink(item: file) { Image(systemName: "square.and.arrow.up") }
                            .accessibilityLabel("共有")
                    }
                }
            }
        }
        .task(id: attempt) { await loader.load(attachment: attachment, controller: controller) }
    }
}

struct PDFKitView: UIViewRepresentable {
    let document: PDFDocument

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.autoScales = true
        view.backgroundColor = .secondarySystemBackground
        view.document = document
        return view
    }

    func updateUIView(_ view: PDFView, context: Context) {
        if view.document !== document { view.document = document }
    }
}
