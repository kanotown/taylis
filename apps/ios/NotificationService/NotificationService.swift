import Foundation
import UserNotifications

/// PUSH_NOTIFICATIONS.md §16: turns a message push (`mutable-content: 1`) into a communication notification with the
/// sender's picture (CommunicationNotification.swift). It holds no credentials: the picture URL in the push is signed by
/// the server. On any failure, and when iOS says time is up, the notification is shown as the server wrote it.
final class NotificationService: UNNotificationServiceExtension {
    private let lock = NSLock()
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var original: UNNotificationContent?
    private var work: Task<Void, Never>?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        lock.lock()
        self.contentHandler = contentHandler
        original = request.content
        lock.unlock()
        let content = request.content
        work = Task { [weak self] in
            let updated = await CommunicationNotification.update(content)
            self?.deliver(updated)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        work?.cancel()
        lock.lock()
        let content = original
        lock.unlock()
        if let content { deliver(content) }
    }

    /// Hands the content over once; the later of the update and the deadline does nothing.
    private func deliver(_ content: UNNotificationContent) {
        lock.lock()
        let handler = contentHandler
        contentHandler = nil
        lock.unlock()
        handler?(content)
    }
}
