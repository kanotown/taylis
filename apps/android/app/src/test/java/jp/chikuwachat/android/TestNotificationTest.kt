package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.ErrorMessages
import jp.chikuwachat.android.api.TestNotificationDevice
import jp.chikuwachat.android.api.TestNotificationOut
import jp.chikuwachat.android.platform.PushMessage
import jp.chikuwachat.android.ui.TestNotificationText
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 「テスト通知を送る」 (PUSH_NOTIFICATIONS.md §15): the response, its words, and the push that becomes a notification. */
class TestNotificationTest {
    private fun device(status: String, platform: String = "android", provider: String = "fcm", name: String? = null, current: Boolean = false, detail: String? = null) =
        TestNotificationDevice(deviceId = "d-$status-$platform", deviceName = name, platform = platform, pushProvider = provider, current = current, status = status, detail = detail)

    private fun out(devices: List<TestNotificationDevice>, apns: Boolean = true, fcm: Boolean = true, dnd: Boolean = false) =
        TestNotificationOut(apnsConfigured = apns, fcmConfigured = fcm, dndActive = dnd, sentCount = devices.count { it.status == "sent" }, devices = devices)

    @Test fun decodesTheServersAnswer() {
        val json = """
            {"apns_configured": false, "fcm_configured": true, "dnd_active": false, "sent_count": 1, "devices": [
              {"device_id": "d1", "device_name": "Pixel", "platform": "android", "push_provider": "fcm", "current": true,
               "status": "sent", "detail": null, "last_seen_at": "2026-10-04T00:00:00Z"},
              {"device_id": "d2", "device_name": null, "platform": "ios", "push_provider": "apns", "current": false, "status": "not_configured"}
            ]}
        """.trimIndent()
        val decoded = Codec.snake.decodeFromString(TestNotificationOut.serializer(), json)
        assertEquals(listOf("Pixel（この端末）", "iPhone / iPad"), decoded.devices.map(TestNotificationText::deviceName))
        assertEquals("このサーバでは iOS のプッシュが無効です", TestNotificationText.status(decoded.devices[1]).first)
        assertEquals(listOf("iOS のプッシュ（APNs）はこのサーバでは無効です"), TestNotificationText.notes(decoded))
    }

    @Test fun eachStatusInWords() {
        assertEquals("送信しました" to TestNotificationText.Tone.OK, TestNotificationText.status(device("sent")))
        assertEquals("送れませんでした（UNREGISTERED）", TestNotificationText.status(device("failed", detail = "UNREGISTERED")).first)
        assertEquals(TestNotificationText.Tone.PROBLEM, TestNotificationText.status(device("no_token")).second)
        assertEquals("このサーバでは Android のプッシュが無効です", TestNotificationText.status(device("not_configured")).first)
        assertEquals(TestNotificationText.Tone.NONE, TestNotificationText.status(device("in_app", platform = "desktop", provider = "none")).second)
        assertEquals("ログインの期限切れ", TestNotificationText.status(device("disabled", detail = "session_expired")).first)
        assertEquals("ログアウト済み", TestNotificationText.status(device("disabled", detail = "logout")).first)
    }

    @Test fun notes() {
        assertEquals(
            listOf(
                "このサーバはプッシュ通知が設定されていません（iPhone・Android のアプリには、開いている間だけ通知が出ます）",
                "プッシュ通知を受け取れる端末（iPhone・Android のアプリ）はありません",
            ),
            TestNotificationText.notes(out(listOf(device("in_app", platform = "desktop")), apns = false, fcm = false)),
        )
        assertEquals(listOf("Android のプッシュ（FCM）はこのサーバでは無効です"), TestNotificationText.notes(out(listOf(device("sent")), fcm = false)))
        assertEquals(listOf("通知を一時停止中ですが、テスト通知は送りました"), TestNotificationText.notes(out(listOf(device("sent")), dnd = true)))
    }

    @Test fun aTestPushBecomesANotificationOfItsOwn() {
        val push = PushMessage.parse(mapOf("kind" to "test", "workspace_id" to "w", "title" to "Taylis", "body" to "テスト通知です。", "collapse_key" to "test"))!!
        assertTrue(push.isTest)
        assertTrue(push.shown)
        assertEquals("test", push.notificationKey)
        // Without a collapse key (an older server would not send kind test at all, but the key stays one).
        assertEquals("test", PushMessage.parse(mapOf("kind" to "test", "title" to "t", "body" to "b"))!!.notificationKey)
    }

    @Test fun theRateLimitSaysSoInJapanese() {
        assertEquals("テスト通知は 10 分に 5 回までです。少し待ってからお試しください", ErrorMessages.byCode["test_notification_rate_limited"])
    }
}
