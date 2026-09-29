import SwiftUI

/// 「ファイル」 (M11i): attachments in my channels (or one channel), newest first; a row reveals its message.
struct FilesView: View {
    /// The sidebar selection value that shows this view instead of a channel.
    static let selectionId = "files"

    @Bindable var controller: AppController
    /// nil: every channel I belong to.
    var channelId: String? = nil
    let onOpen: (_ messageId: String, _ channelId: String, _ parentId: String?) -> Void
    /// Rows to show before the first load (previews and snapshot tests).
    var initial: [FileItem]? = nil
    /// M29: a conversation's 「ファイル」 tab: that channel only, and the filter in the list rather than in the
    /// navigation bar (the conversation's own).
    var embedded = false
    @State private var scope: String?
    @State private var query = ""
    @State private var items: [FileItem]?
    @State private var cursor: String?

    private var channels: [ChannelState] {
        controller.store.channels.values.filter(\.isMember).sorted { channelTitle($0, store: controller.store) < channelTitle($1, store: controller.store) }
    }

    var body: some View {
        if embedded {
            list
        } else {
            list
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "ファイル名で絞り込む")
                .navigationTitle("ファイル")
                .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var list: some View {
        List {
            Section {
                if embedded {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                        TextField("ファイル名で絞り込む", text: $query).submitLabel(.search)
                        if !query.isEmpty {
                            Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                                .buttonStyle(.plain)
                                .accessibilityLabel("絞り込みを消す")
                        }
                    }
                } else {
                    Picker("チャンネル", selection: $scope) {
                        Text("すべてのチャンネル").tag(String?.none)
                        ForEach(channels) { channel in Text(channelTitle(channel, store: controller.store)).tag(String?.some(channel.id)) }
                    }
                }
            }
            if let items {
                if items.isEmpty {
                    ContentUnavailableView(query.isEmpty ? "まだファイルはありません" : "見つかりません", systemImage: "doc",
                                           description: Text("メッセージに添付したファイルがここに集まります。"))
                    .listRowSeparator(.hidden)
                }
                ForEach(items) { item in
                    Button { onOpen(item.messageId, item.channelId, item.parentId) } label: { FileRowView(item: item, controller: controller) }
                        .buttonStyle(.plain)
                }
                if cursor != nil { Button("さらに読み込む") { Task { await load(more: true) } } }
            } else {
                ProgressView()
            }
        }
        .listStyle(.plain)
        .onAppear { if items == nil { scope = channelId; items = initial } }
        .task(id: "\((embedded ? channelId : scope) ?? "")|\(query)|\(controller.engine?.status.rawValue ?? "")") {
            if !query.isEmpty { try? await Task.sleep(for: .milliseconds(250)) }
            await load(more: false)
        }
        .refreshable { await load(more: false) }
    }

    private func load(more: Bool) async {
        guard let api = controller.api else { return }
        do {
            let page = try await api.listFiles(channelId: embedded ? channelId : scope, query: query.trimmingCharacters(in: .whitespaces), cursor: more ? cursor : nil)
            items = more ? (items ?? []) + page.items : page.items
            cursor = page.nextCursor
        } catch {
            // A load replaced by the next one (a new filter, the scope set as the view appears) is no error.
            if !Task.isCancelled { controller.error = controller.describe(error) }
        }
    }
}

/// Thumbnail or file icon, name, and where / who / when.
struct FileRowView: View {
    let item: FileItem
    @Bindable var controller: AppController
    @State private var image: UIImage?

    var body: some View {
        let store = controller.store
        let attachment = item.attachment
        let uploader = store.users[item.uploaderId]?.displayName ?? "?"
        let channel = store.channel(item.channelId).map { channelTitle($0, store: store) } ?? "?"
        HStack(spacing: 12) {
            ZStack {
                RoundedRectangle(cornerRadius: 8).fill(Color(.secondarySystemBackground))
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                } else {
                    Image(systemName: attachment.hasThumbnail ? "photo" : "doc").foregroundStyle(.secondary)
                }
            }
            .frame(width: 48, height: 48)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            VStack(alignment: .leading, spacing: 2) {
                Text(attachment.filename).font(.subheadline).fontWeight(.medium).lineLimit(1)
                Text("\(formatSize(attachment.sizeBytes)) · \(uploader) · \(channel) · \(Timeline.timeLabel(item.attachedAt))")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            AttachmentFileButton(attachment: attachment) { await controller.downloadAttachment(attachment) }
        }
        .padding(.vertical, 2)
        .task(id: attachment.id) {
            guard attachment.hasThumbnail, image == nil else { return }
            if let data = try? await controller.api?.fetchData("/api/v1/attachments/\(attachment.id)/thumbnail") { image = UIImage(data: data) }
        }
    }

}
