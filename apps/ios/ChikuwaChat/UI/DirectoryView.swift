import SwiftUI

/// 「メンバー」(M13g): everyone in the workspace, with presence, title and status; a DM is one tap away. People on the lab
/// roster (M23) come first in roster order under their headings (教員, D3 … B3, その他, 卒業生); the others follow under
/// その他のメンバー, online first.
struct DirectoryView: View {
    @Bindable var controller: AppController
    let onOpen: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var people: [UserPublic] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let roster = controller.store.roster
        let found = controller.store.users.values
            .filter { $0.deactivatedAt == nil }
            .filter { user in
                // M23: the research topic and the reading find people too.
                q.isEmpty || [user.username, user.displayName, user.title, roster[user.id]?.researchTopic, roster[user.id]?.reading]
                    .contains { ($0 ?? "").lowercased().contains(q) }
            }
        return Roster.sorted(found, roster) { (rank($0), $0.displayName) < (rank($1), $1.displayName) }
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
        if let topic = controller.store.roster[user.id]?.researchTopic, !topic.isEmpty { parts.append(topic) }
        if let status = activeStatus(user) { parts.append("\(status.emoji) \(status.text)".trimmingCharacters(in: .whitespaces)) }
        if !parts.isEmpty { return parts.joined(separator: " · ") }
        if user.role == "bot" { return "受信 Webhook" }
        switch controller.store.presenceOf(user.id) {
        case "online": return "オンライン"
        case "away": return "離席中"
        default: return "オフライン"
        }
    }

    private func row(_ user: UserPublic) -> some View {
        HStack(spacing: 12) {
            AvatarView(id: user.id, name: user.displayName, size: 40, presence: user.role == "bot" ? nil : controller.store.presenceOf(user.id))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(user.displayName).fontWeight(.semibold)
                    Text("@\(user.username)").font(.footnote).foregroundStyle(.secondary)
                    if let line = controller.store.roster[user.id] { RosterBadge(profile: line) }
                    if user.role == "admin" { Text("管理者").font(.caption2).foregroundStyle(Color.accentColor) }
                    if user.role == "guest" { Text("ゲスト").font(.caption2).foregroundStyle(.secondary) }
                    if user.role == "bot" { Text("BOT").font(.caption2).bold().foregroundStyle(.secondary) }
                    if user.dndUntil != nil { Text("🔕").font(.caption2) }
                }
                StatusGlyph.text(subtitle(user), controller: controller, height: 16).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
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

    var body: some View {
        let people = people
        let headed = !controller.store.roster.isEmpty
        NavigationStack {
            List {
                if headed {
                    ForEach(Roster.sections(people, controller.store.roster)) { part in
                        Section(part.title) { ForEach(part.people) { row($0) } }
                    }
                } else {
                    ForEach(people) { row($0) }
                }
            }
            .searchable(text: $query, prompt: headed ? "名前・ユーザー名・肩書・研究テーマで検索" : "名前・ユーザー名・肩書で検索")
            .navigationTitle("メンバー (\(people.count))")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
        }
    }
}
