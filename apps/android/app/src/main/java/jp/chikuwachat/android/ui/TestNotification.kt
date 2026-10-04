package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.RemoveCircleOutline
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.TestNotificationDevice
import jp.chikuwachat.android.api.TestNotificationOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

/** The words for 「テスト通知を送る」's result (PUSH_NOTIFICATIONS.md §15), the same as the desktop's and iOS's. */
object TestNotificationText {
    enum class Tone { OK, PROBLEM, NONE }

    private val platformNames = mapOf("ios" to "iPhone / iPad", "android" to "Android", "desktop" to "デスクトップ", "web" to "ブラウザ")

    /** The device's name as its owner knows it, with 「(この端末)」 on the one that asked. */
    fun deviceName(device: TestNotificationDevice): String {
        val name = device.deviceName?.trim()?.takeIf { it.isNotEmpty() } ?: platformNames[device.platform] ?: device.platform
        return if (device.current) "$name (この端末)" else name
    }

    fun status(device: TestNotificationDevice): Pair<String, Tone> = when (device.status) {
        "sent" -> "送信しました" to Tone.OK
        "failed" -> (device.detail?.let { "送れませんでした ($it)" } ?: "送れませんでした") to Tone.PROBLEM
        "no_token" -> "プッシュ未登録 (端末の通知がオフか、アプリをまだ開き直していません)" to Tone.PROBLEM
        "not_configured" -> (if (device.pushProvider == "fcm") "このサーバでは Android のプッシュが無効です" else "このサーバでは iOS のプッシュが無効です") to Tone.PROBLEM
        "in_app" -> "アプリの起動中に表示 (プッシュは使いません)" to Tone.NONE
        "disabled" -> (if (device.detail == "session_expired") "ログインの期限切れ" else "ログアウト済み") to Tone.NONE
        else -> device.status to Tone.NONE
    }

    /** Lines above the list: push off on this server, nothing that can take a push, DND. */
    fun notes(out: TestNotificationOut): List<String> = buildList {
        when {
            !out.apnsConfigured && !out.fcmConfigured ->
                add("このサーバはプッシュ通知が設定されていません (iPhone・Android のアプリには、開いている間だけ通知が出ます)")
            !out.apnsConfigured -> add("iOS のプッシュ (APNs) はこのサーバでは無効です")
            !out.fcmConfigured -> add("Android のプッシュ (FCM) はこのサーバでは無効です")
        }
        if (out.devices.none { it.status != "disabled" && (it.platform == "ios" || it.platform == "android") }) {
            add("プッシュ通知を受け取れる端末 (iPhone・Android のアプリ) はありません")
        }
        if (out.dndActive) add("通知を一時停止中ですが、テスト通知は送りました")
    }
}

/** 「テスト通知」 in 「通知」: the server pushes to every device of mine; the list says what happened on each. */
@Composable
fun TestNotificationSection(controller: AppController, permitted: Boolean) {
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    var result by remember { mutableStateOf<TestNotificationOut?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val hint = MaterialTheme.typography.bodySmall
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val danger = MaterialTheme.colorScheme.error
    Text(
        "テスト通知", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = 16.dp, bottom = 6.dp).semantics { heading() },
    )
    OutlinedButton(enabled = !busy, onClick = {
        scope.launch {
            busy = true
            error = null
            controller.sendTestNotification()
                .onSuccess { result = it }
                .onFailure { result = null; error = controller.describe(it) }
            busy = false
        }
    }) {
        Icon(Icons.Outlined.NotificationsActive, contentDescription = null, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text("テスト通知を送る")
        if (busy) {
            Spacer(Modifier.width(8.dp))
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
        }
    }
    Text(
        if (permitted) "この端末と、ほかの端末 (スマートフォンのアプリ・開いているデスクトップ版) に送ります"
        else "この端末では通知が許可されていないため、送っても表示されません。上のボタンから許可してください",
        style = hint, color = if (permitted) muted else danger, modifier = Modifier.padding(top = 4.dp),
    )
    error?.let { Text(it, style = hint, color = danger, modifier = Modifier.padding(top = 4.dp)) }
    result?.let { out ->
        Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            TestNotificationText.notes(out).forEach { Text(it, style = hint, color = muted) }
            out.devices.forEach { device ->
                val (text, tone) = TestNotificationText.status(device)
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Top) {
                    Icon(
                        when (tone) {
                            TestNotificationText.Tone.OK -> Icons.Outlined.CheckCircle
                            TestNotificationText.Tone.PROBLEM -> Icons.Outlined.ErrorOutline
                            TestNotificationText.Tone.NONE -> Icons.Outlined.RemoveCircleOutline
                        },
                        contentDescription = null,
                        tint = when (tone) {
                            TestNotificationText.Tone.OK -> MaterialTheme.colorScheme.primary
                            TestNotificationText.Tone.PROBLEM -> danger
                            TestNotificationText.Tone.NONE -> muted
                        },
                        modifier = Modifier.padding(top = 2.dp).size(18.dp),
                    )
                    Spacer(Modifier.width(8.dp))
                    Column(Modifier.weight(1f)) {
                        Text(TestNotificationText.deviceName(device))
                        Text(text, style = hint, color = if (tone == TestNotificationText.Tone.PROBLEM) danger else muted)
                    }
                }
            }
        }
    }
}
