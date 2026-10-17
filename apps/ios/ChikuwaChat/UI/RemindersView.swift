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
                Section {
                    ForEach(fired) { row in self.row(row, store: store) }
                } header: {
                    Text("届いたリマインド")
                } footer: {
                    Text("「完了」を押すと一覧とバッジから消えます。")
                }
            }
            if !pending.isEmpty {
                Section("予定") { ForEach(pending) { row in self.row(row, store: store) } }
            }
        }
        .listStyle(.plain)
        .navigationTitle("リマインダー")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await controller.engine?.loadReminders() }
    }

    /// The row opens the message; 完了 (fired) / 取り消し (pending) is a visible button at its trailing edge, with the
    /// swipe and the long-press menu as shortcuts (a swipe alone was never found: the badge seemed stuck, 2026-10-17).
    private func row(_ row: ReminderOut, store: Store) -> some View {
        let fired = row.status == "fired"
        let close: () -> Void = { Task { await controller.closeReminder(row) } }
        return HStack(alignment: .center, spacing: 10) {
            Button { onOpen(row) } label: {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        if row.kind == "ack" {  // L4: the author asked me to acknowledge
                            Label("確認のお願い", systemImage: "checkmark.circle").font(.caption.bold()).foregroundStyle(Color.accentColor)
                        } else if row.kind == "collect" {  // L6: a recurring post's due time passed before my reply (the push's title)
                            Label("提出のお願い", systemImage: "tray.and.arrow.up").font(.caption.bold()).foregroundStyle(Color.orange)
                        }
                        Text(store.channel(row.channelId).map { channelTitle($0, store: store) } ?? "?").font(.footnote).fontWeight(.semibold)
                        Text(fired ? tr("· \(Schedule.label(iso: row.remindAt)) にリマインド") : tr("· \(Schedule.label(iso: row.remindAt)) にリマインド予定")).font(.footnote).foregroundStyle(.secondary)
                    }
                    if let note = row.note, !note.isEmpty { Text(note).font(.subheadline).fontWeight(.medium) }
                    Text(row.preview).font(.subheadline).foregroundStyle(.secondary).lineLimit(2)
                }
                .padding(.vertical, 2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())  // the whole text area, not only the glyphs
            }
            .buttonStyle(.plain)
            Button { close() } label: {
                Label(fired ? tr("完了") : tr("取り消し"), systemImage: fired ? "checkmark" : "xmark").font(.footnote)
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .tint(fired ? Color.accentColor : Color.secondary)
            .fixedSize()
        }
        .contextMenu {
            Button { onOpen(row) } label: { Label("メッセージを開く", systemImage: "arrow.up.forward.square") }
            Button(role: fired ? nil : .destructive) { close() } label: {
                Label(fired ? tr("完了") : tr("取り消し"), systemImage: fired ? "checkmark" : "xmark")
            }
        }
        .swipeActions {
            Button(fired ? tr("完了") : tr("取り消し"), systemImage: fired ? "checkmark" : "xmark", role: fired ? nil : .destructive) { close() }
                .tint(fired ? .green : nil)
        }
    }
}
