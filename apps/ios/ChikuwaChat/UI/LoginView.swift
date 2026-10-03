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
    /// Tests: whether a server offers Google sign-in, without asking it (else GET /auth/methods).
    var offersGoogle: ((String) async -> Bool)? = nil

    @State private var server = ""
    /// M48: whether each server asked offers 「Google でログイン」 (GET /auth/methods).
    @State private var googleByServer: [String: Bool] = [:]
    @State private var googleBusy = false
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
        case .initial: return "Taylis"
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
                        if isAdding { Text("別の Taylis サーバにログインします。https:// は省略できます。") }
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
                    .disabled(busy || googleBusy || (relogin == nil && server.trimmingCharacters(in: .whitespaces).isEmpty) || username.isEmpty || password.isEmpty
                              || (needsCode && totpCode.trimmingCharacters(in: .whitespaces).isEmpty))
                }
                if google {
                    Section { googleSection }
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
            .task(id: methodsServer) { await loadMethods() }
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

    /// 「または」 and the Google button under the password form (M48, SSO.md §6).
    private var googleSection: some View {
        VStack(spacing: 14) {
            HStack(spacing: 12) {
                VStack { Divider() }
                Text("または").font(.footnote).foregroundStyle(.secondary)
                VStack { Divider() }
            }
            .accessibilityHidden(true)
            Button {
                Task { await signInWithGoogle() }
            } label: {
                HStack(spacing: 8) {
                    if googleBusy { ProgressView() }
                    Text("Google でログイン")
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            .disabled(busy || googleBusy || methodsServer.isEmpty)
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }

    /// The server whose sign-in methods the form shows: the one signed back in to, else the one typed.
    private var methodsServer: String { relogin?.serverUrl ?? server.trimmingCharacters(in: .whitespaces) }

    private var google: Bool { googleByServer[methodsServer] == true }

    /// GET /auth/methods of the server in the form, again when the address changes (after a pause in typing). A server
    /// without the endpoint (before M48), or no answer, leaves the button out.
    private func loadMethods() async {
        let target = methodsServer
        guard !target.isEmpty, googleByServer[target] == nil else { return }
        if !googleByServer.isEmpty { // typed after the first answer
            try? await Task.sleep(nanoseconds: 600_000_000)
            if Task.isCancelled { return }
        }
        let offered = await (offersGoogle ?? controller.offersGoogle(server:))(target)
        googleByServer[target] = offered
    }

    private func signInWithGoogle() async {
        googleBusy = true
        defer { googleBusy = false }
        let outcome = await controller.signInWithGoogle(server: methodsServer, adding: isAdding)
        switch outcome {
        case nil:
            break // the sheet was closed: nothing to say
        case .signedIn, .switched:
            error = nil
            onClose()
        case .needsCode:
            break // not asked after Google sign-in (SSO.md §4)
        case .failed(let text):
            error = text
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
