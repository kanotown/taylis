import SwiftUI

/// 「保存済み」 (M11c): my bookmarked messages, newest saved first; a row reveals the message.
struct SavedView: View {
    /// The sidebar selection value that shows this view instead of a channel.
    static let selectionId = "saved"

    @Bindable var controller: AppController
    let onOpen: (MessageOut) -> Void
    @State private var items: [BookmarkItem]?
    @State private var cursor: String?
    @State private var hasMore = false

    private var signature: String { controller.store.bookmarks.sorted().joined(separator: ",") }

    var body: some View {
        List {
            if let items {
                if items.isEmpty {
                    ContentUnavailableView("保存したメッセージはありません", systemImage: "bookmark",
                                           description: Text("メッセージを長押しして「あとで見る」を選ぶと、ここに集まります。"))
                    .listRowSeparator(.hidden)
                }
                ForEach(items, id: \.message.id) { item in
                    Button { onOpen(item.message) } label: { MessageCardView(message: item.message, controller: controller) }
                        .buttonStyle(.plain)
                        .swipeActions { Button("保存を解除", systemImage: "bookmark.slash", role: .destructive) { Task { await controller.toggleBookmark(item.message.id) } } }
                }
                if hasMore { Button("さらに読み込む") { Task { await load(more: true) } } }
            } else {
                ProgressView()
            }
        }
        .listStyle(.plain)
        .navigationTitle("保存済み")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: signature + (controller.engine?.status.rawValue ?? "")) { await load(more: false) } // bookmark.updated re-reads
        .refreshable { await load(more: false) }
    }

    private func load(more: Bool) async {
        guard let api = controller.api else { return }
        do {
            let page = try await api.listBookmarks(cursor: more ? cursor : nil)
            items = more ? (items ?? []) + page.items : page.items
            cursor = page.nextCursor
            hasMore = page.items.count >= 50
        } catch { controller.error = controller.describe(error) }
    }
}
