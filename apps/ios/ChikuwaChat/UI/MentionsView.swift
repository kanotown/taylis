import SwiftUI

/// 「メンション」 (M11h): messages that mention me or everyone, newest first; a row reveals the message.
struct MentionsView: View {
    /// The sidebar selection value that shows this view instead of a channel.
    static let selectionId = "mentions"

    @Bindable var controller: AppController
    let onOpen: (MessageOut) -> Void
    /// Rows to show before the first load (previews and snapshot tests).
    var initial: [MessageOut]? = nil
    @State private var items: [MessageOut]?
    @State private var cursor: String?
    @State private var hasMore = false

    var body: some View {
        List {
            if let items {
                if items.isEmpty {
                    ContentUnavailableView("まだメンションはありません", systemImage: "at",
                                           description: Text("自分宛てと @channel のメッセージがここに集まります。"))
                    .listRowSeparator(.hidden)
                }
                ForEach(items, id: \.id) { message in
                    Button { onOpen(message) } label: { MessageCardView(message: message, controller: controller) }
                        .buttonStyle(.plain)
                }
                if hasMore { Button("さらに読み込む") { Task { await load(more: true) } } }
            } else {
                ProgressView()
            }
        }
        .listStyle(.plain)
        .navigationTitle("メンション")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: controller.engine?.status.rawValue ?? "") { if items == nil { items = initial }; await load(more: false) } // a reconnect re-reads
        .refreshable { await load(more: false) }
    }

    private func load(more: Bool) async {
        guard let api = controller.api else { return }
        do {
            let page = try await api.listMentions(cursor: more ? cursor : nil)
            items = more ? (items ?? []) + page.items : page.items
            cursor = page.nextCursor
            hasMore = page.items.count >= 50
        } catch { controller.error = controller.describe(error) }
    }
}
