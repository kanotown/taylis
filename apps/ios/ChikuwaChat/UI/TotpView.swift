import SwiftUI

/// Turning 2FA on (M12i): password → scan the QR and confirm a code → keep the recovery codes.
struct TotpSetupView: View {
    @Bindable var controller: AppController
    var onDone: () -> Void
    @State private var password = ""
    @State private var setup: TotpSetupOut?
    @State private var code = ""
    @State private var recovery: [String]?
    @State private var error: String?
    @State private var busy = false
    @State private var copied = false

    var body: some View {
        NavigationStack {
            Form {
                if let recovery {
                    recoverySection(recovery)
                } else if let setup {
                    scanSection(setup)
                } else {
                    passwordSection
                }
            }
            .navigationTitle("2 要素認証を有効にする")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if recovery == nil { Button("キャンセル") { onDone() } }
                }
            }
            .interactiveDismissDisabled(recovery != nil)
        }
    }

    @ViewBuilder
    private var passwordSection: some View {
        Section {
            Text("ログイン時にパスワードに加えて認証アプリの 6 桁のコードを求めます。始めるにはパスワードを入力してください。").font(.footnote)
            SecureField("現在のパスワード", text: $password).textContentType(.password)
        }
        if let error { Section { Text(error).foregroundStyle(.red) } }
        Section {
            Button {
                Task { await begin() }
            } label: {
                if busy { ProgressView() } else { Text("次へ") }
            }
            .disabled(busy || password.isEmpty)
        }
    }

    @ViewBuilder
    private func scanSection(_ setup: TotpSetupOut) -> some View {
        Section {
            Text("認証アプリ（Google Authenticator、1Password など）で QR コードを読み取るか、キーを手で入力してください。").font(.footnote)
            if let image = Totp.qrImage(base64: setup.qrPngBase64) {
                HStack { Spacer(); Image(uiImage: image).resizable().interpolation(.none).scaledToFit().frame(width: 200, height: 200); Spacer() }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("手入力用のキー").font(.caption).foregroundStyle(.secondary)
                Text(setup.secret).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                Text("種類：時間ベース（TOTP）、6 桁、30 秒").font(.caption).foregroundStyle(.secondary)
            }
            if let url = URL(string: setup.otpauthUri) {
                Link("この端末の認証アプリで開く", destination: url).font(.footnote)
            }
        }
        Section("アプリに表示された 6 桁のコード") {
            TextField("123456", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode)
        }
        if let error { Section { Text(error).foregroundStyle(.red) } }
        Section {
            Button {
                Task { await confirm() }
            } label: {
                if busy { ProgressView() } else { Text("確認して有効にする") }
            }
            .disabled(busy || !Totp.isCode(code))
        }
    }

    @ViewBuilder
    private func recoverySection(_ codes: [String]) -> some View {
        Section {
            Label("有効になりました。次回のログインから認証アプリのコードが必要です。", systemImage: "checkmark.shield.fill").foregroundStyle(.green).font(.footnote)
            Text("回復コードを安全な場所に保存してください。認証アプリが使えないとき、各コードは 1 回だけログインに使えます。この画面を閉じると再表示できません。").font(.footnote)
        }
        Section("回復コード") {
            ForEach(codes, id: \.self) { item in Text(item).font(.system(.body, design: .monospaced)) }
            Button(copied ? "コピーしました" : "回復コードをコピー") {
                UIPasteboard.general.string = Totp.recoveryCodesText(codes)
                copied = true
            }
        }
        Section {
            Button("保存しました、閉じる") { onDone() }
        }
    }

    private func begin() async {
        busy = true
        error = nil
        do { setup = try await controller.beginTotpSetup(password: password) } catch { self.error = Totp.errorText(error) ?? controller.describe(error) }
        busy = false
    }

    private func confirm() async {
        busy = true
        error = nil
        do { recovery = try await controller.enableTotp(code: code).recoveryCodes } catch { self.error = Totp.errorText(error) ?? controller.describe(error) }
        busy = false
    }
}

/// Turning 2FA off needs the password again.
struct TotpDisableView: View {
    @Bindable var controller: AppController
    var onDone: () -> Void
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Text("以後はパスワードだけでログインできるようになります。回復コードも無効になります。").font(.footnote)
                    SecureField("現在のパスワード", text: $password).textContentType(.password)
                }
                if let error { Section { Text(error).foregroundStyle(.red) } }
                Section {
                    Button("無効にする", role: .destructive) {
                        Task {
                            busy = true
                            error = nil
                            do { try await controller.disableTotp(password: password); onDone() } catch { self.error = Totp.errorText(error) ?? controller.describe(error) }
                            busy = false
                        }
                    }
                    .disabled(busy || password.isEmpty)
                }
            }
            .navigationTitle("2 要素認証を無効にする")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { onDone() } } }
        }
    }
}
