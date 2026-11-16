import SwiftUI

/// M190 (SECURITY.md §6.1): 「暗号化されていない接続です」 before a sign-in form (login, adding a workspace, Google sign-in)
/// or an invite link first contacts a server over plain HTTP across the internet. `check` goes on at once for https and
/// for a LAN / this device; otherwise it holds the request for the alert (`insecureServerAlert`), whose 「https で接続」
/// goes on with the same URL with https and 「このまま接続」 as typed. Nothing is remembered.
@MainActor @Observable
final class InsecureServerPrompt {
    struct Pending {
        /// The normalized http URL.
        let url: String
        /// What the form had, handed back for 「このまま接続」.
        let typed: String
        let proceed: (String) -> Void
    }

    private(set) var pending: Pending?

    /// `server` as the form has it (normalized here as the sign-in will be); `proceed` gets the address to use.
    func check(_ server: String, proceed: @escaping (String) -> Void) {
        guard let url = Workspaces.normalize(server), ServerUrlSecurity.classify(url) == .insecure else {
            proceed(server) // https, a LAN, or not a URL (the sign-in says so)
            return
        }
        pending = Pending(url: url, typed: server, proceed: proceed)
    }

    func useHttps(_ request: Pending) {
        pending = nil
        request.proceed(ServerUrlSecurity.https(request.url))
    }

    func continueAnyway(_ request: Pending) {
        pending = nil
        request.proceed(request.typed)
    }

    func cancel() { pending = nil }
}

extension View {
    /// The alert of an `InsecureServerPrompt`.
    func insecureServerAlert(_ prompt: InsecureServerPrompt) -> some View {
        // The buttons get the request the alert was shown for: the binding is cleared as the alert goes.
        alert("暗号化されていない接続です", isPresented: Binding(get: { prompt.pending != nil }, set: { if !$0 { prompt.cancel() } }),
              presenting: prompt.pending) { request in
            Button("https で接続") { prompt.useHttps(request) }
                .keyboardShortcut(.defaultAction)
            Button("このまま接続", role: .destructive) { prompt.continueAnyway(request) }
            Button("キャンセル", role: .cancel) { prompt.cancel() }
        } message: { _ in
            Text("この URL は http です。パスワードやメッセージが暗号化されずに送られ、途中で読まれたり書き換えられたりするおそれがあります。サーバが https に対応していれば https で接続してください。")
        }
    }
}
