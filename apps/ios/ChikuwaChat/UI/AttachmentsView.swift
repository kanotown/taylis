import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

func formatSize(_ bytes: Int64) -> String {
    if bytes >= 1_048_576 { return String(format: "%.1f MB", Double(bytes) / 1_048_576) }
    if bytes >= 1024 { return String(format: "%.0f KB", Double(bytes) / 1024) }
    return "\(bytes) B"
}

/// Images show their thumbnail (fetched with the bearer token); other files show a row that downloads and shares.
struct AttachmentsView: View {
    let attachments: [AttachmentOut]
    @Bindable var controller: AppController
    @State private var downloaded: [String: URL] = [:]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(attachments) { attachment in
                if attachment.isImage {
                    ThumbnailView(attachment: attachment, controller: controller)
                } else {
                    HStack(spacing: 8) {
                        Image(systemName: "doc").foregroundStyle(.secondary)
                        VStack(alignment: .leading) {
                            Text(attachment.filename).font(.subheadline)
                            Text(formatSize(attachment.sizeBytes)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if let url = downloaded[attachment.id] {
                            ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
                        } else {
                            Button { Task { await download(attachment) } } label: { Image(systemName: "arrow.down.circle") }
                        }
                    }
                    .padding(8)
                    .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding(.top, 2)
    }

    private func download(_ attachment: AttachmentOut) async {
        if let url = await controller.downloadAttachment(attachment) { downloaded[attachment.id] = url }
    }
}

struct ThumbnailView: View {
    let attachment: AttachmentOut
    @Bindable var controller: AppController
    @State private var image: UIImage?
    @State private var shareURL: URL?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
            } else {
                Text(attachment.filename).font(.caption).padding(12).background(Color.secondary.opacity(0.12))
            }
        }
        .frame(maxWidth: 280, maxHeight: 240)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .onTapGesture { Task { shareURL = await controller.downloadAttachment(attachment) } }
        .task(id: attachment.id) {
            if let data = try? await controller.api?.fetchData("/api/v1/attachments/\(attachment.id)/thumbnail") { image = UIImage(data: data) }
        }
        .sheet(item: $shareURL) { url in ShareSheet(items: [url]) }
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Chips for uploads waiting in the composer.
struct PendingAttachmentsView: View {
    let items: [AttachmentOut]
    let onRemove: (AttachmentOut) -> Void

    var body: some View {
        if !items.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(items) { item in
                        Button { onRemove(item) } label: { Label(item.filename, systemImage: "xmark").font(.caption) }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                }
                .padding(.horizontal)
            }
            .padding(.top, 4)
        }
    }
}
