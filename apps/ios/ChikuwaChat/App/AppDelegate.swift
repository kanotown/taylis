import UIKit
import UserNotifications

/// APNs registration callbacks and notification presentation (PUSH_NOTIFICATIONS.md §9).
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
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

extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}
