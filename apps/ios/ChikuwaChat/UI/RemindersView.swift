import SwiftUI

/// 「リマインダー」 (M12e): fired nudges wait for 完了 on top; pending ones list their time.
struct RemindersView: View {
    static let selectionId = "reminders"

    @Bindable var controller: AppController
    let onOpen: (ReminderOut) -> Void

    var body: some View {
        let store = controller.store
        let rows = store.listReminders()
        let fired = rows.filter { $0.status == "fired" }
        let pending = rows.filter { $0.status == "pending" }
        List {
            if rows.isEmpty {
                ContentUnavailableView("リマインダーはありません", systemImage: "alarm",
                                       description: Text("メッセージを長押しして「リマインド」を選ぶと、ここに集まります。"))
                .listRowSeparator(.hidden)
            }
            if !fired.isEmpty {
                Section("届いたリマインド") { ForEach(fired) { row in self.row(row, store: store, action: "完了") } }
            }
            if !pending.isEmpty {
                Section("予定") { ForEach(pending) { row in self.row(row, store: store, action: "取り消し") } }
            }
        }
        .listStyle(.plain)
        .navigationTitle("リマインダー")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await controller.engine?.loadReminders() }
    }

    private func row(_ row: ReminderOut, store: Store, action: String) -> some View {
        Button { onOpen(row) } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if row.kind == "ack" {  // L4: the author asked me to acknowledge
                        Label("確認のお願い", systemImage: "checkmark.circle").font(.caption.bold()).foregroundStyle(Color.accentColor)
                    } else if row.kind == "collect" {  // L6: a recurring post's due time passed before my reply (the push's title)
                        Label("提出のお願い", systemImage: "tray.and.arrow.up").font(.caption.bold()).foregroundStyle(Color.orange)
                    }
                    Text(store.channel(row.channelId).map { channelTitle($0, store: store) } ?? "?").font(.footnote).fontWeight(.semibold)
                    Text("· " + Schedule.label(iso: row.remindAt) + (row.status == "fired" ? " にリマインド" : " にリマインド予定")).font(.footnote).foregroundStyle(.secondary)
                }
                if let note = row.note, !note.isEmpty { Text(note).font(.subheadline).fontWeight(.medium) }
                Text(row.preview).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
            }
            .padding(.vertical, 2)
        }
        .buttonStyle(.plain)
        .swipeActions {
            Button(action, systemImage: action == "完了" ? "checkmark" : "xmark", role: action == "完了" ? nil : .destructive) {
                Task { await controller.closeReminder(row) }
            }
            .tint(action == "完了" ? .green : nil)
        }
    }
}
