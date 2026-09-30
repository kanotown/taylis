import SwiftUI

/// "Alice が入力中…" above the composer; volatile (SYNC_PROTOCOL.md §5.2), re-checked every second so entries expire.
///
/// The line keeps its height while nobody types (empty then), as the desktop's does. It used to appear and go: the
/// conversation above got shorter while someone typed and taller again the instant their message arrived (the line goes
/// with it), so each message from someone else dropped the rows by the line's height in one frame before the new row
/// pushed them up — a jolt on every arrival (tester, 2026-09-30).
struct TypingLine: View {
    @Bindable var controller: AppController
    let channelId: String
    var parentId: String? = nil
    @State private var now = Date()

    var body: some View {
        let users = controller.store.typingUsers(channelId, parentId: parentId, now: now)
        // One caption line's height (it follows Dynamic Type), whether anyone types or not; what is shown lies over it.
        Text(" ").font(.caption)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityHidden(true)
            .overlay(alignment: .leading) {
                if !users.isEmpty {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text(label(users)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 2)
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
