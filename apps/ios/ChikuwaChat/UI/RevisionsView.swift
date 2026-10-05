import SwiftUI

/// 「編集履歴」(M14c): the bodies my edits replaced, oldest first, then the current one. Author only.
struct RevisionsView: View {
    @Bindable var controller: AppController
    let message: MessageState
    @Environment(\.dismiss) private var dismiss
    @State private var rows: [MessageRevisionOut]?
    @State private var failed = false

    private func text(_ body: String) -> String {
        Mentions.toNames(body, users: controller.store.users, groups: controller.store.groups)
    }

    var body: some View {
        NavigationStack {
            List {
                Section { Text("以前の版は自分にだけ表示されます。メッセージを削除すると履歴も消えます。").font(.footnote).foregroundStyle(.secondary) }
                if let rows {
                    if rows.isEmpty { Section { Text("以前の版は記録されていません (履歴の記録を始める前の編集です)。").foregroundStyle(.secondary) } }
                    ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                        Section(tr("\(Timeline.fullLabel(row.writtenAt)) の版")) {
                            Text(text(row.body)).textSelection(.enabled)
                            Text(tr("\(Timeline.fullLabel(row.replacedAt)) に編集")).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    Section(tr("現在の版") + (message.editedAt.map { " · " + Timeline.fullLabel($0) } ?? "")) {
                        Text(text(message.body)).textSelection(.enabled)
                    }
                } else if failed {
                    Text("編集履歴を読み込めませんでした").foregroundStyle(.red)
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("編集履歴")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("閉じる") { dismiss() } } }
            .task {
                if let list = await controller.messageRevisions(message.id) { rows = list } else { failed = true }
            }
        }
    }
}
