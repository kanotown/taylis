import SwiftUI

struct ChangePasswordView: View {
    @Bindable var controller: AppController
    @State private var current = ""
    @State private var next = ""
    @State private var repeatNext = ""
    @State private var busy = false

    private var mismatch: Bool { !repeatNext.isEmpty && next != repeatNext }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("仮パスワードでログインしています。続ける前に新しいパスワードを設定してください。").font(.footnote)
                }
                Section {
                    SecureField("現在のパスワード", text: $current).textContentType(.password)
                    SecureField("新しいパスワード（8 文字以上）", text: $next).textContentType(.newPassword)
                    SecureField("新しいパスワード（確認）", text: $repeatNext).textContentType(.newPassword)
                }
                if mismatch { Section { Text("パスワードが一致しません").foregroundStyle(.red) } }
                if let error = controller.error { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    Button("変更する") {
                        Task {
                            busy = true
                            await controller.changePassword(current: current, new: next)
                            busy = false
                        }
                    }
                    .disabled(busy || mismatch || next.count < 8 || current.isEmpty)
                    Button("ログアウト", role: .destructive) { Task { await controller.logout() } }
                }
            }
            .navigationTitle("パスワードの変更")
        }
    }
}
