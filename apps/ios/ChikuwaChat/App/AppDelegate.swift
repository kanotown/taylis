import UIKit
import UserNotifications

/// APNs registration callbacks and notification presentation (PUSH_NOTIFICATIONS.md §9).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // App Group locks (and the work done on going to the background) run in background tasks, never suspended
        // while held (MOBILE_UI.md §21.3, 0xdead10cc).
        FileLock.activities = ApplicationActivityProvider(application)
        return true
    }

    /// MOBILE_UI.md §21.4: a share's background uploads ended after the share sheet closed. The app attaches to the
    /// share's session, takes the results, posts the message, then lets iOS suspend it again.
    func application(_ application: UIApplication, handleEventsForBackgroundURLSession identifier: String,
                     completionHandler: @escaping () -> Void) {
        // docs/DRIVE.md §29: a drive upload batch's parts ended (the app or the share sheet left the screen): attach to the
        // batch's session, take the results, send what is missing or complete the files, then let iOS suspend it again.
        if let batchId = BackgroundDriveTransport.batchId(ofSession: identifier) {
            guard let processor = DriveUploadProcessor.shared else {
                completionHandler()
                return
            }
            (processor.transport as? BackgroundDriveTransport)?.attach(identifier: identifier)
            Task {
                await processor.run(batchId)
                await MainActor.run { completionHandler() }
            }
            return
        }
        guard let shareId = BackgroundShareTransport.shareId(ofSession: identifier), let processor = ShareProcessor.shared else {
            completionHandler()
            return
        }
        (processor.transport as? BackgroundShareTransport)?.attach(identifier: identifier)
        Task {
            _ = await processor.send(shareId)
            await MainActor.run { completionHandler() }
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let hex = deviceToken.hexString
        Task { @MainActor in PushCenter.shared.tokenReceived(hex) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("push registration failed: \(error.localizedDescription)")
    }

    /// Foreground (WORKSPACES.md §7): the workspace on screen syncs and only its open conversation stays quiet (the
    /// WebSocket delivered it); another workspace's notification shows as a banner.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let payload = PushPayload(userInfo: notification.request.content.userInfo)
        let show = await MainActor.run { PushCenter.shared.shouldPresent(payload) }
        return show ? [.banner, .list, .sound] : []
    }

    /// Tap: the notification's workspace comes on screen, then its conversation opens after the normal sync.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let payload = PushPayload(userInfo: response.notification.request.content.userInfo)
        await MainActor.run { PushCenter.shared.notificationTapped(payload) }
    }
}

/// The app's background time: `UIApplication.beginBackgroundTask`, whose expiration handler lets go of what the work
/// holds and ends the task (FileLock, AppController.didEnterBackground). Both calls are documented as safe off the main
/// thread (a lock may be taken in the share queue or an extension-shared client).
final class ApplicationActivityProvider: BackgroundActivityProvider, @unchecked Sendable {
    private let application: UIApplication

    init(_ application: UIApplication) { self.application = application }

    private final class Activity: BackgroundActivity, @unchecked Sendable {
        let application: UIApplication
        let lock = NSLock()
        var id: UIBackgroundTaskIdentifier = .invalid
        var ended = false

        init(_ application: UIApplication) { self.application = application }

        func end() {
            lock.lock()
            let id = ended ? .invalid : self.id
            ended = true
            lock.unlock()
            if id != .invalid { application.endBackgroundTask(id) }
        }

        /// The task's id once known; ended at once when `end` came first.
        func started(_ id: UIBackgroundTaskIdentifier) {
            lock.lock()
            let endNow = ended
            if !endNow { self.id = id }
            lock.unlock()
            if endNow { application.endBackgroundTask(id) }
        }
    }

    func begin(_ name: String, expired: @escaping () -> Void) -> BackgroundActivity? {
        let activity = Activity(application)
        let id = application.beginBackgroundTask(withName: name) {
            expired()
            activity.end()
        }
        guard id != .invalid else { return nil }
        activity.started(id)
        return activity
    }
}

extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
