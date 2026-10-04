import XCTest
@testable import ChikuwaChat

/// 「テスト通知を送る」 (PUSH_NOTIFICATIONS.md §15): the response, its words, and the push shown with the app open.
final class TestNotificationTests: XCTestCase {
    private func device(_ status: String, platform: String = "ios", provider: String = "apns", name: String? = nil,
                        current: Bool = false, detail: String? = nil) -> TestNotificationDevice {
        TestNotificationDevice(deviceId: UUID().uuidString, deviceName: name, platform: platform, pushProvider: provider,
                               current: current, status: status, detail: detail)
    }

    private func out(_ devices: [TestNotificationDevice], apns: Bool = true, fcm: Bool = true, dnd: Bool = false) -> TestNotificationOut {
        TestNotificationOut(apnsConfigured: apns, fcmConfigured: fcm, dndActive: dnd,
                            sentCount: devices.filter { $0.status == "sent" }.count, devices: devices)
    }

    func testDecodesTheServersAnswer() throws {
        let json = """
        {"apns_configured": true, "fcm_configured": false, "dnd_active": false, "sent_count": 1, "devices": [
          {"device_id": "d1", "device_name": "iPhone", "platform": "ios", "push_provider": "apns", "current": true,
           "status": "sent", "detail": null, "last_seen_at": "2026-10-04T00:00:00Z"},
          {"device_id": "d2", "device_name": null, "platform": "android", "push_provider": "fcm", "current": false,
           "status": "not_configured"}
        ]}
        """
        let decoded = try JSON.snakeDecoder.decode(TestNotificationOut.self, from: Data(json.utf8))
        XCTAssertFalse(decoded.fcmConfigured)
        XCTAssertEqual(decoded.devices.map(\.status), ["sent", "not_configured"])
        XCTAssertEqual(decoded.devices.map(TestNotificationText.deviceName), ["iPhone (この端末)", "Android"])
        XCTAssertEqual(TestNotificationText.status(decoded.devices[1]).text, "このサーバでは Android のプッシュが無効です")
    }

    func testEachStatusInWords() {
        XCTAssertEqual(TestNotificationText.status(device("sent")).tone, .ok)
        XCTAssertEqual(TestNotificationText.status(device("failed", detail: "BadDeviceToken")).text, "送れませんでした (BadDeviceToken)")
        XCTAssertEqual(TestNotificationText.status(device("no_token")).tone, .problem)
        XCTAssertEqual(TestNotificationText.status(device("not_configured")).text, "このサーバでは iOS のプッシュが無効です")
        XCTAssertEqual(TestNotificationText.status(device("in_app", platform: "desktop", provider: "none")).tone, .none)
        XCTAssertEqual(TestNotificationText.status(device("disabled", detail: "session_expired")).text, "ログインの期限切れ")
        XCTAssertEqual(TestNotificationText.status(device("disabled", detail: "logout")).text, "ログアウト済み")
    }

    func testNotes() {
        XCTAssertEqual(TestNotificationText.notes(out([device("in_app", platform: "desktop")], apns: false, fcm: false)), [
            "このサーバはプッシュ通知が設定されていません (iPhone・Android のアプリには、開いている間だけ通知が出ます)",
            "プッシュ通知を受け取れる端末 (iPhone・Android のアプリ) はありません",
        ])
        XCTAssertEqual(TestNotificationText.notes(out([device("sent")], fcm: false)), ["Android のプッシュ (FCM) はこのサーバでは無効です"])
        XCTAssertEqual(TestNotificationText.notes(out([device("sent")], apns: false, dnd: true)), [
            "iOS のプッシュ (APNs) はこのサーバでは無効です",
            "通知を一時停止中ですが、テスト通知は送りました",
        ])
    }

    func testATestPushShowsWithTheAppOpenAndOpensNothing() {
        let payload = PushPayload(userInfo: ["kind": "test", "workspace_id": "w"])
        let here = Workspace(serverUrl: "https://a", username: "me")
        XCTAssertTrue(Workspaces.shouldPresent(payload, target: here, active: "https://a", openChannelId: "ch"))
        XCTAssertNil(payload.channelId)
        XCTAssertFalse(payload.opensEvent || payload.opensTask || payload.opensCanvas || payload.opensMessage)
    }

    func testTheRateLimitSaysSoInJapanese() {
        XCTAssertEqual(ErrorMessages.byCode["test_notification_rate_limited"], "テスト通知は 10 分に 5 回までです。少し待ってからお試しください")
    }
}
