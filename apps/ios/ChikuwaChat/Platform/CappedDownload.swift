import Foundation

/// A GET whose answer is read as it comes and given up past a byte cap (2026-11-16, a hostile-server review): a server's
/// huge or endless answer to a picture's request never sits in memory whole. The chunks come as URLSession delivers
/// them (a delegate of the one task), so a capped download costs what an uncapped one does. Compiled into the app and
/// the Notification Service Extension.
enum CappedDownload {
    enum Failure: Error, Equatable {
        /// More than the cap (a declared length over it is refused before any byte is read).
        case tooLarge
        /// The deadline passed while the bytes were still coming.
        case tooSlow
        /// A redirect where none is followed.
        case redirected
    }

    /// The body and the response of `request`. Throws `Failure` as above and URLSession's errors otherwise (a status that
    /// is not 2xx is the caller's to judge). `followRedirects` false: a 3xx is `Failure.redirected`.
    static func get(_ request: URLRequest, session: URLSession = .shared, maxBytes: Int, followRedirects: Bool = true,
                    deadline: Date = .distantFuture) async throws -> (Data, HTTPURLResponse) {
        let loader = Loader(maxBytes: maxBytes, followRedirects: followRedirects, deadline: deadline)
        let task = session.dataTask(with: request)
        task.delegate = loader
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                loader.start(task, continuation)
            }
        } onCancel: {
            task.cancel()
        }
    }

    /// One task's delegate: it collects the chunks, stops the task past the cap, and answers once.
    private final class Loader: NSObject, URLSessionDataDelegate, @unchecked Sendable { // under its lock
        private let maxBytes: Int
        private let followRedirects: Bool
        private let deadline: Date
        private let lock = NSLock()
        private var data = Data()
        private var response: HTTPURLResponse?
        private var failure: Error?
        private var continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>?

        init(maxBytes: Int, followRedirects: Bool, deadline: Date) {
            self.maxBytes = maxBytes
            self.followRedirects = followRedirects
            self.deadline = deadline
        }

        func start(_ task: URLSessionDataTask, _ continuation: CheckedContinuation<(Data, HTTPURLResponse), Error>) {
            lock.lock()
            self.continuation = continuation
            lock.unlock()
            task.resume()
        }

        private func fail(_ error: Error, _ task: URLSessionTask) {
            lock.lock()
            if failure == nil { failure = error }
            lock.unlock()
            task.cancel()
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
            guard let http = response as? HTTPURLResponse else {
                fail(URLError(.badServerResponse), dataTask)
                completionHandler(.cancel)
                return
            }
            if http.expectedContentLength > Int64(maxBytes) {
                fail(Failure.tooLarge, dataTask)
                completionHandler(.cancel)
                return
            }
            lock.lock()
            self.response = http
            if http.expectedContentLength > 0 { data.reserveCapacity(Int(http.expectedContentLength)) }
            lock.unlock()
            completionHandler(.allow)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive chunk: Data) {
            lock.lock()
            let over = data.count + chunk.count > maxBytes
            let late = Date() > deadline
            if !over && !late { data.append(chunk) }
            lock.unlock()
            if over { fail(Failure.tooLarge, dataTask) } else if late { fail(Failure.tooSlow, dataTask) }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                        newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
            if followRedirects {
                completionHandler(request)
            } else {
                fail(Failure.redirected, task)
                completionHandler(nil)
            }
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            lock.lock()
            let continuation = self.continuation
            self.continuation = nil
            let outcome: Result<(Data, HTTPURLResponse), Error>
            if let failure {
                outcome = .failure(failure)
            } else if let error {
                outcome = .failure(error)
            } else if let response {
                outcome = .success((data, response))
            } else {
                outcome = .failure(URLError(.badServerResponse))
            }
            lock.unlock()
            continuation?.resume(with: outcome)
        }
    }
}
