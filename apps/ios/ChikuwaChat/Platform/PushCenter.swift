import Foundation
import Observation
import UIKit
import UserNotifications

/// Owns the APNs token and the pending "open this channel" request from a tapped notification.
@MainActor
@Observable
final class PushCenter {
    static let shared = PushCenter()

    private(set) var token: String?
    private var uploadedToken: String?
    var pendingChannelId: String?
    private weak var controller: AppController?

    func attach(controller: AppController) {
        self.controller = controller
        uploadedToken = nil // a new session: the server device row is new, so register again
        requestAuthorizationAndRegister()
        uploadTokenIfNeeded()
    }

    func requestAuthorizationAndRegister() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, error in
            if let error { print("notification permission: \(error.localizedDescription)") }
            Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func tokenReceived(_ hex: String) {
        token = hex
        uploadTokenIfNeeded()
    }

    /// `PUT /devices/current` whenever the token changed or a new session started (§3).
    func uploadTokenIfNeeded() {
        guard let token, token != uploadedToken, let api = controller?.api else { return }
        let environment = PushEnvironment.current()
        Task { @MainActor in
            do {
                _ = try await api.updateDevice(pushProvider: "apns", pushToken: token, pushEnvironment: environment)
                uploadedToken = token
            } catch {
                print("push token upload failed: \(error)")
            }
        }
    }

    /// read.updated said the channel is fully read: drop its delivered notifications (thread-id = channel).
    func clearNotifications(channelId: String) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let ids = delivered.filter { $0.request.content.threadIdentifier == channelId }.map { $0.request.identifier }
            if !ids.isEmpty { center.removeDeliveredNotifications(withIdentifiers: ids) }
        }
    }

    /// Bootstrap / read updates overwrite whatever the last push set (PUSH_NOTIFICATIONS.md §9).
    func setBadge(_ count: Int) {
        UNUserNotificationCenter.current().setBadgeCount(count) { _ in }
    }

    func pushReceived() {
        controller?.engine?.reconnectNow()
    }

    func notificationTapped(channelId: String?) {
        pendingChannelId = channelId
        controller?.engine?.reconnectNow()
    }
}

/// Which APNs environment this build's provisioning profile targets (sandbox for Xcode installs).
enum PushEnvironment {
    static func current() -> String {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url) else {
            return "sandbox" // simulator or unsigned build
        }
        return parse(String(decoding: data, as: UTF8.self))
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
