import Foundation

/// Transport as the engine sees it (URLSessionWebSocketTask in the app, a fake in tests).
/// Main-actor isolated so frame delivery and engine state never race.
@MainActor
protocol WsTransport: AnyObject {
    var onMessage: ((String) -> Void)? { get set }
    var onClose: ((Int) -> Void)? { get set }
    func send(_ text: String) async throws
    func close()
}

typealias WsConnector = @MainActor (URL, String) async throws -> WsTransport

/// URLSessionWebSocketTask wrapped so frames are delivered in order on the main actor.
@MainActor
final class WebSocketTransport: WsTransport {
    var onMessage: ((String) -> Void)?
    var onClose: ((Int) -> Void)?
    private let session: URLSession
    private let task: URLSessionWebSocketTask
    private let delegate = Delegate()
    private var closed = false

    struct ConnectError: Error {}

    private init(url: URL) {
        session = URLSession(configuration: .default, delegate: delegate, delegateQueue: nil)
        var request = URLRequest(url: url)
        request.setValue(UILanguage.shared.acceptLanguage, forHTTPHeaderField: "Accept-Language")
        task = session.webSocketTask(with: request)
    }

    static func connect(url: URL) async throws -> WebSocketTransport {
        let transport = WebSocketTransport(url: url)
        try await transport.open()
        return transport
    }

    private func open() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            delegate.onSettled = { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
            task.resume()
        }
        delegate.onServerClose = { [weak self] code in
            Task { @MainActor in self?.fireClose(code: code) }
        }
        Task { [weak self] in await self?.receiveLoop() }
    }

    func send(_ text: String) async throws {
        try await task.send(.string(text))
    }

    func close() {
        guard !closed else { return }
        task.cancel(with: .normalClosure, reason: nil)
        fireClose(code: 1000)
    }

    private func receiveLoop() async {
        while !closed {
            do {
                let message = try await task.receive()
                if case .string(let text) = message { onMessage?(text) }
            } catch {
                fireClose(code: delegate.lastCloseCode ?? 1006)
                return
            }
        }
    }

    private func fireClose(code: Int) {
        guard !closed else { return }
        closed = true
        session.invalidateAndCancel()
        onClose?(code)
    }

    /// URLSession callbacks arrive on a background queue; this object forwards them to the main actor.
    private final class Delegate: NSObject, URLSessionWebSocketDelegate {
        var onSettled: ((Error?) -> Void)?
        var onServerClose: ((Int) -> Void)?
        var lastCloseCode: Int?
        private var settled = false

        private func settle(_ error: Error?) {
            guard !settled, let handler = onSettled else { return }
            settled = true
            onSettled = nil
            handler(error)
        }

        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
            settle(nil)
        }

        func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
            lastCloseCode = closeCode.rawValue
            onServerClose?(closeCode.rawValue)
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            settle(error ?? ConnectError())
            if error != nil { onServerClose?(lastCloseCode ?? 1006) }
        }
    }
}
