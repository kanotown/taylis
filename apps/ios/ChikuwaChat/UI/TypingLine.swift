import SwiftUI

/// "Alice が入力中…" above the composer; volatile (SYNC_PROTOCOL.md §5.2), re-checked every second so entries expire.
struct TypingLine: View {
    @Bindable var controller: AppController
    let channelId: String
    var parentId: String? = nil
    @State private var now = Date()

    var body: some View {
        let users = controller.store.typingUsers(channelId, parentId: parentId, now: now)
        Group {
            if !users.isEmpty {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.mini)
                    Text(label(users)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 2)
                .accessibilityElement(children: .combine)
            }
        }
        .task(id: users.isEmpty) {
            guard !users.isEmpty else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                now = Date()
            }
        }
    }

    private func label(_ users: [String]) -> String {
        let names = users.map { controller.store.users[$0]?.displayName ?? "…" }
        if names.count <= 2 { return names.joined(separator: "、") + " が入力中…" }
        return "\(names[0]) ほか \(names.count - 1) 人が入力中…"
    }
}
