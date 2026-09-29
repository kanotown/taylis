import SwiftUI

/// A reminder at a time of one's own, with a note (M28d; the presets are in the action sheet). At least a minute ahead.
struct ReminderFormView: View {
    @Bindable var controller: AppController
    let message: MessageState
    @Environment(\.dismiss) private var dismiss
    @State private var at = Date().addingTimeInterval(3600)
    @State private var note = ""
    @State private var saving = false

    private var tooSoon: Bool { at.timeIntervalSinceNow < 60 }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    DatePicker("日時", selection: $at, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    TextField("メモ (任意)", text: $note)
                } footer: {
                    if tooSoon { Text("1 分以上先の時刻を選んでください").foregroundStyle(.red) }
                }
            }
            .navigationTitle("リマインド")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "設定中…" : "設定") {
                        saving = true
                        Task {
                            let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
                            let done = await controller.setReminder(messageId: message.id, at: at, note: trimmed.isEmpty ? nil : trimmed)
                            saving = false
                            if done { dismiss() }
                        }
                    }
                    .disabled(tooSoon || saving)
                }
            }
            .interactiveDismissDisabled(saving)
        }
        .presentationDetents([.medium])
    }
}
