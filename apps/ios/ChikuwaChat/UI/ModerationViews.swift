import SwiftUI

/// M104 (docs/MODERATION.md): blocking people, reporting messages, deleting my account. The rules shared with the other
/// clients are here; the views below use them.
enum Moderation {
    /// The reasons of 「報告する」, in the order every client shows them (the server's `reason`).
    static var reasons: [(value: String, label: String)] { [
        ("spam", tr("迷惑・スパム")),
        ("harassment", tr("嫌がらせ")),
        ("inappropriate", tr("不適切な内容")),
        ("other", tr("その他")),
    ] }

    /// 「報告する」 is offered on someone else's message once it is stored (not mine, not sending, not deleted, not a
    /// join / leave line).
    static func canReport(_ message: MessageState, meId: String?) -> Bool {
        message.senderId != meId && !message.pending && !message.deleted && message.seq != nil && message.type == "user"
    }

    /// A row folds to 「ブロック中のユーザーのメッセージ」: its sender is blocked, it is not deleted and not shown on request.
    static func folds(_ message: MessageState, blocked: Set<String>, revealed: Set<String>) -> Bool {
        blocked.contains(message.senderId) && !message.deleted && !revealed.contains(message.id)
    }
}

/// The folded row of a blocked person's message, with 「表示」 (MODERATION.md §4).
struct BlockedMessageRow: View {
    var margin: CGFloat = 0
    let onShow: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "hand.raised").foregroundStyle(.tertiary)
            Text("ブロック中のユーザーのメッセージ").italic().foregroundStyle(.secondary)
            Button("表示", action: onShow).buttonStyle(.borderless)
            Spacer(minLength: 0)
        }
        .font(.caption)
        .padding(.vertical, 6)
        .padding(.horizontal, margin)
        .contentShape(Rectangle())
    }
}

/// 「報告する」 (MODERATION.md §3): a reason and an optional note; the administrators are told, the author is not.
struct ReportMessageSheet: View {
    @Bindable var controller: AppController
    let message: MessageState
    @Environment(\.dismiss) private var dismiss
    @State private var reason: String?
    @State private var note = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(Moderation.reasons, id: \.value) { item in
                        Button {
                            reason = item.value
                        } label: {
                            HStack {
                                Text(item.label).foregroundStyle(Color.primary)
                                Spacer()
                                if reason == item.value { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                            }
                        }
                    }
                } header: {
                    Text("理由")
                } footer: {
                    Text("ワークスペースの管理者に知らせます。投稿した人には伝わりません。")
                }
                Section("補足（任意）") {
                    TextField("補足", text: $note, axis: .vertical).lineLimit(2...5)
                }
            }
            .navigationTitle("メッセージを報告")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("報告する") {
                        guard let reason else { return }
                        busy = true
                        Task {
                            let ok = await controller.reportMessage(message.id, reason: reason, note: String(note.prefix(1000)))
                            busy = false
                            if ok { dismiss() }
                        }
                    }
                    .disabled(reason == nil || busy)
                }
            }
        }
    }
}

/// 「アカウントを削除」 (MODERATION.md §2): confirmed with my password, or my username for an account without one (Google
/// sign-in). Immediate and final; my messages stay under 「退会したユーザー」.
struct DeleteAccountView: View {
    @Bindable var controller: AppController
    @Environment(\.dismiss) private var dismiss
    @State private var secret = ""
    @State private var failure: String?
    @State private var busy = false
    @State private var confirming = false

    private var hasPassword: Bool { (controller.store.me ?? controller.me)?.passwordSet ?? true }
    private var username: String { (controller.store.me ?? controller.me)?.username ?? "" }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Label("すべての端末からすぐにログアウトし、通知も届かなくなります。", systemImage: "iphone.slash")
                    Label("表示名・ユーザー名・メールアドレス・プロフィール画像・ステータスは消去されます。", systemImage: "person.crop.circle.badge.xmark")
                    Label("投稿したメッセージとファイルは会話の記録として残り、「退会したユーザー」と表示されます。", systemImage: "text.bubble")
                } footer: {
                    Text("この操作は取り消せません。")
                }
                Section {
                    if hasPassword {
                        SecureField("パスワード", text: $secret).textContentType(.password)
                    } else {
                        TextField("ユーザー名（\(username)）", text: $secret)
                            .textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                } header: {
                    Text(hasPassword ? "確認のためパスワードを入力" : "確認のためユーザー名を入力")
                } footer: {
                    if let failure { Text(failure).foregroundStyle(.red) }
                }
                Section {
                    Button("アカウントを削除", role: .destructive) { confirming = true }
                        .disabled(secret.trimmingCharacters(in: .whitespaces).isEmpty || busy)
                }
            }
            .navigationTitle("アカウントを削除")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } } }
            .alert("アカウントを削除しますか？", isPresented: $confirming) {
                Button("キャンセル", role: .cancel) {}
                Button("削除", role: .destructive) {
                    busy = true
                    failure = nil
                    Task {
                        let error = await controller.deleteAccount(secret: secret)
                        busy = false
                        if let error { failure = error } else { dismiss() }
                    }
                }
            } message: {
                Text("元に戻せません。")
            }
        }
    }
}

/// The people I blocked, each with 「解除」 (Settings → アカウント).
struct BlockedUsersSection: View {
    @Bindable var controller: AppController

    var body: some View {
        let ids = controller.store.blockedUsers.sorted { name($0) < name($1) }
        if !ids.isEmpty {
            Section("ブロック中のユーザー") {
                ForEach(ids, id: \.self) { id in
                    HStack {
                        Text(name(id))
                        Spacer()
                        Button("解除") { Task { await controller.setUserBlocked(id, on: false) } }.buttonStyle(.borderless)
                    }
                }
            }
        }
    }

    private func name(_ id: String) -> String { controller.store.users[id]?.displayName ?? tr("不明なユーザー") }
}
