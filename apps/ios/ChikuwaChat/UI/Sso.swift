import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

/// Google sign-in (M48, docs/SSO.md §6): the app makes a secret `verifier`, opens the server's start URL in the system's
/// sign-in sheet with only its SHA-256 (`challenge`), and gets back `chikuwachat://sso?ticket=…` (or `?sso_error=…`).
/// The ticket is worth nothing without the verifier, which never leaves memory until the exchange.
enum Sso {
    static let callbackScheme = "chikuwachat"

    /// What the sign-in sheet came back with.
    enum Return: Equatable {
        case ticket(String)
        case error(String)
    }

    /// How a trip through the sign-in sheet ended.
    enum Outcome: Equatable {
        /// Exchange this ticket with the server the trip started on, with this verifier.
        case ticket(ticket: String, verifier: String)
        /// The person closed the sheet: nothing to say.
        case cancelled
        case failed(String)
    }

    static func base64url(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// 32 random bytes: 43 base64url characters (RFC 7636's minimum). Nil only if the system has no randomness to give.
    static func newVerifier() -> String? {
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { return nil }
        return base64url(Data(bytes))
    }

    /// base64url(SHA-256(verifier)), what the start URL carries (S256).
    static func challenge(for verifier: String) -> String {
        base64url(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func startURL(server: URL, challenge: String) -> URL? {
        guard var components = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
        components.path = components.path.replacingOccurrences(of: "/+$", with: "", options: .regularExpression) + "/api/v1/auth/sso/google/start"
        components.queryItems = [URLQueryItem(name: "platform", value: "ios"), URLQueryItem(name: "challenge", value: challenge)]
        return components.url
    }

    /// `chikuwachat://sso?ticket=…` or `?sso_error=<code>`; nil for anything else. An unexpected error code reads as
    /// provider_error.
    static func parse(_ url: URL) -> Return? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.scheme?.lowercased() == callbackScheme, components.host?.lowercased() == "sso" else { return nil }
        let items = components.queryItems ?? []
        if let ticket = items.first(where: { $0.name == "ticket" })?.value, !ticket.isEmpty { return .ticket(ticket) }
        if let code = items.first(where: { $0.name == "sso_error" })?.value {
            return .error(code.range(of: #"^[a-z_]{1,40}$"#, options: .regularExpression) != nil ? code : "provider_error")
        }
        return nil
    }

    /// The Japanese text for a returned `sso_error` code (apps/shared/errors.json).
    static func errorText(_ code: String) -> String {
        ErrorMessages.byCode[code] ?? failedText
    }

    static var failedText: String { tr("Google でのログインに失敗しました。もう一度お試しください") }

    /// Opens the start URL of `server` and waits for the sheet to come back.
    @MainActor
    static func run(server: URL, authenticator: WebAuthenticator) async -> Outcome {
        guard let verifier = newVerifier(), let url = startURL(server: server, challenge: challenge(for: verifier)) else {
            return .failed(failedText)
        }
        do {
            let callback = try await authenticator.authenticate(url: url, callbackScheme: callbackScheme)
            switch parse(callback) {
            case .ticket(let ticket): return .ticket(ticket: ticket, verifier: verifier)
            case .error(let code): return .failed(errorText(code))
            case nil: return .failed(failedText)
            }
        } catch WebAuthenticationError.cancelled {
            return .cancelled
        } catch {
            return .failed(failedText)
        }
    }
}

enum WebAuthenticationError: Error {
    /// The person closed the sheet (or declined the system's "wants to use … to sign in" prompt).
    case cancelled
    case failed(Error?)
}

/// The system sign-in sheet, behind a protocol so the flow can be tested with a fake.
@MainActor
protocol WebAuthenticator {
    /// Opens `url` and returns the URL the server redirected to with `callbackScheme`.
    func authenticate(url: URL, callbackScheme: String) async throws -> URL
}

/// ASWebAuthenticationSession: Safari's cookies are shared (not ephemeral), so a person already signed in to Google in
/// Safari only picks the account. The session catches the `chikuwachat://` redirect itself; the scheme needs no
/// registration in Info.plist.
@MainActor
final class SystemWebAuthenticator: NSObject, WebAuthenticator, ASWebAuthenticationPresentationContextProviding {
    private var session: ASWebAuthenticationSession?

    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            let completion: (URL?, Error?) -> Void = { [weak self] callback, error in
                Task { @MainActor in self?.session = nil }
                if let callback {
                    continuation.resume(returning: callback)
                } else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
                    continuation.resume(throwing: WebAuthenticationError.cancelled)
                } else {
                    continuation.resume(throwing: WebAuthenticationError.failed(error))
                }
            }
            let session: ASWebAuthenticationSession
            if #available(iOS 17.4, *) {
                session = ASWebAuthenticationSession(url: url, callback: .customScheme(callbackScheme), completionHandler: completion)
            } else {
                session = ASWebAuthenticationSession(url: url, callbackURLScheme: callbackScheme, completionHandler: completion)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.session = session
            if !session.start() {
                self.session = nil
                continuation.resume(throwing: WebAuthenticationError.failed(nil))
            }
        }
    }

    nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        MainActor.assumeIsolated {
            let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
            return windows.first(where: \.isKeyWindow) ?? windows.first ?? ASPresentationAnchor()
        }
    }
}
