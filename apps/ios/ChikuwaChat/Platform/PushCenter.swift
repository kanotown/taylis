import Foundation
import Observation
import UIKit
import UserNotifications

/// Owns the APNs token, the notification badge and the pending "open this conversation" request from a tap. Which
/// workspace a notification belongs to is the controller's business (WORKSPACES.md §7).
@MainActor
@Observable
final class PushCenter {
    static let shared = PushCenter()

    private(set) var token: String?
    /// A tapped notification's conversation in the workspace on screen; MainView opens it once the store knows it.
    var pendingChannelId: String?
    /// The tapped notification's thread, when it was a reply (M28d): opened with the channel.
    var pendingParentId: String?
    /// M52: a tapped alarm of my own calendar: MainView opens the calendar (the event is AppController.calendarOpen).
    var pendingCalendar = false
    /// M56: a tapped notification of my own task: MainView opens 「自分のタスク」 (the task is AppController.taskOpen).
    var pendingTasks = false
    @ObservationIgnored private weak var controller: AppController?
    /// A tap that arrived before the app finished starting; routed after startup.
    @ObservationIgnored private var pendingTap: PushPayload?

    func bind(_ controller: AppController) {
        self.controller = controller
    }

    /// The workspace on screen (re)connected: register the token with it again (a new login has a new device row) and
    /// ask iOS for the token (PUSH_NOTIFICATIONS.md §3).
    func sessionConnected() {
        controller?.pushSessionStarted()
        requestAuthorizationAndRegister()
    }

    func requestAuthorizationAndRegister() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, error in
            if let error { print("notification permission: \(error.localizedDescription)") }
            Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    /// A new or changed token goes to every signed-in workspace (WORKSPACES.md §8).
    func tokenReceived(_ hex: String) {
        token = hex
        Task { await controller?.uploadPushTokens() }
    }

    /// read.updated said the channel is fully read: drop its delivered notifications (thread-id = channel).
    func clearNotifications(channelId: String) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let ids = delivered.filter { $0.request.content.threadIdentifier == channelId }.map { $0.request.identifier }
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    /// One workspace signed out while others stay (SYNC_PROTOCOL.md §11): only its delivered notifications go. A server
    /// that sends no workspace_id belongs to a workspace whose id is not known yet.
    func clearNotifications(workspaceId: String?) {
        Task {
            let center = UNUserNotificationCenter.current()
            let delivered = await center.deliveredNotifications()
            let ids = delivered.filter { PushPayload(userInfo: $0.request.content.userInfo).workspaceId == workspaceId }.map(\.request.identifier)
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    /// The app icon number: the controller adds up the workspaces (WORKSPACES.md §6).
    func setBadge(_ count: Int) {
        UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
    }

    /// The last workspace signed out (SYNC_PROTOCOL.md §11): no badge, no delivered notification and no pending tap stay.
    func clearAll() {
        pendingChannelId = nil
        pendingCalendar = false
        pendingTasks = false
        pendingTap = nil
        setBadge(0)
        UNUserNotificationCenter.current().removeAllDeliveredNotifications()
    }

    /// willPresent: whether a notification that arrived with the app on screen is shown.
    func shouldPresent(_ payload: PushPayload) -> Bool {
        controller?.foregroundNotification(payload) ?? false
    }

    func notificationTapped(_ payload: PushPayload) {
        guard let controller, controller.booted else {
            pendingTap = payload
            return
        }
        Task { await controller.openNotification(payload) }
    }

    func queueTap(_ payload: PushPayload) {
        pendingTap = payload
    }

    func takePendingTap() -> PushPayload? {
        defer { pendingTap = nil }
        return pendingTap
    }
}

/// Which APNs environment this build targets: the embedded provisioning profile's for Xcode (sandbox) and Ad Hoc
/// installs. App Store and TestFlight builds carry no embedded profile and always use production.
enum PushEnvironment {
    static func current() -> String {
        #if targetEnvironment(simulator)
        return "sandbox"
        #else
        let profile = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision")
            .flatMap { try? Data(contentsOf: $0) }
            .map { String(decoding: $0, as: UTF8.self) }
        return resolve(profile: profile)
        #endif
    }

    /// `profile` is nil on a device build without an embedded profile, i.e. from the App Store or TestFlight.
    static func resolve(profile: String?) -> String {
        guard let profile else { return "production" }
        return parse(profile)
    }

    /// The profile is a CMS blob wrapping a plist; a substring search is enough for one key.
    static func parse(_ profileText: String) -> String {
        guard let keyRange = profileText.range(of: "<key>aps-environment</key>") else { return "sandbox" }
        let after = profileText[keyRange.upperBound...]
        guard let open = after.range(of: "<string>"), let close = after.range(of: "</string>") else { return "sandbox" }
        let value = after[open.upperBound..<close.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines)
        return value == "production" ? "production" : "sandbox"
    }
}
