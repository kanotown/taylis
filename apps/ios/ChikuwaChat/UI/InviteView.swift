import SwiftUI

/// Joining with an invite link (M12h): paste the link, see who invites, choose a name and a password.
struct InviteView: View {
    @Bindable var controller: AppController
    @State private var link = ""
    @State private var target: (server: URL, token: String)?
    @State private var preview: InvitePreviewOut?
    @State private var username = ""
    @State private var displayName = ""
    @State private var password = ""
    @State private var repeatPassword = ""
    @State private var error: String?
    @State private var busy = false
    /// M190: a link to a server on the internet over plain HTTP is confirmed before the server is first asked.
    @State private var insecure = InsecureServerPrompt()

    private var minLength: Int { preview?.passwordMinLength ?? 8 }
    private var mismatch: Bool { !repeatPassword.isEmpty && password != repeatPassword }
    private var canJoin: Bool {
        !busy && !mismatch && username.count >= 3 && !displayName.trimmingCharacters(in: .whitespaces).isEmpty
            && password.count >= minLength && repeatPassword == password
    }

    var body: some View {
        Form {
            if let target, let preview {
                Section {
                    Text("\(preview.invitedBy) さんから招待されています").font(.headline)
                    if preview.role == "admin" { Text("管理者として参加します").font(.footnote) }
                    if preview.role == "manager" { Text("運営として参加します").font(.footnote) } // M142
                    if let lab = preview.lab { Text(Invite.labLine(lab)).font(.footnote) }  // L7
                    if !preview.channels.isEmpty {
                        Text(tr("参加するチャンネル：") + preview.channels.map { "#\($0)" }.joined(separator: " ")).font(.footnote).foregroundStyle(.secondary)
                    }
                    Text("サーバ \(target.server.absoluteString)").font(.footnote).foregroundStyle(.secondary)
                }
                Section("アカウント") {
                    TextField("ユーザー名（3〜32 文字、a-z 0-9 . _ -）", text: $username)
                        .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .onChange(of: username) { _, value in username = value.lowercased() }
                    TextField("表示名", text: $displayName)
                    SecureField("パスワード（\(minLength) 文字以上）", text: $password).textContentType(.newPassword)
                    SecureField("パスワード（確認）", text: $repeatPassword).textContentType(.newPassword)
                }
                if mismatch { Section { Text("パスワードが一致しません").foregroundStyle(.red) } }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    Button {
                        Task { await join(target) }
                    } label: {
                        if busy { ProgressView() } else { Text("参加する") }
                    }
                    .disabled(!canJoin)
                    Button("別のリンクを使う") { self.target = nil; self.preview = nil; error = nil }
                }
            } else {
                Section("招待リンク") {
                    TextField("https://chat.example.com/invite/…", text: $link)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Section { Text("管理者から受け取ったリンクを貼り付けると、ユーザー名とパスワードを自分で決めて参加できます。").font(.footnote) }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    Button {
                        check()
                    } label: {
                        if busy { ProgressView() } else { Text("リンクを確認") }
                    }
                    .disabled(busy || link.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .navigationTitle("招待リンクで参加")
        .navigationBarTitleDisplayMode(.inline)
        .insecureServerAlert(insecure)
    }

    private func check() {
        guard let parsed = Invite.parse(link) else {
            error = tr("招待リンクの形式が正しくありません（https://サーバ/invite/… の形です）")
            return
        }
        error = nil
        let typed = parsed.server.absoluteString
        insecure.check(typed) { server in
            guard server != typed, let secure = URL(string: server) else {
                Task { await lookUp((parsed.server, parsed.token)) }
                return
            }
            // 「https で接続」: the link in the field says https too.
            link = link.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "^http:", with: "https:", options: [.regularExpression, .caseInsensitive])
            Task { await lookUp((secure, parsed.token)) }
        }
    }

    private func lookUp(_ parsed: (server: URL, token: String)) async {
        busy = true
        error = nil
        do {
            preview = try await controller.previewInvite(server: parsed.server, token: parsed.token)
            target = parsed
        } catch {
            self.error = Invite.errorText(error) ?? controller.describe(error)
        }
        busy = false
    }

    private func join(_ target: (server: URL, token: String)) async {
        busy = true
        error = nil
        let failure = await controller.acceptInvite(server: target.server, token: target.token, username: username,
                                                    displayName: displayName.trimmingCharacters(in: .whitespaces), password: password)
        busy = false
        if let failure { error = failure }
    }
}
