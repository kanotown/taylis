import SwiftUI

/// 「下書き」 (M11h): conversations with unsent text or attachments; a row opens the conversation with the draft restored.
struct DraftsView: View {
    /// The sidebar selection value that shows this view instead of a channel.
    static let selectionId = "drafts"

    @Bindable var controller: AppController
    let onOpen: (_ channelId: String, _ parentId: String?) -> Void

    var body: some View {
        let store = controller.store
        let drafts = store.listDrafts().filter { store.channel($0.channelId) != nil }
        List {
            if drafts.isEmpty {
                ContentUnavailableView("下書きはありません", systemImage: "doc.text",
                                       description: Text("入力途中のメッセージは会話ごとに自動で残ります。"))
                .listRowSeparator(.hidden)
            }
            ForEach(drafts) { entry in
                if let channel = store.channel(entry.channelId) {
                    Button { onOpen(entry.channelId, entry.parentId) } label: {
                        VStack(alignment: .leading, spacing: 3) {
                            HStack(spacing: 6) {
                                Text(channelTitle(channel, store: store)).font(.footnote).fontWeight(.semibold)
                                if entry.parentId != nil { Text("· スレッド").font(.footnote).foregroundStyle(.secondary) }
                                if !entry.draft.attachments.isEmpty {
                                    Text("· 添付 \(entry.draft.attachments.count)").font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                            Text(entry.draft.text.isEmpty ? "(本文なし)" : entry.draft.text).font(.subheadline).lineLimit(2)
                        }
                        .padding(.vertical, 2)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .listStyle(.plain)
        .navigationTitle("下書き")
        .navigationBarTitleDisplayMode(.inline)
    }
}
