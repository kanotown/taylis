import SwiftUI

/// Signing in (WORKSPACES.md §5.1): the first workspace, another one (`add`: cancel returns to the one on screen),
/// or back into a workspace whose session ended (`relogin`, with the way to the others).
struct LoginView: View {
    enum Mode {
        case initial
        case add
        case relogin(Workspace)
    }

    @Bindable var controller: AppController
    var mode: Mode = .initial
    /// add: close the sheet (cancelled, or signed in).
    var onClose: () -> Void = {}

    @State private var server = ""
    @State private var username = ""
    @State private var password = ""
    @State private var totpCode = ""
    @State private var needsCode = false
    @State private var error: String?
    @State private var busy = false
    @State private var prepared = false
    @State private var adding = false
    @State private var forgetting = false

    private var relogin: Workspace? {
        if case .relogin(let workspace) = mode { return workspace }
        return nil
    }

    private var isAdding: Bool {
        if case .add = mode { return true }
        return false
    }

    private var title: String {
        switch mode {
        case .initial: return "ChikuwaChat"
        case .add: return "ワークスペースを追加"
        case .relogin(let workspace): return workspace.name
        }
    }

    /// The form's own message; before any attempt, what the app said (a failed restore at startup).
    private var message: String? { error ?? (isAdding ? nil : controller.error) }

    var body: some View {
        NavigationStack {
            Form {
                if let workspace = relogin {
                    Section {
                        HStack(spacing: 12) {
                            WorkspaceTile(workspace: workspace, size: 44)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(workspace.name).font(.headline)
                                Text(workspace.host).font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    } footer: {
                        if workspace.signedOut == true { Text("このワークスペースからサインアウトされました。もう一度ログインしてください。") }
                    }
                } else {
                    Section {
                        TextField("https://chat.example.com", text: $server)
                            .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    } header: {
                        Text("サーバ")
                    } footer: {
                        if isAdding { Text("別の ChikuwaChat サーバにログインします。https:// は省略できます。") }
                    }
                }
                Section("アカウント") {
                    TextField("ユーザー名", text: $username)
                        .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("パスワード", text: $password).textContentType(.password)
                }
                if needsCode {
                    Section("2 要素認証") {
                        TextField("認証アプリの 6 桁のコード (または回復コード)", text: $totpCode)
                            .keyboardType(.asciiCapable).textContentType(.oneTimeCode).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                }
                if let message {
                    Section { Text(message).foregroundStyle(.red) }
                }
                Section {
                    Button {
                        Task { await submit() }
                    } label: {
                        if busy { ProgressView() } else { Text(needsCode ? "コードを確認してログイン" : "ログイン") }
                    }
                    .disabled(busy || (relogin == nil && server.trimmingCharacters(in: .whitespaces).isEmpty) || username.isEmpty || password.isEmpty
                              || (needsCode && totpCode.trimmingCharacters(in: .whitespaces).isEmpty))
                }
                if relogin == nil {
                    Section {
                        NavigationLink("招待リンクをお持ちの方はこちら") { InviteView(controller: controller) }
                            .font(.footnote)
                    }
                }
                if let workspace = relogin {
                    let others = controller.workspaces.filter { $0.serverUrl != workspace.serverUrl }
                    if !others.isEmpty {
                        Section("ほかのワークスペース") {
                            ForEach(others) { other in
                                Button { Task { await controller.switchTo(other.serverUrl) } } label: { WorkspaceRow(workspace: other, active: false) }
                                    .foregroundStyle(.primary)
                            }
                        }
                    }
                    Section {
                        Button("ワークスペースを追加", systemImage: "plus") { adding = true }
                        Button("このワークスペースを一覧から外す", systemImage: "minus.circle", role: .destructive) { forgetting = true }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(isAdding ? .inline : .automatic)
            .toolbar {
                if isAdding { ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { onClose() } } }
            }
            .onAppear(perform: prepare)
            .sheet(isPresented: $adding) { LoginView(controller: controller, mode: .add) { adding = false } }
            .alert("このワークスペースを一覧から外しますか？", isPresented: $forgetting) {
                Button("一覧から外す", role: .destructive) {
                    if let workspace = relogin { Task { await controller.signOutWorkspace(workspace.serverUrl) } }
                }
                Button("キャンセル", role: .cancel) {}
            } message: {
                Text("この端末からこのワークスペースの記録を消します。サーバ上のデータは消えません。")
            }
        }
    }

    private func prepare() {
        guard !prepared else { return }
        prepared = true
        switch mode {
        case .initial:
            server = controller.loginServer
            username = controller.loginUsername
        case .add:
            break
        case .relogin(let workspace):
            username = workspace.username
        }
    }

    private func submit() async {
        busy = true
        defer { busy = false }
        let code = needsCode ? totpCode : nil
        let outcome = await controller.signIn(server: relogin?.serverUrl ?? server, username: username.trimmingCharacters(in: .whitespaces),
                                              password: password, totpCode: code, adding: isAdding)
        switch outcome {
        case .signedIn, .switched:
            error = nil
            onClose()
        case .needsCode(let text):
            needsCode = true
            error = text
        case .failed(let text):
            error = text
        }
    }
}
