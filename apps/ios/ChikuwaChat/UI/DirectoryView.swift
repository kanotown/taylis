import SwiftUI

/// 「メンバー」(M13g): everyone in the workspace, with presence, title and status; a DM is one tap away.
struct DirectoryView: View {
    @Bindable var controller: AppController
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var people: [UserPublic] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        return controller.store.users.values
            .filter { $0.deactivatedAt == nil }
            .filter { q.isEmpty || $0.username.lowercased().contains(q) || $0.displayName.lowercased().contains(q) || ($0.title ?? "").lowercased().contains(q) }
            .sorted { (rank($0), $0.displayName) < (rank($1), $1.displayName) }
    }

    private func rank(_ user: UserPublic) -> Int {
        if user.role == "bot" { return 3 }
        switch controller.store.presenceOf(user.id) {
        case "online": return 0
        case "away": return 1
        default: return 2
        }
    }

    private func subtitle(_ user: UserPublic) -> String {
        var parts: [String] = []
        if let title = user.title, !title.isEmpty { parts.append(title) }
        if let status = activeStatus(user) { parts.append("\(status.emoji) \(status.text)".trimmingCharacters(in: .whitespaces)) }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        if user.role == "bot" { return "受信 Webhook" }
        switch controller.store.presenceOf(user.id) {
        case "online": return "オンライン"
        case "away": return "離席中"
        default: return "オフライン"
        }
    }

    var body: some View {
        NavigationStack {
            List(people) { user in
                HStack(spacing: 12) {
                    AvatarView(id: user.id, name: user.displayName, size: 40, presence: user.role == "bot" ? nil : controller.store.presenceOf(user.id))
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 6) {
                            Text(user.displayName).fontWeight(.semibold)
                            Text("@\(user.username)").font(.footnote).foregroundStyle(.secondary)
                            if user.role == "admin" { Text("管理者").font(.caption2).foregroundStyle(Color.accentColor) }
                            if user.role == "guest" { Text("ゲスト").font(.caption2).foregroundStyle(.secondary) }
                            if user.role == "bot" { Text("BOT").font(.caption2).bold().foregroundStyle(.secondary) }
                            if user.dndUntil != nil { Text("🔕").font(.caption2) }
                        }
                        Text(subtitle(user)).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                    }
                    Spacer()
                    if user.id != controller.store.me?.id && user.role != "bot" {
                        Button {
                            Task { if let id = await controller.openDmWith(user.id) { onOpen(id); dismiss() } }
                        } label: { Image(systemName: "bubble.left") }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                    }
                }
            }
            .searchable(text: $query, prompt: "名前・ユーザー名・肩書で検索")
            .navigationTitle("メンバー (\(people.count))")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
        }
    }
}
