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
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/** The words for 「テスト通知を送る」's result (PUSH_NOTIFICATIONS.md §15), the same as the desktop's and iOS's. */
object TestNotificationText {
    enum class Tone { OK, PROBLEM, NONE }

    private val platformNames get() = mapOf("ios" to "iPhone / iPad", "android" to "Android", "desktop" to L10n.str(R.string.common_desktop), "web" to L10n.str(R.string.test_notification_browser))

    /** The device's name as its owner knows it, with 「(この端末)」 on the one that asked. */
    fun deviceName(device: TestNotificationDevice): String {
        val name = device.deviceName?.trim()?.takeIf { it.isNotEmpty() } ?: platformNames[device.platform] ?: device.platform
        return if (device.current) L10n.str(R.string.test_notification_this_device, name) else name
    }

    fun status(device: TestNotificationDevice): Pair<String, Tone> = when (device.status) {
        "sent" -> L10n.str(R.string.test_notification_sent) to Tone.OK
        "failed" -> (device.detail?.let { L10n.str(R.string.test_notification_couldnt_send, it) } ?: L10n.str(R.string.test_notification_couldnt_send_2)) to Tone.PROBLEM
        "no_token" -> L10n.str(R.string.test_notification_push_not_registered_notifications_are) to Tone.PROBLEM
        "not_configured" -> (if (device.pushProvider == "fcm") L10n.str(R.string.test_notification_android_push_is_disabled_on_this) else L10n.str(R.string.test_notification_ios_push_is_disabled_on_this)) to Tone.PROBLEM
        "in_app" -> L10n.str(R.string.test_notification_shown_while_the_app_is_open) to Tone.NONE
        "disabled" -> (if (device.detail == "session_expired") L10n.str(R.string.test_notification_sign_in_expired) else L10n.str(R.string.test_notification_signed_out)) to Tone.NONE
        else -> device.status to Tone.NONE
    }

    /** Lines above the list: push off on this server, nothing that can take a push, DND. */
    fun notes(out: TestNotificationOut): List<String> = buildList {
        when {
            !out.apnsConfigured && !out.fcmConfigured ->
                add(L10n.str(R.string.test_notification_this_server_has_no_push_notifications))
            !out.apnsConfigured -> add(L10n.str(R.string.test_notification_ios_push_apns_is_disabled_on))
            !out.fcmConfigured -> add(L10n.str(R.string.test_notification_android_push_fcm_is_disabled_on))
        }
        if (out.devices.none { it.status != "disabled" && (it.platform == "ios" || it.platform == "android") }) {
            add(L10n.str(R.string.test_notification_no_devices_can_receive_push))
        }
        if (out.dndActive) add(L10n.str(R.string.test_notification_notifications_are_paused_but_the_test))
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
        stringResource(R.string.test_notification_test_notification), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary,
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
        Text(stringResource(R.string.test_notification_send_a_test_notification))
        if (busy) {
            Spacer(Modifier.width(8.dp))
            CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
        }
    }
    Text(
        if (permitted) stringResource(R.string.test_notification_sends_to_this_device_and_your)
        else stringResource(R.string.test_notification_notifications_arent_allowed_on_this),
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
