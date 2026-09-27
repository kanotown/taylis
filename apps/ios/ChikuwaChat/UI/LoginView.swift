import SwiftUI

struct LoginView: View {
    @Bindable var controller: AppController
    @State private var server = ""
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section("サーバ") {
                    TextField("https://chat.example.com", text: $server)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                Section("アカウント") {
                    TextField("ユーザー名", text: $username)
                        .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("パスワード", text: $password).textContentType(.password)
                }
                if let error = controller.error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                Section {
                    Button {
                        Task {
                            busy = true
                            await controller.login(server: server, username: username, password: password)
                            busy = false
                        }
                    } label: {
                        if busy { ProgressView() } else { Text("ログイン") }
                    }
                    .disabled(busy || server.isEmpty || username.isEmpty || password.isEmpty)
                }
                Section {
                    NavigationLink("招待リンクをお持ちの方はこちら") { InviteView(controller: controller) }
                        .font(.footnote)
                }
            }
            .navigationTitle("ChikuwaChat")
            .onAppear {
                if server.isEmpty { server = controller.serverUrl }
                if username.isEmpty { username = controller.username }
            }
        }
    }
}
